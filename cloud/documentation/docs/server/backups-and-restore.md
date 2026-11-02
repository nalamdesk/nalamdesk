---
sidebar_position: 5
title: Backups and restore
---

# Server backups and restore

## Daily backups

The server writes an encrypted backup every day at the time set in
**Settings > Data & Backup** (13:00 by default) to `<data directory>/backups`,
and keeps 30 days of them. Backups use the same portable `.ndbackup`
format as the single-computer app, and open with the recovery code alone.

From any joined computer, an admin sees backup health and the list of
backups in **Settings > Data & Backup**, and can run one now. On the server:

```sh
sudo nalamdesk-server backup                     # into <data directory>/backups
sudo nalamdesk-server backup --out /mnt/usb/clinic.ndbackup
```

## Off-site copies

A backup on the server's own disk is lost with that disk. Set an off-site
target and the server copies each scheduled backup there as soon as it is
written. The copy is the encrypted `.ndbackup` file unchanged, so the target
never sees readable records. If a copy fails, the local backup is kept, the
backup card shows **Attention needed**, and the next backup tries again.

**A network share, USB drive or second disk:**

```sh
NALAMDESK_OFFSITE_TARGET=folder
NALAMDESK_OFFSITE_PATH=/mnt/clinic-share/nalamdesk
```

The folder must already exist and be outside the data directory; the
server never creates it, so an unplugged drive fails loudly instead of
filling the server's disk. Copies older than 30 days are removed.

**S3-compatible storage** (Amazon S3, Cloudflare R2, Backblaze B2, Wasabi,
MinIO):

```sh
NALAMDESK_OFFSITE_TARGET=s3
NALAMDESK_OFFSITE_S3_ENDPOINT=https://s3.ap-south-1.amazonaws.com
NALAMDESK_OFFSITE_S3_BUCKET=asha-clinic-backups
NALAMDESK_OFFSITE_S3_REGION=ap-south-1          # R2 uses auto
NALAMDESK_OFFSITE_S3_PREFIX=nalamdesk           # optional
NALAMDESK_OFFSITE_S3_ACCESS_KEY_ID=...
NALAMDESK_OFFSITE_S3_SECRET_ACCESS_KEY_FILE=/run/secrets/s3-secret
```

Give the access key permission to upload and nothing else (`s3:PutObject`
on AWS). The server never deletes from the bucket: set a lifecycle rule to
expire old copies, and turn on versioning or object lock if your provider
offers it.

Restart the server after changing the target. `nalamdesk-server status`
shows the target in use.

## Restore a backup

Stop the server, then:

```sh
sudo systemctl stop nalamdesk-server
sudo nalamdesk-server restore /path/to/nalamdesk-backup.ndbackup
sudo systemctl start nalamdesk-server
```

`restore` asks for the backup's recovery code (or reads it from
`NALAMDESK_RECOVERY_CODE_FILE`), saves a copy of the current vault first,
and then replaces it. Afterwards the vault opens with the server's key
provider and the backup's recovery code; add any other ways to unlock again
with `nalamdesk-server key add`.

**Test a restore now and then** on a spare machine: install the server,
restore the backup there, start it and sign in.

## Move a single-computer clinic onto the server

1. In the app on that computer, sign in as admin, open **Settings > Data &
   Backup**, check that **Last backup** is recent, and copy the newest
   `.ndbackup` file to the server. Do this at the end of a day.
2. Have the clinic's recovery code ready.
3. On a server with no vault yet (skip `init`):

   ```sh
   sudo nalamdesk-server import /path/to/nalamdesk-backup.ndbackup
   ```

4. Start the server. Staff sign in with their existing accounts and
   passwords.
5. Stop using the old single-computer copy, or records split between the
   two. You can then connect that computer to the server like any other.

Import checks the backup and the recovery code before it writes anything,
so a wrong code or a damaged file changes nothing.
