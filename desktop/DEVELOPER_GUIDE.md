# Developer Guide (Desktop)

## Setup
1.  **Prerequisites**: Node.js (v18+), python (for build tools), Visual Studio Build Tools (for native modules like `better-sqlite3`).
2.  **Install Dependencies**:
    ```bash
    cd desktop
    npm install
    ```

## Running Locally
```bash
npm start
```
This will:
1.  Start the Angular Dev Server (`ng serve`).
2.  Wait for port 4200.
3.  Launch Electron (`src/main/main.ts`).
4.  Launch the embedded Local Server (`src/server/app.ts`).

## Database
- **Development**: The database is located at `desktop/nalamdesk.db`.
- **Production**: `%APPDATA%\NalamDesk\nalamdesk.db`.
- **Tools**: Use `SQLite Viewer` extension or `DBeaver` to inspect `nalamdesk.db`.

## Authentication session boundary
- Renderer login calls `auth:login`, which sets `SessionService` in the main process.
- Renderer logout must call `auth:logout`, which runs `SessionService.clearSession()`. If that IPC fails, the renderer must not clear local storage or navigate.
- Protected IPC is gated on that main-process principal. After logout those handlers fail with `Unauthorized` until a new login.
- Logout does **not** invent a second `closeDb` / restore-fence path. The device vault stays on the existing unlock contract; only the user principal is cleared.
- Reloading the window after logout must not restore the prior role: the principal is in-memory only, and the renderer lands on `/#/login`.

## Linux vault encryption
- At process start, main calls `preferLinuxGnomeLibsecret(app.commandLine)` so Electron OSCrypt uses `gnome-libsecret` without a user-facing CLI flag.
- `ElectronSafeStorageDeviceKeyStore` still rejects `basic_text` (`INSECURE_LINUX_BACKEND`).
- If encryption is still unavailable, setup/login surfaces `ENCRYPTION_UNAVAILABLE` naming gnome-libsecret / `libsecret-1-0` / gnome-keyring. There is no second crypto stack.

## Application version
- Settings reads a single IPC, `app:getVersion`, backed by packaged `app.getVersion()` plus `build-identity.json` (commit / CI run id when stamped).
- Development builds append `(development)` to the displayed version.
- `npm run build` stamps `desktop/build-identity.json`. Feature CI asserts artifact names, electron-builder `latest*.yml`, identity, and displayed version agree (`npm run assert:packaged-version`).

## In-app updates (#43)
Packaged Electron only (`app.isPackaged`). Unpackaged `npm start` skips the updater.

### Interim feed (this PR)
- Provider: **generic** via `NALAMDESK_UPDATE_FEED_URL` (HTTPS directory that serves `latest.yml` / `latest-mac.yml` / `latest-linux.yml` plus the OS packages those files name). Plain HTTP is rejected except `localhost` / `127.0.0.1`.
- Ops copies **approved** builds onto that feed. Feature CI PR zips and random Actions artifacts are not an update channel. Automated Release / public GitHub Releases are not required here.
- Optional: `NALAMDESK_UPDATE_DOWNLOAD_PAGE` (Linux `.deb` fallback opens this URL).

### GitHub provider seam (later PR)
Set `NALAMDESK_UPDATE_PROVIDER=github` (optional `NALAMDESK_UPDATE_GITHUB_OWNER` / `NALAMDESK_UPDATE_GITHUB_REPO`). IPC (`updates:check|download|install|cancel|status` + `updates:event`) and Settings/launch UX stay the same.

### OS apply paths
| OS | Packaged form | In-app apply |
| --- | --- | --- |
| Windows | NSIS | `electron-updater` `quitAndInstall` |
| macOS | DMG | `electron-updater` `quitAndInstall` |
| Linux | AppImage | `electron-updater` `quitAndInstall` |
| Linux | `.deb` (clinic first-install) | **Open download page** if the running process is not an AppImage, or if the feed has no AppImage. No apt repo. |

Unsigned / checksum-only feeds must not claim full code-signature verification in the UI. `NALAMDESK_UPDATE_RELEASE_SIGNED=1` is a later-PR seam only; this build always reports checksum-only integrity until the updater returns a real verification result.

The updater never wipes, moves, or re-encrypts `userData` / the vault.

## Visit catalogs (#46)
One SQLite migration (`condition_catalog`, `medicine_catalog`, `condition_med_presets`). Visit writes stay denormalized `diagnosis` TEXT + `prescription_json`. IPC extends existing `db:*` / `invokeDbMethod` (Electron and HTTP `/api/ipc`). Doctor/admin can search and Add new during a visit; Settings catalog maintenance is admin-only.

## Clinical Safety, Practitioner Provenance & Actionable Triage (#11, #15, #17, #53)
Migration v11 adds longitudinal records and triage tracking:
- **Practitioner Provenance (`encounters.doctor_id`):** Every consultation requires an active doctor with a valid license (`doctor_license_json`). Delegated authoring (e.g., triage intake by staff) captures both the responsible `doctor_id` and the `author_id`.
- **Longitudinal Safety Profile:**
  - `patient_allergies`: tracks substances, verification status, severity, and reactions.
  - `patient_conditions`: problem list with onset dates, clinical statuses, and ICD-10 codes.
  - `patient_medications`: reconciled active medications.
  - Prescriptions conflicting with active allergies require an explicit clinical override reason (`allergy_override_reason`).
- **Actionable Triage:**
  - `patient_queue.urgency`: 4-tier urgency level (`immediate`, `urgent`, `priority`, `routine`).
  - `queue_triage_history`: audit trail capturing prior/new urgency, required clinical reason, and assessor ID.
  - Queue items preserve triage audit records even after deletion.
- **Physiological Vitals Validation:**
  - Evaluates LOINC/UCUM ranges with unit conversions (°F / °C, kg / lbs).
  - Flags abnormal vitals (hypothermia, fever, hypoxia, tachycardia/bradycardia, hypertension/hypotension) directly in queue queries.

## ABDM Scan & Share callbacks (#60)

The local Fastify server exposes an unauthenticated gateway callback:

- `POST /abdm/v0.5/patients/profile/share` validates the profile shape and stores
  it as a numbered `abdm_share_tokens` row (daily sequence, 15-minute expiry).
  Nothing executes from the payload; the Queue dock picks it up on its 5s poll.
- The callback is gateway-initiated and therefore unauthenticated: it accepts
  a strict shape (name required, capped field lengths, 8 KB body cap) at
  30 requests/minute per source IP, and intake still needs an explicit human
  accept before any patient record is created. Treat tunnel URLs as sensitive
  and rotate them if they leak.
- The counter QR encodes `{ app: 'NalamDesk Scan & Share', v: 1, hipId, counterId }`
  (facility identity only, no patient data). Configure HIP/counter IDs under
  Settings → ABDM, download the QR image, and display the printout at reception.

Clinic PCs sit behind NAT, so sandbox callbacks cannot reach `localhost`
directly. For certification, expose the local API port through a tunnel:

```bash
# Example: Cloudflare Tunnel (quick tunnel, no account needed for sandbox)
cloudflared tunnel --url http://127.0.0.1:3002
# Alternative: ngrok http 3002
# Register the printed https://<tunnel> URL as the callback base with ABDM.
```

Use a tunnel only for sandbox testing. Production callbacks must terminate on
infrastructure the clinic controls, never on a developer laptop.

## ABDM M2: HIP registry, care contexts, inbox, Fidelius transfer (#57, #61–#64)

M2 makes the desktop a Health Information Provider (HIP) on top of the M1
intake track. Schema arrives in migrations v19–v24 (v19 facility/practitioner
registry, v20 care-context linking + callback inbox, v21 inbox LAN grants,
v22 transfer endpoint + recipient key, v23 transfer grants + callback secret +
per-doctor registry, v24 monotonic care-context sequence).

- **Registry identity (#57):** `settings` carries `abdm_hip_id`,
  `abdm_counter_id`, `abdm_hfr_id`, `abdm_hip_endpoint`,
  `abdm_recipient_key`, `abdm_callback_secret`, plus per-user
  `abdm_hpr_id`. Profile edits that omit registry IDs must not wipe them
  (clearing goes through an explicit empty string); covered in
  `ClinicalSafety.spec` ("preserves per-doctor registry IDs").
- **FHIR foundation (#61, #62):** zero-dependency FHIR R4 types plus NRCeS
  profile constants in `src/shared/fhir/`. `serializer.ts` builds two
  documents from one encounter: the ABDM OPConsultRecord (ordered sections:
  Complaints → Observations → Diagnosis → Prescription → Advice) and the
  HL7 IPS (LOINC-coded sections). Live reconfirm TODOs mark the HPR/HFR
  identifier system URLs — check them against current ABDM docs before
  certification, don't guess.
- **Care contexts + inbox (#63):** encounters get `OP-YYYY-XXXX` refs from
  the `care_context_seq` counter (never reused after deletes).
  `POST /abdm/v0.5/callbacks/:kind` queues gateway callbacks; the desk
  acknowledges each exactly once (`abdmGetInbox` / `abdmAckInbox`; nurses
  read-only). Callback shape is strict and, once a callback secret is set,
  requests without it are rejected (open acceptance before that is for
  sandbox testing only).
- **Fidelius transfer (#64):** `FideliusService` does ECDH Curve25519
  direct data-push (`abdmTransferBundle`): fresh ephemeral key per
  transfer, tamper-rejecting envelopes, bounded timeouts. No endpoint
  configured means a flagged loopback receipt, never a silent drop.
- **Session hardening (follow-up fixes):** gateway token, mode, and URL are
  pinned per operation with atomic session snapshots, so concurrent
  callbacks cannot cross-contaminate sessions.

## ABDM M3: HIU consent, inbound records, chart import (#66)

M3 makes the desktop a Health Information User (HIU): with patient consent,
doctors pull outside history into the chart. Schema arrives in migrations
v27–v30 (v27 consent/record tables + HIU keypair columns + key grants, v28
notify dedupe + flow grants, v29 read/clear grants, v30 import grant).

- **HIU identity (`HiuService`):** one-time X25519 keypair per device; the
  private half is keychain-wrapped under the client-secret contract (never
  in reads, IPC, or LAN). The public half is shareable for incoming pushes.
- **Consent flow:** `abdmHiuRequestConsent` records the request locally
  (mock gateway returns a mock id end-to-end; live calls refuse explicitly
  until gateway certification — never a guessed shape). Gateway
  notifications land on the existing inbox channel with enumerated kinds
  (`consent-granted/denied/expired`, `data-ready`) and `requestId` dedupe
  (including the lost-race path); bookkeeping auto-applies, clinical data
  never does.
- **Inbound pipeline:** `POST /abdm/hiu/data/transfer` (256KB cap, rate
  limit, secret gate) decrypts each envelope with the HIU key into the
  SQLCipher-encrypted cache with 30-day expiry. `FhirParser`
  (`shared/fhir/parser.ts`) turns document Bundles into the display model;
  foreign profiles degrade to text/warnings, and unreadable single records
  error per-record instead of failing the read.
- **Retention:** expired rows sweep at startup, daily at 03:00, and before
  every read; per-patient explicit wipe is audited (`abdmHiuClearExternalRecords`).
- **Chart import:** the External tab (patient chart) hosts request, fetch,
  read, and 1-click medication import. Import runs the prescription
  allergy gate server-side (`importExternalMedication`): conflicts need an
  explicit override recorded in audit; active duplicates return as-is.
  Request/fetch/import are doctor/admin; reads follow the inbox split.
- **Chart refactor (same change):** the patient chart's record-type tabs
  (Allergies/Problems/Medications grids) became a Summary page — persistent
  allergy banner, active problems/meds sections with the same add/remove
  affordances, recent visits — plus Visits and External tabs.

## Build & Distribution
Output is `desktop/release/`.

```bash
npm run dist:win     # Windows NSIS installer
npm run dist:mac     # macOS DMG
npm run dist:linux   # Linux .deb (primary clinic artifact) + AppImage (secondary)
```

Linux clinic install is the `.deb`:

```bash
sudo apt install ./nalamdesk-desktop_*_amd64.deb
```

The AppImage requires FUSE 2 (`libfuse.so.2`). If FUSE is missing, use `run-nalamdesk-appimage.sh` (fails with an actionable `.deb` message) or install the `.deb`. Do not document or use squashfs extract / `--appimage-extract` as an install path.
