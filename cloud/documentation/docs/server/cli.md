---
sidebar_position: 6
title: Command reference
---

# `nalamdesk-server` commands

Run them with `sudo` on the `.deb`, with `docker compose exec nalamdesk`
(or `docker compose run --rm nalamdesk` while the server is stopped) on
Docker, and in an administrator PowerShell on Windows.

| Command | What it does |
| :--- | :--- |
| `init [--clinic-name <name>]` | Creates the encrypted vault and the admin account, and prints the recovery code once |
| `start` | Unlocks the vault and serves the clinic's computers (the default; the service runs this) |
| `status` | Shows the data directory, whether the vault is set up, how it unlocks, the listen address and the off-site backup target |
| `import <backup.ndbackup>` | Moves a single-computer clinic onto a new server from its backup |
| `key list` | Lists the ways the vault can unlock |
| `key add --provider <provider> [...]` | Adds a way to unlock: `key-file --key-file <path>`, `passphrase`, `systemd-creds` or `tpm` (`--credential-name`, `--credential-path`), `dpapi --dpapi-blob <path>`, `kms --key-command <command>`. `--label` names it |
| `key remove <slot-id>` | Removes a way to unlock (never the recovery code or the last one) |
| `recovery confirm` | Confirms you have saved the recovery code |
| `backup [--out <file>]` | Writes an encrypted backup now |
| `restore <file>` | Replaces the vault with a backup. Stop the server first |
| `join-code [--name <computer>] [--minutes <n>]` | Issues a one-time code that joins a computer (15 minutes by default, up to 1440) |
| `devices list` | Lists joined computers |
| `devices revoke <id>` | Removes a computer and signs out its sessions |

`--config <file>` (or `NALAMDESK_CONFIG`) points any command at a JSON
config file. Secrets are read from `NAME_FILE` variables:
`NALAMDESK_ADMIN_PASSWORD_FILE` for `init`, `NALAMDESK_RECOVERY_CODE_FILE`
for `import` and `restore`, and `NALAMDESK_PASSPHRASE_FILE` for the
passphrase provider.
