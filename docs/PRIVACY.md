# Privacy Policy — NalamDesk

**Last updated:** 2026-10-25

## Summary

NalamDesk is an offline-first medical practice management system. Your
clinical data lives on your clinic's own computer, encrypted at rest,
and is never sent to any server by default. There is no telemetry,
analytics, or usage tracking of any kind.

## What data NalamDesk handles

- **Patient records, encounters, prescriptions, vitals, billing, and
  queue state** — stored in a local SQLite database on the clinic device.
- **User accounts** — doctor/receptionist/nurse/admin accounts with
  role-based access, stored locally.
- **Backups** — created locally on a schedule the clinic controls.

## Where data lives

- All clinical data resides in a single SQLite database file on the
  clinic computer (dev: `desktop/nalamdesk.db`; production:
  `%APPDATA%/NalamDesk` on Windows).
- The database is encrypted at rest with SQLCipher; the encryption key
  is stored in the operating system's secure keyring (Windows
  Credential Manager / DPAPI, macOS Keychain, Linux libsecret).
- No patient data is transmitted to any cloud service unless the clinic
  explicitly configures the optional cloud sync module.

## What we do NOT collect

- No telemetry, analytics, crash reporting, or usage statistics.
- No account creation with NalamDesk servers — the app runs fully
  offline.
- No advertising identifiers or tracking cookies (the landing site is a
  static Astro page with no analytics scripts).

## Optional cloud sync

- Cloud sync is opt-in and requires explicit pairing between the
  desktop app and a self-hosted or NalamDesk-managed cloud instance.
- When enabled, only appointment slots, directory entries, and transient
  booking requests are exchanged. Encounters, prescriptions, vitals,
  history, and patient clinical records never leave the device.
- The cloud holds directory, slots, and request messages — never the
  record.

## Data retention and deletion

- Data persists on the clinic device until the clinic deletes it.
- Uninstalling the app does not delete the database; the clinic retains
  full control and can back up or remove the data directory manually.
- There is no password reset path by design — losing the admin password
  and recovery code means the encrypted vault cannot be recovered.

## Security

- Full-database encryption at rest with the key in the system keyring.
- Role-based access control on the desktop.
- Secret scanning and push protection are enabled on the source
  repository; CI never prints secrets.
- Vulnerability reporting: see `SECURITY.md`.

## Contact

Privacy questions: `hello@nalamdesk.com`.

## Changes

This policy may be updated as the product evolves. The current version
is committed in the repository at `docs/PRIVACY.md`.
