# Cloud shared code

Code the ABDM relay (`cloud/relay`) and the booking API (`cloud/booking/api`) share, so both
check a desktop the same way. Both depend on it as `"@nalamdesk/cloud-shared": "file:../shared"`
and import its TypeScript sources directly; esbuild bundles it into each Web Function.

## Signed device requests (#154)

Every call from a paired desktop carries four headers and an Ed25519 signature:

| Header | Value |
| --- | --- |
| `X-ND-Device` | Device ID from pairing |
| `X-ND-Timestamp` | Epoch milliseconds |
| `X-ND-Nonce` | 16 random bytes, base64url |
| `X-ND-Signature` | Ed25519 over the canonical string, base64url |

The canonical string is these lines joined by `\n` (`src/signing.ts`):

```
nalamdesk-req-v1
<audience: relay | booking>
<METHOD>
<path>?<query as sent>      (just <path> when there is no query)
<hex SHA-256 of the body>
<timestamp>
<nonce>
<X-HIP-ID, or empty>
```

The audience is a fixed name rather than the Host header, because CloudFront rewrites Host on
the way to a Web Function; it stops a request signed for one service being replayed at the other.
`test/vectors.json` pins the string and signatures (RFC 8032 test key) so the desktop signer can
run the same vectors.

`createDeviceAuthenticator()` checks, cheapest first so junk never costs a write:

1. Header shape, else `401 unsigned`.
2. Timestamp within 60 seconds, else `401 clock_skew` with the server time, so the desktop can
   correct its offset and retry once.
3. Device row by ID (cached 30 seconds), `active`, else `401 device_unknown` or `device_revoked`.
4. Signature, with the current key or, until `previousKeyValidUntil`, the key before the last
   rotation, else `401 bad_signature`.
5. Per-device rate limit, in memory per environment (20 a second, burst 60), else `429 rate_limited`.
6. Nonce: a conditional put of `<deviceId>#<nonce>` with a 5-minute TTL, else `401 replay`.

Each app still checks the facility (`X-HIP-ID`) and its own path rules after this.

## Commands

```sh
npm install
npm test
npm run typecheck
```

The apps resolve this package through a symlink with `preserveSymlinks` (TypeScript, Vitest
and esbuild), so its imports, such as `@aws-sdk/client-dynamodb`, come from the app's own
`node_modules`. It lists them as peer dependencies for that reason.
