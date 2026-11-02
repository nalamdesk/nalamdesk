---
sidebar_position: 1
title: One computer or many
---

# One computer or many

NalamDesk runs in one of two ways. Pick the one that fits the clinic.

| | Single computer | NalamDesk Server |
| :--- | :--- | :--- |
| **Who it suits** | A clinic that works on one computer | A clinic, hospital or group of branches with several computers |
| **Where records live** | Encrypted on that computer | Encrypted on a server the clinic controls |
| **What staff use** | The NalamDesk app | The NalamDesk app or a web browser, on any joined computer |
| **Without internet** | Everything keeps working | Keeps working as long as computers can reach the server |
| **Backups** | Daily, on that computer | Daily, on the server, with optional off-site copies |

Both use the same screens, roles and records. A clinic can start on one
computer and [move onto a server](./backups-and-restore.md#move-a-single-computer-clinic-onto-the-server)
later without losing anything.

## How NalamDesk Server works

NalamDesk Server is a program with no screen of its own. It holds the
clinic's encrypted database and serves the same NalamDesk screens to the
clinic's computers:

- **The NalamDesk app** on Windows or Linux. On first run, choose
  **Connect this computer to it** instead of setting up a new clinic. The
  computer keeps no patient records; it only remembers the server's address
  and its own sign-in credential. See [Connect computers](./connect-computers.md).
- **A web browser** pointed at the server's address. The browser is asked
  for a join code the first time.

Each computer joins once with a one-time **join code** from an admin. Staff
then sign in with their own accounts. Changes made on one computer, such as
a patient joining the queue, show on the others within a second or two.

Patient records stay on your server. They are never sent to NalamDesk Cloud.

## Where to put the server

Clinic computers stop working when they cannot reach the server, so choose
its place with care:

- **Where the internet is unreliable, put the server on the clinic
  network**: a small always-on PC or mini server, wired to the router.
  Computers then keep working through an internet outage.
- **A server in a data centre or the cloud** suits a group of branches with
  reliable internet. An outage at one branch stops that branch.
- **A clinic with one computer does not need a server.** The app keeps its
  own database.

2 CPU cores, 2 GB of RAM and 10 GB of disk are enough for a clinic. Use an
SSD, a UPS, and full-disk encryption (LUKS on Linux, BitLocker on Windows).

## Next steps

1. [Install NalamDesk Server](./install.md) with Docker, a Debian or Ubuntu
   package, or as a Windows service.
2. [Choose how the vault unlocks](./vault-keys.md) and store the recovery
   code offline.
3. [Connect the clinic's computers](./connect-computers.md).
4. [Set up backups](./backups-and-restore.md), including an off-site copy.
5. If the clinic has branches or departments, set up
   [facilities](../user-guide/facilities.md).
