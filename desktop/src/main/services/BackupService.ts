import { CronJob } from 'cron';
import { DatabaseService } from './DatabaseService';
import { GoogleDriveService } from './GoogleDriveService';
import { SecurityService, type SecurityConfigV3 } from './SecurityService';
import { MIGRATIONS } from '../schema/migrations';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

const MAGIC = Buffer.from('NALAMDESK-BACKUP\n', 'ascii');
const FORMAT = 'nalamdesk-offline-backup';
const MAX_MANIFEST = 1024 * 1024;
const RESTORE_JOURNAL = 'backup-restore.json';
const SECURITY_CONFIG = 'security.json';
const MAX_SUPPORTED_SCHEMA = Math.max(0, ...MIGRATIONS.map(migration => migration.version));
type PortableMetadata = Pick<SecurityConfigV3, 'version' | 'vaultId' | 'keyVersion' | 'recovery' | 'transitionRecovery'>;

interface ManifestBody {
    format: typeof FORMAT; version: 1; createdAt: string; appVersion: string;
    database: { fileName: 'vault.db'; size: number; sha256: string; schemaVersion: number };
    vault: PortableMetadata;
}
interface Manifest extends ManifestBody {
    integrity: { algorithm: 'sha256'; manifestSha256: string };
}
type RestorePhase = 'staged-validated' | 'snapshot-created' | 'live-files-replacing' |
    'live-files-replaced' | 'activated' | 'rollback-restored';
interface RestoreJournal {
    version: 1; phase: RestorePhase; startedAt: string; stageDirectory: string;
    targetDatabase: string; liveConfig: string; databaseRollback: string; configRollback: string;
    hadDatabase: boolean; hadConfig: boolean; preRestoreSnapshot?: string;
}
export interface SystemBackupInfo {
    name: string; path: string; createdTime: Date; size: number;
    format: 'bundle-v1' | 'legacy-database-only' | 'invalid-bundle'; recoverable: boolean; warning?: string;
}
export interface RestoreResult { success: true; restartRequired: true; preRestoreSnapshot?: string }
export type BackupStep = 'restore-after-stage-validation' | 'restore-after-snapshot' |
    'restore-before-live-close' |
    'restore-after-journal' | 'restore-after-database-replace' |
    'restore-after-config-replace' | 'restore-after-activation';
export interface BackupServiceOptions {
    createIsolatedSecurityService?: () => SecurityService;
    appVersion?: string;
    onStep?: (step: BackupStep) => void;
    /** Test seams for platform-specific durability behavior. */
    fsync?: (fd: number) => void;
    write?: (fd: number, buffer: Buffer, offset: number, length: number, position: number | null) => number;
    platform?: NodeJS.Platform;
    /** Required restore commit boundary: invalidate every pre-restore session. */
    onRestoreCommitted?: () => void;
    /** Test seam: how long fence() waits for in-flight API/IPC DB work. */
    drainTimeoutMs?: number;
}

/** Offline bundle checksums detect corruption. Authenticity/recoverability is
 * established by recovery AEAD unwrap, SQLCipher open, and DB vault binding. */
export class BackupService {
    private localJob: CronJob | null = null;
    private cloudJob: CronJob | null = null;
    private localBackupPath: string;

    constructor(
        private dbService: DatabaseService,
        private driveService: GoogleDriveService,
        private securityService: SecurityService,
        private userDataPath: string,
        private readonly options: BackupServiceOptions = {}
    ) {
        this.localBackupPath = path.join(userDataPath, 'backups');
        this.reconcileInterruptedRestore();
    }

    setLocalBackupPath(backupPath: string) { this.localBackupPath = backupPath; }
    initAutomatedBackup() {
        const settings = this.dbService.getSettings();
        // Stored values predate validation (or were hand-edited): repair to
        // the default with an audit trail instead of leaving the schedule
        // silently dead on every launch.
        this.scheduleLocalBackup(this.validatedStoredSchedule(settings?.backup_schedule, 'backup_schedule', 'local'));
        this.scheduleCloudBackup(this.validatedStoredSchedule(settings?.cloud_backup_schedule, 'cloud_backup_schedule', 'cloud'));
    }

    private validatedStoredSchedule(
        stored: unknown, column: 'backup_schedule' | 'cloud_backup_schedule', label: string
    ): string {
        if (stored == null || stored === '') return '13:00';
        if (BackupService.isValidScheduleTime(stored)) return stored;
        try {
            this.dbService.saveSettings({ [column]: '13:00' });
        } catch { /* repair must not break startup; schedule still fires */ }
        try {
            this.dbService.logAudit('BACKUP_ERROR', 'system', 0, 0,
                `Invalid stored ${label} backup schedule '${stored}': reset to 13:00`);
        } catch { /* audit is best-effort at boot */ }
        return '13:00';
    }
    private convertToCron(time: string): string {
        if (!/^\d{2}:\d{2}$/.test(time)) return time;
        const [hours, minutes] = time.split(':');
        return `0 ${minutes} ${hours} * * *`;
    }
    scheduleLocalBackup(time: string) {
        // Build before swapping: a bad expression keeps the previous job
        // alive instead of silently disabling the schedule.
        try {
            const next = new CronJob(this.convertToCron(time), () => void this.performLocalBackup().catch(error =>
                console.error('[Backup] Scheduled local backup failed:', error)));
            this.localJob?.stop();
            this.localJob = next;
            this.localJob.start();
        } catch (error) { console.error('[Backup] Failed to schedule local backup:', error); }
    }
    scheduleCloudBackup(time: string) {
        try {
            const next = new CronJob(this.convertToCron(time), () => void this.performCloudBackup());
            this.cloudJob?.stop();
            this.cloudJob = next;
            this.cloudJob.start();
        } catch (error) { console.error('[Backup] Failed to schedule cloud backup:', error); }
    }

    /**
     * HH:MM schedule times with range checking (HH 00-23, MM 00-59).
     * Shape-only checks admit '99:99', which cron rejects and date math
     * silently rolls over — validate before persisting or scheduling.
     */
    static isValidScheduleTime(time: unknown): time is string {
        return typeof time === 'string' && /^([01]\d|2[0-3]):([0-5]\d)$/.test(time);
    }

    /**
     * Next daily fire for an HH:MM schedule in local time. Pure function of
     * (time, now) so restarts, DST boundaries, and display math stay
     * testable without touching the live cron job.
     */
    static nextDailyRun(time: string, now: Date = new Date()): string | null {
        const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
        if (!match) return null;
        const candidate = new Date(now);
        candidate.setHours(Number(match[1]), Number(match[2]), 0, 0);
        if (candidate.getTime() <= now.getTime()) candidate.setDate(candidate.getDate() + 1);
        return candidate.toISOString();
    }

    /**
     * Durable backup health for the Settings UI: schedule, destination
     * readiness, newest valid backup + age, last recorded failure, and the
     * next scheduled fire. File state and the audit trail (not memory) are
     * the sources, so a restart reports the same health the last run left.
     */
    async getLocalBackupHealth(now: Date = new Date()) {
        const schedule = this.dbService.getSettings()?.backup_schedule || '13:00';
        const destination = this.localBackupPath;
        let writable = false;
        let freeBytes: number | null = null;
        try {
            fs.mkdirSync(destination, { recursive: true });
            fs.accessSync(destination, fs.constants.W_OK);
            writable = true;
            const stats = fs.statfsSync(destination);
            freeBytes = Number(stats.bfree) * Number(stats.bsize);
        } catch { /* destReady stays false; surfaced, not thrown */ }

        let lastBackupAt: string | null = null;
        let lastBackupName: string | null = null;
        try {
            const backups = await this.listSystemBackups();
            const latest = backups
                .filter((b) => b.name.startsWith('nalamdesk-auto-backup-') && b.recoverable !== false)[0];
            if (latest) {
                lastBackupAt = latest.createdTime instanceof Date
                    ? latest.createdTime.toISOString() : new Date(latest.createdTime).toISOString();
                lastBackupName = latest.name;
            }
        } catch { /* no backups yet */ }

        let lastErrorAt: string | null = null;
        let lastError: string | null = null;
        try {
            const audits = this.dbService.getAuditLogs(100) as any[];
            const failure = (audits || []).find((a) => a?.action === 'BACKUP_ERROR');
            if (failure) {
                lastErrorAt = failure.created_at || failure.timestamp || null;
                lastError = String(failure.details || 'Backup failed.');
            }
        } catch { /* audit unavailable */ }

        const nextRunAt = BackupService.nextDailyRun(schedule, now);
        const ageHours = lastBackupAt
            ? (now.getTime() - new Date(lastBackupAt).getTime()) / 3_600_000 : null;
        return {
            enabled: writable, schedule, destination, writable, freeBytes,
            lastBackupAt, lastBackupName,
            backupAgeHours: ageHours == null ? null : Math.round(ageHours * 10) / 10,
            lastErrorAt, lastError, nextRunAt,
            // A schedule that never produced a backup within ~2 daily windows
            // is either failing silently or never firing: surface, don't guess.
            missed: lastBackupAt == null || (ageHours != null && ageHours > 49)
        };
    }
    updateSchedule(type: 'local' | 'cloud', time: string) {
        type === 'local' ? this.scheduleLocalBackup(time) : this.scheduleCloudBackup(time);
    }
    async performBackupOnQuit() {
        try { await this.performBackup(); }
        catch (error) { console.error('[Backup] Backup on quit failed', error); }
    }
    async performBackup() {
        let localError: unknown;
        if (this.localBackupPath) {
            try { await this.performLocalBackup(); }
            catch (error) { localError = error; }
        }
        // Cloud remains an independent attempt if local bundle creation fails.
        if (this.driveService.isAuthenticated()) await this.performCloudBackup();
        if (localError) throw localError;
    }

    async createBackupBundle(destination: string): Promise<string> {
        const databaseTemp = `${destination}.database.tmp`;
        const bundleTemp = `${destination}.tmp`;
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        this.remove(databaseTemp); this.remove(bundleTemp);
        try {
            await this.dbService.backupDatabase(databaseTemp);
            // No await is permitted between reading the metadata and writing the
            // bundle, so a recovery rotation cannot interleave with this pair.
            const metadata = this.securityService.getPortableVaultMetadata();
            return this.writePortableBundle(destination, databaseTemp, metadata,
                Number(this.securityService.getDb()?.pragma('user_version', { simple: true }) || 0));
        } finally { this.remove(databaseTemp); this.remove(bundleTemp); }
    }

    private writePortableBundle(
        destination: string, databasePath: string, metadata: PortableMetadata, schemaVersion: number
    ): string {
        const bundleTemp = `${destination}.tmp`;
        this.remove(bundleTemp);
        try {
            const body: ManifestBody = {
                format: FORMAT, version: 1, createdAt: new Date().toISOString(),
                appVersion: this.options.appVersion || 'unknown',
                database: {
                    fileName: 'vault.db', size: fs.statSync(databasePath).size,
                    sha256: this.hashFile(databasePath), schemaVersion
                },
                vault: this.sanitizePortableMetadata(metadata)
            };
            const manifest: Manifest = { ...body, integrity: { algorithm: 'sha256', manifestSha256: this.hashText(this.stable(body)) } };
            this.writeBundle(bundleTemp, manifest, databasePath);
            fs.renameSync(bundleTemp, destination);
            this.fsyncDirectory(path.dirname(destination));
            return destination;
        } finally { this.remove(bundleTemp); }
    }

    private async performLocalBackup(): Promise<void> {
        try {
            fs.mkdirSync(this.localBackupPath, { recursive: true });
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            const name = `nalamdesk-auto-backup-${stamp}.ndbackup`;
            await this.createBackupBundle(path.join(this.localBackupPath, name));
            this.pruneLocalBackups();
            this.dbService.logAudit('BACKUP_LOCAL', 'system', 0, 0, `Created recoverable local backup: ${name}`);
        } catch (error: any) {
            console.error('[Backup] Local backup failed:', error);
            this.dbService.logAudit('BACKUP_ERROR', 'system', 0, 0, `Local backup failed: ${error.message}`);
            throw error;
        }
    }
    private pruneLocalBackups() {
        try {
            const retention = 30 * 24 * 60 * 60 * 1000;
            for (const file of fs.readdirSync(this.localBackupPath)) {
                if (!file.startsWith('nalamdesk-auto-backup-') || (!file.endsWith('.ndbackup') && !file.endsWith('.db'))) continue;
                const target = path.join(this.localBackupPath, file);
                if (Date.now() - fs.statSync(target).mtimeMs > retention) fs.unlinkSync(target);
            }
        } catch (error) { console.error('[Backup] Failed to prune old backups:', error); }
    }

    // Cloud backup remains outside this offline-only change.
    private async performCloudBackup() {
        try {
            const dbPath = this.securityService.getDbPath();
            if (!dbPath || !fs.existsSync(dbPath)) return;
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            const name = `nalamdesk-cloud-backup-${stamp}.db`;
            await this.driveService.uploadFile(dbPath, name);
            this.dbService.logAudit('BACKUP_CLOUD', 'system', 0, 0, `Uploaded cloud backup: ${name}`);
        } catch (error: any) {
            console.error('[Backup] Cloud backup failed:', error);
            this.dbService.logAudit('BACKUP_ERROR', 'system', 0, 0, `Cloud backup failed: ${error.message}`);
        }
    }

    async listSystemBackups(): Promise<SystemBackupInfo[]> {
        try {
            if (!fs.existsSync(this.localBackupPath)) return [];
            return fs.readdirSync(this.localBackupPath)
                .filter(file => file.includes('backup') && (file.endsWith('.ndbackup') || file.endsWith('.db')))
                .map(file => this.describe(path.join(this.localBackupPath, file)))
                .sort((a, b) => b.createdTime.getTime() - a.createdTime.getTime());
        } catch (error) { console.error('[Backup] Failed to list system backups:', error); return []; }
    }
    private describe(filePath: string): SystemBackupInfo {
        const stats = fs.statSync(filePath);
        const common = { name: path.basename(filePath), path: filePath, createdTime: stats.mtime, size: stats.size };
        if (!this.hasMagic(filePath)) return { ...common, format: 'legacy-database-only', recoverable: false,
            warning: 'Legacy database-only backup: wrapped-key metadata is missing; clean-machine recovery is unavailable.' };
        try { this.readManifest(filePath); return { ...common, format: 'bundle-v1', recoverable: true }; }
        catch (error: any) { return { ...common, format: 'invalid-bundle', recoverable: false, warning: error.message }; }
    }

    async restoreLocalBackup(backupPath: string, recoveryCode: string): Promise<RestoreResult> {
        if (!fs.existsSync(backupPath)) throw new Error('BACKUP_NOT_FOUND');
        if (!this.hasMagic(backupPath)) throw new Error('LEGACY_DATABASE_ONLY_BACKUP');
        if (!recoveryCode) throw new Error('RECOVERY_CODE_REQUIRED');
        if (!this.options.createIsolatedSecurityService) throw new Error('RESTORE_VALIDATOR_UNAVAILABLE');
        if (!this.options.onRestoreCommitted) throw new Error('RESTORE_COMMIT_CALLBACK_REQUIRED');

        const targetDatabase = this.securityService.getDbPath() || path.join(this.userDataPath,
            process.env['NODE_ENV'] === 'test' ? 'nalamdesk-test.db' : 'nalamdesk.db');
        const liveConfig = path.join(this.userDataPath, SECURITY_CONFIG);
        const stageDirectory = path.join(this.userDataPath, `.backup-restore-stage-${crypto.randomUUID()}`);
        const stagedDatabase = path.join(stageDirectory, 'vault.db');
        const stagedConfig = path.join(stageDirectory, SECURITY_CONFIG);
        const journal: RestoreJournal = {
            version: 1, phase: 'staged-validated', startedAt: new Date().toISOString(), stageDirectory,
            targetDatabase, liveConfig, databaseRollback: path.join(stageDirectory, 'live-database.rollback'),
            configRollback: path.join(stageDirectory, 'live-security.rollback'),
            hadDatabase: fs.existsSync(targetDatabase), hadConfig: fs.existsSync(liveConfig)
        };
        fs.mkdirSync(stageDirectory, { recursive: true });
        let validator: SecurityService | undefined;
        let liveDatabaseClosed = false;
        let preRestoreSnapshot: {
            destination: string; metadata: PortableMetadata; schemaVersion: number;
        } | undefined;
        try {
            const manifest = this.extractAndValidate(backupPath, stagedDatabase);
            validator = this.options.createIsolatedSecurityService();
            await validator.installPortableVaultMetadata(manifest.vault, recoveryCode, stagedDatabase, stageDirectory);
            const stagedDb = validator.getDb();
            this.runKeyedIntegrityChecks(stagedDb);
            const stagedSchema = Number(stagedDb?.pragma('user_version', { simple: true }));
            if (!Number.isInteger(stagedSchema) || stagedSchema < 0) throw new Error('BACKUP_DATABASE_SCHEMA_INVALID');
            if (manifest.database.schemaVersion !== 0 && manifest.database.schemaVersion !== stagedSchema) {
                throw new Error('BACKUP_DATABASE_SCHEMA_MISMATCH');
            }
            if (stagedSchema > MAX_SUPPORTED_SCHEMA) throw new Error('BACKUP_SCHEMA_VERSION_UNSUPPORTED');
            validator.closeDb(); validator = undefined;
            if (!fs.existsSync(stagedConfig)) throw new Error('STAGED_SECURITY_CONFIG_MISSING');
            this.step('restore-after-stage-validation');
            this.saveJournal(journal);

            await this.dbService.fence(this.options.drainTimeoutMs ?? 10_000);
            // From this point until activation, no live write may commit outside
            // the rollback snapshot. Closing checkpoints WAL data into the base
            // file and makes the following durable copy transactionally final.
            this.step('restore-before-live-close');
            if (journal.hadDatabase && journal.hadConfig) {
                fs.mkdirSync(this.localBackupPath, { recursive: true });
                const stamp = new Date().toISOString().replace(/[:.]/g, '-');
                const liveDb = this.securityService.getDb();
                preRestoreSnapshot = {
                    destination: path.join(this.localBackupPath, `nalamdesk-pre-restore-${stamp}.ndbackup`),
                    metadata: liveDb
                        ? this.securityService.getPortableVaultMetadata()
                        : this.readPortableMetadata(liveConfig),
                    schemaVersion: liveDb ? Number(liveDb.pragma('user_version', { simple: true }) || 0) : 0
                };
            }
            if (this.securityService.getDb()) {
                this.securityService.closeDb();
                liveDatabaseClosed = true;
            }
            if (journal.hadDatabase) this.copyDurable(targetDatabase, journal.databaseRollback);
            if (preRestoreSnapshot) {
                // Build the durable disaster-recovery bundle from the same
                // quiescent bytes used for rollback. This includes every write
                // committed before close, including WAL and boundary writes.
                journal.preRestoreSnapshot = this.writePortableBundle(
                    preRestoreSnapshot.destination, journal.databaseRollback,
                    preRestoreSnapshot.metadata, preRestoreSnapshot.schemaVersion
                );
            }
            journal.phase = 'snapshot-created'; this.saveJournal(journal); this.step('restore-after-snapshot');
            if (journal.hadConfig) this.copyDurable(liveConfig, journal.configRollback);
            this.fsyncDirectory(stageDirectory);
            journal.phase = 'live-files-replacing'; this.saveJournal(journal); this.step('restore-after-journal');

            this.securityService.closeDb();
            this.removeSidecars(targetDatabase);
            this.replaceAtomic(stagedDatabase, targetDatabase); this.step('restore-after-database-replace');
            this.replaceAtomic(stagedConfig, liveConfig); this.step('restore-after-config-replace');
            journal.phase = 'live-files-replaced'; this.saveJournal(journal);
            await this.securityService.initializeDevice(targetDatabase, this.userDataPath);
            this.dbService.setDb(this.securityService.getDb());
            this.options.onRestoreCommitted();
            journal.phase = 'activated'; this.saveJournal(journal);
            try { this.step('restore-after-activation'); this.cleanup(journal); }
            catch (error) { console.error('[Backup] Restore committed; cleanup deferred to restart reconciliation.', error); }
            return { success: true, restartRequired: true, preRestoreSnapshot: journal.preRestoreSnapshot };
        } catch (error) {
            if (!liveDatabaseClosed) this.dbService.unfence();
            validator?.closeDb();
            const persisted = this.loadJournal();
            if (persisted && ['live-files-replacing', 'live-files-replaced'].includes(persisted.phase)) {
                await this.rollback(persisted);
            } else if (persisted) this.cleanup(persisted);
            else this.cleanupStage(stageDirectory);
            if (liveDatabaseClosed && journal.hadDatabase && journal.hadConfig) {
                if (!this.securityService.getDb()) {
                    await this.securityService.initializeDevice(targetDatabase, this.userDataPath);
                    this.dbService.setDb(this.securityService.getDb());
                }
                if (this.securityService.getDb()) this.dbService.unfence();
            }
            throw error;
        }
    }

    reconcileInterruptedRestore(): void {
        const journal = this.loadJournal();
        if (!journal) return;
        this.assertJournalPaths(journal);
        if (['live-files-replacing', 'live-files-replaced'].includes(journal.phase)) {
            this.restorePair(journal); journal.phase = 'rollback-restored'; this.saveJournal(journal);
        }
        this.cleanup(journal);
    }
    private async rollback(journal: RestoreJournal) {
        this.assertJournalPaths(journal);
        this.securityService.closeDb(); this.restorePair(journal);
        journal.phase = 'rollback-restored'; this.saveJournal(journal);
        if (journal.hadDatabase && journal.hadConfig) {
            await this.securityService.initializeDevice(journal.targetDatabase, this.userDataPath);
            this.dbService.setDb(this.securityService.getDb());
        }
        this.cleanup(journal);
    }
    private restorePair(journal: RestoreJournal) {
        this.assertJournalPaths(journal);
        this.removeSidecars(journal.targetDatabase);
        if (journal.hadDatabase) {
            if (!fs.existsSync(journal.databaseRollback)) throw new Error('RESTORE_ROLLBACK_MISSING');
            this.replaceAtomic(journal.databaseRollback, journal.targetDatabase);
        } else this.remove(journal.targetDatabase);
        if (journal.hadConfig) {
            if (!fs.existsSync(journal.configRollback)) throw new Error('RESTORE_ROLLBACK_MISSING');
            this.replaceAtomic(journal.configRollback, journal.liveConfig);
        } else this.remove(journal.liveConfig);
    }

    private extractAndValidate(bundlePath: string, destination: string): Manifest {
        const { manifest, databaseOffset } = this.readManifest(bundlePath);
        const body: ManifestBody = { format: manifest.format, version: manifest.version, createdAt: manifest.createdAt,
            appVersion: manifest.appVersion, database: manifest.database, vault: manifest.vault };
        if (this.hashText(this.stable(body)) !== manifest.integrity.manifestSha256) throw new Error('BACKUP_MANIFEST_CHECKSUM_MISMATCH');
        const total = fs.statSync(bundlePath).size;
        if (total - databaseOffset !== manifest.database.size) throw new Error('BACKUP_DATABASE_SIZE_MISMATCH');
        const source = fs.openSync(bundlePath, 'r'); const target = fs.openSync(destination, 'w', 0o600);
        const hash = crypto.createHash('sha256'); const buffer = Buffer.allocUnsafe(1024 * 1024); let position = databaseOffset;
        try {
            while (position < total) {
                const bytes = fs.readSync(source, buffer, 0, Math.min(buffer.length, total - position), position);
                if (!bytes) throw new Error('BACKUP_TRUNCATED');
                this.writeAll(target, buffer, 0, bytes); hash.update(buffer.subarray(0, bytes)); position += bytes;
            }
            fs.fsyncSync(target);
        } finally { fs.closeSync(source); fs.closeSync(target); }
        if (hash.digest('hex') !== manifest.database.sha256) { this.remove(destination); throw new Error('BACKUP_DATABASE_CHECKSUM_MISMATCH'); }
        return manifest;
    }
    private readManifest(bundlePath: string): { manifest: Manifest; databaseOffset: number } {
        const fd = fs.openSync(bundlePath, 'r');
        try {
            const prefix = Buffer.alloc(MAGIC.length + 4);
            if (fs.readSync(fd, prefix, 0, prefix.length, 0) !== prefix.length || !prefix.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('INVALID_BACKUP_MAGIC');
            const length = prefix.readUInt32BE(MAGIC.length);
            if (length < 2 || length > MAX_MANIFEST) throw new Error('INVALID_BACKUP_MANIFEST_LENGTH');
            const bytes = Buffer.alloc(length);
            if (fs.readSync(fd, bytes, 0, length, prefix.length) !== length) throw new Error('BACKUP_TRUNCATED');
            const manifest = JSON.parse(bytes.toString('utf8')) as Manifest; this.validateManifest(manifest);
            return { manifest, databaseOffset: prefix.length + length };
        } catch (error) { if (error instanceof SyntaxError) throw new Error('INVALID_BACKUP_MANIFEST'); throw error; }
        finally { fs.closeSync(fd); }
    }
    private validateManifest(value: Manifest) {
        const hash = (input: unknown) => typeof input === 'string' && /^[0-9a-f]{64}$/i.test(input);
        if (value?.format !== FORMAT || value?.version !== 1 || typeof value.createdAt !== 'string' || typeof value.appVersion !== 'string' ||
            value.database?.fileName !== 'vault.db' || !Number.isSafeInteger(value.database?.size) || value.database.size < 1 ||
            !hash(value.database.sha256) || !Number.isInteger(value.database.schemaVersion) || value.database.schemaVersion < 0 ||
            value.vault?.version !== 3 || !value.vault.vaultId || !Number.isInteger(value.vault.keyVersion) || value.vault.keyVersion < 1 ||
            !value.vault.recovery || value.integrity?.algorithm !== 'sha256' || !hash(value.integrity.manifestSha256)) throw new Error('INVALID_BACKUP_MANIFEST');
        this.sanitizePortableMetadata(value.vault);
        this.assertExactKeys(value, ['format', 'version', 'createdAt', 'appVersion', 'database', 'vault', 'integrity']);
        this.assertExactKeys(value.database, ['fileName', 'size', 'sha256', 'schemaVersion']);
        this.assertExactKeys(value.integrity, ['algorithm', 'manifestSha256']);
        this.assertEnvelopeKeys(value.vault.recovery, false);
        if (value.vault.transitionRecovery) this.assertEnvelopeKeys(value.vault.transitionRecovery, true);
    }
    private writeBundle(target: string, manifest: Manifest, database: string) {
        const bytes = Buffer.from(JSON.stringify(manifest), 'utf8');
        if (bytes.length > MAX_MANIFEST) throw new Error('BACKUP_MANIFEST_TOO_LARGE');
        const output = fs.openSync(target, 'w', 0o600); const input = fs.openSync(database, 'r');
        try {
            this.writeAll(output, MAGIC); const length = Buffer.alloc(4); length.writeUInt32BE(bytes.length);
            this.writeAll(output, length); this.writeAll(output, bytes);
            const buffer = Buffer.allocUnsafe(1024 * 1024); let read: number;
            while ((read = fs.readSync(input, buffer, 0, buffer.length, null)) > 0) this.writeAll(output, buffer, 0, read);
            fs.fsyncSync(output);
        } finally { fs.closeSync(input); fs.closeSync(output); }
    }
    private writeAll(fd: number, buffer: Buffer, offset = 0, length = buffer.length) {
        let written = 0;
        while (written < length) {
            const bytes = (this.options.write || fs.writeSync)(fd, buffer, offset + written, length - written, null);
            if (bytes <= 0) throw new Error('BACKUP_WRITE_FAILED');
            written += bytes;
        }
    }
    private hasMagic(filePath: string): boolean {
        try { const fd = fs.openSync(filePath, 'r'); try { const bytes = Buffer.alloc(MAGIC.length); return fs.readSync(fd, bytes, 0, bytes.length, 0) === bytes.length && bytes.equals(MAGIC); } finally { fs.closeSync(fd); } }
        catch { return false; }
    }
    private hashFile(filePath: string): string {
        const hash = crypto.createHash('sha256'); const fd = fs.openSync(filePath, 'r'); const buffer = Buffer.allocUnsafe(1024 * 1024);
        try { let bytes: number; while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, bytes)); }
        finally { fs.closeSync(fd); } return hash.digest('hex');
    }
    private hashText(value: string) { return crypto.createHash('sha256').update(value).digest('hex'); }
    private stable(value: any): string {
        if (Array.isArray(value)) return `[${value.map(item => this.stable(item)).join(',')}]`;
        if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${this.stable(value[key])}`).join(',')}}`;
        return JSON.stringify(value);
    }
    private replaceAtomic(source: string, destination: string) {
        fs.mkdirSync(path.dirname(destination), { recursive: true }); const temporary = `${destination}.restore.tmp`;
        this.remove(temporary); this.copyDurable(source, temporary); fs.renameSync(temporary, destination); this.fsyncDirectory(path.dirname(destination));
    }
    private copyDurable(source: string, destination: string) {
        fs.copyFileSync(source, destination);
        this.fsyncFile(destination);
    }
    private fsyncFile(filePath: string) {
        const fd = fs.openSync(filePath, 'r+');
        try { (this.options.fsync || fs.fsyncSync)(fd); } finally { fs.closeSync(fd); }
    }
    private removeSidecars(database: string) { for (const suffix of ['-wal', '-shm']) this.remove(`${database}${suffix}`); }
    private journalPath() { return path.join(this.userDataPath, RESTORE_JOURNAL); }
    private saveJournal(journal: RestoreJournal) {
        const target = this.journalPath(); const temporary = `${target}.tmp`; fs.mkdirSync(this.userDataPath, { recursive: true });
        const fd = fs.openSync(temporary, 'w', 0o600); try { fs.writeFileSync(fd, JSON.stringify(journal, null, 2), 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        fs.renameSync(temporary, target); this.fsyncDirectory(this.userDataPath);
    }
    private loadJournal(): RestoreJournal | null {
        const target = this.journalPath(); if (!fs.existsSync(target)) return null;
        const value = JSON.parse(fs.readFileSync(target, 'utf8')) as RestoreJournal;
        if (value.version !== 1 || !value.stageDirectory || !value.targetDatabase || !value.liveConfig) throw new Error('RESTORE_JOURNAL_CORRUPT');
        this.assertJournalPaths(value);
        return value;
    }

    private assertJournalPaths(journal: RestoreJournal) {
        const expectedDatabase = path.resolve(path.join(this.userDataPath,
            process.env['NODE_ENV'] === 'test' ? 'nalamdesk-test.db' : 'nalamdesk.db'));
        const expectedConfig = path.resolve(path.join(this.userDataPath, SECURITY_CONFIG));
        const stage = path.resolve(journal.stageDirectory);
        if (path.resolve(journal.targetDatabase) !== expectedDatabase || path.resolve(journal.liveConfig) !== expectedConfig ||
            path.dirname(stage) !== path.resolve(this.userDataPath) || !path.basename(stage).startsWith('.backup-restore-stage-') ||
            path.resolve(journal.databaseRollback) !== path.join(stage, 'live-database.rollback') ||
            path.resolve(journal.configRollback) !== path.join(stage, 'live-security.rollback')) throw new Error('RESTORE_JOURNAL_PATH_MISMATCH');
    }

    private readPortableMetadata(configPath: string): PortableMetadata {
        const value = JSON.parse(fs.readFileSync(configPath, 'utf8')) as SecurityConfigV3;
        const metadata: PortableMetadata = {
            version: value.version, vaultId: value.vaultId, keyVersion: value.keyVersion,
            recovery: value.recovery,
            ...(value.transitionRecovery ? { transitionRecovery: value.transitionRecovery } : {})
        };
        // Apply the same strict no-extra-fields checks used for imported bundles.
        this.validatePortableMetadata(metadata);
        return metadata;
    }

    private validatePortableMetadata(metadata: PortableMetadata) {
        const probe = {
            format: FORMAT, version: 1, createdAt: new Date().toISOString(), appVersion: '',
            database: { fileName: 'vault.db', size: 1, sha256: '0'.repeat(64), schemaVersion: 0 },
            vault: metadata, integrity: { algorithm: 'sha256', manifestSha256: '0'.repeat(64) }
        } as Manifest;
        this.validateManifest(probe);
    }

    private sanitizePortableMetadata(value: PortableMetadata): PortableMetadata {
        const allowed = ['version', 'vaultId', 'keyVersion', 'recovery', 'transitionRecovery'];
        this.assertExactKeys(value, allowed);
        if (value.version !== 3 || typeof value.vaultId !== 'string' || !value.vaultId ||
            !Number.isInteger(value.keyVersion) || value.keyVersion < 1) throw new Error('INVALID_PORTABLE_VAULT_METADATA');
        const recovery = this.sanitizeEnvelope(value.recovery, false);
        const transitionRecovery = value.transitionRecovery
            ? this.sanitizeEnvelope(value.transitionRecovery, true) as SecurityConfigV3['transitionRecovery']
            : undefined;
        return {
            version: 3, vaultId: value.vaultId, keyVersion: value.keyVersion, recovery,
            ...(transitionRecovery ? { transitionRecovery } : {})
        };
    }

    private sanitizeEnvelope(envelope: any, transition: boolean): SecurityConfigV3['recovery'] {
        this.assertEnvelopeKeys(envelope, transition);
        const params = envelope.kdfParams;
        const hex = (input: unknown, bytes: number) => typeof input === 'string' &&
            input.length === bytes * 2 && /^[0-9a-f]+$/i.test(input);
        if (envelope.algorithm !== 'aes-256-gcm' || envelope.kdf !== 'argon2id' || envelope.aadVersion !== 1 ||
            !hex(envelope.salt, 16) || !hex(envelope.iv, 12) || !hex(envelope.wrappedKey, 48) ||
            !Number.isInteger(params.timeCost) || params.timeCost < 1 || params.timeCost > 10 ||
            !Number.isInteger(params.memoryCost) || params.memoryCost < 8192 || params.memoryCost > 1048576 ||
            !Number.isInteger(params.parallelism) || params.parallelism < 1 || params.parallelism > 16 ||
            params.hashLength !== 32 || (transition && envelope.purpose !== 'legacy-transition')) {
            throw new Error('INVALID_PORTABLE_RECOVERY_ENVELOPE');
        }
        return {
            algorithm: 'aes-256-gcm', kdf: 'argon2id', aadVersion: 1,
            salt: envelope.salt, iv: envelope.iv, wrappedKey: envelope.wrappedKey,
            kdfParams: {
                timeCost: params.timeCost, memoryCost: params.memoryCost,
                parallelism: params.parallelism, hashLength: 32
            },
            ...(transition ? { purpose: 'legacy-transition' } : {})
        } as SecurityConfigV3['recovery'];
    }

    private resultStrings(value: unknown): string[] | null {
        if (!Array.isArray(value)) return null;
        const strings: string[] = [];
        for (const row of value) {
            if (typeof row === 'string') strings.push(row);
            else if (row && typeof row === 'object') {
                const values = Object.values(row as Record<string, unknown>);
                if (values.length !== 1 || typeof values[0] !== 'string') return null;
                strings.push(values[0]);
            } else return null;
        }
        return strings;
    }
    private assertCipherIntegrity(value: unknown) {
        const results = this.resultStrings(value);
        // SQLCipher documents zero rows on success; some driver builds expose "ok".
        if (!results || (results.length !== 0 && !(results.length === 1 && results[0] === 'ok'))) {
            throw new Error('BACKUP_CIPHER_INTEGRITY_FAILED');
        }
    }
    private assertSqliteIntegrity(value: unknown) {
        const results = this.resultStrings(value);
        if (!results || results.length !== 1 || results[0] !== 'ok') throw new Error('BACKUP_DATABASE_INTEGRITY_FAILED');
    }
    private runKeyedIntegrityChecks(database: any) {
        try { this.assertCipherIntegrity(database?.pragma('cipher_integrity_check')); }
        catch { throw new Error('BACKUP_CIPHER_INTEGRITY_FAILED'); }
        try { this.assertSqliteIntegrity(database?.pragma('integrity_check')); }
        catch { throw new Error('BACKUP_DATABASE_INTEGRITY_FAILED'); }
    }

    private assertEnvelopeKeys(envelope: any, transition: boolean) {
        this.assertExactKeys(envelope, transition
            ? ['algorithm', 'kdf', 'kdfParams', 'salt', 'iv', 'wrappedKey', 'aadVersion', 'purpose']
            : ['algorithm', 'kdf', 'kdfParams', 'salt', 'iv', 'wrappedKey', 'aadVersion']);
        this.assertExactKeys(envelope.kdfParams, ['timeCost', 'memoryCost', 'parallelism', 'hashLength']);
    }
    private assertExactKeys(value: any, allowed: string[]) {
        if (!value || typeof value !== 'object' || Object.keys(value).some(key => !allowed.includes(key))) {
            throw new Error('BACKUP_CONTAINS_FORBIDDEN_METADATA');
        }
    }
    private cleanup(journal: RestoreJournal) { this.cleanupStage(journal.stageDirectory); this.remove(this.journalPath()); this.remove(`${this.journalPath()}.tmp`); this.fsyncDirectory(this.userDataPath); }
    private cleanupStage(directory: string) {
        const resolved = path.resolve(directory);
        if (path.dirname(resolved) !== path.resolve(this.userDataPath) || !path.basename(resolved).startsWith('.backup-restore-stage-')) throw new Error('UNSAFE_RESTORE_STAGE_PATH');
        if (fs.existsSync(resolved)) fs.rmSync(resolved, { recursive: true, force: true });
    }
    private remove(target: string) { if (fs.existsSync(target)) fs.unlinkSync(target); }
    private fsyncDirectory(directory: string) {
        try {
            const fd = fs.openSync(directory, 'r');
            try { (this.options.fsync || fs.fsyncSync)(fd); } finally { fs.closeSync(fd); }
        } catch (error: any) {
            // Windows does not support fsync on directory handles. Only those
            // documented capability errors are ignorable; real I/O errors fail.
            const unsupported = ['EPERM', 'EINVAL', 'EBADF', 'ENOTSUP'].includes(error?.code);
            if ((this.options.platform || process.platform) === 'win32' && unsupported) return;
            throw error;
        }
    }
    private step(step: BackupStep) { this.options.onStep?.(step); }
}
