---
sidebar_position: 1
---

# Architecture Overview

NalamDesk uses a secure, local-first hybrid desktop architecture designed for resilience and performance.

## Technology Stack

| Component | Technology | Description |
| :--- | :--- | :--- |
| **Runtime** | Electron | Cross-platform desktop environment. |
| **Frontend** | Angular + TailwindCSS | Responsive, component-based UI. |
| **Backend** | Fastify | High-performance local Node.js server. |
| **Database** | SQLite + SQLCipher | Encrypted local data storage. |
| **Security** | Argon2 | Industry-standard password hashing. |

## System Components

### 1. Main Process (Electron)
- **Entry Point**: `src/main/main.ts`
- **Responsibilities**:
    - App Window Management.
    - Native System Integrations (File System, Dialogs).
    - Auto-updates (`electron-updater`) in packaged builds from the generic feed at `https://nalamdesk.com/updates/desktop`, which nalamdesk.com streams from the public `nalamdesk/releases` GitHub Releases (override with `NALAMDESK_UPDATE_FEED_URL`).
    - Linux `gnome-libsecret` password-store switch at process start.
    - Authenticated desktop session (`SessionService`); `auth:logout` clears the principal.

### 2. Local API Server (Fastify)
- **Entry Point**: `src/server/app.ts` (bootstrapped via `src/server/bootstrap.ts`, served by `src/server/index.ts`; built with `tsconfig.server.json`)
- **Port**: `3000` (Localhost)
- **Role**: Validates requests and proxies them to the `DatabaseService`.
- **Security**:
    - **JWT Authentication**: Validates tokens on protected routes.
    - **IP Restriction**: With `STRICT_ADMIN_IP=true`, admin login is
      restricted to local IP (`127.0.0.1` or `::1`) to prevent
      network-based attacks. The server otherwise listens on all
      interfaces (`0.0.0.0:3000`); the header shows the LAN URL for
      clinic devices.
- **Renderer access**: the Angular app reaches the main process through a
  preload IPC bridge (`src/main/preload.ts`); the local API additionally
  serves LAN consumers with token + RBAC checks.

### 3. Database Layer
- **Service**: `src/main/services/DatabaseService.ts`
- **Engine**: `better-sqlite3-multiple-ciphers`
- **Encryption**: The entire database file (`nalamdesk.db`) is encrypted on disk. The encryption key is derived securely, ensuring that data is inaccessible without proper authentication.

## Data Flow Diagram

```mermaid
graph TD
    User[User] -->|Interact| UI[Angular Frontend]
    UI -->|HTTP POST (JWT)| Server[Fastify Server (Port 3000)]
    Server -->|Validate Token & RBAC| Auth[Auth Middleware]
    Auth -->|Approved| DBService[Database Service]
    DBService -->|SQL Query| SQLite[(Encrypted SQLite DB)]
    SQLite -->|Result| DBService
    DBService -->|JSON Response| UI
```

## Security Architecture

### Password Hashing
NalamDesk uses **Argon2**, a memory-hard password hashing algorithm, to store user passwords. This makes brute-force attacks computationally expensive and infeasible.

- **Implementation**: `src/main/services/DatabaseService.ts` -> `saveUser` / `validateUser`.

### Role-Based Access Control (RBAC)
Access control is enforced at the API layer, with a shared permission
model in `src/shared/access.ts` (built-in roles `admin`, `doctor`,
`nurse`, `receptionist`; Cedar policy checks behind handler-gated
clinical actions) and a permission-conformance spec at
`src/server/access-conformance.spec.ts`.

| Role | Permissions |
| :--- | :--- |
| **Admin** | **Full Access**. User management, custom roles and per-user overrides, Clinic Settings, Backup/Restore. Acts as scribe in consults (must pick the responsible doctor). |
| **Doctor** | Responsible licensed practitioner. Clinical Encounters, Prescriptions, Queue Triage, Vitals, Chart Merge, Billing. |
| **Receptionist** | Patient Registration, Queue Management & Triage, Vitals, Billing & Day Close, Chart Archive. No safety-data edits, no merges. |
| **Nurse** | Patient Vitals, Queue Triage & Monitoring. No queue removal, no billing, no merges. |

Settings routes additionally require `admin` (`adminGuard` redirects
everyone else to the dashboard). Handler-gated actions (consult
finalization, merges) reject non-qualifying roles even when a custom
role or override would otherwise permit them.

## Clinical Safety & Governance Architecture

### 1. Responsible Licensed Practitioner Provenance
To ensure medico-legal compliance and patient safety:
- **Licensed Practitioner Assertion**: Every clinical encounter and prescription requires a responsible licensed practitioner with role `doctor`. Non-practitioner accounts (administrators, receptionists) cannot independently finalize prescriptions or complete encounters without associating a licensed doctor.
- **License Snapshotting**: When an encounter is completed, the responsible practitioner's license number is durably snapshotted onto `visits.practitioner_license_snapshot`, freezing the practitioner's credentials as they existed at the moment of signing.
- **Authorship vs. Attending Doctor**: Scribe and assistant entries distinguish the acting user (`author_id`) from the attending responsible practitioner (`doctor_id`).

### 2. Longitudinal Clinical Safety Engine
- **Longitudinal Records**: NalamDesk tracks patient allergies/intolerances, active problems (conditions), and active medications across all past encounters.
- **Automated Prescription Medication Sync**: Upon completion of a consultation, prescribed medications are automatically reflected in the patient's active medication list.
- **Prescribing Allergy Conflict Detection**: Real-time cross-checks compare newly prescribed drugs against documented active allergies. If a conflict is detected, the practitioner is alerted and must provide an explicit clinical override reason (e.g. "Desensitized, patient tolerated previously") before the prescription can be saved.

### 3. Actionable Queue Triage & Dual-Unit Vitals Engine
- **4-Tier Urgency Hierarchy**: Patient flow supports 4 standard urgency tiers (`immediate` [Priority 4], `urgent` [Priority 3], `priority` [Priority 2], `routine` [Priority 1]).
- **Triage Audit Trail**: Every priority reassessment records a historical audit entry in `queue_triage_history` with the previous priority, new priority, clinical reason, and staff ID.
- **Abnormal Vitals Detection**: Vitals observations are automatically evaluated against clinical thresholds; abnormal vitals trigger warning badges in the patient queue to facilitate rapid clinical intervention.
- **Standardized Dual-Unit Vitals Engine**: The vitals engine accepts measurements in clinical units (°F or °C, kg or lbs), persists canonical values, and aligns with standard LOINC codes and UCUM unit symbols.
