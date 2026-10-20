# Online booking (NalamBook)

NalamBook, "by NalamDesk", is the patient-facing name of this site; clinics keep using NalamDesk.

The public booking stack from the cloud relay plan (Milestone G, iteration 3: #156, #157, #158).
Patients find a clinic, pick a time or ask for a call back, and send their name, phone and
reason. The browser seals those details to the clinic's X25519 key before anything leaves the
device, so the cloud only ever stores ciphertext, for at most 48 hours, in the shared mailbox.

| Folder | What it is |
| --- | --- |
| `api/` | Hono app for a Lambda Web Function: directory, slots, `POST /api/book`, status, signed clinic routes. |
| `web/` | React + Vite + Tailwind site, served from S3 through CloudFront. Design rules in `web/DESIGN.md`. |
| `infra/` | CDK app (ap-south-1): site bucket, CloudFront on `book.<zone>`, the API Web Function, DynamoDB tables. |
| `scripts/deploy.sh` | Creates the phone pepper once, tests and builds, deploys. |

Shared resources come from `cloud/core` (#153) through Parameter Store, under
`/nalamdesk/<stage>/core/`: the hosted zone, the `book` certificate and the versioned code bucket.
The names are mirrored in `infra/lib/contract.ts`. The site is `book.<zone>` in production and
`book-sandbox.<zone>` in sandbox.

The desktop side lives in `desktop/src/main/booking/BookingInboxService.ts` (#158).

## API

| Route | Caller | Notes |
| --- | --- | --- |
| `GET /api/clinics` | Public | Listed clinics with Online/Offline and sealing key. Cached 30 s at CloudFront. |
| `GET /api/slots/:clinicId` | Public | Open slots for the next 14 days (IST). Cached 30 s. |
| `POST /api/book` | Public | `{clinicId, ref, slotId \| null, phoneDigest, sealed, sealedTo}`. `sealedTo` is the key the browser sealed to: a stale one gets `409 clinic_key_changed` with the current key, and a listing whose computer was replaced gets `503 clinic_unavailable` until the new one lists the clinic again. Conditional slot hold, sealed item to the mailbox, doorbell. Rate-limited at the edge. |
| `GET /api/booking/:ref` | Public | `Requested`, `Accepted` or `Declined`, and the clinic name. Nothing else. |
| `PUT/DELETE /api/clinic/listing` | Paired desktop | Signed (`cloud/shared`, audience `booking`). Turns the listing on with name, city, specialty and sealing key, or off. |
| `PUT/GET /api/clinic/slots` | Paired desktop | Signed. Replaces open slots on given dates; held and booked slots stay. |
| `POST /api/clinic/bookings/:ref/decision` | Paired desktop | Signed. `accepted` books the slot, `declined` releases it. |

**What the cloud keeps.** Clinics (name, city, specialty, public key, presence), slots
(date, time, state, the holding reference) and a status record per request (reference, clinic,
slot, status, and a keyed hash of a browser-side phone digest, dropped once the clinic decides).
The sealed request itself goes to the shared 48-hour mailbox.

**Phone limit.** At most 2 open requests per phone per clinic. The browser sends
`SHA-256("nalamdesk-booking-phone-v1|" + number)`; the API stores only an HMAC of that under a
pepper from Parameter Store (`/nalamdesk/<stage>/booking/phone-pepper`). A ten-digit number space is small, so this is a rate-limit key, not
a secret, and a scripted client can send random digests. The CloudFront rate rule is the
backstop.

**Concurrency.** A slot hold is a DynamoDB conditional update (`available`, or `held` with a
lapsed hold), so of two concurrent bookings for one slot exactly one wins; the other gets `409
slot_taken`.

## Sealing format

Identical to `cloud/relay/src/seal.ts`: X25519 with a fresh ephemeral key, HKDF-SHA256
(`nalamdesk-mailbox-v1`), AES-256-GCM, associated data `nalamdesk-mailbox-v1|<clinic ID>|booking-request`.
The browser uses WebCrypto X25519 and falls back to `@noble/curves` for the key agreement on
browsers without it (smaller than libsodium; HKDF and AES-GCM stay in WebCrypto). The sealed
payload is `{v: 1, ref, clinicId, slotId, slot, name, phone, reason, sentAt}`.

## Site hardening

Hashed, immutable assets; Subresource Integrity on every script and stylesheet (`vite.config.ts`);
self-hosted fonts; CSP `default-src 'none'` with only `'self'` sources (`infra/lib/booking-stack.ts`);
HSTS, `X-Frame-Options: DENY`, no referrer. The patient still trusts the JavaScript NalamDesk
serves; these make silent tampering hard, not impossible.

## Deploy notes

The API puts each sealed request in the Core mailbox and rings the clinic's doorbell
(`cloud/shared`, #155); until the Core names reach it, `api/src/server.ts` serves a 503 holding app
whose `/api/health` names what is missing. A paired desktop signs its calls (#154) and
`BookingInboxService` uses the X25519 key created at pairing.

**CloudFront rate rule.** The Free flat-rate plan includes WAF rate limiting but is not set
through CloudFormation. After the first deploy, subscribe the distribution to the Free plan and
add one rate-based rule: path starts with `/api/book`, 10 requests per IP per 5 minutes, block.

**To confirm on the first deploy** (the Web Function CloudFormation resources are new): the
`IamAuth` and `HomeRegion` values, the `nodejs24.x` runtime string, the execution role's trust
principal, and that a CloudFront origin access control of type `lambda` can sign requests to a Web
Function endpoint. The relay stack (`cloud/relay/infra`) makes the same assumptions and the API is
bundled the same way: one CommonJS `index.js` that listens on `AWS_LAMBDA_HTTP_ENDPOINT`.

## Commands

```sh
cd api && npm install && npm test && npm run dev   # in-memory API on :8787 with two demo clinics
cd web && npm install && npm test && npm run dev   # site on :5173, proxies /api to :8787
cd web && npm run lint:design                       # Impeccable anti-pattern scan
cd infra && npm install && npm test && npx cdk synth -c zoneName=example.in   # needs api/node_modules
scripts/deploy.sh <zone> [sandbox|production]       # after cloud/core; needs AWS credentials
```
