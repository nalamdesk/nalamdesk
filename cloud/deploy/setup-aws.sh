#!/usr/bin/env bash
# One-time AWS setup for NalamDesk Cloud. Run once per AWS account, by hand,
# with an account that can create IAM roles and Route 53 zones.
#
#   ./cloud/deploy/setup-aws.sh <stage> [zoneName]
#
#   stage      sandbox (default) or production
#   zoneName   DNS zone for the cloud, default cloud.nalamdesk.com
#
# It does five things, each one safe to repeat:
#
#   1. CDK bootstrap in ap-south-1 and us-east-1
#   2. the Route 53 hosted zone, and prints the name servers to delegate
#   3. the GitHub deploy roles (cloud/deploy/github-deploy-role.yaml)
#   4. the hand-made Parameter Store values (relay + NalamBook)
#   5. prints the GitHub and Cloudflare steps that follow
#
# Run it with AWS credentials in the environment (~/.aws/credentials, an
# exported key, or `aws sso login`). No key is ever written to this repository.
#
# The zone is created here, not by CloudFormation, because the certificate
# cannot be validated until the name servers are delegated, and the deploy
# would sit waiting for that. Core then imports the zone with
# -c hostedZoneId, which is what the deployment workflow does as well.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
region=ap-south-1
edge_region=us-east-1

stage="${1:-sandbox}"
zone="${2:-cloud.nalamdesk.com}"
github_repo="${GITHUB_REPO:-nalamdesk/nalamdesk}"

case "$stage" in
  sandbox|production) ;;
  *) echo "Stage must be sandbox or production, not '$stage'." >&2; exit 2 ;;
esac

say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
note() { printf '   %s\n' "$*"; }
die()  { printf '\n\033[31mError: %s\033[0m\n' "$*" >&2; exit 1; }

# --- 0. Prerequisites -------------------------------------------------------

say "Checking the tools"
for tool in aws node npx openssl; do
  command -v "$tool" >/dev/null 2>&1 || die "'$tool' is not on the PATH."
done
node_major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$node_major" -ge 22 ] || die "Node 22 or newer is needed (found $(node -v))."
note "node $(node -v), aws $(aws --version 2>&1 | head -1)"

if ! aws sts get-caller-identity >/dev/null 2>&1; then
  die "No usable AWS credentials. Run 'aws sso login' or set AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY."
fi
account="$(aws sts get-caller-identity --query Account --output text)"
note "account $account, region $region (and $edge_region for the certificate and zone)"

# The deploy roles trust this exact repository. A wrong name here means CI
# cannot assume the role even though everything else looks fine.
if [ "$github_repo" != "nalamdesk/nalamdesk" ]; then
  note "GitHub repository is $github_repo, not the default. The IAM roles still trust"
  note "nalamdesk/nalamdesk unless the template is changed, so CI would fail to assume them."
fi

# --- 1. CDK bootstrap ------------------------------------------------------
# CloudFormation acts through these roles, so the account admin controls what
# a deploy can actually change. The GitHub role can only assume them.

say "Bootstrapping CDK in $region and $edge_region"
note "this takes a few minutes per region and is safe to repeat"
(cd "$repo/cloud/core" && npm ci --no-audit --no-fund >/dev/null)
(cd "$repo/cloud/core" && npx cdk bootstrap "aws://$account/$region" "aws://$account/$edge_region")

# --- 2. The Route 53 hosted zone -------------------------------------------
# Created here so the name servers can be delegated to Cloudflare before
# anything waits on a certificate. The zone name is a subdomain of the
# nalamdesk.com zone that Cloudflare serves, so the delegation is a set of
# NS records at Cloudflare, not a change of registrar.

say "Preparing the Route 53 hosted zone for $zone"
zone_id="$(aws route53 list-hosted-zones-by-name --dns-name "$zone" --max-items 1 \
  --query "HostedZones[?Name=='$zone.'] | [0].Id" --output text 2>/dev/null || true)"

if [ -n "$zone_id" ] && [ "$zone_id" != "None" ]; then
  zone_id="${zone_id#/hostedzone/}"
  note "the zone already exists: $zone_id"
else
  created="$(aws route53 create-hosted-zone --name "$zone" --caller-reference "nalamdesk-$stage" \
    --query 'HostedZone' --output json)"
  zone_id="$(printf '%s' "$created" | node -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).Id.split("/hostedzone/")[1]')"
  note "created the zone: $zone_id"
fi

name_servers="$(aws route53 get-hosted-zone --id "$zone_id" --query 'NameServers' --output text)"
note "name servers:"
for ns in $name_servers; do note "  $ns"; done

# --- 3. GitHub deploy roles -------------------------------------------------
# One role per stage. The trust policy only accepts a token minted for a job
# running in that stage's GitHub environment.

say "Creating the GitHub deploy roles"
role_stack="nalamdesk-github-deploy-$stage"
overrides=("GitHubRepo=$github_repo")

# The OIDC provider is a one-per-account resource: a second create fails.
if aws iam list-open-id-connect-providers --output text 2>/dev/null \
    | grep -q 'token.actions.githubusercontent.com'; then
  note "the account already has the GitHub OIDC provider; reusing it"
  overrides+=("CreateOidcProvider=false")
fi

aws cloudformation deploy --region "$region" --stack-name "$role_stack" \
  --template-file "$here/github-deploy-role.yaml" \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides "${overrides[@]}" \
  --no-fail-on-empty-changeset >/dev/null

# The template names one output per stage.
if [ "$stage" = "production" ]; then output_key=ProductionRoleArn; else output_key=SandboxRoleArn; fi
role_arn="$(aws cloudformation describe-stacks --region "$region" --stack-name "$role_stack" \
  --query "Stacks[0].Outputs[?OutputKey=='$output_key'].OutputValue" --output text)"
[ -n "$role_arn" ] && [ "$role_arn" != "None" ] || die "Could not read the deploy role ARN from $role_stack."

# --- 4. Parameter Store ----------------------------------------------------
# CloudFormation cannot create a SecureString, so these are made by hand, once
# per stage. The relay caches them for five minutes.

say "Creating the Parameter Store values"

put_param() { # name type value [overwrite]
  local name="$1" type="$2" value="$3" overwrite="${4:-}"
  if aws ssm get-parameter --region "$region" --name "$name" >/dev/null 2>&1; then
    if [ "$overwrite" = "overwrite" ]; then
      aws ssm put-parameter --region "$region" --name "$name" --type "$type" --value "$value" --overwrite >/dev/null
      note "updated $name"
    else
      note "kept $name (it already exists)"
    fi
  else
    aws ssm put-parameter --region "$region" --name "$name" --type "$type" --value "$value" >/dev/null
    note "created $name"
  fi
}

relay_prefix="/nalamdesk/$stage/relay"

# The ABDM client ID and secret come from NHA, so they are asked for here.
read -r -p "ABDM client ID for $stage (blank to skip): " abdm_client_id || true
read -r -s -p "ABDM client secret for $stage (blank to skip): " abdm_client_secret || true
printf '\n'

if [ -n "$abdm_client_id" ] && [ -n "$abdm_client_secret" ]; then
  put_param "$relay_prefix/abdm-client-id"     String       "$abdm_client_id"     overwrite
  put_param "$relay_prefix/abdm-client-secret" SecureString "$abdm_client_secret" overwrite
else
  note "skipped the ABDM credentials."
  note "the relay deploys but every ABDM call fails until they are set:"
  note "  aws ssm put-parameter --region $region --type String       --name $relay_prefix/abdm-client-id     --value '<id>'"
  note "  aws ssm put-parameter --region $region --type SecureString --name $relay_prefix/abdm-client-secret --value '<secret>'"
fi

# The pairing pepper is not overwritten: replacing it invalidates every
# pairing code that is still open.
put_param "$relay_prefix/pairing-pepper" SecureString "$(openssl rand -base64 48)"

# NalamBook's phone-limit key is never overwritten either: replacing it
# would reset every open-request count.
put_param "/nalamdesk/$stage/booking/phone-pepper" SecureString "$(openssl rand -base64 48)"

# --- 5. What to do next ----------------------------------------------------

say "Next steps"

cat <<EOF

1. At Cloudflare, delegate the zone to Route 53. In DNS, add these four NS
   records for '$zone' (DNS only, proxy off). This is the step that lets the
   ACM certificate validate and the CloudFront names resolve:

$(for ns in $name_servers; do printf '     %s\n' "$ns"; done)

   Until this is done, the bridge and booking domains do not resolve and the
   first deploy waits on the certificate.

2. Set the GitHub environment's secrets and variables:

     gh secret set AWS_DEPLOY_ROLE_ARN --env $stage --repo $github_repo <<< '$role_arn'
     gh secret set NALAMDESK_BUDGET_EMAIL --env $stage --repo $github_repo <<< '<your email>'
     gh variable set NALAMDESK_ZONE_NAME --env $stage --repo $github_repo --body '$zone'
     gh variable set NALAMDESK_HOSTED_ZONE_ID --env $stage --repo $github_repo --body '$zone_id'

   The budget email also receives the IoT alarm, so it must be an address
   you read. SNS sends a confirmation the first time; click it.

3. Run the first deploy by hand:

     gh workflow run deploy-cloud.yml --repo $github_repo -f stage=$stage -f stacks=all
     gh run watch --repo $github_repo

   The push to master does this on its own once the environment is set up.

4. After it finishes, set the bridge URL for the desktop releases and
   register it with NHA for the ABDM client ID:

     gh variable set NALAMDESK_RELAY_URL --repo $github_repo \\
       --body 'https://abdm-$stage.$zone'

   The URL is also in the job summary of the deploy run.

EOF

echo "Role ARN for the $stage environment: $role_arn"
echo "Hosted zone ID for the $stage environment: $zone_id"
