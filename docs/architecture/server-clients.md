# NalamDesk Server: clients

How the app and browsers use a NalamDesk Server (milestone 4 of
[ADR 0001](0001-headless-server.md), issue #194). Server side:
[server-network.md](server-network.md).

## The app

- **First run** still sets up a single-PC clinic by default. A link on the
  welcome screen, "Connect this computer to it", asks for the server address,
  a join code and a name for the computer. Joining is refused once the
  computer holds a single-PC vault.
- The join (`src/main/client/join.ts`) reads the server's certificate before
  sending anything. When the code is pinned, the certificate's fingerprint
  must match the code, or the join stops with `WRONG_SERVER`. The whole
  certificate is then pinned for every later connection; operator
  certificates are checked against the system CAs instead.
- The app stores `server-connection.json` in its data folder: address,
  pinned certificate and the device credential sealed with the OS keychain
  (`safeStorage`). Nothing else: no vault, keys, Cloud identity or patient
  data.
- On start, `dist/main/entry.js` picks the mode. With a saved connection it
  runs `clientMain`: no database, local API server, backups or Cloud. The
  bundled UI gets `window.nalamdeskClient` (not `window.electron`), so it
  takes the same server path as browsers. Each request goes through the main
  process, which allows only `/api/` paths and a few headers, adds the device
  credential and sends it over pinned HTTPS. The page never sees the
  credential.
- "Disconnect this computer" on the sign-in screen forgets the connection
  and restarts as a fresh install. Admins can also remove the computer on
  the server.
- Printing stays local. Client computers keep auto-updating; the server is
  upgraded by its operator.

## Browsers

- The server serves the same UI. On a server that only accepts joined
  computers, the sign-in page first asks for a join code; the browser keeps
  its credential in `localStorage`.
- Sessions live in `sessionStorage`, one per tab, so two tabs never race to
  rotate the same refresh token.

## Shared behaviour

`src/shared/server-client.ts` is used by both:

- Access tokens are refreshed a minute before they expire and on a `401`,
  one refresh at a time. A failed refresh ends the session and returns to
  sign-in.
- The live events stream (`/api/events`) is read with `fetch` (app: through
  the main process), resumes with `Last-Event-ID`, and backs off from 1 to
  30 seconds between reconnects. The queue page and the queue badge refresh
  on `queue` events; `resync` refetches.
- Clients do not work offline. When the server is unreachable a banner says
  so, and the client knocks on `/api/server/hello` until it answers.
- The protocol handshake runs both ways: `checkServerHello` before signing
  in, and `426` answers on any call. The banner names the side that must
  upgrade.
- A removed computer is told so and sent back to sign-in (browsers are asked
  to join again).

## Admin

Settings → Computers (browser and client-mode app) issues join codes, lists
joined computers and removes them, through `/api/admin/join-codes` and
`/api/admin/devices`.

An admin on any computer also runs the server's Cloud pairing and listing
(`cloud*` methods), and in Data & Backup sees backup health, the backups in
`<dataDir>/backups` (`backupList`) and runs one now (`backupRunNow`). The
backup location, Google Drive and restore stay on the server's own machine:
restore with `nalamdesk-server restore`.

Screens refresh from `/api/events`: the Cloud card on `cloud`, Online
Booking on `bookings`, the ABDM inbox and Scan & Share dock on `abdm.inbox`
and the queue on `queue`; `resync` refreshes them all. These replace the
desktop's `cloud:pairingChanged` and `cloud:newRequests` pushes.

## Updates

The client-mode app updates itself with the same feed and in-app panel as
the single-PC app: its preload exposes `nalamdeskClient.updates`, the UI
checks at launch, and Settings → General has Check for updates. The server
is upgraded by its operator.
