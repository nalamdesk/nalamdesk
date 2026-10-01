import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BackupService, type BackupStep } from './BackupService';
import { CronJob } from 'cron';
import type { GoogleDriveService } from './GoogleDriveService';
import type { SecurityService, SecurityConfigV3 } from './SecurityService';
import { DatabaseService } from './DatabaseService';
import { MIGRATIONS } from '../schema/migrations';

const cron = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn() }));
vi.mock('cron', () => ({ CronJob: vi.fn(function CronJob() { return { start: cron.start, stop: cron.stop }; }) }));

const envelope = {
    algorithm: 'aes-256-gcm' as const, kdf: 'argon2id' as const,
    kdfParams: { timeCost: 3, memoryCost: 65536, parallelism: 1, hashLength: 32 },
    salt: '11'.repeat(16), iv: '22'.repeat(12), wrappedKey: '33'.repeat(48), aadVersion: 1 as const
};
const portable = { version: 3 as const, vaultId: 'vault-source', keyVersion: 1, recovery: envelope };
const liveConfig = (): SecurityConfigV3 => ({
    ...portable, device: { provider: 'test', protectedPayload: 'device-only' }
});

describe('BackupService recoverable bundles', () => {
    let root: string;
    let sourceUserData: string;
    let sourceDb: string;
    let bundle: string;

    beforeEach(() => {
        vi.clearAllMocks();
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'nalamdesk-backup-'));
        sourceUserData = path.join(root, 'source');
        sourceDb = path.join(sourceUserData, 'nalamdesk-test.db');
        bundle = path.join(root, 'portable.ndbackup');
        fs.mkdirSync(sourceUserData, { recursive: true });
        fs.writeFileSync(sourceDb, Buffer.from('encrypted-sqlcipher-source-data'));
    });
    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

    function drive(): GoogleDriveService {
        return { isAuthenticated: vi.fn(() => false), uploadFile: vi.fn() } as unknown as GoogleDriveService;
    }

    it('preserves default scheduling and stops replaced jobs', () => {
        const db = database(sourceDb);
        (db.getSettings as any).mockReturnValue(null);
        const service = new BackupService(db, drive(), sourceSecurity(), sourceUserData);
        service.initAutomatedBackup();
        expect(CronJob).toHaveBeenCalledWith('0 00 13 * * *', expect.any(Function));
        expect(cron.start).toHaveBeenCalledTimes(2);
        service.scheduleLocalBackup('14:00');
        service.scheduleCloudBackup('15:00');
        expect(cron.stop).toHaveBeenCalledTimes(2);
    });

    it('preserves configured local/cloud schedules', () => {
        const db = database(sourceDb);
        (db.getSettings as any).mockReturnValue({ backup_schedule: '02:30', cloud_backup_schedule: '03:45' });
        new BackupService(db, drive(), sourceSecurity(), sourceUserData).initAutomatedBackup();
        expect(CronJob).toHaveBeenCalledWith('0 30 02 * * *', expect.any(Function));
        expect(CronJob).toHaveBeenCalledWith('0 45 03 * * *', expect.any(Function));
    });

    it('falls back to the default when stored schedules predate validation', () => {
        const db = database(sourceDb);
        (db.getSettings as any).mockReturnValue({ backup_schedule: '99:99', cloud_backup_schedule: null });
        new BackupService(db, drive(), sourceSecurity(), sourceUserData).initAutomatedBackup();
        expect(CronJob).toHaveBeenCalledWith('0 00 13 * * *', expect.any(Function));
        expect(CronJob).not.toHaveBeenCalledWith(expect.stringContaining('99'), expect.anything());
    });

    it('repairs an invalid stored schedule with an audit trail', () => {
        const db = database(sourceDb) as any;
        db.saveSettings = vi.fn();
        (db.getSettings as any).mockReturnValue({ backup_schedule: '99:99' });
        new BackupService(db, drive(), sourceSecurity(), sourceUserData).initAutomatedBackup();
        expect(db.saveSettings).toHaveBeenCalledWith({ backup_schedule: '13:00' });
        expect(db.logAudit).toHaveBeenCalledWith('BACKUP_ERROR', 'system', 0, 0,
            expect.stringContaining('reset to 13:00'));
    });

    it('keeps the running job when a reschedule expression is invalid', () => {
        const db = database(sourceDb);
        const service = new BackupService(db, drive(), sourceSecurity(), sourceUserData);
        service.scheduleLocalBackup('14:00');
        const stopsBefore = (cron.stop as any).mock.calls.length;
        vi.mocked(CronJob).mockImplementationOnce(((expr: unknown) => {
            throw new Error(`bad cron: ${expr}`);
        }) as any);
        expect(() => service.scheduleLocalBackup('not-a-time')).not.toThrow();
        // Old job untouched: build-first-swap means no stop without a replacement.
        expect((cron.stop as any).mock.calls.length).toBe(stopsBefore);
        service.scheduleLocalBackup('15:00');
        expect(CronJob).toHaveBeenCalledWith('0 00 15 * * *', expect.any(Function));
    });

    describe('nextDailyRun', () => {
        it('fires later today when the time is ahead', () => {
            const at = BackupService.nextDailyRun('13:00', new Date('2026-03-10T09:00:00'));
            expect(at).toBe(new Date('2026-03-10T13:00:00').toISOString());
        });

        it('rolls to tomorrow once the time has passed', () => {
            const at = BackupService.nextDailyRun('06:30', new Date('2026-03-10T18:00:00'));
            expect(at).toBe(new Date('2026-03-11T06:30:00').toISOString());
        });

        it('rejects non-HH:MM expressions', () => {
            expect(BackupService.nextDailyRun('bogus')).toBeNull();
            expect(BackupService.nextDailyRun('0 0 13 * * *')).toBeNull();
            expect(BackupService.nextDailyRun('99:99')).toBeNull();
            expect(BackupService.nextDailyRun('25:70')).toBeNull();
        });

        it('range-checks schedule times', () => {
            expect(BackupService.isValidScheduleTime('13:00')).toBe(true);
            expect(BackupService.isValidScheduleTime('00:00')).toBe(true);
            expect(BackupService.isValidScheduleTime('23:59')).toBe(true);
            expect(BackupService.isValidScheduleTime('99:99')).toBe(false);
            expect(BackupService.isValidScheduleTime('24:00')).toBe(false);
            expect(BackupService.isValidScheduleTime('13:60')).toBe(false);
            expect(BackupService.isValidScheduleTime('13:0')).toBe(false);
            expect(BackupService.isValidScheduleTime('bogus')).toBe(false);
        });
    });

    describe('getLocalBackupHealth', () => {
        function healthService(audits: any[] = []) {
            const db = database(sourceDb);
            (db.getSettings as any).mockReturnValue({ backup_schedule: '13:00' });
            (db as any).getAuditLogs = vi.fn(() => audits);
            return new BackupService(db, drive(), sourceSecurity(), sourceUserData);
        }

        it('reports a healthy recent backup with free space', async () => {
            const service = healthService();
            vi.spyOn(service, 'listSystemBackups').mockResolvedValue([{
                name: 'nalamdesk-auto-backup-fresh.ndbackup', path: 'x',
                createdTime: new Date(), size: 10, format: 'bundle-v1', recoverable: true
            } as any]);
            const health = await service.getLocalBackupHealth(new Date());
            expect(health.schedule).toBe('13:00');
            expect(health.writable).toBe(true);
            expect(health.lastBackupName).toContain('nalamdesk-auto-backup-');
            expect(health.missed).toBe(false);
            expect(health.nextRunAt).not.toBeNull();
            expect(typeof health.freeBytes === 'number' || health.freeBytes === null).toBe(true);
        });

        it('flags missing backups and surfaces the latest failure', async () => {
            const service = healthService([{
                action: 'BACKUP_ERROR', details: 'disk full', timestamp: '2026-03-10 12:00:00'
            }]);
            vi.spyOn(service, 'listSystemBackups').mockResolvedValue([]);
            const health = await service.getLocalBackupHealth(new Date('2026-03-12T12:00:00'));
            expect(health.lastBackupAt).toBeNull();
            expect(health.missed).toBe(true);
            expect(health.lastError).toBe('disk full');
            expect(health.lastErrorAt).toBe('2026-03-10 12:00:00');
        });

        it('reports an unwritable destination instead of throwing', async () => {
            const fileAsDir = path.join(root, 'not-a-dir');
            fs.writeFileSync(fileAsDir, 'x');
            const db = database(sourceDb);
            (db.getSettings as any).mockReturnValue({ backup_schedule: '13:00' });
            (db as any).getAuditLogs = vi.fn(() => []);
            const service = new BackupService(db, drive(), sourceSecurity(), fileAsDir);
            const health = await service.getLocalBackupHealth();
            expect(health.writable).toBe(false);
            expect(health.enabled).toBe(false);
        });
    });

    it('uploads cloud independently when local bundle creation fails', async () => {
        const db = database(sourceDb);
        (db.backupDatabase as any).mockRejectedValue(new Error('local disk full'));
        const cloud = { isAuthenticated: vi.fn(() => true), uploadFile: vi.fn(async () => undefined) } as unknown as GoogleDriveService;
        const security = sourceSecurity();
        const service = new BackupService(db, cloud, security, sourceUserData);
        await expect(service.performBackup()).rejects.toThrow('local disk full');
        expect(cloud.uploadFile).toHaveBeenCalledWith(sourceDb, expect.stringContaining('nalamdesk-cloud-backup-'));
    });

    it('skips cloud when unauthenticated and attempts it on quit when authenticated', async () => {
        const db = database(sourceDb);
        const cloud = { isAuthenticated: vi.fn(() => false), uploadFile: vi.fn(async () => undefined) } as unknown as GoogleDriveService;
        const service = new BackupService(db, cloud, sourceSecurity(), sourceUserData);
        await service.performBackup();
        expect(cloud.uploadFile).not.toHaveBeenCalled();
        (cloud.isAuthenticated as any).mockReturnValue(true);
        await service.performBackupOnQuit();
        expect(cloud.uploadFile).toHaveBeenCalledOnce();
    });
    function database(snapshotSource: string): DatabaseService {
        return {
            backupDatabase: vi.fn(async (destination: string) => fs.copyFileSync(snapshotSource, destination)),
            logAudit: vi.fn(), getSettings: vi.fn(() => null), setDb: vi.fn(),
            fence: vi.fn(async () => undefined), unfence: vi.fn(),
            beginWork: vi.fn(), endWork: vi.fn()
        } as unknown as DatabaseService;
    }
    function sourceSecurity(): SecurityService {
        return {
            getPortableVaultMetadata: vi.fn(() => portable),
            getDb: vi.fn(() => ({ pragma: vi.fn(() => 6) })), getDbPath: vi.fn(() => sourceDb)
        } as unknown as SecurityService;
    }
    function validator(expectedCode = 'correct-code', error?: string, schemaVersion = 6): SecurityService {
        return {
            installPortableVaultMetadata: vi.fn(async (metadata: any, code: string, _db: string, userData: string) => {
                if (error || code !== expectedCode) throw new Error(error || 'INVALID_RECOVERY_CODE');
                fs.writeFileSync(path.join(userData, 'security.json'), JSON.stringify({
                    ...metadata, device: { provider: 'test', protectedPayload: 'new-device' }
                }));
            }), getDb: vi.fn(() => ({ pragma: vi.fn((name: string) => {
                if (name === 'cipher_integrity_check') return [];
                if (name === 'integrity_check') return [{ integrity_check: 'ok' }];
                return schemaVersion;
            }) })), closeDb: vi.fn()
        } as unknown as SecurityService;
    }
    async function createBundle() {
        const service = new BackupService(database(sourceDb), drive(), sourceSecurity(), sourceUserData, { appVersion: 'test' });
        await service.createBackupBundle(bundle);
    }
    function targetService(options: { existing?: boolean; validatorError?: string; validatorSchema?: number;
        failAt?: BackupStep; write?: (fd: number, buffer: Buffer, offset: number, length: number, position: number | null) => number } = {}) {
        const userData = path.join(root, 'target');
        const dbPath = path.join(userData, 'nalamdesk-test.db');
        fs.mkdirSync(userData, { recursive: true });
        if (options.existing) {
            fs.writeFileSync(dbPath, 'encrypted-old-live-data');
            fs.writeFileSync(path.join(userData, 'security.json'), JSON.stringify(liveConfig()));
        }
        const live = {
            getDbPath: vi.fn(() => dbPath), getDb: vi.fn(() => null), closeDb: vi.fn(),
            initializeDevice: vi.fn(async () => ({}))
        } as unknown as SecurityService;
        const db = database(dbPath);
        const committed = vi.fn();
        const service = new BackupService(db, drive(), live, userData, {
            createIsolatedSecurityService: () => validator('correct-code', options.validatorError, options.validatorSchema ?? 6),
            onStep: step => { if (step === options.failAt) throw new Error(`INTERRUPTED_${step}`); },
            onRestoreCommitted: committed,
            write: options.write
        });
        return { service, userData, dbPath, live, db, committed };
    }

    it('writes a versioned bundle with encrypted DB, portable metadata, and no device or plaintext fields', async () => {
        await createBundle();
        const bytes = fs.readFileSync(bundle);
        expect(bytes.subarray(0, 17).toString()).toBe('NALAMDESK-BACKUP\n');
        const text = bytes.toString('utf8');
        expect(text).toContain('nalamdesk-offline-backup');
        expect(text).toContain('vault-source');
        expect(text).not.toContain('device-only');
        expect(text).not.toContain('password');
        expect(text).not.toContain('recoveryCode');
        expect(text).not.toContain('token');
    });

    it('retries short writes while creating and extracting a bundle', async () => {
        const shortWrite = (fd: number, data: Buffer, offset: number, length: number, position: number | null) =>
            fs.writeSync(fd, data, offset, Math.min(length, 3), position);
        await new BackupService(database(sourceDb), drive(), sourceSecurity(), sourceUserData, { write: shortWrite })
            .createBackupBundle(bundle);
        const { service, dbPath } = targetService({ write: shortWrite });
        await expect(service.restoreLocalBackup(bundle, 'correct-code')).resolves.toMatchObject({ success: true });
        expect(fs.readFileSync(dbPath).toString()).toBe('encrypted-sqlcipher-source-data');
    });

    it.each([
        ['nested recovery secret', { ...portable, recovery: { ...envelope, recoveryCode: 'plaintext' } }],
        ['device envelope', { ...portable, device: { protectedPayload: 'device' } }],
        ['nested KDF plaintext', { ...portable, recovery: { ...envelope, kdfParams: { ...envelope.kdfParams, password: 'secret' } } }]
    ])('refuses creation metadata containing a forbidden %s field', async (_label, injected) => {
        const security = { ...sourceSecurity(), getPortableVaultMetadata: vi.fn(() => injected) } as unknown as SecurityService;
        await expect(new BackupService(database(sourceDb), drive(), security, sourceUserData)
            .createBackupBundle(bundle)).rejects.toThrow('BACKUP_CONTAINS_FORBIDDEN_METADATA');
        expect(fs.existsSync(bundle)).toBe(false);
    });

    it('validates an optional transition envelope even when primary recovery metadata is valid', async () => {
        const security = { ...sourceSecurity(), getPortableVaultMetadata: vi.fn(() => ({
            ...portable, transitionRecovery: { ...envelope, purpose: 'wrong-purpose' }
        })) } as unknown as SecurityService;
        await expect(new BackupService(database(sourceDb), drive(), security, sourceUserData)
            .createBackupBundle(bundle)).rejects.toThrow('INVALID_PORTABLE_RECOVERY_ENVELOPE');
    });

    it('restores onto a clean machine only after isolated recoverability validation', async () => {
        await createBundle();
        const { service, dbPath, userData, live, db, committed } = targetService();
        const result = await service.restoreLocalBackup(bundle, 'correct-code');
        expect(result).toMatchObject({ success: true, restartRequired: true });
        expect(fs.readFileSync(dbPath).toString()).toBe('encrypted-sqlcipher-source-data');
        expect(JSON.parse(fs.readFileSync(path.join(userData, 'security.json'), 'utf8')).device.protectedPayload).toBe('new-device');
        expect(live.initializeDevice).toHaveBeenCalledOnce();
        expect(db.setDb).toHaveBeenCalledOnce();
        expect(committed).toHaveBeenCalledOnce();
    });

    it('rejects an incorrect recovery code without touching live files', async () => {
        await createBundle();
        const { service, dbPath, userData, live } = targetService({ existing: true });
        const oldDb = fs.readFileSync(dbPath); const oldConfig = fs.readFileSync(path.join(userData, 'security.json'));
        await expect(service.restoreLocalBackup(bundle, 'wrong')).rejects.toThrow('INVALID_RECOVERY_CODE');
        expect(fs.readFileSync(dbPath)).toEqual(oldDb);
        expect(fs.readFileSync(path.join(userData, 'security.json'))).toEqual(oldConfig);
        expect(live.closeDb).not.toHaveBeenCalled();
    });

    it('rejects corruption before isolated SQLCipher validation or live mutation', async () => {
        await createBundle();
        const fd = fs.openSync(bundle, 'r+');
        try { const last = fs.statSync(bundle).size - 1; fs.writeSync(fd, Buffer.from([0xff]), 0, 1, last); } finally { fs.closeSync(fd); }
        const { service, dbPath, userData, live } = targetService({ existing: true });
        const oldDb = fs.readFileSync(dbPath); const oldConfig = fs.readFileSync(path.join(userData, 'security.json'));
        await expect(service.restoreLocalBackup(bundle, 'correct-code')).rejects.toThrow('BACKUP_DATABASE_CHECKSUM_MISMATCH');
        expect(fs.readFileSync(dbPath)).toEqual(oldDb); expect(fs.readFileSync(path.join(userData, 'security.json'))).toEqual(oldConfig);
        expect(live.closeDb).not.toHaveBeenCalled();
    });

    it('rejects vault/key metadata mismatch before replacing the live pair', async () => {
        await createBundle();
        const { service, dbPath, userData } = targetService({ existing: true, validatorError: 'VAULT_BINDING_MISMATCH' });
        const oldDb = fs.readFileSync(dbPath); const oldConfig = fs.readFileSync(path.join(userData, 'security.json'));
        await expect(service.restoreLocalBackup(bundle, 'correct-code')).rejects.toThrow('VAULT_BINDING_MISMATCH');
        expect(fs.readFileSync(dbPath)).toEqual(oldDb); expect(fs.readFileSync(path.join(userData, 'security.json'))).toEqual(oldConfig);
    });

    it.each([
        ['cipher_integrity_check', [{ cipher_integrity_check: 'HMAC verification failed' }], 'BACKUP_CIPHER_INTEGRITY_FAILED'],
        ['integrity_check', [{ integrity_check: 'row missing' }], 'BACKUP_DATABASE_INTEGRITY_FAILED']
    ])('rejects failed keyed %s before replacing live files', async (pragma, result, error) => {
        await createBundle();
        const { service, dbPath, userData, live } = targetService({ existing: true });
        const isolated = validator();
        (isolated.getDb as any).mockReturnValue({ pragma: vi.fn((name: string) =>
            name === pragma ? result : name === 'cipher_integrity_check' ? [] :
                name === 'integrity_check' ? [{ integrity_check: 'ok' }] : 6) });
        (service as any).options.createIsolatedSecurityService = () => isolated;
        const oldDb = fs.readFileSync(dbPath); const oldConfig = fs.readFileSync(path.join(userData, 'security.json'));
        await expect(service.restoreLocalBackup(bundle, 'correct-code')).rejects.toThrow(error);
        expect(fs.readFileSync(dbPath)).toEqual(oldDb); expect(fs.readFileSync(path.join(userData, 'security.json'))).toEqual(oldConfig);
        expect(live.closeDb).not.toHaveBeenCalled();
    });

    it('rejects a manifest schema that disagrees with the unlocked staged database', async () => {
        await createBundle();
        const { service, dbPath, userData } = targetService({ existing: true, validatorSchema: 5 });
        const oldDb = fs.readFileSync(dbPath); const oldConfig = fs.readFileSync(path.join(userData, 'security.json'));
        await expect(service.restoreLocalBackup(bundle, 'correct-code')).rejects.toThrow('BACKUP_DATABASE_SCHEMA_MISMATCH');
        expect(fs.readFileSync(dbPath)).toEqual(oldDb); expect(fs.readFileSync(path.join(userData, 'security.json'))).toEqual(oldConfig);
    });

    it('rejects an unlocked database newer than this application supports', async () => {
        const future = Math.max(...MIGRATIONS.map(item => item.version)) + 1;
        const futureSecurity = { ...sourceSecurity(), getDb: vi.fn(() => ({ pragma: vi.fn(() => future) })) } as SecurityService;
        await new BackupService(database(sourceDb), drive(), futureSecurity, sourceUserData).createBackupBundle(bundle);
        const { service } = targetService({ validatorSchema: future });
        await expect(service.restoreLocalBackup(bundle, 'correct-code')).rejects.toThrow('BACKUP_SCHEMA_VERSION_UNSUPPORTED');
    });

    it('captures pre-restore schema after restore-before-live-close and restores that bundle', async () => {
        await createBundle();
        let schemaVersion = 6;
        const userData = path.join(root, 'schema-boundary');
        const dbPath = path.join(userData, 'nalamdesk-test.db');
        fs.mkdirSync(userData, { recursive: true });
        fs.writeFileSync(dbPath, 'encrypted-old-live-data');
        fs.writeFileSync(path.join(userData, 'security.json'), JSON.stringify(liveConfig()));
        const live = {
            getDbPath: vi.fn(() => dbPath),
            getPortableVaultMetadata: vi.fn(() => portable),
            getDb: vi.fn(() => ({ pragma: vi.fn(() => schemaVersion) })),
            closeDb: vi.fn(),
            initializeDevice: vi.fn(async () => ({}))
        } as unknown as SecurityService;
        const interrupted = new BackupService(database(dbPath), drive(), live, userData, {
            createIsolatedSecurityService: () => validator(),
            onStep: step => {
                if (step === 'restore-before-live-close') schemaVersion = 7;
                if (step === 'restore-after-config-replace') throw new Error('INTERRUPTED_restore-after-config-replace');
            },
            onRestoreCommitted: vi.fn()
        });
        await expect(interrupted.restoreLocalBackup(bundle, 'correct-code')).rejects.toThrow('INTERRUPTED');
        const snapshots = fs.readdirSync(path.join(userData, 'backups')).filter(file => file.includes('pre-restore'));
        expect(snapshots).toHaveLength(1);
        const { service, dbPath: recoveredPath } = targetService({ validatorSchema: 7 });
        await expect(service.restoreLocalBackup(path.join(userData, 'backups', snapshots[0]), 'correct-code'))
            .resolves.toMatchObject({ success: true });
        expect(fs.readFileSync(recoveredPath).toString()).toBe('encrypted-old-live-data');
    });

    it('rejects overlapping API/IPC DB work with RESTORE_IN_PROGRESS and closes only after drain', async () => {
        await createBundle();
        const db = new DatabaseService();
        db.beginWork();
        const userData = path.join(root, 'write-fence');
        const dbPath = path.join(userData, 'nalamdesk-test.db');
        fs.mkdirSync(userData, { recursive: true });
        fs.writeFileSync(dbPath, 'encrypted-old-live-data');
        fs.writeFileSync(path.join(userData, 'security.json'), JSON.stringify(liveConfig()));
        const live = {
            getDbPath: vi.fn(() => dbPath),
            getPortableVaultMetadata: vi.fn(() => portable),
            getDb: vi.fn(() => ({ pragma: vi.fn(() => 6) })),
            closeDb: vi.fn(),
            initializeDevice: vi.fn(async () => ({}))
        } as unknown as SecurityService;
        const overlapping: Error[] = [];
        const interrupted = new BackupService(db, drive(), live, userData, {
            createIsolatedSecurityService: () => validator(),
            onStep: step => {
                if (step === 'restore-after-stage-validation') {
                    queueMicrotask(() => {
                        try { db.beginWork(); }
                        catch (error: any) { overlapping.push(error); }
                        db.endWork();
                    });
                }
                if (step === 'restore-after-snapshot') throw new Error('INTERRUPTED_restore-after-snapshot');
            },
            onRestoreCommitted: vi.fn()
        });
        await expect(interrupted.restoreLocalBackup(bundle, 'correct-code')).rejects.toThrow('INTERRUPTED');
        expect(overlapping).toHaveLength(1);
        expect(overlapping[0].message).toBe('RESTORE_IN_PROGRESS');
        expect(live.closeDb).toHaveBeenCalled();
        expect(() => { db.beginWork(); db.endWork(); }).not.toThrow();
    });

    it('aborts restore on drain timeout without closing the vault', async () => {
        await createBundle();
        const db = new DatabaseService();
        db.beginWork();
        const userData = path.join(root, 'drain-timeout');
        const dbPath = path.join(userData, 'nalamdesk-test.db');
        fs.mkdirSync(userData, { recursive: true });
        fs.writeFileSync(dbPath, 'encrypted-old-live-data');
        fs.writeFileSync(path.join(userData, 'security.json'), JSON.stringify(liveConfig()));
        const live = {
            getDbPath: vi.fn(() => dbPath),
            getPortableVaultMetadata: vi.fn(() => portable),
            getDb: vi.fn(() => ({ pragma: vi.fn(() => 6) })),
            closeDb: vi.fn(),
            initializeDevice: vi.fn(async () => ({}))
        } as unknown as SecurityService;
        const service = new BackupService(db, drive(), live, userData, {
            createIsolatedSecurityService: () => validator(),
            drainTimeoutMs: 20,
            onRestoreCommitted: vi.fn()
        });
        await expect(service.restoreLocalBackup(bundle, 'correct-code')).rejects.toThrow('RESTORE_DRAIN_TIMEOUT');
        expect(live.closeDb).not.toHaveBeenCalled();
        expect(live.getDb().pragma()).toBe(6);
        db.endWork();
        expect(() => { db.beginWork(); db.endWork(); }).not.toThrow();
    });

    it('unfences immediately when restore throws before closeDb', async () => {
        await createBundle();
        const db = new DatabaseService();
        const userData = path.join(root, 'throw-before-close');
        const dbPath = path.join(userData, 'nalamdesk-test.db');
        fs.mkdirSync(userData, { recursive: true });
        fs.writeFileSync(dbPath, 'encrypted-old-live-data');
        fs.writeFileSync(path.join(userData, 'security.json'), JSON.stringify(liveConfig()));
        const live = {
            getDbPath: vi.fn(() => dbPath),
            getPortableVaultMetadata: vi.fn(() => portable),
            getDb: vi.fn(() => ({ pragma: vi.fn(() => 6) })),
            closeDb: vi.fn(),
            initializeDevice: vi.fn(async () => ({}))
        } as unknown as SecurityService;
        const service = new BackupService(db, drive(), live, userData, {
            createIsolatedSecurityService: () => validator(),
            onStep: step => { if (step === 'restore-before-live-close') throw new Error('INTERRUPTED_restore-before-live-close'); },
            onRestoreCommitted: vi.fn()
        });
        await expect(service.restoreLocalBackup(bundle, 'correct-code')).rejects.toThrow('INTERRUPTED_restore-before-live-close');
        expect(live.closeDb).not.toHaveBeenCalled();
        expect(() => { db.beginWork(); db.endWork(); }).not.toThrow();
        expect(live.getDb().pragma()).toBe(6);
    });

    it('stays fenced when initializeDevice throws after closeDb', async () => {
        await createBundle();
        const db = new DatabaseService();
        const userData = path.join(root, 'reopen-fails');
        const dbPath = path.join(userData, 'nalamdesk-test.db');
        fs.mkdirSync(userData, { recursive: true });
        fs.writeFileSync(dbPath, 'encrypted-old-live-data');
        fs.writeFileSync(path.join(userData, 'security.json'), JSON.stringify(liveConfig()));
        let open: { pragma: ReturnType<typeof vi.fn> } | null = { pragma: vi.fn(() => 6) };
        const live = {
            getDbPath: vi.fn(() => dbPath),
            getPortableVaultMetadata: vi.fn(() => portable),
            getDb: vi.fn(() => open),
            closeDb: vi.fn(() => { open = null; }),
            initializeDevice: vi.fn(async () => { throw new Error('REOPEN_FAILED'); })
        } as unknown as SecurityService;
        const service = new BackupService(db, drive(), live, userData, {
            createIsolatedSecurityService: () => validator(),
            onStep: step => { if (step === 'restore-after-snapshot') throw new Error('INTERRUPTED_restore-after-snapshot'); },
            onRestoreCommitted: vi.fn()
        });
        await expect(service.restoreLocalBackup(bundle, 'correct-code')).rejects.toThrow('REOPEN_FAILED');
        expect(live.closeDb).toHaveBeenCalled();
        expect(live.initializeDevice).toHaveBeenCalled();
        expect(live.getDb()).toBeNull();
        expect(() => db.beginWork()).toThrow('RESTORE_IN_PROGRESS');
    });

    it('keeps the DatabaseService fence closed after a successful restore', async () => {
        await createBundle();
        const db = new DatabaseService();
        const { userData } = targetService({ existing: true });
        const dbPath = path.join(userData, 'nalamdesk-test.db');
        const live = {
            getDbPath: vi.fn(() => dbPath), getDb: vi.fn(() => null), closeDb: vi.fn(),
            initializeDevice: vi.fn(async () => ({}))
        } as unknown as SecurityService;
        const committed = vi.fn();
        const service = new BackupService(db, drive(), live, userData, {
            createIsolatedSecurityService: () => validator(),
            onRestoreCommitted: committed
        });
        await expect(service.restoreLocalBackup(bundle, 'correct-code')).resolves.toMatchObject({ success: true });
        expect(committed).toHaveBeenCalledOnce();
        expect(() => db.beginWork()).toThrow('RESTORE_IN_PROGRESS');
    });

    it.each(['restore-after-database-replace', 'restore-after-config-replace'] as BackupStep[])(
        'rolls back the exact DB/config pair after interruption at %s', async failAt => {
            await createBundle();
            const { service, dbPath, userData } = targetService({ existing: true, failAt });
            const oldDb = fs.readFileSync(dbPath); const oldConfig = fs.readFileSync(path.join(userData, 'security.json'));
            await expect(service.restoreLocalBackup(bundle, 'correct-code')).rejects.toThrow('INTERRUPTED');
            expect(fs.readFileSync(dbPath)).toEqual(oldDb); expect(fs.readFileSync(path.join(userData, 'security.json'))).toEqual(oldConfig);
            const snapshots = fs.readdirSync(path.join(userData, 'backups')).filter(file => file.includes('pre-restore'));
            expect(snapshots).toHaveLength(1);
        }
    );

    it('removes a partially installed pair when clean-machine restore is interrupted', async () => {
        await createBundle();
        const { service, dbPath, userData } = targetService({ failAt: 'restore-after-config-replace' });
        await expect(service.restoreLocalBackup(bundle, 'correct-code')).rejects.toThrow('INTERRUPTED');
        expect(fs.existsSync(dbPath)).toBe(false); expect(fs.existsSync(path.join(userData, 'security.json'))).toBe(false);
    });

    it('returns committed success and invalidates the old session when post-activation cleanup fails', async () => {
        await createBundle();
        const { service, dbPath, committed } = targetService({ existing: true, failAt: 'restore-after-activation' });
        await expect(service.restoreLocalBackup(bundle, 'correct-code')).resolves.toMatchObject({ success: true, restartRequired: true });
        expect(committed).toHaveBeenCalledOnce();
        expect(fs.readFileSync(dbPath).toString()).toBe('encrypted-sqlcipher-source-data');
    });

    it('detects legacy database-only backups and reports why they are not recoverable', async () => {
        const userData = path.join(root, 'legacy'); const backups = path.join(userData, 'backups');
        fs.mkdirSync(backups, { recursive: true }); fs.writeFileSync(path.join(backups, 'nalamdesk-auto-backup-old.db'), 'legacy');
        const service = new BackupService(database(sourceDb), drive(), sourceSecurity(), userData);
        const listed = await service.listSystemBackups();
        expect(listed[0]).toMatchObject({ format: 'legacy-database-only', recoverable: false });
        expect(listed[0].warning).toContain('wrapped-key metadata');
        await expect(service.restoreLocalBackup(listed[0].path, 'code')).rejects.toThrow('LEGACY_DATABASE_ONLY_BACKUP');
    });

    it('rejects a journal whose mutable JSON points outside userData', () => {
        const userData = path.join(root, 'journal'); fs.mkdirSync(userData);
        fs.writeFileSync(path.join(userData, 'backup-restore.json'), JSON.stringify({
            version: 1, phase: 'live-files-replacing', stageDirectory: '/tmp/attacker',
            targetDatabase: '/tmp/attacker.db', liveConfig: '/tmp/security.json',
            databaseRollback: '/tmp/a', configRollback: '/tmp/b', hadDatabase: true, hadConfig: true
        }));
        expect(() => new BackupService(database(sourceDb), drive(), sourceSecurity(), userData)).toThrow('RESTORE_JOURNAL_PATH_MISMATCH');
    });

    it('propagates regular-file fsync failures so rollback copies are never assumed durable', () => {
        const service = new BackupService(database(sourceDb), drive(), sourceSecurity(), sourceUserData, { fsync: () => {
            const error: any = new Error('disk I/O failure'); error.code = 'EIO'; throw error;
        } }) as any;
        expect(() => service.copyDurable(sourceDb, path.join(root, 'copy.db'))).toThrow('disk I/O failure');
    });

    it('ignores only unsupported Windows directory fsync and propagates Windows EIO', () => {
        const unsupported: any = new Error('unsupported'); unsupported.code = 'EPERM';
        const unsupportedService = new BackupService(database(sourceDb), drive(), sourceSecurity(), sourceUserData, {
            platform: 'win32', fsync: () => { throw unsupported; }
        }) as any;
        expect(() => unsupportedService.fsyncDirectory(sourceUserData)).not.toThrow();
        const io: any = new Error('I/O'); io.code = 'EIO';
        const ioService = new BackupService(database(sourceDb), drive(), sourceSecurity(), sourceUserData, {
            platform: 'win32', fsync: () => { throw io; }
        }) as any;
        expect(() => ioService.fsyncDirectory(sourceUserData)).toThrow('I/O');
    });

    it('refuses to replace a closed legacy vault when no portable snapshot metadata exists', async () => {
        await createBundle();
        const { service, dbPath, userData, live } = targetService({ existing: true });
        fs.writeFileSync(path.join(userData, 'security.json'), JSON.stringify({
            version: 2, salt: '11'.repeat(16), iv: '22'.repeat(12), wrappedKey: '33'.repeat(48)
        }));
        const oldDb = fs.readFileSync(dbPath); const oldConfig = fs.readFileSync(path.join(userData, 'security.json'));
        await expect(service.restoreLocalBackup(bundle, 'correct-code')).rejects.toThrow('INVALID_BACKUP_MANIFEST');
        expect(fs.readFileSync(dbPath)).toEqual(oldDb); expect(fs.readFileSync(path.join(userData, 'security.json'))).toEqual(oldConfig);
        expect(live.closeDb).not.toHaveBeenCalled();
    });
});
