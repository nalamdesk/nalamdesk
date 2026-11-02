---
sidebar_position: 2
title: Install the server
---

# Install NalamDesk Server

Each NalamDesk release publishes the server in four forms, all the same
version as the app:

| Form | Runs on | Where to get it |
| :--- | :--- | :--- |
| Docker image | Any machine with Docker, `amd64` or `arm64` | `ghcr.io/nalamdesk/nalamdesk-server` |
| `.deb` package | Debian and Ubuntu, `amd64` or `arm64` | [Releases page](https://github.com/nalamdesk/releases/releases) |
| Tarball | Other Linux (glibc 2.28 or later), `amd64` or `arm64` | [Releases page](https://github.com/nalamdesk/releases/releases) |
| Windows zip | Windows, x64, installs as a Windows service | [Releases page](https://github.com/nalamdesk/releases/releases) |

Every form bundles its own runtime, so there is nothing else to install.
`arm64` covers machines such as a Raspberry Pi 4 or 5 with a 64-bit OS. For
the `.deb` and tarball, download the file ending in your architecture
(`dpkg --print-architecture` prints it).

Every install has the same first step, `init`, which creates the encrypted
vault and the admin account. It asks for an admin password of **12
characters or more** and prints the **recovery code once**. Write the code
down before you go on: see [The recovery code](./vault-keys.md#the-recovery-code).

## Docker

The quickest way is the compose file:

```sh
curl -fsSLO https://raw.githubusercontent.com/nalamdesk/nalamdesk/master/desktop/packaging/server/compose.yaml
docker compose run --rm nalamdesk init --clinic-name "Asha Clinic"
docker compose up -d
```

To pin a release instead of `latest`, put `NALAMDESK_VERSION=v0.0.14` in a
`.env` file next to `compose.yaml`. `NALAMDESK_PORT` publishes another port
than 3000.

Without Compose:

```sh
docker volume create nalamdesk-data
docker run --rm -it -v nalamdesk-data:/var/lib/nalamdesk \
  ghcr.io/nalamdesk/nalamdesk-server:latest init --clinic-name "Asha Clinic"
docker run -d --name nalamdesk --restart unless-stopped \
  -p 3000:3000 -v nalamdesk-data:/var/lib/nalamdesk \
  ghcr.io/nalamdesk/nalamdesk-server:latest
```

Everything the server keeps is in the `/var/lib/nalamdesk` volume: the
encrypted database, its key, TLS files and backups.

## Debian and Ubuntu

```sh
sudo apt install ./nalamdesk-server_0.0.14_amd64.deb
sudo nalamdesk-server init --clinic-name "Asha Clinic"
sudo systemctl start nalamdesk-server
```

The package creates a `nalamdesk` system user and `/var/lib/nalamdesk`, and
installs a hardened `nalamdesk-server` systemd service that starts at boot.
Run `nalamdesk-server` commands with `sudo`. Settings go in
`/etc/nalamdesk/server.json` or `/etc/default/nalamdesk-server`.

## Windows

1. Extract `nalamdesk-server-<version>-windows-x64.zip`.
2. In PowerShell as administrator, from the extracted folder:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\nalamdesk-server\service\install-service.ps1
   ```

   This installs the server to `C:\Program Files\NalamDesk Server`, keeps its
   data in `C:\ProgramData\NalamDesk\server` (readable by administrators
   only), opens port 3000 on private networks and registers the **NalamDesk
   Server** service, which starts with Windows.
3. In a new administrator PowerShell:

   ```powershell
   nalamdesk-server init --clinic-name "Asha Clinic"
   Start-Service NalamDeskServer
   ```

Logs are in `C:\ProgramData\NalamDesk\server\logs`. Running
`service\uninstall-service.ps1` removes the service and keeps the data.

## HTTPS

Computers always talk to the server over HTTPS. Pick one:

- **Do nothing.** The server makes its own certificate. Joined computers
  trust it through the join code, which carries part of the certificate's
  fingerprint. If computers reach the server by extra names or IP
  addresses, list them in `NALAMDESK_PUBLIC_HOSTNAMES`, for example
  `nalamdesk.clinic.lan,192.168.1.20`.
- **Your own certificate** for a domain: set `NALAMDESK_TLS_CERT` and
  `NALAMDESK_TLS_KEY` to the certificate and key files.
- **A reverse proxy** such as Caddy or nginx: set `NALAMDESK_TLS=proxy` and
  let only the proxy reach the server.

## Settings

Settings come from an optional JSON file (`--config <file>` or
`NALAMDESK_CONFIG`), and environment variables override it:

| Setting | Variable | Default |
| :--- | :--- | :--- |
| `dataDir` | `NALAMDESK_DATA_DIR` | `/var/lib/nalamdesk`; Windows `C:\ProgramData\NalamDesk\server` |
| `host` | `NALAMDESK_HOST` | `0.0.0.0` |
| `port` | `NALAMDESK_PORT` | `3000` |
| `keyProvider` | `NALAMDESK_KEY_PROVIDER` | `key-file`; see [Vault keys](./vault-keys.md) |
| `offsiteTarget` | `NALAMDESK_OFFSITE_TARGET` | `none`; see [Off-site copies](./backups-and-restore.md#off-site-copies) |

Secrets such as passwords never go in the JSON file. Pass them as a file
path in a `NAME_FILE` variable, for example `NALAMDESK_ADMIN_PASSWORD_FILE`.

## Check it is running

```sh
nalamdesk-server status
```

shows the data directory, whether the vault is set up, how it unlocks, the
address it listens on and the off-site backup target. For logs, use
`journalctl -u nalamdesk-server`, `docker logs`, or the Windows log folder
above.

## Upgrade

The server never updates itself, so upgrade it before the clinic computers
(the server accepts apps on its own version and the one before):

- **Docker:** `docker compose pull && docker compose up -d`.
- **.deb:** `sudo apt install ./nalamdesk-server_<new>_amd64.deb`.
- **Windows:** extract the new zip and run its `install-service.ps1` again.

Database changes run on start, after the server keeps a copy of the
database as `nalamdesk.db.bak`. The app on each computer keeps updating
itself as usual.

The full operator guide, with every setting and the hardened service
details, is [self-hosting.md](https://github.com/nalamdesk/nalamdesk/blob/master/docs/self-hosting.md)
in the source repository.
