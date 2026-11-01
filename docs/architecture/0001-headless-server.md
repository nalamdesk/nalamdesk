# ADR 0001: NalamDesk Server, a headless self-hosted server

- Status: Accepted
- Date: 2026-11-01

## Context

Every NalamDesk install today is a self-contained Electron app:

- The Electron main process owns the SQLCipher database. Its key is protected
  by the OS keychain (Electron `safeStorage`), which only exists inside a
  logged-in desktop session.
- `desktop/src/server/app.ts` is a Fastify API (`POST /api/ipc/:method`) with a
  method allowlist, JWT login and the same Cedar RBAC as Electron IPC. It runs
  inside the app on `0.0.0.0:3000` so LAN browsers can use the clinic's data.
  `desktop/src/server/index.ts` can start it standalone, but without ABDM keys,
  NalamDesk Cloud, backups or setup.
- The renderer already speaks HTTP: `DataService.invoke` uses Electron IPC when
  available and `/api/ipc` otherwise.
- Everything that talks to the outside world lives in the Electron main
  process: Cloud pairing and signed requests (`CloudLink`), the sealed mailbox
  and doorbell, the ABDM mailbox processor, booking sync, backups and restore,
  and updates.

We want NalamDesk to work like classic client-server software (Postgres,
Kafka): anyone can host a NalamDesk Server, from a single clinic to a hospital
chain running many branches on one server, and a hosted option may follow.

## Decision

NalamDesk ships as two products from one repository.

### NalamDesk Server

A headless Node service with no Electron dependency.

- Owns the encrypted database, users and roles, the API, ABDM (HIP and HIU),
  NalamDesk Cloud pairing, the mailbox, doorbell and relay connection, online
  booking sync, scheduled backups and the audit log.
- Installed like any server: Docker image, Linux package with a systemd unit,
  Windows service. Configured by one config file or environment variables
  (data directory, port, TLS certificate, public URL).
- First-run setup by CLI: `nalamdesk-server init` creates the vault and admin
  and prints the recovery code. Also `status`, `backup`, `restore`,
  `join-code`, `key`. There is still no password reset path.
- Operators upgrade it (new image or package). Migrations run on start behind
  the existing automatic pre-migration backup. The server never self-updates.

### NalamDesk clients

- **App:** the Electron app connects to a server address with a one-time join
  code, then staff sign in with their own accounts. No vault, keys, Cloud
  identity or patient data on the client's disk. The UI is bundled in the app
  and talks to the server over HTTPS. Printing stays local.
- **Browser:** the same Angular UI served by the server.
- Admin screens (backups, Cloud pairing, ABDM, joined computers) work from any
  client signed in as an admin, because they call the server.

### Single-PC mode

The app can run the same server core in-process, reachable only from that
computer, so one-PC clinics need no separate install. This is today's
behaviour on the new core. `nalamdesk-server import <backup>` moves a
single-PC clinic onto a real server using the existing backup format.

### Organisations and facilities

One server can serve one organisation with many facilities (branches).

- Patients belong to the organisation: one record across branches.
- Queue, appointments, invoices, daily close, numbering and letterheads are
  per facility.
- Each facility has its own HFR and HIP ID, so ABDM and Cloud pairing are per
  facility.
- Staff roles are granted per facility.

A future hosted offering runs one server instance and one database per
customer organisation (container per tenant), not a shared multi-tenant
database.

### Vault key: key slots

The database is encrypted once with a random data key. Each enabled unlock
method stores its own wrapped copy of the data key in a key slot. Any one slot
opens the vault, in the same way as LUKS disk encryption.

| Provider | Restarts unattended | Protects against |
|---|---|---|
| Recovery code (always present) | n/a | Lost or dead server |
| Key file (service-account only) | Yes | Copied database files and backups |
| Passphrase at start | No | Stolen disk or machine |
| Windows DPAPI, TPM, Linux `systemd-creds` | Yes | Copied files, disk moved to another machine |
| Cloud KMS (hosted offering) | Yes | All of the above, with audited key use |

- `init --key-provider <name>` picks the first slot, defaulting to the
  strongest provider available on the machine.
- `key add|remove|list` manage slots without re-encrypting the database.
- The recovery code slot cannot be removed. Slot changes are audited.
- Single-PC mode keeps using the desktop keychain as its slot.
- Delivery order: key file, passphrase and recovery code first; then DPAPI,
  TPM and `systemd-creds`; KMS with the hosted offering.

### Network and security

- HTTPS only. Operators bring a certificate (or a reverse proxy) for a domain.
  Without one, the server makes a self-signed certificate and clients pin it
  through the join code, which carries part of the certificate fingerprint.
- Each client computer joins once with a short-lived join code from an admin
  and receives a revocable device credential. User sessions are bound to it.
- Login rate limiting and lockout, a signing key stored in the vault (restarts
  do not log users out), short sessions with refresh, and an audit trail with
  user and computer.
- RBAC stays on the server (Cedar plus the method allowlist).
- A live events stream replaces renderer push and polling for clients.

### Offline

Clients stop and wait when the server is unreachable, show a banner, and
reconnect on their own. They do not work offline. A server hosted outside the
clinic means an internet outage stops the clinic; the self-hosting guide
recommends a server on the clinic network where internet is unreliable.

### Cloud, relay and pairing

The server takes over the desktop's role: it pairs with NalamDesk Cloud
(per facility), holds the device identity, reads the sealed mailbox, listens
on the doorbell and calls ABDM through the relay. No cloud changes are needed.

### Releases

One version number for server and app. CI publishes the server's Docker
image, Linux package and Windows service with the desktop installers. Clients
send a protocol version; the server accepts its own and the previous one, and
tells an outdated side which one to upgrade. The app keeps auto-updating.

### Database engine

The server ships on SQLite with SQLCipher. New code goes through a data-access
layer so Postgres can be added when a large customer needs it.

## Consequences

- The privacy promise holds: the record lives on infrastructure the customer
  controls, never on NalamDesk Cloud.
- Offline-first holds only for single-PC mode and servers on the clinic
  network.
- Operators take on TLS, backups, upgrades and monitoring; defaults and a
  self-hosting guide carry most of it.
- Main-process features (Cloud, mailbox, backups, ABDM keys, updates) are
  refactored into server code.

## Delivery plan

1. This record and one tracking issue per milestone.
2. Server core: services without Electron, `nalamdesk-server` entry point,
   config, `init` CLI, key slots (key file, passphrase, recovery code).
   Single-PC mode on the same core.
3. Network and auth: HTTPS, join codes, device credentials, persisted signing
   key, login limits, events stream, version handshake, Docker image in CI.
4. Clients: client mode in the app and the browser client.
5. Organisations and facilities.
6. Cloud, mailbox, ABDM and backups move into the server; admin screens call
   the server.
7. Packaging: Linux package with systemd, Windows service, `import`, remaining
   key providers, self-hosting guide.
