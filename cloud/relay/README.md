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
| `GET/POST /abdm/abha/...`, `/abdm/gateway/...` | Paired desktop | Device signature checked, `X-HIP-ID` must be the device's facility, path must be on the allowlist (`src/allowlist.ts`). The relay adds `Authorization`, `X-CM-ID` and `X-HIP-ID`/`X-HIU-ID`, forwards, and streams the response back. The vendor token never leaves the relay. |
| `POST /api/v3/...` | ABDM gateway | The callback JWT is verified against the gateway's published keys, the facility must be linked to the bridge, then headers and body are sealed to the clinic's X25519 key, stored in the mailbox, and the doorbell rings. `202` is sent only after the store succeeds, because ABDM does not resend an acknowledged callback. |
| `POST /hiu/data-push/:token` | An HIP | Fidelius ciphertext for an HIU request, routed by the opaque token in the clinic's data push URL and sealed byte for byte. |
| `GET /health` | Load balancer | Liveness. |

Logs hold metadata only (route, path, facility, status, timing); see `src/log.ts`.

## Sealing format

`src/seal.ts`: X25519 with a fresh ephemeral key per item, HKDF-SHA256 (`nalamdesk-mailbox-v1`),
AES-256-GCM, with `nalamdesk-mailbox-v1|<clinic ID>|<item type>` as associated data. The desktop's
mailbox reader (#155) must match `open()` in the same file.

## What is not wired yet

The relay depends on adapters owned by earlier iterations. They are interfaces in
`src/ports.ts` and test doubles in `test/helpers.ts`; `src/server.ts` refuses to start
until real ones are supplied.

| Port | Owner |
| --- | --- |
| `DeviceAuthenticator` (signature, clock window, nonce, rate limits) | #154 |
| `FacilityDirectory` (device registry, bridge links, data push tokens) | #153, #154 |
| `Mailbox`, `Doorbell` (48-hour sealed mailbox, IoT Core) | #155 |
| `VendorCredentials` | Done: `src/parameterStore.ts` reads two SSM Parameter Store parameters (SecureString for the secret). The Relay stack creates them after #153. |

Still to confirm with NHA during sandbox registration (#152): the v3 certificate URL and
issuer for callback JWTs, the ABHA host, and each allowlisted path.

## Commands

```sh
npm install
npm test          # vitest
npm run typecheck
npm run build     # dist/ for the Web Function revision
```

Environment variables for `src/server.ts`: `ABDM_ENV` (`sandbox` or `production`),
`ABDM_CLIENT_ID_PARAM` and `ABDM_CLIENT_SECRET_PARAM` (Parameter Store names),
optional `ABDM_GATEWAY_BASE_URL`, `ABDM_ABHA_BASE_URL`, `ABDM_GATEWAY_CERTS_URL`,
`ABDM_GATEWAY_ISSUER`, and `PORT`.
