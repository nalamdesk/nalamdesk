# AGENTS.md — Instructions for AI coding agents

## ABDM v3: official sources only

All ABDM integration work (M1 ABHA, M2 HIP, M3 HIU) must validate against the
**official ABDM sandbox sources**. Never use third-party Postman collections,
blogs, or forum snippets as ground truth for endpoint paths, methods, or
payload shapes — they have been wrong before (e.g. a fictitious
`POST /v3/profile/account/getAbhaCard` and `enrol/byMobile` routes).

### Canonical sources (fetch these first, every time)

1. **Docs hub:** https://sandbox.abdm.gov.in/sandbox/v3/new-documentation
   - **V3 Documentation** tab — official M1 / M2 / M3 integration PDFs/DOCXs,
     scan-and-share docs, running-token docs, M1 API mapping doc.
   - **Swagger** tab — complete swagger for ABHA Number APIs, HIP APIs,
     HIU APIs, PHR APIs, ABHA Address APIs, HIE-CM APIs.
   - **Postman Collection** tab — official collections (M1 v3, scan-and-share,
     running-token, face-auth).
   - **Test Cases** tab — official NHA functional test-case workbooks.
2. **Direct CMS links** (same files as the hub; stable URLs):
   - M1 v3 doc: https://sandboxcms.abdm.gov.in/uploads/ABDM_ABHA_V3_AP_Is_V1_31_07_2025_869ab8cda9.pdf
   - M2 doc: https://sandboxcms.abdm.gov.in/uploads/M2_Document_16_02_2026_11822aedc7.docx
   - M3 doc: https://sandboxcms.abdm.gov.in/uploads/M3_Dcoument_16_02_2026_2319bac7bf.docx
   - Scan-and-share: https://sandboxcms.abdm.gov.in/uploads/Scan_and_share_Document_03_03_25_8c48f696e0.pdf
   - Running token: https://sandboxcms.abdm.gov.in/uploads/Running_Token_Status_Documentation_6a55ffc7f4.pdf
   - Official Postman bundle: https://sandboxcms.abdm.gov.in/uploads/Postman_Collection_e7773f400f.zip
3. **Menu API** (to discover current doc page URLs):
   `https://sandboxcms.abdm.gov.in/api/newmenus?sort[1]=orderID:asc&populate=deep`

### Strict v3 rules

- v3 only across M1/M2/M3. No v0.5, v1, v2, or invented routes.
- Every new/changed endpoint needs: (a) official doc or collection citation,
  (b) exact METHOD + path in code, (c) matching `cloud/relay/src/allowlist.ts`
  entry, (d) positive + negative cases in `cloud/relay/test/allowlist.spec.ts`.
- The relay allowlist must contain zero dead permissions — every rule needs a
  sender in `desktop/src` or `cloud/relay/src`.
- The sandbox site is sometimes slow/flaky (504s). Retry, or fall back to the
  direct `sandboxcms.abdm.gov.in` file URLs above.

### Local reference copies (optional, gitignored)

Contributors may keep downloaded official docs under `docs/abdm-official/`
(local only, never committed). That folder is gitignored.
