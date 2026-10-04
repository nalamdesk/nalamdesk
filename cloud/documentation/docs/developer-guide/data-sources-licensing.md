# Catalog Data Sources & Licensing

How clinical catalog content (medicines, conditions, codes) enters NalamDesk,
and the license rules that keep an AGPL app distributed worldwide compliant.

## Source map

| Source | What we take | License | How |
|---|---|---|---|
| NLEM 2022 (MoHFW) | 384 generic names | Free govt PDF; names are facts | `desktop/scripts/extract_nlem.py` → `nlem2022.seeds.ts` |
| WHO EML 2025 (24th list) | Cross-check generics | CC BY-NC-SA 3.0 IGO | Manual reference |
| ICD-10 (common OP codes) | ~58 short codes | WHO license required for software distribution | Filed/pending; see below |
| ICD-11 MMS | 58 mapped codes + URIs | CC BY-ND 3.0 IGO (free incl. commercial) | `desktop/scripts/map_icd11.py` (annual) |
| SNOMED CT | Nothing vendored | Affiliate License mandatory (free in India via NRCeS) | Live BHTS queries only |
| Indian brand names | Hand-curated examples | No official feed exists | Curated in migration seeds |

NLEM 2022 is the latest notified list (CDSCO lists only 2022 and 2015).
A revision is publicly demanded but not published as of Oct 2026.

## Hard rules

1. **No licensed bulk content in the repo.** No SNOMED release files,
   no WHO ICD CSV dumps. Ever.
2. **Codes ship with URIs + citation.** CC BY-ND requires ICD-11 codes to
   travel with their URIs and WHO attribution. Never store a bare code.
3. **Facts only in seeds.** Short generic names and common code mappings
   are factual entries, each carrying its source citation.
4. **NULL means unmapped.** `snomed_*` and unmapped `icd11_*` columns stay
   NULL rather than carrying guessed codes. Wrong medical codes are worse
   than missing ones.
5. **Never hand-write medical codes.** All code mappings come from the
   scripts below, reviewed as data PRs.

## WHO ICD API key handling

The key is a free access credential (rate limiting), not a purchase. It is
needed only for the annual mapping run -- never at clinic runtime.

- Local runs: `WHO_ICD_CLIENT_ID` / `WHO_ICD_CLIENT_SECRET` in `.env`
  (gitignored). The script reads env only.
- CI: GitHub repo secret, consumed solely by the manually-dispatched
  seed-refresh workflow -- never per-PR builds.
- Never in source, the Electron bundle, the database, logs, or audit
  trails. Rotate immediately if exposed (free, same portal).

Get a key: register at `https://icd.who.int/icdapi` (free, ~2 minutes).

## Annual refresh

1. Run `map_icd11.py conditions.txt` with the current ICD release.
2. Diff the output; review every changed code as a data change.
3. Paste curated mappings into `SEED_CONDITIONS`; the migration's
   stamp-pattern (`UPDATE ... WHERE icd11_code IS NULL`) applies them.
4. Record the release (e.g. `2025-01`) in the seed header comment.
5. Re-run `extract_nlem.py` only when MoHFW notifies a new NLEM.

Seeds are the offline core for version-stamped releases; anything beyond
them resolves live when connected (see BHTS below).

## SNOMED CT via NRCeS

- **Affiliate License (mandatory even though free in India):**
  register at `mlds.ihtsdotools.org` → landing `/IN`, activate the
  account, accept the agreement, request access; download link in
  4-5 business days. Help: `nrc-help@cdac.in`, `nrces.in`.
- **Scope:** an NRCeS license covers use within India. Distribution or
  use abroad needs per-country licenses -- incompatible with blind
  global AGPL distribution, so SNOMED features stay gated/BYO-license
  outside India.
- **BHTS public API** (`nrces.in/bhts/api/v1/ts/fhir`): keyless Snowstorm
  FHIR -- `$lookup`, `$translate` (SNOMED→ICD-10), `$expand` all verified
  working. Fine for live queries; confirm terms before production-scale
  traffic, and never persist answers into shipped seeds (that is
  redistribution).

## Decision log

- **ICD-11 first:** free license, PM-JAY precedent (live in all states
  since Apr 2022), offline container available. ICD-10 seeds retained per
  issue #56 and EHR Standards 2016.
- **SNOMED deferred:** no current use case (drug/allergy/procedure coding);
  columns reserved, BHTS covers live lookup.
- **Brands curated:** no official brand↔generic feed exists; hand list
  stays, clearly labeled.
