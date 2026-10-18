import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as argon2 from 'argon2';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { DeviceKeyStore } from './DeviceKeyStore';
import { SecurityService } from './SecurityService';
import { DatabaseService } from './DatabaseService';
import { CredentialRotationService, CredentialRotationStep } from './CredentialRotationService';

class IntegrationDeviceStore implements DeviceKeyStore {
    constructor(private readonly mask: number) { }
    status() { return { available: true, provider: 'credential-integration-store' }; }
    protect(value: Buffer) { return Buffer.from(value.map(byte => byte ^ this.mask)); }
    unprotect(value: Buffer) { return this.protect(value); }
}

describe.skipIf(!process.versions.electron)('CredentialRotationService SQLCipher integration', () => {
    let directory: string;
    let dbPath: string;
    let store: IntegrationDeviceStore;
    let security: SecurityService;
    let database: DatabaseService;
    let recoveryCode: string;

    beforeEach(async () => {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nalamdesk-credential-integration-'));
        dbPath = path.join(directory, 'nalamdesk.db');
        store = new IntegrationDeviceStore(0x45);
        security = new SecurityService(store);
        recoveryCode = await security.setup('not-used-for-vault', dbPath, directory);
        database = new DatabaseService();
        database.setDb(security.getDb());
        await database.migrate({ skipBackup: true });
        await database.ensureAdminUser('admin-current');
        await database.saveUser({
            username: 'doctor', password: 'doctor-current', role: 'doctor', name: 'Doctor',
            license_number: 'MED-E2E-1'
        });
        security.completeProvisioning();
    });

    afterEach(() => {
        security?.closeDb();
        fs.rmSync(directory, { recursive: true, force: true });
    });

    const restart = async () => {
        security.closeDb();
        security = new SecurityService(store);
        await security.initializeDevice(dbPath, directory);
        database = new DatabaseService();
        database.setDb(security.getDb());
        await database.migrate({ skipBackup: true });
        const rotations = new CredentialRotationService();
        rotations.setDb(security.getDb());
        rotations.reconcileInterruptedRotation();
        return rotations;
    };

    it('binds a freshly provisioned same-process vault and changes login across restart without changing vault metadata', async () => {
        const configBefore = fs.readFileSync(path.join(directory, 'security.json'));
        const rotations = new CredentialRotationService();
        rotations.setDb(security.getDb());
        await rotations.changeOwnPassword(1, 'admin-current', 'admin-replacement');

        await restart();
        expect(await database.validateUser('admin', 'admin-current')).toMatchObject({ success: false });
        expect(await database.validateUser('admin', 'admin-replacement')).toMatchObject({ success: true });
        expect(fs.readFileSync(path.join(directory, 'security.json'))).toEqual(configBefore);
    });

    it('rejects an invalid current credential without creating a journal', async () => {
        const rotations = new CredentialRotationService();
        rotations.setDb(security.getDb());
        await expect(rotations.changeOwnPassword(1, 'wrong-current', 'admin-replacement'))
            .rejects.toThrow('INVALID_CREDENTIALS');
        expect(security.getDb().prepare('SELECT COUNT(*) AS count FROM credential_rotation_journal').get())
            .toEqual({ count: 0 });
        expect(await database.validateUser('admin', 'admin-current')).toMatchObject({ success: true });
    });

    it('migrates an existing encrypted v7 database without changing clinic data or credentials', async () => {
        security.getDb().exec(`
            CREATE TABLE preserved_clinic_data(value TEXT);
            INSERT INTO preserved_clinic_data VALUES ('preserved');
            DROP TABLE credential_rotation_journal;
        `);
        security.getDb().pragma('user_version = 7');
        await database.migrate({ skipBackup: true });
        expect(security.getDb().prepare('SELECT value FROM preserved_clinic_data').get())
            .toEqual({ value: 'preserved' });
        expect(await database.validateUser('admin', 'admin-current')).toMatchObject({ success: true });
        expect(security.getDb().pragma('user_version', { simple: true })).toBe(11);
    });

    it.each(['after-prepare', 'after-apply'] as CredentialRotationStep[])(
        'rolls back an interruption at %s on the next encrypted-database unlock',
        async interruptedStep => {
            const rotations = new CredentialRotationService({
                onStep: step => { if (step === interruptedStep) throw new Error('simulated process death'); }
            });
            rotations.setDb(security.getDb());
            await expect(rotations.changeOwnPassword(1, 'admin-current', 'admin-replacement'))
                .rejects.toThrow('simulated process death');

            await restart();
            expect(await database.validateUser('admin', 'admin-current')).toMatchObject({ success: true });
            expect(await database.validateUser('admin', 'admin-replacement')).toMatchObject({ success: false });
            expect(security.getDb().prepare('SELECT COUNT(*) AS count FROM credential_rotation_journal').get())
                .toEqual({ count: 0 });
        }
    );

    it('keeps the completed credential authoritative if notification fails after the commit boundary', async () => {
        const rotations = new CredentialRotationService({
            onStep: step => { if (step === 'after-complete') throw new Error('post-commit notification failure'); }
        });
        rotations.setDb(security.getDb());
        await expect(rotations.changeOwnPassword(1, 'admin-current', 'admin-replacement'))
            .rejects.toThrow('post-commit notification failure');
        await restart();
        expect(await database.validateUser('admin', 'admin-current')).toMatchObject({ success: false });
        expect(await database.validateUser('admin', 'admin-replacement')).toMatchObject({ success: true });
    });

    it('requires the current admin credential for a separate staff reset workflow', async () => {
        const doctor = database.getUserByUsername('doctor');
        const rotations = new CredentialRotationService();
        rotations.setDb(security.getDb());
        await expect(rotations.resetUserPassword(1, 'wrong', doctor.id, 'doctor-temporary'))
            .rejects.toThrow('INVALID_CREDENTIALS');
        await rotations.resetUserPassword(1, 'admin-current', doctor.id, 'doctor-temporary');
        await restart();
        expect(await database.validateUser('doctor', 'doctor-current')).toMatchObject({ success: false });
        expect(await database.validateUser('doctor', 'doctor-temporary')).toMatchObject({
            success: true, user: { password_reset_required: 1 }
        });
    });

    it.each([
        ['demoted', "UPDATE users SET role = 'doctor' WHERE id = 1"],
        ['deactivated', 'UPDATE users SET active = 0 WHERE id = 1']
    ])('rejects a staff reset when the administrator is %s during password hashing', async (_state, sql) => {
        const doctor = database.getUserByUsername('doctor');
        const rotations = new CredentialRotationService({
            onStep: step => {
                if (step === 'after-hash') security.getDb().prepare(sql).run();
            }
        });
        rotations.setDb(security.getDb());

        await expect(rotations.resetUserPassword(1, 'admin-current', doctor.id, 'doctor-temporary'))
            .rejects.toThrow('CREDENTIAL_CHANGED_CONCURRENTLY');
        expect(await database.validateUser('doctor', 'doctor-current')).toMatchObject({ success: true });
        expect(await database.validateUser('doctor', 'doctor-temporary')).toMatchObject({ success: false });
        expect(security.getDb().prepare('SELECT COUNT(*) AS count FROM credential_rotation_journal').get())
            .toEqual({ count: 0 });
    });

    it('rejects a self-service rotation when the user is deactivated during password hashing', async () => {
        const doctor = database.getUserByUsername('doctor');
        const rotations = new CredentialRotationService({
            onStep: step => {
                if (step === 'after-hash') {
                    security.getDb().prepare('UPDATE users SET active = 0 WHERE id = ?').run(doctor.id);
                }
            }
        });
        rotations.setDb(security.getDb());

        await expect(rotations.changeOwnPassword(doctor.id, 'doctor-current', 'doctor-replacement'))
            .rejects.toThrow('CREDENTIAL_CHANGED_CONCURRENTLY');
        const stored = security.getDb().prepare('SELECT password FROM users WHERE id = ?').get(doctor.id);
        expect(await argon2.verify(stored.password, 'doctor-current')).toBe(true);
        expect(await argon2.verify(stored.password, 'doctor-replacement')).toBe(false);
        expect(security.getDb().prepare('SELECT COUNT(*) AS count FROM credential_rotation_journal').get())
            .toEqual({ count: 0 });
    });

    it('lets a forced-reset user change their own temporary credential and clears the reset flag', async () => {
        const doctor = database.getUserByUsername('doctor');
        const rotations = new CredentialRotationService();
        rotations.setDb(security.getDb());
        await rotations.changeOwnPassword(doctor.id, 'doctor-current', 'doctor-permanent');
        await restart();
        expect(await database.validateUser('doctor', 'doctor-permanent')).toMatchObject({
            success: true, user: { password_reset_required: 0 }
        });
    });

    it('rejects existing-user password fields through the real encrypted generic edit path', async () => {
        const admin = database.getUserByUsername('admin');
        await expect(database.saveUser({
            ...admin,
            password: 'generic-bypass-attempt'
        }, admin.id)).rejects.toThrow('GENERIC_PASSWORD_CHANGE_FORBIDDEN');
        expect(await database.validateUser('admin', 'admin-current')).toMatchObject({ success: true });
        expect(await database.validateUser('admin', 'generic-bypass-attempt')).toMatchObject({ success: false });
    });

    it('keeps login, device-envelope, and recovery rotations independent and recoverable', async () => {
        const rotations = new CredentialRotationService();
        rotations.setDb(security.getDb());
        await rotations.changeOwnPassword(1, 'admin-current', 'admin-replacement');

        security.rotateDeviceEnvelope();
        const afterDevice = fs.readFileSync(path.join(directory, 'security.json'));
        expect(JSON.parse(afterDevice.toString())).toMatchObject({ version: 3 });
        expect(await database.validateUser('admin', 'admin-replacement')).toMatchObject({ success: true });

        const newRecoveryCode = await security.regenerateRecoveryCode();
        expect(security.getPendingRecoveryCode()).toBe(newRecoveryCode);
        const afterRecovery = fs.readFileSync(path.join(directory, 'security.json'));
        expect(afterRecovery).not.toEqual(afterDevice);
        expect(await database.validateUser('admin', 'admin-replacement')).toMatchObject({ success: true });
        security.acknowledgePendingRecoveryCode(newRecoveryCode);

        security.closeDb();
        const replacementStore = new IntegrationDeviceStore(0x72);
        security = new SecurityService(replacementStore);
        await expect(security.recoverDevice(recoveryCode, directory, dbPath)).rejects.toThrow('INVALID_RECOVERY_CODE');
        await security.recoverDevice(newRecoveryCode, directory, dbPath);
        database = new DatabaseService();
        database.setDb(security.getDb());
        expect(await database.validateUser('admin', 'admin-replacement')).toMatchObject({ success: true });
    });

    it('keeps the old recovery authoritative until the proposed code is acknowledged', async () => {
        const before = JSON.parse(fs.readFileSync(path.join(directory, 'security.json'), 'utf8'));
        const proposedCode = await security.regenerateRecoveryCode();
        const pending = JSON.parse(fs.readFileSync(path.join(directory, 'security.json'), 'utf8'));
        expect(pending.recovery).toEqual(before.recovery);
        expect(pending.pendingRecoveryAck.nextRecovery).toBeTruthy();
        expect(JSON.stringify(pending)).not.toContain(proposedCode);
        expect(security.getPortableVaultMetadata().recovery).toEqual(before.recovery);

        security.closeDb();
        const replacementStore = new IntegrationDeviceStore(0x73);
        security = new SecurityService(replacementStore);
        await expect(security.recoverDevice(proposedCode, directory, dbPath))
            .rejects.toThrow('INVALID_RECOVERY_CODE');
        await expect(security.recoverDevice(recoveryCode, directory, dbPath))
            .resolves.toEqual({ migrated: false });
    });

    it('keeps a rotated recovery code pending across restart until exact acknowledgement', async () => {
        const before = JSON.parse(fs.readFileSync(path.join(directory, 'security.json'), 'utf8'));
        const rotatedCode = await security.regenerateRecoveryCode();
        const configText = fs.readFileSync(path.join(directory, 'security.json'), 'utf8');
        expect(configText).not.toContain(rotatedCode);
        await restart();
        expect(security.getPendingRecoveryCode()).toBe(rotatedCode);
        expect(() => security.acknowledgePendingRecoveryCode(`${rotatedCode}X`))
            .toThrow('INVALID_RECOVERY_ACK');
        expect(security.getPendingRecoveryCode()).toBe(rotatedCode);
        const afterWrongAck = JSON.parse(fs.readFileSync(path.join(directory, 'security.json'), 'utf8'));
        expect(afterWrongAck.recovery).toEqual(before.recovery);
        expect(afterWrongAck.pendingRecoveryAck).toBeTruthy();
        security.acknowledgePendingRecoveryCode(rotatedCode);
        expect(security.getPendingRecoveryCode()).toBeNull();
        const activated = JSON.parse(fs.readFileSync(path.join(directory, 'security.json'), 'utf8'));
        expect(activated.recovery).not.toEqual(before.recovery);
        expect(activated.pendingRecoveryAck).toBeUndefined();
    });

    it('never stores submitted plaintext credentials in the journal', async () => {
        const rotations = new CredentialRotationService({
            onStep: step => { if (step === 'after-prepare') throw new Error('inspect journal'); }
        });
        rotations.setDb(security.getDb());
        await expect(rotations.changeOwnPassword(1, 'admin-current', 'plaintext-sentinel'))
            .rejects.toThrow('inspect journal');
        const journal = security.getDb().prepare('SELECT * FROM credential_rotation_journal').get();
        expect(JSON.stringify(journal)).not.toContain('admin-current');
        expect(JSON.stringify(journal)).not.toContain('plaintext-sentinel');
        expect(await argon2.verify(journal.previous_hash, 'admin-current')).toBe(true);
        expect(await argon2.verify(journal.replacement_hash, 'plaintext-sentinel')).toBe(true);
    });
});
