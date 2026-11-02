---
sidebar_position: 4
title: Vault keys
---

# How the vault unlocks

The server's database is encrypted. When the server starts, it must unlock
the encryption key without anyone typing a password, or with someone on
hand to type one. You choose how with a **key provider**. The vault can have
several ways to unlock at once (each is a *key slot*), and any one of them
opens it.

## The six key providers

| Provider | Starts unattended | Protects against | Use when |
| :--- | :--- | :--- | :--- |
| `key-file` (default) | Yes | Someone copying the database or backups without the key file | Docker, Windows, and any server with full-disk encryption |
| `systemd-creds` | Yes | Copied files, and the disk moved to another machine | Linux with systemd 250 or later (recommended for the `.deb`) |
| `tpm` | Yes | As above, bound to this machine's TPM 2.0 chip | Linux servers with a TPM |
| `dpapi` | Yes | Copied files, and the disk moved to another machine | Windows, with the vault created by the service account |
| `kms` | Yes | All of the above, with every key use audited | You already run a cloud KMS or HashiCorp Vault |
| `passphrase` | No: someone types it at start, or it is passed as a file | A stolen disk or machine | Someone is on site to start the server |

Set the provider with `NALAMDESK_KEY_PROVIDER` (or `keyProvider` in the
config file) before you run `init`, or add another one later.

## Add or remove a way to unlock

No re-encryption is needed:

```sh
sudo nalamdesk-server key list
sudo nalamdesk-server key add --provider passphrase --label "Owner"
sudo nalamdesk-server key add --provider systemd-creds --label "This server"
sudo nalamdesk-server key add --provider key-file --key-file /secure/usb/vault.key
sudo nalamdesk-server key add --provider dpapi --dpapi-blob C:\ProgramData\NalamDesk\server\vault.dpapi
sudo nalamdesk-server key add --provider kms --key-command "aws kms decrypt ..."
sudo nalamdesk-server key remove <slot-id>
```

Every change is written to the audit log. A good pattern: add a
machine-bound slot (`systemd-creds`, `tpm` or `dpapi`), check that the
server restarts with it, then remove the key file slot. The
[self-hosting guide](https://github.com/nalamdesk/nalamdesk/blob/master/docs/self-hosting.md#systemd-creds-on-the-deb)
has the exact steps for `systemd-creds` on the `.deb`.

**Keep the key file apart from your backups.** A backup and its key file
together open the clinic's records.

## The recovery code

`init` shows the recovery code once. It is always one of the vault's key
slots and cannot be removed.

- It opens the vault when every other way is lost, and it is needed to
  restore a backup on a new machine.
- There is no password reset and no other way in.
- Write it down and keep it offline in two safe places, such as a safe and
  the owner's home.
- Confirm it when `init` asks, or later with
  `nalamdesk-server recovery confirm`. The server warns at every start until
  you do.
