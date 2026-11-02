---
sidebar_position: 3
title: Connect computers
---

# Connect the clinic's computers

Each computer joins the server once with a **join code**, then staff sign in
with their own accounts.

## Get a join code

An admin can issue a code from any computer already joined, in
**Settings > Computers > Get a join code** (give the computer a name, such
as "Reception"). Or on the server:

```sh
sudo nalamdesk-server join-code --name "Reception"                    # .deb
docker compose exec nalamdesk nalamdesk-server join-code --name "Reception"   # Docker
nalamdesk-server join-code --name "Reception"                         # Windows, as administrator
```

A code works once, for 15 minutes (`--minutes N` for longer, up to a day).
It also carries part of the server's certificate fingerprint, so the
computer can tell it reached the right server. The server must have
started once before it can issue codes.

## Join with the NalamDesk app

1. Install the NalamDesk app on the computer, as for a single computer.
2. On the welcome screen, under *Your clinic or hospital runs a NalamDesk
   Server?*, choose **Connect this computer to it**.
3. Enter the **Server address** (for example `nalamdesk.myclinic.in` or
   `192.168.1.20:3000`), the **Join code** and a **Name for this computer**.
4. Click **Connect**. NalamDesk restarts and shows the sign-in screen.

The computer keeps no patient records, backups or keys. It stores only the
server's address, its certificate and its own credential, sealed with the
operating system's keychain. Printing still happens on the computer, and
the app keeps updating itself. A computer that already holds a
single-computer clinic cannot join; move that clinic onto the server first
(see [Backups and restore](./backups-and-restore.md#move-a-single-computer-clinic-onto-the-server)).

To take a computer off the server, choose **Disconnect this computer** on
the sign-in screen. It restarts as a fresh install.

## Join with a web browser

Open `https://<server address>` in Chrome, Edge or Firefox. The first time,
the sign-in page asks for a join code; after that the browser signs in like
the app. Each browser tab has its own session.

## When the server cannot be reached

Joined computers do not work offline. If the server is unreachable, a
banner says so and NalamDesk reconnects by itself as soon as it can. If the
server and the computer are on different versions, the banner says which
one needs to be upgraded.

## See and remove computers

**Settings > Computers** lists every joined computer with when it joined and
when it was last seen. **Remove** signs it out at once and stops it from
connecting again. Use it for a lost, stolen or retired computer. On the
server, `nalamdesk-server devices list` and
`nalamdesk-server devices revoke <id>` do the same.

## What admins can do from any computer

Signed in as an admin on a joined computer, you can manage users,
facilities, catalogs, Cloud pairing and ABDM, see backup health and the
list of server backups, and run a backup now. Restoring a backup is done on
the server itself (see [Backups and restore](./backups-and-restore.md)).
