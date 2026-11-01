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
NODE=/opt/nalamdesk-server/runtime/node
URL="${SMOKE_URL:-https://127.0.0.1:3000}"
$NODE /smoke/login.js wait "$URL" || { cat /tmp/server.log; exit 1; }
# join-code reads serving.json, which start writes just after it binds.
CODE=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
    CODE="$(nalamdesk-server join-code --name "Smoke test" 2>/dev/null | grep -oE '[0-9A-Z]{5}(-[0-9A-Z]{5}){3}' | head -n 1 || true)"
    [ -n "$CODE" ] && break
    sleep 1
done
NODE_EXTRA_CA_CERTS=/var/lib/nalamdesk/tls/server.crt $NODE /smoke/login.js "$URL" admin /work/desktop-password "$CODE" || { cat /tmp/server.log; exit 1; }
