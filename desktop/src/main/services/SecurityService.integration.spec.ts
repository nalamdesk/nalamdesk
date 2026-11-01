import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import * as argon2 from 'argon2';
// @ts-ignore native SQLCipher module
import Database from 'better-sqlite3-multiple-ciphers';
import type { DeviceKeyStore } from './DeviceKeyStore';
import { SecurityService } from './SecurityService';
import { KeyFileStore, PassphraseKeyStore } from './HeadlessKeyStores';
import { DatabaseService } from './DatabaseService';
import { ProvisioningService } from './ProvisioningService';

class IntegrationDeviceStore implements DeviceKeyStore {
    constructor(private readonly mask: number) { }
    status() { return { available: true, provider: 'integration-device-store' }; }
    protect(value: Buffer) { return Buffer.from(value.map(byte => byte ^ this.mask)); }
    unprotect(value: Buffer) { return this.protect(value); }
}

// The native SQLCipher module is rebuilt for Electron by postinstall, so these
// run under Electron's Node mode rather than the host Node ABI.
describe.skipIf(!process.versions.electron)('SecurityService SQLCipher integration', () => {
    let directory: string;
    let dbPath: string;

    beforeEach(() => {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nalamdesk-vault-integration-'));
        dbPath = path.join(directory, 'nalamdesk.db');
    });
    afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

    const createEncryptedDb = (key: Buffer, value = 'legacy-preserved') => {
        const db = new Database(dbPath);
        db.pragma(`key = "x'${key.toString('hex')}'"`);
        db.exec(`CREATE TABLE clinical_data (value TEXT); INSERT INTO clinical_data VALUES ('${value}')`);
        db.close();
    };
    const wrapLegacyV2 = (dek: Buffer, kek: Buffer) => {
        const iv = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv('aes-256-gcm', kek, iv);
        const ciphertext = Buffer.concat([cipher.update(dek), cipher.final()]);
        return {
            iv: iv.toString('hex'),
            wrappedKey: Buffer.concat([cipher.getAuthTag(), ciphertext]).toString('hex')
        };
    };

    it('cold-starts the same encrypted database using only the device envelope', async () => {
        const store = new IntegrationDeviceStore(0x42);
        const first = new SecurityService(store);
        await first.setup('admin-login-only', dbPath, directory);
        first.getDb().exec('CREATE TABLE clinical_data (value TEXT); INSERT INTO clinical_data VALUES (\'preserved\')');
        first.completeProvisioning();
        first.closeDb();

        const coldStart = new SecurityService(store);
        await coldStart.initializeDevice(dbPath, directory);
        expect(coldStart.getDb().prepare('SELECT value FROM clinical_data').get()).toEqual({ value: 'preserved' });
        coldStart.closeDb();
    });

    it.each(['migration', 'settings', 'admin'] as const)(
        'rolls back real fresh provisioning after a %s failure and succeeds on retry',
        async failure => {
            const store = new IntegrationDeviceStore(0x44);
            const security = new SecurityService(store);
            const database = new DatabaseService();
            if (failure === 'migration') {
                vi.spyOn(database, 'migrate').mockRejectedValueOnce(new Error('forced migration failure'));
            } else if (failure === 'settings') {
                vi.spyOn(database, 'saveSettings').mockImplementationOnce(() => {
                    throw new Error('forced settings failure');
                });
            } else {
                vi.spyOn(database, 'ensureAdminUser').mockRejectedValueOnce(new Error('forced admin failure'));
            }
            await expect(new ProvisioningService(security, database).provision(
                'admin-password', { clinic_name: 'Test Clinic' }, dbPath, directory
            )).rejects.toThrow(`forced ${failure} failure`);
            expect(fs.existsSync(dbPath)).toBe(false);
            expect(fs.existsSync(path.join(directory, 'security.json'))).toBe(false);
            expect(fs.existsSync(path.join(directory, 'security-setup.json'))).toBe(false);

            const retrySecurity = new SecurityService(store);
            const retryDatabase = new DatabaseService();
            const code = await new ProvisioningService(retrySecurity, retryDatabase).provision(
                'admin-password', { clinic_name: 'Test Clinic' }, dbPath, directory
            );
            expect(retrySecurity.getPendingRecoveryCode()).toBe(code);
            expect(await retryDatabase.validateUser('admin', 'admin-password')).toMatchObject({ success: true });
            retrySecurity.closeDb();
            await expect(new SecurityService(store).initializeDevice(dbPath, directory))
                .resolves.toEqual({ migrated: false });
        }
    );

    it('cold-starts a headless vault from a key file, and from a passphrase', async () => {
        const keyStore = KeyFileStore.create(path.join(directory, 'vault.key'));
        const first = new SecurityService(keyStore);
        await first.setup('admin-login-only', dbPath, directory);
        first.getDb().exec('CREATE TABLE clinical_data (value TEXT); INSERT INTO clinical_data VALUES (\'headless\')');
        first.completeProvisioning();
        first.closeDb();

        const restart = new SecurityService(new KeyFileStore(path.join(directory, 'vault.key')));
        await restart.initializeDevice(dbPath, directory);
        expect(restart.getDb().prepare('SELECT value FROM clinical_data').get()).toEqual({ value: 'headless' });
        restart.closeDb();

        const passphraseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nalamdesk-vault-passphrase-'));
        try {
            const passphraseDb = path.join(passphraseDir, 'nalamdesk.db');
            const owner = new SecurityService(new PassphraseKeyStore('correct horse battery', { logN: 14 }));
            await owner.setup('admin-login-only', passphraseDb, passphraseDir);
            owner.completeProvisioning();
            owner.closeDb();

            await expect(new SecurityService(new PassphraseKeyStore('wrong horse battery', { logN: 14 }))
                .initializeDevice(passphraseDb, passphraseDir)).rejects.toThrow('DEVICE_UNLOCK_FAILED');
            const unlocked = new SecurityService(new PassphraseKeyStore('correct horse battery', { logN: 14 }));
            await unlocked.initializeDevice(passphraseDb, passphraseDir);
            unlocked.closeDb();
        } finally {
            fs.rmSync(passphraseDir, { recursive: true, force: true });
        }
    });

    it('opens one real vault through a desktop slot, a key file slot, and a passphrase slot', async () => {
        const owner = new SecurityService(new IntegrationDeviceStore(0x46));
        await owner.setup('admin-login-only', dbPath, directory);
        owner.getDb().exec('CREATE TABLE clinical_data (value TEXT); INSERT INTO clinical_data VALUES (\'slotted\')');
        owner.completeProvisioning();
        owner.addKeySlot(KeyFileStore.create(path.join(directory, 'vault.key')), 'Key file');
        owner.addKeySlot(new PassphraseKeyStore('correct horse battery', { logN: 14 }), 'Passphrase');
        owner.closeDb();

        for (const store of [
            new IntegrationDeviceStore(0x46),
            new KeyFileStore(path.join(directory, 'vault.key')),
            new PassphraseKeyStore('correct horse battery', { logN: 14 })
        ]) {
            const service = new SecurityService(store);
            await service.initializeDevice(dbPath, directory);
            expect(service.getDb().prepare('SELECT value FROM clinical_data').get()).toEqual({ value: 'slotted' });
            service.closeDb();
        }
    });

    it('re-enrols a new device through the recovery envelope', async () => {
        const original = new SecurityService(new IntegrationDeviceStore(0x11));
        const code = await original.setup('admin-login-only', dbPath, directory);
        original.completeProvisioning();
        original.closeDb();

        const replacementStore = new IntegrationDeviceStore(0x77);
        const replacement = new SecurityService(replacementStore);
        await expect(replacement.recoverDevice(code, directory, dbPath)).resolves.toEqual({ migrated: false });
        replacement.closeDb();
        await expect(new SecurityService(replacementStore).initializeDevice(dbPath, directory)).resolves.toEqual({ migrated: false });
    });

    it('rejects valid key material paired with a different vault identity', async () => {
        const store = new IntegrationDeviceStore(0x42);
        const service = new SecurityService(store);
        await service.setup('admin-login-only', dbPath, directory);
        service.completeProvisioning();
        service.closeDb();
        const configPath = path.join(directory, 'security.json');
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        config.vaultId = '00000000-0000-4000-8000-000000000000';
        fs.writeFileSync(configPath, JSON.stringify(config));

        await expect(new SecurityService(store).initializeDevice(dbPath, directory)).rejects.toThrow('VAULT_BINDING_MISMATCH');
    });

    it('allows admin, doctor, nurse, and receptionist to be first login after separate cold starts', async () => {
        const store = new IntegrationDeviceStore(0x24);
        const setup = new SecurityService(store);
        await setup.setup('admin-password', dbPath, directory);
        setup.getDb().exec(`CREATE TABLE users (
            id INTEGER PRIMARY KEY, username TEXT, password TEXT, role TEXT, name TEXT,
            active INTEGER DEFAULT 1, password_reset_required INTEGER DEFAULT 0
        )`);
        const insert = setup.getDb().prepare('INSERT INTO users (id, username, password, role, name) VALUES (?, ?, ?, ?, ?)');
        const roles = ['admin', 'doctor', 'nurse', 'receptionist'];
        for (const [index, role] of roles.entries()) {
            insert.run(index + 1, role, await argon2.hash(`${role}-password`), role, role);
        }
        setup.completeProvisioning();
        setup.closeDb();

        for (const role of roles) {
            const coldStart = new SecurityService(store);
            await coldStart.initializeDevice(dbPath, directory);
            const database = new DatabaseService();
            database.setDb(coldStart.getDb());
            await expect(database.validateUser(role, `${role}-password`)).resolves.toMatchObject({
                success: true,
                user: { role }
            });
            coldStart.closeDb();
        }
    });

    it('migrates a real v2 SQLCipher database and preserves data across restart', async () => {
        const store = new IntegrationDeviceStore(0x31);
        const builder = new SecurityService(store) as any;
        const dek = crypto.randomBytes(32);
        createEncryptedDb(dek);
        const salt = crypto.randomBytes(16);
        const wrapped = wrapLegacyV2(dek, await builder.deriveLegacyKey('legacy-master', salt));
        fs.writeFileSync(path.join(directory, 'security.json'), JSON.stringify({
            version: 2, salt: salt.toString('hex'), wrappedKey: wrapped.wrappedKey, iv: wrapped.iv
        }));

        const migrated = new SecurityService(store);
        await expect(migrated.migrateLegacy('legacy-master', dbPath, directory)).resolves.toEqual({ migrated: true });
        expect(migrated.getDb().prepare('SELECT value FROM clinical_data').get()).toEqual({ value: 'legacy-preserved' });
        expect(migrated.getPendingRecoveryCode()).toBeTruthy();
        migrated.closeDb();
        await expect(new SecurityService(store).initializeDevice(dbPath, directory)).resolves.toEqual({ migrated: false });
    });

    it('migrates and rekeys a real v1 SQLCipher database', async () => {
        const store = new IntegrationDeviceStore(0x17);
        const builder = new SecurityService(store) as any;
        const salt = crypto.randomBytes(16);
        fs.writeFileSync(path.join(directory, 'salt.bin'), salt);
        const legacyKey = await builder.deriveLegacyKey('legacy-master', salt);
        createEncryptedDb(legacyKey);

        const migrated = new SecurityService(store);
        await migrated.migrateLegacy('legacy-master', dbPath, directory);
        expect(migrated.getDb().prepare('SELECT value FROM clinical_data').get()).toEqual({ value: 'legacy-preserved' });
        expect(fs.existsSync(path.join(directory, 'salt.bin.migrated'))).toBe(true);
    });

    it('restores the real v1 database and old key when migration fails after rekey', async () => {
        const store = new IntegrationDeviceStore(0x61);
        const builder = new SecurityService(store) as any;
        const salt = crypto.randomBytes(16);
        fs.writeFileSync(path.join(directory, 'salt.bin'), salt);
        const legacyKey = await builder.deriveLegacyKey('legacy-master', salt);
        createEncryptedDb(legacyKey, 'rollback-preserved');
        const failing = new SecurityService(store, {
            onStep: step => { if (step === 'migration-after-rekey') throw new Error('forced crash'); }
        });

        await expect(failing.migrateLegacy('legacy-master', dbPath, directory)).rejects.toThrow('forced crash');
        const restored = new Database(dbPath);
        restored.pragma(`key = "x'${legacyKey.toString('hex')}'"`);
        expect(restored.prepare('SELECT value FROM clinical_data').get()).toEqual({ value: 'rollback-preserved' });
        restored.close();
    });

    it.each([
        { version: 1 as const, path: 'final' as const },
        { version: 1 as const, path: 'transition' as const },
        { version: 2 as const, path: 'final' as const },
        { version: 2 as const, path: 'transition' as const }
    ])('survives v$version device loss before acknowledgement through the $path recovery path', async ({ version, path: recoveryPath }) => {
        const legacySecret = `legacy-v${version}`;
        const oldStore = new IntegrationDeviceStore(0x21);
        const builder = new SecurityService(oldStore) as any;
        if (version === 1) {
            const salt = crypto.randomBytes(16);
            fs.writeFileSync(path.join(directory, 'salt.bin'), salt);
            createEncryptedDb(await builder.deriveLegacyKey(legacySecret, salt), 'device-loss-preserved');
        } else {
            const dek = crypto.randomBytes(32);
            createEncryptedDb(dek, 'device-loss-preserved');
            const salt = crypto.randomBytes(16);
            const wrapped = wrapLegacyV2(dek, await builder.deriveLegacyKey(legacySecret, salt));
            fs.writeFileSync(path.join(directory, 'security.json'), JSON.stringify({
                version: 2, salt: salt.toString('hex'), wrappedKey: wrapped.wrappedKey, iv: wrapped.iv
            }));
        }

        const migrated = new SecurityService(oldStore);
        await migrated.migrateLegacy(legacySecret, dbPath, directory);
        const pendingFinalCode = migrated.getPendingRecoveryCode()!;
        migrated.closeDb();

        const newStore = new IntegrationDeviceStore(0x72);
        const recovered = new SecurityService(newStore);
        await recovered.recoverDevice(
            recoveryPath === 'final' ? pendingFinalCode : legacySecret,
            directory,
            dbPath
        );
        expect(recovered.getDb().prepare('SELECT value FROM clinical_data').get())
            .toEqual({ value: 'device-loss-preserved' });
        if (recoveryPath === 'final') {
            expect(recovered.getPendingRecoveryCode()).toBeNull();
        } else {
            const rotatedCode = recovered.getPendingRecoveryCode();
            expect(rotatedCode).toBeTruthy();
            recovered.acknowledgePendingRecoveryCode(rotatedCode!);
        }
        recovered.closeDb();
        await expect(new SecurityService(newStore).initializeDevice(dbPath, directory))
            .resolves.toEqual({ migrated: false });
        await expect(new SecurityService(oldStore).initializeDevice(dbPath, directory))
            .rejects.toThrow('DEVICE_UNLOCK_FAILED');
    });
});
