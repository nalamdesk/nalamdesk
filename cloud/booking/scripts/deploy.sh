#!/usr/bin/env bash
# Deploys NalamBook (the online booking stack) to ap-south-1 with the current
# AWS profile. Deploy cloud/core for the same stage and zone first: it owns
# the hosted zone, the booking certificate and the code bucket.
#   scripts/deploy.sh <zoneName> [sandbox|production]
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
region=ap-south-1
zone="${1:?Pass the zone name, the same as cloud/core}"
stage="${2:-sandbox}"

# Phone-limit HMAC key: created once, never overwritten (that would reset every open-request count).
pepper_param="/nalamdesk/$stage/booking/phone-pepper"
if ! aws ssm get-parameter --region "$region" --name "$pepper_param" >/dev/null 2>&1; then
  aws ssm put-parameter --region "$region" --name "$pepper_param" --type SecureString \
    --value "$(openssl rand -base64 48)" >/dev/null
fi

# The CDK app bundles the API itself (infra/lib/bundle.ts) from api/src.
(cd "$here/api" && npm ci && npm test)
(cd "$here/web" && npm ci && npm test && npm run build)
(cd "$here/infra" && npm ci && npx cdk deploy --require-approval never \
  -c zoneName="$zone" -c stage="$stage" -c siteDir="$here/web/dist")
