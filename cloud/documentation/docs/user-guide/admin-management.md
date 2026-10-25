---
sidebar_position: 3
---

# Admin Management

**Settings** is admin-only: the route itself refuses non-admin users, so
everything below requires an Administrator login. Tabs: **General**,
**Users**, **Security**, **Data & Backup**, **Audit Logs**,
**Catalogs**, **ABDM**. The footer shows the packaged version
(`NalamDesk v0.0.13 (abc1234)` style, `(development)` for dev builds);
quote it when reporting defects. Logout clears the session.

## General

- **Clinic Name**: appears on prescriptions, receipts, and reports.
- **Consultation Fee**: auto-added as the first invoice line on every
  visit bill. Zero disables it.
- **Updates**: installed version plus **Check for updates**. Packaged
  apps check an approved feed; a failed check shows a plain error and
  never touches the vault. Unsigned or checksum-only feeds do not claim
  full signature verification.

## User Management (Users tab)

### Adding a User

1. Click **Add User**.
2. Fill in: **Username** (unique, minimum 3 characters, locked after
   creation), **Full Name**, **Role**, mobile (10 digits), email,
   address, date of birth, joining date, designation.
3. Doctors may carry an **HPR ID** (optional, preserved across edits).
4. Set a **Temporary Password** (minimum 6 characters, new users only).
   Existing users reset through a dedicated workflow, not by editing.
5. Click **Save**.

Built-in roles are `admin`, `doctor`, `nurse`, `receptionist`. Admins
can also compose **custom roles** from permission templates (Front
Desk, Observer, Triage Nurse, Blank) and grant or forbid individual
permissions per user with a recorded reason. Some duties stay
role-gated no matter what: only doctors finalize encounters, and only
doctors and admins merge charts.

### Managing Existing Users

- **Edit**: update details or disable the account.
- **Deactivate**: batch-disable selected users. Removing a user who
  owns clinical history is blocked; history is deactivated, never
  silently deleted.

## Security Tab

- **Change Login Password**: changes only the sign-in credential.
- **Rotate Device Envelope**: re-protects the unchanged database key
  for this device. Login passwords and the recovery code are
  unaffected.
- **Portable Vault Recovery Code**: generate the code that restores
  backups. The previous code stays valid until you confirm the new
  one — finish the ceremony, don't abandon it halfway.

## Catalogs Tab

Diagnosis and medicine inventories plus condition-to-medicine presets.
**Soft-retire** hides a term from typeahead; past visit text is
unchanged. Presets fill suggested prescription lines when their
condition is diagnosed.

## ABDM Tab (India)

One-time facility setup: HIP ID, counter ID, HFR facility ID, and each
doctor's HPR ID. Until credentials are configured the gateway stays in
mock mode and everything works offline: the counter QR, scan check-in,
callback inbox, and consent-based outside records are documented in
the desktop User Guide. Connection test and the pending-callback
acknowledgement live on this tab.

## Audit Logs Tab

A paged grid (50 per page) of security-relevant actions: who did what,
to which record, and when. Triage reassessments, merges, overrides,
and restores all leave entries here.

## Data & Backup

Local backups, restore, and backup health live under **Settings > Data &
Backup**. See [Data & Backups](../backups.md) for the full guide.
