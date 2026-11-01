#!/bin/sh
# Installs the .deb in a clean Debian container and moves a desktop backup
# onto it. Run inside the container with /pkg (the .deb), /work (backup,
# recovery code) and /smoke (this folder) mounted.
set -eu
dpkg -i /pkg/nalamdesk-server_*.deb
test "$(stat -c %U:%a /var/lib/nalamdesk)" = "nalamdesk:700"
# Like a backup copied into an admin's home folder: unreadable by the service user.
install -d -m 0700 /root/backups
install -m 0600 /work/clinic.ndbackup /work/code /root/backups/
NALAMDESK_RECOVERY_CODE_FILE=/root/backups/code nalamdesk-server import /root/backups/clinic.ndbackup
test -z "$(ls /tmp | grep nalamdesk-import || true)"
test "$(stat -c %U /var/lib/nalamdesk/security.json)" = "nalamdesk"
nalamdesk-server status | grep -q 'Vault: set up'
nalamdesk-server start > /tmp/server.log 2>&1 &
/opt/nalamdesk-server/runtime/node /smoke/login.js "${SMOKE_URL:-http://127.0.0.1:3000}" admin /work/desktop-password \
    || { cat /tmp/server.log; exit 1; }
