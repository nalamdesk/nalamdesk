# Core stacks

Shared NalamDesk cloud resources (issue #153), used by the relay (`cloud/relay`) and the
booking stack (#156). Two CDK stacks per stage:

| Stack | Region | Resources |
| --- | --- | --- |
| `NalamdeskCoreEdge-<stage>` | us-east-1 | The imported Route 53 hosted zone (or one created here) and DNS-validated ACM certificates for the bridge and booking domains (CloudFront only accepts us-east-1 certificates) |
| `NalamdeskCore-<stage>` | ap-south-1 | DynamoDB tables for devices (indexes by HIP ID and data push token, point-in-time recovery, retained), pairing requests (24-hour TTL), nonces (5-minute TTL) and clinic IDs (one per HFR ID, retained); Cognito user pool for the ops console with TOTP MFA required, no self sign-up, an `ops` group, a public PKCE app client and a managed login domain (`nalamdesk-ops-<stage>`, or `-c opsDomainPrefix=...`); versioned SSE-S3 code bucket that Lambda can read; the 48-hour mailbox (#155): a table keyed by clinic and item with TTL, and a private bucket for large items with a 2-day lifecycle rule; the IoT Core device policy for the doorbell (connect as its own thing, receive only its clinic's topic, no publish), the IoT data endpoint, a presence table fed by IoT lifecycle events, and an alarm on refused IoT connections that emails the budget address; $10 monthly AWS Budget with email alerts; Parameter Store entries under `/nalamdesk/<stage>/core/` naming all of the above |

```sh
npm install
npm test
npx cdk bootstrap aws://<account>/ap-south-1 aws://<account>/us-east-1
npm run deploy -- -c zoneName=<zone> -c budgetEmail=<address> [-c stage=production] [-c hostedZoneId=<id>]
```

The zone name is a subdomain of the domain Cloudflare serves, so the zone is
delegated to Route 53 with NS records at Cloudflare. Create it by hand and
import it with `-c hostedZoneId`, as `cloud/deploy/setup-aws.sh` does: both
stages share one zone, so CloudFormation must not create it twice, and the
certificate cannot be validated until the delegation exists. If the zone is
created here instead, point the name's NS records at it before the
certificates can validate. The parameter names are mirrored in
`cloud/relay/infra/contract.ts` and `cloud/booking/infra/lib/contract.ts`.
Confirm the alarm's SNS email subscription after the first deploy.
