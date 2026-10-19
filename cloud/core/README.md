# Core stacks

Shared NalamDesk cloud resources (issue #153), used by the relay (`cloud/relay`) and the
booking stack (#156). Two CDK stacks per stage:

| Stack | Region | Resources |
| --- | --- | --- |
| `NalamdeskCoreEdge-<stage>` | us-east-1 | Route 53 hosted zone (or an imported one) and DNS-validated ACM certificates for the bridge and booking domains (CloudFront only accepts us-east-1 certificates) |
| `NalamdeskCore-<stage>` | ap-south-1 | DynamoDB tables for devices (indexes by HIP ID and data push token, point-in-time recovery, retained), pairing requests (24-hour TTL) and nonces (5-minute TTL); Cognito user pool for the ops console with TOTP MFA required, no self sign-up and an `ops` group; versioned SSE-S3 code bucket that Lambda can read; $10 monthly AWS Budget with email alerts; Parameter Store entries under `/nalamdesk/<stage>/core/` naming all of the above |

```sh
npm install
npm test
npx cdk bootstrap aws://<account>/ap-south-1 aws://<account>/us-east-1
npm run deploy -- -c zoneName=<zone> -c budgetEmail=<address> [-c stage=production] [-c hostedZoneId=<id>]
```

If the zone is created here, point the domain's NS records at it before the certificates
can validate. The parameter names are mirrored in `cloud/relay/infra/contract.ts`.
