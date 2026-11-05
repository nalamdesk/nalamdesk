#!/usr/bin/env node
/**
 * Test helper for the server smoke test: makes a backup bundle the way the
 * desktop app does (a vault unlocked by a device keychain, then "Back up
 * now"), so `nalamdesk-server import` can be tested end to end.
 *
 *   node make-desktop-backup.js <server-dist-dir> <out-dir>
 *
 * <server-dist-dir> is a server build's dist/server folder. Writes
 * clinic.ndbackup, code (its recovery code) and desktop-password to <out-dir>.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

async function main() {
    const [distDir, outDir] = process.argv.slice(2);
    if (!distDir || !outDir) {
        console.error('Usage: make-desktop-backup.js <server-dist-dir> <out-dir>');
        process.exit(2);
    }
    fs.mkdirSync(outDir, { recursive: true });
    const bundlePath = path.join(outDir, 'clinic.ndbackup');
    const password = 'desktop-admin-password';
    const services = path.resolve(distDir, 'main', 'services');
    const { SecurityService } = require(path.join(services, 'SecurityService.js'));
    const { DatabaseService } = require(path.join(services, 'DatabaseService.js'));
    const { ProvisioningService } = require(path.join(services, 'ProvisioningService.js'));
    const { BackupService } = require(path.join(services, 'BackupService.js'));

    // Stands in for the desktop keychain (Electron safeStorage).
    const keychain = {
        status: () => ({ available: true, provider: 'electron-safe-storage' }),
        protect: (value) => Buffer.from(value.map((byte) => byte ^ 0x5a)),
        unprotect: (value) => Buffer.from(value.map((byte) => byte ^ 0x5a))
    };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nalamdesk-desktop-'));
    try {
        const dbPath = path.join(dir, 'nalamdesk.db');
        const security = new SecurityService(keychain);
        const database = new DatabaseService();
        const code = await new ProvisioningService(security, database)
            .provision(password, { clinic_name: 'Smoke Test Clinic' }, dbPath, dir);
        database.setDb(security.getDb());
        const backups = new BackupService(database, security, dir, { appVersion: 'smoke' });
        await backups.createBackupBundle(bundlePath);
        security.closeDb();
        fs.writeFileSync(path.join(outDir, 'code'), `${code}\n`, { mode: 0o600 });
        fs.writeFileSync(path.join(outDir, 'desktop-password'), `${password}\n`, { mode: 0o600 });
        console.log(`Wrote a desktop backup of "Smoke Test Clinic" to ${bundlePath}`);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

main().catch((error) => { console.error(error); process.exit(1); });
