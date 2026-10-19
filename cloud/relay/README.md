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
| `POST /pairing/request`, `DELETE /pairing/request`, `POST /pairing/activate` | Desktop, before pairing | See [Pairing](#pairing). Bodies are signed by the install's new key; requests are rate limited per client IP. |
| `POST /device/rotate-key` | Paired desktop | Signed. Replaces the signing key, with proof from the new key; the old key stays valid for 10 minutes, and another rotation waits until then. |
| `GET /inbox`, `POST /inbox/ack` | Paired desktop | Signed. Lists the clinic's sealed mail, oldest first; acknowledging deletes it. See [Mailbox and doorbell](#mailbox-and-doorbell). |
| `POST /device/iot-certificate` | Paired desktop | Signed. Issues the doorbell certificate for a P-256 CSR and returns it with the IoT endpoint, client ID and topic. |
| `GET /ops/` | NalamDesk staff | The ops console page. |
| `/ops/api/*` | Ops console | Cognito access token from the ops pool, `ops` group: list, approve and reject pairing requests; list and revoke devices. |
| `GET /health` | Load balancer | Liveness. |

Logs hold metadata only (route, path, facility, status, timing); see `src/log.ts`.

## Pairing

`src/pairing.ts` (#154). Exactly one active desktop per clinic, bound to its HFR ID:

1. The desktop sends `POST /pairing/request` with the HFR ID (`IN` and ten digits), its Ed25519
   signing key and X25519 sealing key, a device name and app version, and an Ed25519 signature by
   the new key over `nalamdesk-pair-request-v1|hfrId|signingKey|sealingKey|label|appVersion|timestamp`.
   At most 5 requests per IP an hour and 20 a day; one pending request per HFR ID (`409 pending_exists`;
   a retry from the same install gets the same answer); requests lapse after 24 hours.
2. Staff check the facility in HFR, link it to the bridge in ABDM, and approve it in the ops
   console. Approval mints an 8-character code (Crockford base32), valid 15 minutes and stored only
   as `HMAC-SHA256(pepper, hfrId|requestId|code)`. Staff read it to the contact registered in HFR.
3. The desktop sends `POST /pairing/activate` with the code, signed by the same key over
   `nalamdesk-pair-activate-v1|hfrId|code|signingKey|sealingKey|timestamp` (the code as 8 characters,
   upper case, no dash). The signature is checked before the code, so only that install can spend
   attempts; 5 wrong codes void the request. One transaction creates the device, revokes any other
   active device for the HFR ID, points the clinic ID row at the new device (so two activations
   cannot both win), and deletes the request. The clinic ID stays the same for the HFR ID.
   If the answer is lost, the same signed activation returns the same device again.

The answer carries the device ID, clinic ID and the clinic's HIU data push URL. Timestamps must be
within 60 seconds (`401 clock_skew` returns the server time). The client IP comes from
`x-nd-viewer-ip`, which a CloudFront Function sets on every request.

**Staff accounts.** The ops pool has no self sign-up and requires TOTP MFA. Add a person with:

```sh
aws cognito-idp admin-create-user --region ap-south-1 --user-pool-id <pool> --username <email> --user-attributes Name=email,Value=<email> Name=email_verified,Value=true
aws cognito-idp admin-add-user-to-group --region ap-south-1 --user-pool-id <pool> --username <email> --group-name ops
```

They set a password and an authenticator app on first sign-in at `https://<bridge domain>/ops/`.

## Mailbox and doorbell

`cloud/shared/src/mailbox.ts` and `doorbell.ts` (#155), shared with the booking API.

- **Mailbox.** One DynamoDB row per sealed item, keyed by clinic ID and a time-ordered item ID.
  Items over 300 KB go to the mailbox bucket and the row keeps a pointer; `GET /inbox` returns
  those as presigned links valid 5 minutes. A listing holds at most 50 items and 3 MB inline, with
  `more: true` when another page waits; an acknowledgement takes at most 100 IDs. DynamoDB TTL and
  a 2-day bucket lifecycle rule drop anything left after 48 hours. When a device is replaced or
  revoked, mail stored before that moment is deleted, since only the old key could open it.
- **Doorbell.** After each store, an empty QoS 0 message on
  `nalamdesk/<stage>/clinic/<clinicId>/mail`. The desktop fetches on connect, every 30 minutes and
  on each ring, so a lost or forged ring costs one fetch at most.
- **Certificates.** Each paired device is an IoT thing named by its device ID, with its clinic ID as
  an attribute and one certificate made from a CSR, so the private key stays on the computer. The
  Core device policy lets it connect only with its thing name as client ID and subscribe only to
  its own clinic's topic; it cannot publish. A new certificate retires the old one, and
  revocation revokes and deletes them. Until that cleanup (and the mail purge) succeeds, the
  device row carries `cleanupPending`, set in the same write that revoked it; listing the HFR
  ID's devices, a later activation, or revoking again retries it. Each certificate is recorded in
  the device row's `iotCertArns` set, on condition that the device is still active, before it
  is attached; revocation reads that set consistently after marking the device revoked. A
  certificate request racing a revocation therefore either fails with `device_revoked` or has
  its certificate retired by the revocation.

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
| IAM execution role | Reads the three Parameter Store values (with `kms:Decrypt` only via SSM); reads, creates and updates devices; reads and writes pairing requests, clinic IDs and nonces; writes its log group |
| CloudWatch log group | `/aws/lambda/web/nalamdesk-abdm-relay-<stage>`, 30-day retention |
| CloudFront distribution | On `abdm.<zone>` (production) or `abdm-sandbox.<zone>`, TLS 1.2+, no caching, a viewer-request function that sets `x-nd-viewer-ip`, origin access control that signs every request (`always-amz-auth`, so ABDM's own `Authorization` JWT still reaches the relay) |
| `AWS::Lambda::ResourcePolicy` | Only that distribution may invoke the endpoint |
| Route 53 A and AAAA records | Bridge domain to CloudFront |

It reads the Core stack's names from Parameter Store (`/nalamdesk/<stage>/core/...`, see
`cloud/core`). CloudFormation cannot create a SecureString, so the vendor credentials and the
pairing-code pepper are created once by hand:

```sh
aws ssm put-parameter --region ap-south-1 --type String       --name /nalamdesk/sandbox/relay/abdm-client-id     --value <client id>
aws ssm put-parameter --region ap-south-1 --type SecureString --name /nalamdesk/sandbox/relay/abdm-client-secret --value <secret>
aws ssm put-parameter --region ap-south-1 --type SecureString --name /nalamdesk/sandbox/relay/pairing-pepper     --value "$(openssl rand -base64 48)"
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
| Pairing and the ops console | Done: `src/pairing.ts`, `src/dynamoPairing.ts`, `src/pairingRoutes.ts` |
| `Mailbox`, `Doorbell`, inbox and device certificates (#155) | Done: `src/mailboxAdapters.ts`, `src/iotCertificates.ts`, `src/inboxRoutes.ts`, on `cloud/shared` |

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
`ABDM_CLIENT_ID_PARAM`, `ABDM_CLIENT_SECRET_PARAM`, `DEVICES_TABLE`, `NONCES_TABLE`, `PAIRING_TABLE`,
`CLINIC_IDS_TABLE`, `PAIRING_PEPPER_PARAM`, `BRIDGE_URL`, `OPS_USER_POOL_ID`, `OPS_CLIENT_ID`, `OPS_AUTH_DOMAIN`,
`MAILBOX_TABLE`, `MAILBOX_BUCKET`, `IOT_DATA_ENDPOINT`, `IOT_POLICY_NAME`, `DOORBELL_TOPIC_PREFIX`, optional
`ABDM_GATEWAY_BASE_URL`, `ABDM_ABHA_BASE_URL`, `ABDM_GATEWAY_CERTS_URL`, `ABDM_GATEWAY_ISSUER`.
The Web Function runtime supplies `AWS_LAMBDA_HTTP_ENDPOINT`, where the server listens.
