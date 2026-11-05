# Product — NalamDesk Desktop

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary: Doctor in a small clinic doing consultations, prescriptions, timelines, and safety overrides — needs speed and clinical confidence during live patient flow.

Supporting roles under RBAC: Receptionist (patient registration, live queue, check-in of online bookings, vitals entry), Nurse (vitals, queue triage monitoring), Admin / Clinic owner (first-run vault setup, user management, clinic settings, diagnosis/medicine catalogs, backups).

## Product Purpose

Offline-first Electron desktop app for daily clinic operations. Walk-in registration → live urgency-ordered queue → consultation workbench → printed PDF prescription, plus catalogs, users, and backups. Success means a full clinic day (queue, consult, print) works with no internet, and core medical records stay encrypted on this device. Cloud is only a booking intake: desktop polls `GET /sync` (~30s) and checks in requests after Age/Gender validation.

## Positioning

Offline-first privacy vault. Unlike generic cloud clinic SaaS, the desktop stores data in an encrypted local SQLite vault (SQLCipher via `better-sqlite3-multiple-ciphers` + Argon2, key held in system keyring) and never sends core medical records to the cloud. Only appointment-request messages move, via the cloud queue.

## Operating Context

Small-clinic rituals on Windows / macOS / Linux (`.deb` primary on Linux, AppImage secondary needing FUSE 2): first-run vault setup with recovery code, morning login (session cleared on logout), walk-in + synced-booking check-in (Today's Appointments → validate → Live Queue), 4-tier triage (`immediate`/`urgent`/`priority`/`routine`) with mandatory rationale + `queue_triage_history` audit, dual-unit vitals with abnormal badges, scribe (`author_id`) vs. attending doctor (`doctor_id`) attribution with license snapshot on encounter completion, condition presets → editable prescription lines → PDF print, evening automated daily local backup (30-day retention, each bundle optionally copied to a chosen backup folder such as a Drive/OneDrive sync folder or USB disk) + `.ndbackup` restore gated by Recovery Code + admin password.

## Capabilities and Constraints

Confirmed: patient search by Name/Mobile, registration/edit, live queue with urgency + vitals alerts + Waiting/In-Consult/Completed states, longitudinal safety profile (allergies with criticality/reaction, active problems with ICD-10, auto-synced active meds), real-time allergy-conflict block requiring explicit override reason, doctor-provenance rule (only `doctor` role finalizes encounters/prescriptions), diagnosis/medicine typeahead with Add-new + soft-retire + condition→medicine presets, clinic details on prescriptions, Light/Dark/High-Contrast themes, local Fastify server on port 3000 with JWT + RBAC + admin-login loopback restriction, Electron auto-update via approved HTTPS feed, crash-report save flow, slot publishing + sync ack (`POST /slots`, `GET /sync`, `POST /ack` with `x-api-key` / `x-clinic-id`).

Durable constraints future work must preserve: offline-first (no network for queue/consult/print), full-DB encryption at rest with no password reset path, RBAC matrix (Admin full / Doctor clinical / Receptionist registration+queue / Nurse vitals+triage), AGPL-3.0-only, packaged version from Electron `app.getVersion()`.

## Brand Commitments

Name: NalamDesk. Promise: secure, offline-first, local data ownership. Voice in guides is practical/clinical. Visual identity for this app is `DESIGN.md` in this folder (Clinical Clarity, Trust Blue) — cloud portal has its own world.

## Evidence on Hand

Real paths: `desktop/USER_GUIDE.md`, `desktop/DEVELOPER_GUIDE.md`, `desktop/src/tailwind.css`, `desktop/tailwind.config.js` (enterprise daisyUI theme), `desktop/src/renderer/app/settings/settings.component.html`, `cloud/documentation/docs/developer-guide/architecture.md`, `cloud/documentation/docs/developer-guide/database-schema.md`.

Absences future work must not fabricate: no testimonials, customers, benchmarks, pricing, or deployment claims in repo.

## Product Principles

1. Local-first privacy by default — cloud is intake only, never the record.
2. Clinical safety cannot be bypassed — provenance, allergy blocks, and triage audit stay mandatory.
3. Queue reflects clinical urgency, not arrival order.
4. Small-clinic operability — one app covers registration to printed prescription without specialist IT.
5. No silent data loss — backups, restore gating, and explicit override reasons are part of the workflow.

## Accessibility & Inclusion

Preserve Light/Dark/High-Contrast themes and dual-unit vitals input (canonical persistence with LOINC/UCUM). No formal WCAG target established — do not claim one.
