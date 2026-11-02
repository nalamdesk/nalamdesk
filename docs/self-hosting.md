# Self-hosting NalamDesk Server

NalamDesk Server runs a clinic's encrypted database, the API and the browser
UI on a machine you control. The clinic's computers connect to it with the
NalamDesk app or a browser. Patient records stay on your server. They never go
to NalamDesk Cloud. The design is in
[ADR 0001](architecture/0001-headless-server.md).

This guide covers installing, first run, HTTPS, unlocking the vault, backups,
upgrades and monitoring.

## Where to put the server

Clinic computers stop working when they cannot reach the server. They do not
work offline. So:

- **Where the internet is unreliable, put the server on the clinic network**:
  a small always-on PC or mini server in the clinic, wired to the router.
  Clinic computers then keep working during an internet outage.
- A server in a data centre or the cloud suits a chain of branches with
  reliable internet. An outage at one branch stops that branch.
- A clinic with one computer does not need a server. The desktop app keeps
  its own database.

**Hardware:** 2 CPU cores, 2 GB RAM and 10 GB of disk are enough for a clinic.
Use an SSD, a UPS, and full-disk encryption (LUKS or BitLocker).

## Install

Each release publishes the same version of the server in four forms. The
`.deb`, tarball and Windows zip are on the
[releases page](https://github.com/nalamdesk/releases/releases). The Docker
image is `ghcr.io/nalamdesk/nalamdesk-server`. Each form bundles its own Node
runtime, so you do not install Node.

The Docker image, `.deb` and tarball come for `amd64` (x64) and `arm64`
(for example a Raspberry Pi 4 or 5 with a 64-bit OS, or an ARM cloud
server). Docker picks the right one by itself. For the `.deb` and tarball,
download the file whose name ends in your architecture (`dpkg
--print-architecture` prints it). The Windows zip is x64 only.

### Docker

The image is public, so any machine with Docker can run it. The quickest way
is the [compose file](../desktop/packaging/server/compose.yaml):

```sh
curl -fsSLO https://raw.githubusercontent.com/nalamdesk/nalamdesk/master/desktop/packaging/server/compose.yaml
docker compose run --rm nalamdesk init --clinic-name "Asha Clinic"
docker compose up -d
```

`init` asks for the admin password (12 characters or more) and prints the
**recovery code** once. Store it offline (see
[The recovery code](#the-recovery-code)). Then join the clinic's computers
with `docker compose exec nalamdesk nalamdesk-server join-code --name "Reception"`.
Set `NALAMDESK_VERSION=v0.0.14` in a `.env` file next to `compose.yaml` to pin
a version instead of `latest`, and `NALAMDESK_PORT` to publish another port.

Without Compose, the same steps with `docker run`:

```sh
docker volume create nalamdesk-data
printf '%s\n' 'choose-a-strong-admin-password' > admin-password   # 12 characters or more
docker run --rm -v nalamdesk-data:/var/lib/nalamdesk \
  -v "$PWD/admin-password:/run/secrets/admin-password:ro" \
  -e NALAMDESK_ADMIN_PASSWORD_FILE=/run/secrets/admin-password \
  ghcr.io/nalamdesk/nalamdesk-server:latest init --clinic-name "Asha Clinic"
shred -u admin-password

docker run -d --name nalamdesk --restart unless-stopped \
  -p 3000:3000 -v nalamdesk-data:/var/lib/nalamdesk \
  ghcr.io/nalamdesk/nalamdesk-server:latest
```

The image runs as user `nalamdesk` (uid 10001). Everything it keeps is in the
`/var/lib/nalamdesk` volume: the encrypted database, the key file, TLS files
and backups. To run `init` in a terminal instead of passing a password file,
add `-it` and leave out the `-e` and secret mount.

### Debian and Ubuntu (.deb)

```sh
sudo apt install ./nalamdesk-server_0.0.14_amd64.deb
sudo nalamdesk-server init --clinic-name "Asha Clinic"
sudo systemctl start nalamdesk-server
```

The package:

- installs to `/opt/nalamdesk-server` and links `/usr/bin/nalamdesk-server`;
- creates the `nalamdesk` system user and `/var/lib/nalamdesk` (mode 0700);
- reads `/etc/nalamdesk/server.json` and, for environment overrides,
  `/etc/default/nalamdesk-server`;
- installs a hardened `nalamdesk-server.service` (no new privileges,
  read-only system, private `/tmp`, write access to its state directory only)
  and enables it. It starts the service once a vault exists.

Run CLI commands with `sudo`. The launcher switches to the `nalamdesk` user,
so the files it creates stay readable by the service. The one exception is a
command that creates a `systemd-creds` or `tpm` credential (see
[key providers](#unlocking-the-vault-key-providers)): it stays root, because
only root can use the host key and write `/etc/credstore.encrypted`, and then
gives the data directory back to `nalamdesk`.

The service and the launcher ignore `.env` files (`NALAMDESK_NO_DOTENV=1`).
Put settings in `/etc/nalamdesk/server.json` or `/etc/default/nalamdesk-server`.

### Other Linux (tarball)

Extract `nalamdesk-server-<version>-linux-x64.tar.gz` (or `-linux-arm64`) to
`/opt/nalamdesk-server`, create a `nalamdesk` system user, and install
`packaging/server/linux/nalamdesk-server.service` from the source tree. Or
run `/opt/nalamdesk-server/bin/nalamdesk-server start` under the supervisor
you already use. The tarball needs glibc 2.28 or later.

### Windows

1. Extract `nalamdesk-server-<version>-windows-x64.zip`.
2. In PowerShell as administrator, from the extracted folder:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\nalamdesk-server\service\install-service.ps1
   ```

   This copies the server to `C:\Program Files\NalamDesk Server`, creates
   `C:\ProgramData\NalamDesk\server` (readable by SYSTEM and Administrators
   only), opens port 3000 on private and domain networks, adds
   `nalamdesk-server` to the PATH and registers the **NalamDesk Server**
   service, which starts automatically.
3. In a new administrator PowerShell:

   ```powershell
   nalamdesk-server init --clinic-name "Asha Clinic"
   Start-Service NalamDeskServer
   ```

Logs are in `C:\ProgramData\NalamDesk\server\logs`. To remove the service,
run `service\uninstall-service.ps1` from the install folder. Both scripts
leave the clinic's data in place.

## Join the clinic's computers

Each computer joins the server once with a one-time join code, then staff
sign in with their own accounts. With the server running, issue a code for
each computer:

```sh
sudo nalamdesk-server join-code --name "Reception"            # .deb
docker exec nalamdesk nalamdesk-server join-code --name "Reception"   # Docker
nalamdesk-server join-code --name "Reception"                 # Windows, as administrator
```

Enter the code in NalamDesk on that computer within 15 minutes
(`--minutes N` for longer, up to a day). The code also carries part of the
server's certificate fingerprint, so the computer knows it reached the right
server. `join-code` works only after the server has started once, because it
pins exactly what the running server serves.

`nalamdesk-server devices list` shows the joined computers.
`nalamdesk-server devices revoke <id>` removes a lost or retired computer
and signs out its sessions. An admin can do the same from any joined
computer in Settings → Computers.

## Move a desktop clinic onto the server

A clinic that has used the desktop app on one computer can move its records
onto the server.

1. In the desktop app, sign in as admin and open **Settings → Data &
   Backup**. Check that **Last backup** is recent, then copy the newest
   `.ndbackup` file from the **Location** shown there to the server. Make the
   move at the end of a day, so the backup holds the latest records.
2. Have the clinic's **recovery code** ready. It is the code the app showed at
   setup.
3. On a server with no vault yet, run:

   ```sh
   sudo nalamdesk-server import /path/to/nalamdesk-backup.ndbackup
   ```

   The file can be anywhere root can read, such as your home folder. For
   Docker, mount the file and pass the code as a file with
   `NALAMDESK_RECOVERY_CODE_FILE`, or add `-it` and type it in.
4. Start the server. Staff sign in with their existing accounts and
   passwords.
5. **Stop using the desktop copy for that clinic.** Otherwise records split
   between the two.

Import checks the backup's checksums and opens it with the recovery code
before it writes anything. A wrong code or a damaged file changes nothing.
The server then unlocks the vault with its own key provider, a key file by
default. The desktop keychain is not needed. The recovery code stays the
same, unless the backup is from an old version that needs a new one. In that
case import prints the new code and asks you to confirm it.

## Configuration

Settings come from an optional JSON file, `--config <file>` or
`NALAMDESK_CONFIG`. Environment variables override the file.

| Setting | Variable | Default |
|---|---|---|
| `dataDir` | `NALAMDESK_DATA_DIR` | `/var/lib/nalamdesk`; on Windows `C:\ProgramData\NalamDesk\server` |
| `host` | `NALAMDESK_HOST` | `0.0.0.0` |
| `port` | `NALAMDESK_PORT` | `3000` |
| `keyProvider` | `NALAMDESK_KEY_PROVIDER` | `key-file` |
| `keyFile` | `NALAMDESK_KEY_FILE` | `<dataDir>/vault.key` |
| `offsiteTarget` | `NALAMDESK_OFFSITE_TARGET` | `none`; see [Off-site copies](#off-site-copies) |

The server refuses secrets in the JSON file. Pass passphrases, the admin
password and the recovery code as `NAME_FILE` (a path, which suits Docker
secrets and systemd credentials) or as `NAME`:

- `NALAMDESK_PASSPHRASE_FILE`: vault passphrase, for the passphrase provider.
- `NALAMDESK_ADMIN_PASSWORD_FILE`: admin password, for `init` only.
- `NALAMDESK_RECOVERY_CODE_FILE`: recovery code, for `import` only.
- `NALAMDESK_OFFSITE_S3_SECRET_ACCESS_KEY_FILE`: S3 secret key, for the `s3`
  off-site target.

The server creates its files owner-only (umask 077).

## HTTPS

Clinic computers talk to the server over HTTPS. Choose one of these:

- **Your own certificate** for a domain:
  `NALAMDESK_TLS_CERT=/path/fullchain.pem` and
  `NALAMDESK_TLS_KEY=/path/privkey.pem` (set both, or neither). The service
  account must be able to read both files.
- **A reverse proxy** (Caddy, nginx, Traefik) that handles TLS:
  `NALAMDESK_TLS=proxy`. The server then serves plain HTTP and trusts the
  proxy's `X-Forwarded-*` headers. Bind it to localhost
  (`NALAMDESK_HOST=127.0.0.1`), or keep it on a private Docker network, so
  only the proxy can reach it.
- **Neither:** the server makes a self-signed certificate once, in
  `<dataDir>/tls/`. Clinic computers trust it through the join code, which
  carries part of the certificate fingerprint. List any extra names or IPs
  that clients use in `NALAMDESK_PUBLIC_HOSTNAMES`, for example
  `nalamdesk.clinic.lan,192.168.1.20`.

Details: [server network and auth](architecture/server-network.md).

## Unlocking the vault: key providers

The database is encrypted with a random data key. Each way of unlocking it
holds its own wrapped copy of that key in a *key slot*. Any one slot opens
the vault.

| Provider | Restarts unattended | Protects against | Use when |
|---|---|---|---|
| `key-file` (default) | Yes | Copied database or backups without the key file | Docker, Windows, and any server with full-disk encryption |
| `systemd-creds` | Yes | Copied files, and a disk moved to another machine | Linux with systemd 250 or later (recommended for the .deb) |
| `tpm` | Yes | As above, bound to this machine's TPM chip | Linux servers with a TPM 2.0 |
| `dpapi` | Yes | Copied files, and a disk moved to another machine | Windows, with the vault created as the service account |
| `kms` | Yes | All of the above, with audited key use | A cloud KMS or Vault you already run |
| `passphrase` | No: someone types it, or supplies `NALAMDESK_PASSPHRASE_FILE` | A stolen disk or machine | Someone is on site to start the server |
| Recovery code (always present) | n/a | A lost or dead server | Disaster recovery only |

Manage slots without re-encrypting:

```sh
sudo nalamdesk-server key list
sudo nalamdesk-server key add --provider passphrase --label "Owner"
sudo nalamdesk-server key add --provider key-file --key-file /secure/usb/vault.key
sudo nalamdesk-server key remove <slot-id>
```

Every change is written to the audit log. The recovery code slot cannot be
removed. A good pattern is to add a machine-bound slot, check that the
service starts with it, and then remove the key file slot.

The machine-bound providers and their options (`--credential-name`,
`--dpapi-blob`, `--key-command`) are described in the
[developer guide](../desktop/DEVELOPER_GUIDE.md).

### systemd-creds on the .deb

`systemd-creds` binds the vault key to this machine's host key (and, with
`tpm`, its TPM chip). Run these as root with `sudo`. The launcher stays root
for `key add --provider systemd-creds|tpm`, and for `init` or `import` when
the configured provider is `systemd-creds` or `tpm`. The credential is
written to `/etc/credstore.encrypted/nalamdesk-vault-key`, readable by root
only, and systemd hands it to the service at start.

1. Add the slot while the key file still unlocks the vault:

   ```sh
   sudo nalamdesk-server key add --provider systemd-creds --label "This server"
   ```

2. Tell the service to load the credential and unlock with it
   (`sudo systemctl edit nalamdesk-server` opens the drop-in):

   ```ini
   [Service]
   Environment=NALAMDESK_KEY_PROVIDER=systemd-creds
   LoadCredentialEncrypted=nalamdesk-vault-key
   ```

   With `--credential-name` or `--credential-path`, use the line `key add`
   printed instead, for example
   `LoadCredentialEncrypted=clinic-key:/etc/credstore.encrypted/clinic-key`.

3. Restart and check that it unlocks:

   ```sh
   sudo systemctl restart nalamdesk-server
   sudo systemctl status nalamdesk-server
   ```

CLI commands run outside the service, so they have no `$CREDENTIALS_DIRECTORY`
and cannot unlock with this slot; they keep using the provider in
`/etc/nalamdesk/server.json`. Before you remove the key file slot
(`sudo nalamdesk-server key remove <slot-id>`), add another slot for the CLI,
such as a `passphrase`, and point `server.json` at it.

**Keep the key file separate from your backups.** A backup and its key file
together open the clinic's records.

## The recovery code

`init` shows the recovery code once. It opens the vault when every other
slot is lost, and you need it to restore a backup on a new machine. There is
no password reset and no other way in.

- Write it down, and keep it offline in two safe places, such as a safe and
  the owner's home.
- Confirm it after `init` when asked, or later with
  `nalamdesk-server recovery confirm`. The server warns at every start until
  you confirm.

## Backups

Back up the data directory (`/var/lib/nalamdesk`, the Docker volume, or
`C:\ProgramData\NalamDesk\server`). It holds the database (`nalamdesk.db`),
`security.json` (key slots) and `tls/`.

- Stop the server first, or copy from a filesystem snapshot, so the database
  copy is consistent.
- Keep backups **off the server**, with at least one copy offline or
  offsite.
- Store the key file (`vault.key`) apart from the backups. A backup restores
  with the recovery code alone.
- Before each upgrade's migrations, the server keeps a copy of the database
  as `nalamdesk.db.bak`.

The server also writes a backup every day at the time set in **Settings >
Backup** (13:00 by default) to `<dataDir>/backups`, in the clinic's portable
`.ndbackup` format, and keeps 30 days of them. Admins can run one from
Settings at any time, or with `nalamdesk-server backup`. A backup restores
with the recovery code alone, on this server or a new one.

### Off-site copies

A backup on the server's own disk is lost with the disk. Set an off-site
target and the server copies each scheduled backup there as soon as it is
written. The copy is the `.ndbackup` file unchanged: the database inside is
encrypted and its key is wrapped with the recovery code, so the target never
sees readable records. A failed copy does not undo the local backup; it shows
as **Attention needed** on the backup card in Settings, and the next backup
tries again.

**A network share, USB drive or second disk** (`folder`):

| Setting | Variable |
|---|---|
| `offsiteTarget: "folder"` | `NALAMDESK_OFFSITE_TARGET=folder` |
| `offsitePath` | `NALAMDESK_OFFSITE_PATH` |

The folder must already exist and sit outside the data directory. The server
never creates it, so an unplugged drive or an unmounted share fails loudly
instead of filling the server's own disk. Copies older than 30 days are
removed from the folder. In Docker, mount the share or drive into the
container and point `NALAMDESK_OFFSITE_PATH` at the mount.

**S3-compatible storage** (`s3`), such as Amazon S3, Cloudflare R2,
Backblaze B2, Wasabi or MinIO:

| Setting | Variable | Notes |
|---|---|---|
| `offsiteTarget: "s3"` | `NALAMDESK_OFFSITE_TARGET=s3` | |
| `offsiteS3Endpoint` | `NALAMDESK_OFFSITE_S3_ENDPOINT` | e.g. `https://s3.ap-south-1.amazonaws.com` |
| `offsiteS3Bucket` | `NALAMDESK_OFFSITE_S3_BUCKET` | |
| `offsiteS3Region` | `NALAMDESK_OFFSITE_S3_REGION` | default `us-east-1`; R2 uses `auto` |
| `offsiteS3Prefix` | `NALAMDESK_OFFSITE_S3_PREFIX` | optional folder inside the bucket |
| `offsiteS3AccessKeyId` | `NALAMDESK_OFFSITE_S3_ACCESS_KEY_ID` | |
| (environment only) | `NALAMDESK_OFFSITE_S3_SECRET_ACCESS_KEY_FILE` | or `NALAMDESK_OFFSITE_S3_SECRET_ACCESS_KEY` |

Give the key permission to upload objects to that bucket and nothing else
(`s3:PutObject` on AWS). The server does not delete from the bucket: set a
lifecycle rule to expire old copies, and turn on object lock or versioning if
your provider offers it, so a compromised server cannot erase its history.

`nalamdesk-server status` shows the configured target. Restart the server
after changing it.

### Restore

Stop the server, then replace the vault with a backup:

```sh
sudo systemctl stop nalamdesk-server
sudo nalamdesk-server restore /path/to/nalamdesk-backup.ndbackup
sudo systemctl start nalamdesk-server
```

`restore` asks for the backup's recovery code (or reads
`NALAMDESK_RECOVERY_CODE_FILE`), saves a snapshot of the current vault, and
refuses while the server is running. Afterwards the vault opens with the
server's key provider and the backup's recovery code; add other slots again
with `nalamdesk-server key add`. Restore is not offered in the app, even to
admins: it runs on the server only.

**Test a restore.** Install the server on a spare machine, restore a backup
there, start it and sign in.

## Upgrades

The server never updates itself. To upgrade:

- **Docker:** `docker compose pull && docker compose up -d`, or `docker
  pull` the new tag and recreate the container with the same volume.
- **.deb:** `sudo apt install ./nalamdesk-server_<new>_amd64.deb`. The
  package restarts the service.
- **Windows:** extract the new zip and run its `install-service.ps1`. It
  stops the service, replaces the program files and starts it again.

Database migrations run on start, after the automatic pre-migration copy.
Server and app share one version number. The server accepts clients on its
own version and the one before, so upgrade the server first, then the clinic
computers.

## Monitoring

- **Running:** `systemctl status nalamdesk-server`,
  `docker ps` (the image has a health check on the port), or
  `Get-Service NalamDeskServer`.
- **Logs:** `journalctl -u nalamdesk-server`, `docker logs nalamdesk`, or
  `C:\ProgramData\NalamDesk\server\logs`.
- **Vault:** `nalamdesk-server status` shows the data directory, whether the
  vault is set up, the key provider, the listen address and the off-site
  backup target.
- Watch free disk space on the data directory, and check that your backup
  job ran.
- Look for the recovery-code warning in the logs after a fresh install.

## Uninstall

- **.deb:** `sudo apt remove nalamdesk-server`. Even `purge` keeps
  `/var/lib/nalamdesk`. Delete it yourself once you are sure you have a
  backup.
- **Docker:** remove the container. The volume keeps the data.
- **Windows:** run `uninstall-service.ps1`, then delete
  `C:\Program Files\NalamDesk Server`. The data folder is kept.
