# ABDM relay

The zero-knowledge ABDM relay from the cloud relay plan (issue #159). It is the only
party ABDM knows: it holds the NalamDesk vendor Client ID and secret, forwards signed
desktop calls to the gateway, and seals gateway callbacks to the clinic's own key
before they touch storage. Clinic data stays on the desktop.

It is a plain [Hono](https://hono.dev) app, so the same code runs on a Lambda Web
Function (Node 24, arm64) and on a local Node server.

## Routes

| Route | Caller | What happens |
| --- | --- | --- |
| `GET/POST /abdm/abha/...`, `/abdm/gateway/...` | Paired desktop | Device signature checked (see `cloud/shared`), `X-HIP-ID` must be the device's facility, path must be on the allowlist (`src/allowlist.ts`). The relay adds `Authorization`, `X-CM-ID` and `X-HIP-ID`/`X-HIU-ID`, forwards, and streams the response back. The vendor token never leaves the relay. |
| `POST /api/v3/...` | ABDM gateway | The callback JWT is verified against the gateway's published keys, the facility must be linked to the bridge, then headers and body are sealed to the clinic's X25519 key, stored in the mailbox, and the doorbell rings. `202` is sent only after the store succeeds, because ABDM does not resend an acknowledged callback. |
| `POST /hiu/data-push/:token` | An HIP | Fidelius ciphertext for an HIU request, routed by the opaque token in the clinic's data push URL and sealed byte for byte. |
| `GET /health` | Load balancer | Liveness. |

Logs hold metadata only (route, path, facility, status, timing); see `src/log.ts`.

## Sealing format

`src/seal.ts`: X25519 with a fresh ephemeral key per item, HKDF-SHA256 (`nalamdesk-mailbox-v1`),
AES-256-GCM, with `nalamdesk-mailbox-v1|<clinic ID>|<item type>` as associated data. The desktop's
mailbox reader (#155) must match `open()` in the same file.

## Infrastructure (`infra/`)

`infra/relay-stack.ts` is a CDK stack in ap-south-1 that deploys everything the relay needs:

| Resource | Notes |
| --- | --- |
| `AWS::Lambda::WebFunction`, `WebFunctionRevision`, `WebFunctionEndpoint` | Node 24, HomeRegion endpoint with `IamAuth`, `MaxEnvironments` 2, 64 concurrent requests per environment, 30-second timeout, 100 requests a second |
| Code upload | `infra/bundle.ts` bundles `src/server.ts` to one `index.js`; it is uploaded to the Core code bucket and pinned by S3 version |
| IAM execution role | Reads the two Parameter Store values (with `kms:Decrypt` only via SSM), queries the device registry indexes, reads devices by ID, writes nonces, writes its log group |
| CloudWatch log group | `/aws/lambda/web/nalamdesk-abdm-relay-<stage>`, 30-day retention |
| CloudFront distribution | On `abdm.<zone>` (production) or `abdm-sandbox.<zone>`, TLS 1.2+, no caching, origin access control that signs every request (`always-amz-auth`, so ABDM's own `Authorization` JWT still reaches the relay) |
| `AWS::Lambda::ResourcePolicy` | Only that distribution may invoke the endpoint |
| Route 53 A and AAAA records | Bridge domain to CloudFront |

It reads the Core stack's names from Parameter Store (`/nalamdesk/<stage>/core/...`, see
`cloud/core`). CloudFormation cannot create a SecureString, so the vendor credentials are
created once by hand:

```sh
aws ssm put-parameter --region ap-south-1 --type String       --name /nalamdesk/sandbox/relay/abdm-client-id     --value <client id>
aws ssm put-parameter --region ap-south-1 --type SecureString --name /nalamdesk/sandbox/relay/abdm-client-secret --value <secret>
```

Deploy `cloud/core` first, then:

```sh
npm run deploy -- -c zoneName=<zone> [-c stage=production] [-c gatewayIssuer=<iss>]
```

Then register the `BridgeUrl` output for the Client ID (#159) and smoke-test `/health`, since
a revision can show Active while the app fails to start.

## What is not wired yet

Until every adapter exists the deployed revision serves a 503 holding app, and `/health`
names what is missing (`src/bootstrap.ts`). Interfaces are in `src/ports.ts`; test doubles
in `test/helpers.ts`.

| Port | Status |
| --- | --- |
| `VendorCredentials` | Done: `src/parameterStore.ts` |
| `FacilityDirectory` | Done: `src/dynamoFacilities.ts`, against the Core devices table |
| `DeviceAuthenticator` (signature, clock window, nonce, rate limits) | Done: `cloud/shared`, against the Core devices and nonces tables |
| `Mailbox`, `Doorbell` (48-hour sealed mailbox, IoT Core) | #155 |

Still to confirm with NHA during sandbox registration (#152): the v3 certificate URL and
issuer for callback JWTs, the ABHA host, and each allowlisted path.

## Commands

```sh
npm install
npm test          # app, adapters and stack assertions
npm run typecheck
npm run synth -- -c zoneName=example.in
npm start         # bundle and run locally on PORT or 127.0.0.1:8080
```

Runtime environment variables (set by the stack): `ABDM_ENV` (`sandbox` or `production`),
`ABDM_CLIENT_ID_PARAM`, `ABDM_CLIENT_SECRET_PARAM`, `DEVICES_TABLE`, `NONCES_TABLE`, optional
`ABDM_GATEWAY_BASE_URL`, `ABDM_ABHA_BASE_URL`, `ABDM_GATEWAY_CERTS_URL`, `ABDM_GATEWAY_ISSUER`.
The Web Function runtime supplies `AWS_LAMBDA_HTTP_ENDPOINT`, where the server listens.
