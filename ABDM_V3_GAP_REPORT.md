# ABDM v3 Validation Report — NalamDesk (M1/M2/M3)

Scope: validate the current implementation against the ABDM v3 sandbox docs, the
Nirmitee v3 Postman collection, and the NHA functional test-case workbooks
(M1/M2/M3). M4 (NHCX) out of scope. Source-of-truth inputs: sandbox
`/sandbox/v3/new-documentation`, `Nirmitee-tech/abdm-v3-postman-collection`,
`sandboxcms.abdm.gov.in` test-case xlsx files.

## 0. Summary of top defects

1. **ABHA card fetch uses wrong path+method.** `AbdmAbhaService` calls
   `GET /v3/profile/account/abha-card`; ABDM v3 (Postman) expects
   `POST /v3/profile/account/getAbhaCard`. Also allowlist only permits the GET
   variant, so the live call is rejected before the vendor token is attached.
2. **ABHA enrollment paths do not match v3.** Service uses
   `enrol/byMobile` and `enrol/verify`; v3 uses `enrol/byAbdm` and
   `profile/login/verify`-style flows. `enrol/byAbdm` is never called.
3. **HIP callback paths are v0.5-era.** `HipService` handles
   `/api/v3/hip/token/on-generate-token` and `/api/v3/link/on_carecontext`,
   which are not in the v3 callback set; v3 uses token generation via
   `/v3/token/generate-token` and care-context linking via
   `/hip/v3/link/carecontext` + `/hip/v3/link/context/notify`. These handlers
   may never fire in v3, leaving HIP-initiated linking half-wired.
4. **Allowlist is missing v3 endpoints.** `/hip/v3/link/patient/links/sms/notify2`
   (M2), `GET /gateway/v3/bridge/getServices` (M2) are not allowlisted, so the
   desktop cannot reach them through the relay.
5. **HIU uses a non-v3 callback path.** `HIU_ON_REQUEST_PATH =
   /api/v3/hiu/health-information/on-request` is not part of the v3 inbound
   set; data pushes arrive at the relay data-push URL instead. Likely dead code.
6. **Scan-and-share reply shape.** `applyShare` posts to
   `/patient-share/v3/on-share` with an `acknowledgement` envelope; verify
   against the v3 schema (Postman marks this endpoint 403 in sandbox — known
   WSO2 issue). Implementation not validated live.
7. **No live verification of any path.** All paths carry "reconfirm against
   sandbox" TODOs (#152); the mock responder masks path drift, so defects only
   surface in production.

## 1. M1 — ABHA (AbdmAbhaService, AbdmRelayService)

| Area | Implementation | v3 expectation (Postman) | Status |
|---|---|---|---|
| Session token | relay `/abdm/abha/...` | `/gateway/v3/sessions` | OK via relay |
| Enrol OTP | `/v3/enrollment/request/otp` (GET allowlist) | `/v3/enrollment/request/otp` POST | Path OK, method differs (allowlist GET only) |
| Enrol by Aadhaar | `/v3/enrollment/enrol/byAadhaar` | `/v3/enrollment/enrol/byAadhaar` | OK |
| Enrol by ABDM | not implemented | `/v3/enrollment/enrol/byAbdm` | **GAP** |
| Enrol by mobile | `/v3/enrollment/enrol/byMobile` | not in v3 collection | **GAP / legacy** |
| Enrol verify | `/v3/enrollment/enrol/verify` | not in v3 collection | **GAP / legacy** |
| Login request OTP | `/v3/profile/login/request/otp` | `/v3/profile/login/request/otp` | OK |
| Login verify | `/v3/profile/login/verify` | `/v3/profile/login/verify` | OK |
| Account verify | `/v3/profile/account/verify` | not in v3 collection | Extra (allowlisted) |
| ABHA card | `GET /v3/profile/account/abha-card` | `POST /v3/profile/account/getAbhaCard` | **DEFECT** |
| Public cert | `GET /v3/profile/public/certificate` | (not in collection) | OK (allowlisted) |
| ABHA address suggestion | not implemented | `/v3/enrollment/enrol/suggestion` (GET), `/v3/enrollment/enrol/abha-address` (POST) | GAP (optional) |

Test-case workbook (M1) covers ABHA creation flows, login, card download, error
messages. Implementation covers enrolment/login/card but not `byAbdm` or
suggested-address selection. Improvements: add tests for `byAbdm` path and the
`getAbhaCard` contract; fix path before live run.

## 2. M2 — HIP (HipService, allowlist)

Inbound callbacks handled: discover, link init, link confirm, consent notify,
health-information request, patient share. All match v3 inbound paths. OK.

Outbound HIP calls:
| Call | Implementation | v3 (Postman) | Allowlisted | Status |
|---|---|---|---|---|
| on-discover | `/user-initiated-linking/v3/patient/care-context/on-discover` | same | yes | OK |
| on-init | `/user-initiated-linking/v3/link/care-context/on-init` | same | yes | OK |
| on-confirm | `/user-initiated-linking/v3/link/care-context/on-confirm` | same | yes | OK |
| consent on-notify | `/consent/v3/request/hip/on-notify` | same | yes | OK |
| health-info on-request | `/data-flow/v3/health-information/hip/on-request` | same | yes | OK |
| health-info notify | `/data-flow/v3/health-information/notify` | same | yes | OK |
| patient-share on-share | `/patient-share/v3/on-share` | same | yes (M1) | OK |
| generate-token | `/v3/token/generate-token` | same | yes | OK |
| link carecontext | `/hip/v3/link/carecontext` | same | yes | OK |
| link context notify | `/hip/v3/link/context/notify` | same | yes | OK |
| link sms notify2 | not implemented | `/hip/v3/link/patient/links/sms/notify2` | **GAP (not allowlisted)** |
| bridge getServices | not implemented | `GET /gateway/v3/bridge/getServices` | **GAP (not allowlisted)** |
| bridge url (PATCH) | not implemented | `PATCH /gateway/v3/bridge/url` | Intentionally excluded (admin) |

Legacy/v0.5 handlers present in `HipService.applyCallback`:
- `/api/v3/hip/token/on-generate-token`
- `/api/v3/link/on_carecontext`

These do not appear in the v3 callback set. In v3 the token result arrives via
the generate-token flow and care-context linking via on-init/on-confirm. These
handlers are likely dead code and their paths are not allowlisted as outbound
(they are inbound-only anyway). **Defect risk:** if the gateway still posts to
these paths, the relay seals them and `HipService.applyCallback` handles them;
but if v3 uses different callback paths, linking silently never completes.
Action: confirm callback path names against the live sandbox and either remove
or rename.

Data transfer (Fidelius): implementation pushes one page per care context with
MD5 checksum, HTTPS-only public host, 30s timeout. Matches v3 shape
(`{ transactionId, keyMaterial, entries }`). OK. Max 100 records per push
enforced in mailbox processor. OK.

## 3. M3 — HIU (HiuService, AbdmMailboxProcessor)

Inbound callbacks handled: on-init, on-fetch, on-request (HIU), consent notify.
v3 inbound set: on-init, on-status, on-fetch, consent/request/notify. The
`/api/v3/hiu/consent/request/on-status` callback is **not handled** in
`HiuService.applyCallback` (only on-init, on-fetch, on-request). Status updates
arrive through the consent notify path instead — verify this is sufficient.
`HIU_ON_REQUEST_PATH` (`/api/v3/hiu/health-information/on-request`) is not in
the v3 inbound set; likely dead code.

Outbound HIU calls:
| Call | Implementation | v3 | Allowlisted | Status |
|---|---|---|---|---|
| consent init | `/consent/v3/request/init` | same | yes | OK |
| consent status | not called (uses notify) | `/consent/v3/request/status` | yes | GAP (optional) |
| consent fetch | `/consent/v3/fetch` | same | yes | OK |
| data-flow request | `/data-flow/v3/health-information/request` | same | yes | OK |
| data-flow notify | not implemented (HIP only) | `/data-flow/v3/health-information/notify` | yes | N/A (HIU is requester) |

Consent notification handling: `CONSENT_KINDS` maps GRANTED/DENIED/EXPIRED/
REVOKED → kinds. v3 notify may also carry `data-ready` (HIU side); handled via
mailbox `receiveInboxCallback`. OK.

Data-push decryption: supports both `{ requestId, records }` and
`{ transactionId, keyMaterial, entries }`. Max 100 records. Consent-gated
storage enforced. OK.

Retention: 30 days (MOCK_RETENTION_DAYS). Verify against v3 docs (may be
configurable). Minor.

## 4. Cross-cutting (relay, mailbox, FHIR)

- Relay allowlist: see gaps in sections 1–3. Additionally `method` field only
  allows GET/POST; v3 uses PATCH for `/gateway/v3/bridge/url` (intentionally
  excluded).
- Callback path validation: `CALLBACK_PATH = /^\/api\/v3(\/[A-Za-z0-9._-]+){1,8}$/`
  allows up to 8 segments; v3 paths fit. OK.
- FHIR serializer: HPR/HFR system URLs marked "reconfirm against ABDM docs".
  OPConsultRecord + IPS builders. Validate identifier systems against current
  ABDM docs (known TODO).
- Mailbox processor: idempotency via `abdmMailboxRequestSeen` (request-id
  dedupe). OK. No retry on failure (by design). OK.
- Scan-and-share token expiry 15 min. OK.

## 5. Test-suite improvements

Existing tests: `AbdmAbhaService.spec.ts`, `HipService.spec.ts`,
`HiuService.spec.ts`, `AbdmMailboxProcessor.spec.ts`, `AbdmInbox.spec.ts`,
`AbdmRelayService.spec.ts`, `FideliusService.spec.ts`, `fhir/*.spec.ts`.
Gaps to add:
- Path/method contract tests asserting each service call matches the v3
  Postman path (catches drift like the abha-card defect).
- Negative tests for allowlist: ensure non-allowlisted paths (e.g.
  bridge admin) are refused by `resolveRoute`.
- M1: tests for `enrol/byAbdm`, suggested ABHA address, card fetch via
  `getAbhaCard`.
- M2: tests for HIP-initiated linking SMS notify, bridge getServices.
- M3: test for on-status callback handling; consent status endpoint.
- Integration-style tests using the Postman collection payloads as fixtures
  (request/response shapes) to validate parsing.
- FHIR: validate generated bundles against ABDM's FHIR validator (external).

## 6. Recommended next actions

1. Fix `AbdmAbhaService` paths: `abha-card` → `getAbhaCard` (POST), add
   `enrol/byAbdm`, drop or gate `byMobile`/`enrol/verify` unless confirmed.
2. Reconfirm and, if needed, rename `HipService`'s legacy callback paths.
3. Add missing allowlist entries or document why excluded.
4. Handle `/api/v3/hiu/consent/request/on-status` or confirm notify covers it.
5. Add path-contract tests to prevent future drift.
6. Run against sandbox with real credentials to close #152.
