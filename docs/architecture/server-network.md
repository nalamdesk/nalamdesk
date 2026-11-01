# NalamDesk Server: network and auth

How clients reach a NalamDesk Server and sign in (milestone 3 of
[ADR 0001](0001-headless-server.md), issue #193).

## HTTPS

The server only serves HTTPS. Pick one:

| Setup | Config | Join codes pin the certificate? |
|---|---|---|
| Self-signed (default) | nothing; made once in `<dataDir>/tls/` | Yes |
| Operator certificate | `NALAMDESK_TLS_CERT`, `NALAMDESK_TLS_KEY` (PEM files) | No, verified against system CAs |
| Reverse proxy ends TLS | `NALAMDESK_TLS=proxy` | No, verified against system CAs |

`NALAMDESK_PUBLIC_HOSTNAMES` adds names or IPs to the self-signed certificate.

## Joining a computer

1. An admin issues a join code: `nalamdesk-server join-code`, or
   `POST /api/admin/join-codes { deviceName? }` from a signed-in admin.
   Codes look like `7K2QM-9XR4T-B3N8D-HV6WC`, last 15 minutes and work once.
2. The code is an 8-character secret followed by the first 12 characters of
   the certificate's SHA-256 fingerprint (Crockford base32). On first
   contact the client checks the server's certificate against that prefix
   (`joinCodeMatchesFingerprint` in `src/shared/join-code.ts`). A prefix of
   all zeros means "not pinned: verify against system CAs".
3. The client calls `POST /api/devices/join { code, name }` and gets
   `{ deviceId, deviceToken, tls: { selfSigned, fingerprint256 } }`. It keeps
   the token and, for a self-signed certificate, pins the full fingerprint.
4. Every later request sends `X-NalamDesk-Device: <deviceToken>`.

Wrong codes are limited per address (10 per 15 minutes); 20 wrong codes
across the network void every outstanding code.

Admins list and revoke computers with `GET /api/admin/devices` and
`DELETE /api/admin/devices/:id`. Revoking signs out every session on that
computer and closes its event streams.

## Sessions

- `POST /api/auth/login { username, password }` (with the device header)
  returns `{ token, refreshToken, expiresIn, user }`. The access token lasts
  15 minutes and is bound to the session and computer.
- `POST /api/auth/refresh { refreshToken }` returns a new pair. Refresh
  tokens rotate: replaying an old one ends the session, so clients must not
  refresh concurrently. Sessions end after 12 hours idle or 24 hours total.
  Role changes and deactivation apply at the next refresh.
- `POST /api/auth/logout` ends the session.
- The signing key is kept in the vault (`server_secrets`), so restarts do not
  sign anyone out.
- Sign-in failures are limited per address (30 per 15 minutes), and a
  username locks after 5 failures for 1 minute, doubling to 15 minutes.
  A locked or limited sign-in gets `429` with `Retry-After`.
- Sign-in, failures, lockouts, joins, revocations and every audited API call
  record the computer (`audit_logs.device_id`).

## Live events

`GET /api/events` (signed in) is a Server-Sent Events stream. Each event names
a topic (`queue`, `appointments`, `bookings`, `abdm.inbox`, `patients`,
`billing`, `clinical`, `settings`, `users`, `data`) and the method that
caused it, never the data: clients refetch through the API, which applies
RBAC. Send `Last-Event-ID` to replay missed events; `event: resync` means
refetch everything. Browsers' `EventSource` cannot send headers, so clients
read the stream with `fetch`.

## Protocol handshake

Clients send `X-NalamDesk-Protocol: <n>`. Every API response carries the
server's `X-NalamDesk-Protocol` and `X-NalamDesk-Server-Version`. The server
accepts its own protocol and the previous one; otherwise it answers `426`
with `{ error, upgrade: 'client' | 'server', protocol, minProtocol }`.
`GET /api/server/hello` returns the same details without signing in.

## Single-PC and the in-app LAN server

The desktop app's built-in server keeps working as before (HTTP, no join
codes, 12-hour tokens) until client mode lands (#194). It already uses the
vault signing key and server sessions.
