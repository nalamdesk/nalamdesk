import * as argon2 from 'argon2';
// @ts-ignore native module has no compatible default declaration
import Database from 'better-sqlite3-multiple-ciphers';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { DeviceKeyStore } from './DeviceKeyStore';

export interface RecoveryEnvelope {
    algorithm: 'aes-256-gcm';
    kdf: 'argon2id';
    kdfParams: {
        timeCost: number;
        memoryCost: number;
        parallelism: number;
        hashLength: number;
    };
    salt: string;
    iv: string;
    wrappedKey: string;
    aadVersion: 1;
}

interface PendingRecoveryAck {
    protectedPayload: string;
    createdAt: string;
    reason: 'fresh-setup' | 'legacy-migration' | 'transition-recovery' | 'recovery-rotation';
    nextRecovery?: RecoveryEnvelope;
}

export interface TransitionRecoveryEnvelope extends RecoveryEnvelope {
    purpose: 'legacy-transition';
}

/**
 * An extra unlock method for the same DEK (ADR 0001 key slots). `device` stays
 * the primary slot so older app versions keep reading this config unchanged.
 */
export interface KeySlot {
    id: string;
    provider: string;
    label?: string;
    createdAt: string;
    protectedPayload: string;
}

/** A slot as listed to operators: never the protected payload. */
export interface KeySlotSummary {
    id: string;
    provider: string;
    label?: string;
    createdAt?: string;
    kind: 'primary' | 'slot' | 'recovery';
    removable: boolean;
    unlockedWith: boolean;
}

export const PRIMARY_SLOT_ID = 'primary';
export const RECOVERY_SLOT_ID = 'recovery';
const SLOT_LABEL_MAX = 80;

export interface SecurityConfigV3 {
    version: 3;
    vaultId: string;
    keyVersion: number;
    device: { provider: string; protectedPayload: string; label?: string; createdAt?: string };
    slots?: KeySlot[];
    recovery: RecoveryEnvelope;
    migratedFrom?: 1 | 2;
    pendingRecoveryAck?: PendingRecoveryAck;
    transitionRecovery?: TransitionRecoveryEnvelope;
}

interface SecurityConfigV2 {
    version: 2;
    salt: string;
    wrappedKey: string;
    iv: string;
    recovery?: { salt: string; wrappedKey: string; iv: string };
}

export interface SetupStatus {
    isSetup: boolean;
    hasRecovery: boolean;
    vaultState: 'not-setup' | 'ready' | 'legacy-migration-required' | 'recovery-required' | 'corrupt';
    configVersion?: number;
}

export interface VaultUnlockResult { migrated: boolean }

interface MigrationJournal {
    version: 1;
    sourceVersion: 1 | 2;
    phase: 'snapshot-created' | 'database-rekeyed' | 'config-committing' | 'config-written' | 'rollback-restored';
    databaseBackup: string;
    configBackup?: string;
    legacySaltPath?: string;
    startedAt: string;
}

export interface SetupJournal {
    version: 1;
    phase: 'started' | 'vault-created' | 'complete';
    databaseCreated: boolean;
    startedAt: string;
}

export type SecurityStep =
    | 'setup-after-journal' | 'setup-after-bind' | 'setup-after-config-commit'
    | 'migration-after-snapshot' | 'migration-after-rekey' | 'migration-after-bind'
    | 'migration-after-config-commit' | 'cleanup-legacy-salt' | 'cleanup-database-backup'
    | 'cleanup-config-backup' | 'cleanup-journal' | 'cleanup-rollback-database-backup'
    | 'cleanup-rollback-config-backup' | 'cleanup-rollback-journal' | 'cleanup-setup-journal';

export interface SecurityServiceHooks {
    onStep?: (step: SecurityStep) => void;
    platform?: NodeJS.Platform;
    fsync?: (fd: number) => void;
}

const CONFIG_FILE = 'security.json';
const JOURNAL_FILE = 'security-migration.json';
const SETUP_JOURNAL_FILE = 'security-setup.json';
const LEGACY_SALT_FILE = 'salt.bin';
const VAULT_TABLE = '__nalamdesk_vault';
const RECOVERY_KDF_PARAMS = Object.freeze({ timeCost: 3, memoryCost: 65536, parallelism: 1, hashLength: 32 });

/**
 * Owns the SQLCipher DEK. User passwords are intentionally absent from the v3
 * unlock path: device unlock and user authentication are separate operations.
 */
export class SecurityService {
    private db: any;
    private dbPath = '';
    private appUserDataPath = '';
    private dek: Buffer | null = null;
    private unlockedSlotId: string | null = null;

    constructor(
        private readonly deviceKeyStore: DeviceKeyStore,
        private readonly hooks: SecurityServiceHooks = {}
    ) { }

    isSetup(userDataPath: string): SetupStatus {
        const configPath = path.join(userDataPath, CONFIG_FILE);
        const legacySaltPath = path.join(userDataPath, LEGACY_SALT_FILE);
        if (!fs.existsSync(configPath)) {
            return fs.existsSync(legacySaltPath)
                ? { isSetup: true, hasRecovery: false, vaultState: 'legacy-migration-required', configVersion: 1 }
                : { isSetup: false, hasRecovery: false, vaultState: 'not-setup' };
        }
        try {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as SecurityConfigV3 | SecurityConfigV2;
            if (config.version === 3) {
                return {
                    isSetup: true,
                    hasRecovery: true,
                    vaultState: this.deviceKeyStore.status().available ? 'ready' : 'recovery-required',
                    configVersion: 3
                };
            }
            if (config.version === 2) {
                return { isSetup: true, hasRecovery: !!config.recovery, vaultState: 'legacy-migration-required', configVersion: 2 };
            }
            return { isSetup: true, hasRecovery: false, vaultState: 'corrupt', configVersion: (config as any).version };
        } catch {
            return { isSetup: true, hasRecovery: false, vaultState: 'corrupt' };
        }
    }

    /** adminPassword remains only for caller compatibility; it never wraps the DEK. */
    async setup(_adminPassword: string, dbPath: string, userDataPath: string): Promise<string> {
        this.configurePaths(dbPath, userDataPath);
        this.assertDeviceStoreAvailable();
        this.reconcileSetupJournal();
        if (fs.existsSync(path.join(userDataPath, CONFIG_FILE))) throw new Error('ALREADY_SETUP');
        const databaseCreated = !fs.existsSync(dbPath) || fs.statSync(dbPath).size === 0;
        if (!databaseCreated) throw new Error('UNCLAIMED_DATABASE_PRESENT');
        const journal: SetupJournal = {
            version: 1,
            phase: 'started',
            databaseCreated,
            startedAt: new Date().toISOString()
        };
        this.saveSetupJournal(journal);
        this.step('setup-after-journal');
        const dek = crypto.randomBytes(32);
        const recoveryCode = this.generateRecoveryCodeString();
        const config = await this.createV3Config(dek, recoveryCode, undefined, undefined, 'fresh-setup');
        try {
            this.initDb(dbPath, dek);
            this.bindVault(config.vaultId, config.keyVersion, true);
            this.db.pragma('wal_checkpoint(TRUNCATE)');
            this.step('setup-after-bind');
            this.saveConfigAtomic(config);
            this.step('setup-after-config-commit');
            journal.phase = 'vault-created';
            this.saveSetupJournal(journal);
            this.dek = dek;
            this.unlockedSlotId ??= PRIMARY_SLOT_ID;
            return recoveryCode;
        } catch (error) {
            this.closeDb();
            this.rollbackSetup(journal);
            throw error;
        }
    }

    /** Marks the entire setup pipeline (vault, schema, settings, admin) durable. */
    completeProvisioning(): void {
        const journal = this.loadSetupJournal();
        if (!journal || journal.phase !== 'vault-created') throw new Error('PROVISIONING_NOT_STARTED');
        this.db?.pragma('wal_checkpoint(TRUNCATE)');
        journal.phase = 'complete';
        this.saveSetupJournal(journal);
        this.cleanupSetupJournal();
    }

    /** Rolls back only files created by the in-progress fresh provisioning. */
    abortProvisioning(): void {
        const journal = this.loadSetupJournal();
        if (!journal || journal.phase === 'complete') return;
        this.rollbackSetup(journal);
    }

    /** Reconciles an interrupted setup before setup-state is presented. */
    reconcileProvisioning(dbPath: string, userDataPath: string): void {
        this.configurePaths(dbPath, userDataPath);
        this.reconcileSetupJournal();
    }

    /** Unlock v3 using only the OS-bound device envelope. */
    async initializeDevice(dbPath: string, userDataPath: string): Promise<VaultUnlockResult> {
        this.configurePaths(dbPath, userDataPath);
        this.reconcileSetupJournal();
        this.reconcileMigrationJournal();
        const status = this.isSetup(userDataPath);
        if (!status.isSetup) throw new Error('NOT_SETUP');
        if (status.vaultState === 'legacy-migration-required') throw new Error('LEGACY_MIGRATION_REQUIRED');
        if (status.vaultState === 'corrupt') throw new Error('SECURITY_CONFIG_CORRUPT');
        this.assertDeviceStoreAvailable();
        const config = this.loadConfigV3();
        try {
            const { dek, slotId } = this.unprotectAnySlot(config);
            this.unlockedSlotId = slotId;
            this.initDb(dbPath, dek);
            this.bindVault(config.vaultId, config.keyVersion, false);
            this.dek = dek;
            this.unlockedSlotId ??= PRIMARY_SLOT_ID;
            return { migrated: false };
        } catch (error: any) {
            this.closeDb();
            if (error?.message === 'VAULT_BINDING_MISMATCH') throw error;
            throw new Error('DEVICE_UNLOCK_FAILED');
        }
    }

    /** One-time compatibility path. The legacy secret is never retained in v3. */
    async migrateLegacy(legacySecret: string, dbPath: string, userDataPath: string): Promise<VaultUnlockResult> {
        this.configurePaths(dbPath, userDataPath);
        this.assertDeviceStoreAvailable();
        this.reconcileMigrationJournal();
        const configPath = path.join(userDataPath, CONFIG_FILE);
        if (fs.existsSync(configPath)) {
            const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as SecurityConfigV3 | SecurityConfigV2;
            if (parsed.version === 3) return this.initializeDevice(dbPath, userDataPath);
            if (parsed.version !== 2) throw new Error('UNSUPPORTED_SECURITY_CONFIG');
            return this.migrateV2(parsed, legacySecret);
        }
        const saltPath = path.join(userDataPath, LEGACY_SALT_FILE);
        if (!fs.existsSync(saltPath)) throw new Error('NOT_SETUP');
        return this.migrateV1(legacySecret, saltPath);
    }

    /** Re-enrol this device from the portable recovery envelope. */
    async recoverDevice(recoveryCode: string, userDataPath: string, dbPath: string): Promise<VaultUnlockResult> {
        this.configurePaths(dbPath, userDataPath);
        this.assertDeviceStoreAvailable();
        const status = this.isSetup(userDataPath);
        if (status.configVersion === 2) {
            return this.migrateLegacy(recoveryCode, dbPath, userDataPath);
        }
        const config = this.loadConfigV3();
        const previousConfigText = fs.readFileSync(path.join(userDataPath, CONFIG_FILE), 'utf8');
        let dek: Buffer;
        let usedTransition = false;
        this.validateRecoveryEnvelope(config.recovery);
        try {
            dek = await this.unwrapRecovery(config.recovery, recoveryCode, config.vaultId, config.keyVersion);
        } catch {
            if (config.transitionRecovery?.purpose !== 'legacy-transition') throw new Error('INVALID_RECOVERY_CODE');
            this.validateRecoveryEnvelope(config.transitionRecovery);
            try {
                dek = await this.unwrapRecovery(
                    config.transitionRecovery,
                    recoveryCode,
                    config.vaultId,
                    config.keyVersion,
                    'legacy-transition'
                );
                usedTransition = true;
            } catch { throw new Error('INVALID_RECOVERY_CODE'); }
        }
        try {
            this.initDb(dbPath, dek);
            this.bindVault(config.vaultId, config.keyVersion, false);
        } catch (error: any) {
            this.closeDb();
            dek.fill(0);
            if (error?.message === 'VAULT_BINDING_MISMATCH') throw error;
            throw new Error('INVALID_RECOVERY_CODE');
        }
        try {
            const updated: SecurityConfigV3 = {
                ...config,
                device: this.createDeviceEnvelope(dek, config.vaultId, config.keyVersion)
            };
            if (usedTransition) {
                const freshCode = this.generateRecoveryCodeString();
                updated.recovery = await this.createRecoveryEnvelope(dek, freshCode, config.vaultId, config.keyVersion);
                updated.transitionRecovery = await this.createTransitionRecoveryEnvelope(
                    dek, recoveryCode, config.vaultId, config.keyVersion
                );
                updated.pendingRecoveryAck = this.createPendingRecoveryAck(
                    freshCode, config.vaultId, config.keyVersion, 'transition-recovery'
                );
            } else {
                // Possession of the primary code retires every transitional artifact.
                delete updated.pendingRecoveryAck;
                delete updated.transitionRecovery;
            }
            this.saveConfigAtomic(updated);
            this.dek = dek;
            this.unlockedSlotId ??= PRIMARY_SLOT_ID;
            return { migrated: false };
        } catch (error) {
            this.failEnrollment(dek, previousConfigText);
            throw error;
        }
    }

    async regenerateRecoveryCode(): Promise<string> {
        if (!this.dek) throw new Error('VAULT_LOCKED');
        const config = this.loadConfigV3();
        const recoveryCode = this.generateRecoveryCodeString();
        const nextRecovery = await this.createRecoveryEnvelope(
            this.dek, recoveryCode, config.vaultId, config.keyVersion
        );
        config.pendingRecoveryAck = this.createPendingRecoveryAck(
            recoveryCode, config.vaultId, config.keyVersion, 'recovery-rotation', nextRecovery
        );
        this.saveConfigAtomic(config);
        return recoveryCode;
    }

    /** Re-wrap the unchanged DEK for this device; independent of all user credentials. */
    rotateDeviceEnvelope(): void {
        if (!this.dek) throw new Error('VAULT_LOCKED');
        this.assertDeviceStoreAvailable();
        const config = this.loadConfigV3();
        const slot = config.slots?.find((entry) => entry.id === this.unlockedSlotId);
        if (slot) {
            // Re-wrap the slot this process opened, never overwrite the primary with it.
            slot.protectedPayload = this.createDeviceEnvelope(this.dek, config.vaultId, config.keyVersion).protectedPayload;
        } else {
            config.device = { ...config.device, ...this.createDeviceEnvelope(this.dek, config.vaultId, config.keyVersion) };
        }
        this.saveConfigAtomic(config);
    }

    getPendingRecoveryCode(): string | null {
        const config = this.loadConfigV3();
        if (!config.pendingRecoveryAck) return null;
        const payload = this.unprotectContextPayload(config.pendingRecoveryAck.protectedPayload);
        if (payload.version !== 1 || payload.purpose !== 'recovery-ack' ||
            payload.vaultId !== config.vaultId || payload.keyVersion !== config.keyVersion ||
            typeof payload.recoveryCode !== 'string') {
            throw new Error('PENDING_RECOVERY_CONTEXT_MISMATCH');
        }
        return payload.recoveryCode;
    }

    acknowledgePendingRecoveryCode(recoveryCode: string): void {
        const config = this.loadConfigV3();
        if (!config.pendingRecoveryAck) throw new Error('NO_PENDING_RECOVERY_CODE');
        const pending = this.getPendingRecoveryCode();
        if (!pending || !this.constantTimeEqual(pending, recoveryCode)) throw new Error('INVALID_RECOVERY_ACK');
        if (config.pendingRecoveryAck.reason === 'recovery-rotation') {
            if (!config.pendingRecoveryAck.nextRecovery) throw new Error('PENDING_RECOVERY_ENVELOPE_MISSING');
            this.validateRecoveryEnvelope(config.pendingRecoveryAck.nextRecovery);
            config.recovery = config.pendingRecoveryAck.nextRecovery;
        }
        delete config.pendingRecoveryAck;
        delete config.transitionRecovery;
        this.saveConfigAtomic(config);
    }

    /** Frozen portable contract consumed by issue #8. */
    getPortableVaultMetadata(): Pick<SecurityConfigV3, 'version' | 'vaultId' | 'keyVersion' | 'recovery' | 'transitionRecovery'> {
        const { version, vaultId, keyVersion, recovery, transitionRecovery } = this.loadConfigV3();
        return { version, vaultId, keyVersion, recovery, ...(transitionRecovery ? { transitionRecovery } : {}) };
    }

    /** Frozen restore contract consumed by issue #8. */
    async installPortableVaultMetadata(
        metadata: Pick<SecurityConfigV3, 'version' | 'vaultId' | 'keyVersion' | 'recovery' | 'transitionRecovery'>,
        recoveryCode: string,
        dbPath: string,
        userDataPath: string
    ): Promise<void> {
        this.configurePaths(dbPath, userDataPath);
        this.assertDeviceStoreAvailable();
        const configPath = path.join(userDataPath, CONFIG_FILE);
        const previousConfigText = fs.existsSync(configPath)
            ? fs.readFileSync(configPath, 'utf8')
            : undefined;
        let dek: Buffer;
        let usedTransition = false;
        this.validateRecoveryEnvelope(metadata.recovery);
        try {
            dek = await this.unwrapRecovery(metadata.recovery, recoveryCode, metadata.vaultId, metadata.keyVersion);
        } catch {
            if (metadata.transitionRecovery?.purpose !== 'legacy-transition') throw new Error('INVALID_RECOVERY_CODE');
            this.validateRecoveryEnvelope(metadata.transitionRecovery);
            dek = await this.unwrapRecovery(
                metadata.transitionRecovery,
                recoveryCode,
                metadata.vaultId,
                metadata.keyVersion,
                'legacy-transition'
            );
            usedTransition = true;
        }
        try {
            this.initDb(dbPath, dek);
            this.bindVault(metadata.vaultId, metadata.keyVersion, false);
        } catch (error) {
            this.closeDb();
            dek.fill(0);
            throw error;
        }
        try {
            const config: SecurityConfigV3 = {
                ...metadata,
                device: this.createDeviceEnvelope(dek, metadata.vaultId, metadata.keyVersion)
            };
            if (usedTransition) {
                const freshCode = this.generateRecoveryCodeString();
                config.recovery = await this.createRecoveryEnvelope(
                    dek, freshCode, metadata.vaultId, metadata.keyVersion
                );
                config.transitionRecovery = await this.createTransitionRecoveryEnvelope(
                    dek, recoveryCode, metadata.vaultId, metadata.keyVersion
                );
                config.pendingRecoveryAck = this.createPendingRecoveryAck(
                    freshCode, metadata.vaultId, metadata.keyVersion, 'transition-recovery'
                );
            } else {
                delete config.pendingRecoveryAck;
                delete config.transitionRecovery;
            }
            this.saveConfigAtomic(config);
            this.dek = dek;
            this.unlockedSlotId ??= PRIMARY_SLOT_ID;
        } catch (error) {
            this.failEnrollment(dek, previousConfigText);
            throw error;
        }
    }

    /** Every way this vault can be unlocked. Payloads are never returned. */
    listKeySlots(): KeySlotSummary[] {
        const config = this.loadConfigV3();
        const extra = config.slots ?? [];
        const unlockMethods = 1 + extra.length;
        return [
            {
                id: PRIMARY_SLOT_ID,
                provider: config.device.provider,
                ...(config.device.label ? { label: config.device.label } : {}),
                ...(config.device.createdAt ? { createdAt: config.device.createdAt } : {}),
                kind: 'primary',
                removable: unlockMethods > 1,
                unlockedWith: this.unlockedSlotId === PRIMARY_SLOT_ID
            },
            ...extra.map((slot): KeySlotSummary => ({
                id: slot.id,
                provider: slot.provider,
                ...(slot.label ? { label: slot.label } : {}),
                createdAt: slot.createdAt,
                kind: 'slot',
                removable: true,
                unlockedWith: this.unlockedSlotId === slot.id
            })),
            {
                id: RECOVERY_SLOT_ID,
                provider: 'recovery-code',
                kind: 'recovery',
                removable: false,
                unlockedWith: false
            }
        ];
    }

    /** The slot this process unlocked with, or null while locked or after setup. */
    getUnlockedSlotId(): string | null { return this.dek ? this.unlockedSlotId : null; }

    /**
     * Adds an unlock method for the open vault. The new slot is proven to
     * open before it is saved, so a broken provider never lands in the config.
     */
    addKeySlot(store: DeviceKeyStore, label?: string): KeySlotSummary {
        if (!this.dek) throw new Error('VAULT_LOCKED');
        const status = store.status();
        if (!status.available) throw new Error(status.message || status.reason || 'DEVICE_KEY_UNAVAILABLE');
        const cleanLabel = this.cleanSlotLabel(label);
        const config = this.loadConfigV3();
        const envelope = this.createDeviceEnvelope(this.dek, config.vaultId, config.keyVersion, store);
        let check: Buffer;
        try {
            check = this.dekFromPayload(
                JSON.parse(store.unprotect(Buffer.from(envelope.protectedPayload, 'base64')).toString('utf8')), config);
        } catch {
            throw new Error('KEY_SLOT_VERIFY_FAILED');
        }
        const matches = crypto.timingSafeEqual(check, this.dek);
        check.fill(0);
        if (!matches) throw new Error('KEY_SLOT_VERIFY_FAILED');
        const slot: KeySlot = {
            id: crypto.randomBytes(8).toString('hex'),
            provider: envelope.provider,
            ...(cleanLabel ? { label: cleanLabel } : {}),
            createdAt: new Date().toISOString(),
            protectedPayload: envelope.protectedPayload
        };
        config.slots = [...(config.slots ?? []), slot];
        this.saveConfigAtomic(config);
        return this.listKeySlots().find((entry) => entry.id === slot.id)!;
    }

    /**
     * Removes an unlock method. The recovery code can't be removed, and at
     * least one other method must remain. Removing the primary promotes the
     * oldest extra slot into its place.
     */
    removeKeySlot(slotId: string): void {
        if (!this.dek) throw new Error('VAULT_LOCKED');
        if (slotId === RECOVERY_SLOT_ID) throw new Error('RECOVERY_SLOT_REQUIRED');
        const config = this.loadConfigV3();
        const extra = config.slots ?? [];
        if (slotId === PRIMARY_SLOT_ID) {
            if (extra.length === 0) throw new Error('LAST_KEY_SLOT');
            const [promoted, ...rest] = extra;
            config.device = {
                provider: promoted.provider,
                protectedPayload: promoted.protectedPayload,
                ...(promoted.label ? { label: promoted.label } : {}),
                createdAt: promoted.createdAt
            };
            config.slots = rest;
            if (this.unlockedSlotId === PRIMARY_SLOT_ID) this.unlockedSlotId = null;
            else if (this.unlockedSlotId === promoted.id) this.unlockedSlotId = PRIMARY_SLOT_ID;
        } else {
            if (!extra.some((slot) => slot.id === slotId)) throw new Error('KEY_SLOT_NOT_FOUND');
            config.slots = extra.filter((slot) => slot.id !== slotId);
            if (this.unlockedSlotId === slotId) this.unlockedSlotId = null;
        }
        if (config.slots.length === 0) delete config.slots;
        this.saveConfigAtomic(config);
    }

    private cleanSlotLabel(label?: string): string | undefined {
        if (label === undefined || label === null) return undefined;
        const clean = String(label).replace(/[\u0000-\u001f\u007f]/g, '').trim();
        if (clean.length > SLOT_LABEL_MAX) throw new Error('KEY_SLOT_LABEL_TOO_LONG');
        return clean || undefined;
    }

    generateRecoveryCodeString(): string {
        const hex = crypto.randomBytes(16).toString('hex').toUpperCase();
        return `${hex.slice(0, 8)}-${hex.slice(8, 16)}-${hex.slice(16, 24)}-${hex.slice(24, 32)}`;
    }

    async deriveKey(secret: string, salt: Buffer): Promise<Buffer> {
        return argon2.hash(secret, {
            type: argon2.argon2id,
            raw: true,
            salt,
            ...RECOVERY_KDF_PARAMS
        });
    }

    getDb(): any { return this.db; }
    getDbPath(): string { return this.dbPath; }
    getVaultId(): string | null { try { return this.loadConfigV3().vaultId; } catch { return null; } }

    closeDb(): void {
        if (this.db) this.db.close();
        this.db = null;
        if (this.dek) this.dek.fill(0);
        this.dek = null;
        this.unlockedSlotId = null;
    }

    private async migrateV2(config: SecurityConfigV2, secret: string): Promise<VaultUnlockResult> {
        let oldDek: Buffer;
        try {
            oldDek = await this.unwrapLegacy(config.wrappedKey, config.iv, config.salt, secret);
        } catch {
            if (!config.recovery) throw new Error('INVALID_LEGACY_CREDENTIAL');
            try {
                oldDek = await this.unwrapLegacy(
                    config.recovery.wrappedKey,
                    config.recovery.iv,
                    config.recovery.salt,
                    secret
                );
            } catch { throw new Error('INVALID_LEGACY_CREDENTIAL'); }
        }
        try {
            this.initDb(this.dbPath, oldDek);
            this.db.pragma('wal_checkpoint(TRUNCATE)');
            this.closeDb();
        } catch {
            this.closeDb();
            throw new Error('INVALID_LEGACY_CREDENTIAL');
        }
        return this.commitLegacyMigration(2, oldDek, this.generateRecoveryCodeString(), secret, false);
    }

    private async migrateV1(secret: string, saltPath: string): Promise<VaultUnlockResult> {
        const oldKey = await this.deriveLegacyKey(secret, fs.readFileSync(saltPath));
        try { this.initDb(this.dbPath, oldKey); } catch { throw new Error('INVALID_LEGACY_CREDENTIAL'); }
        this.db.pragma('wal_checkpoint(TRUNCATE)');
        this.closeDb();
        return this.commitLegacyMigration(1, crypto.randomBytes(32), this.generateRecoveryCodeString(), secret, true, oldKey, saltPath);
    }

    private async commitLegacyMigration(
        sourceVersion: 1 | 2,
        dek: Buffer,
        recoveryCode: string,
        legacySecret: string,
        rekey: boolean,
        oldKey?: Buffer,
        saltPath?: string
    ): Promise<VaultUnlockResult> {
        const backup = `${this.dbPath}.pre-v3-migration`;
        const configPath = path.join(this.appUserDataPath, CONFIG_FILE);
        const configBackup = `${configPath}.pre-v3-migration`;
        const journal: MigrationJournal = {
            version: 1,
            sourceVersion,
            phase: 'snapshot-created',
            databaseBackup: backup,
            configBackup: fs.existsSync(configPath) ? configBackup : undefined,
            legacySaltPath: saltPath,
            startedAt: new Date().toISOString()
        };
        fs.copyFileSync(this.dbPath, backup);
        this.fsyncFile(backup);
        if (journal.configBackup) {
            fs.copyFileSync(configPath, journal.configBackup);
            this.fsyncFile(journal.configBackup);
        }
        this.saveJournal(journal);
        this.step('migration-after-snapshot');
        let committed = false;
        try {
            if (rekey) {
                this.initDb(this.dbPath, oldKey!);
                this.db.pragma(`rekey = "x'${dek.toString('hex')}'"`);
                this.db.pragma('wal_checkpoint(TRUNCATE)');
                this.closeDb();
                journal.phase = 'database-rekeyed';
                this.saveJournal(journal);
                this.step('migration-after-rekey');
            }
            this.initDb(this.dbPath, dek);
            const config = await this.createV3Config(dek, recoveryCode, sourceVersion, legacySecret, 'legacy-migration');
            this.bindVault(config.vaultId, config.keyVersion, true);
            // Make the binding durable in the main database before the config
            // commit becomes authoritative.
            this.db.pragma('wal_checkpoint(TRUNCATE)');
            this.step('migration-after-bind');
            journal.phase = 'config-committing';
            this.saveJournal(journal);
            this.saveConfigAtomic(config);
            committed = true;
            this.step('migration-after-config-commit');
            journal.phase = 'config-written';
            this.saveJournal(journal);
            this.dek = dek;
            this.unlockedSlotId ??= PRIMARY_SLOT_ID;
            this.cleanupCommittedMigration(journal, saltPath);
            return { migrated: true };
        } catch (error) {
            if (committed || this.hasV3Config()) {
                this.dek = dek;
            this.unlockedSlotId ??= PRIMARY_SLOT_ID;
                this.cleanupCommittedMigration(journal, saltPath);
                return { migrated: true };
            }
            this.closeDb();
            this.restoreMigrationSnapshot(journal);
            this.cleanupRollbackArtifacts(journal);
            throw error;
        }
    }

    private reconcileMigrationJournal(): void {
        const journalPath = this.journalPath();
        if (!fs.existsSync(journalPath)) return;
        const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as MigrationJournal;
        const configCommitted = this.hasV3Config();
        if (!configCommitted) {
            this.closeDb();
            if (journal.phase !== 'rollback-restored') this.restoreMigrationSnapshot(journal);
            this.cleanupRollbackArtifacts(journal);
            return;
        }
        this.cleanupCommittedMigration(journal, journal.legacySaltPath);
    }

    private async createV3Config(
        dek: Buffer,
        recoveryCode: string,
        migratedFrom?: 1 | 2,
        legacySecret?: string,
        pendingReason?: PendingRecoveryAck['reason']
    ): Promise<SecurityConfigV3> {
        const vaultId = crypto.randomUUID();
        const keyVersion = 1;
        const config: SecurityConfigV3 = {
            version: 3,
            vaultId,
            keyVersion,
            device: this.createDeviceEnvelope(dek, vaultId, keyVersion),
            recovery: await this.createRecoveryEnvelope(dek, recoveryCode, vaultId, keyVersion)
        };
        if (pendingReason) {
            config.pendingRecoveryAck = this.createPendingRecoveryAck(
                recoveryCode, vaultId, keyVersion, pendingReason
            );
        }
        if (migratedFrom && legacySecret) {
            config.migratedFrom = migratedFrom;
            config.transitionRecovery = await this.createTransitionRecoveryEnvelope(
                dek, legacySecret, vaultId, keyVersion
            );
        }
        return config;
    }

    private async createRecoveryEnvelope(
        dek: Buffer,
        code: string,
        vaultId: string,
        keyVersion: number,
        purpose: 'recovery-dek' | 'legacy-transition' = 'recovery-dek'
    ): Promise<RecoveryEnvelope> {
        const salt = crypto.randomBytes(16);
        const wrapped = this.aesEncrypt(
            dek,
            await this.deriveKey(code, salt),
            this.recoveryAad(vaultId, keyVersion, purpose)
        );
        return {
            algorithm: 'aes-256-gcm',
            kdf: 'argon2id',
            kdfParams: { ...RECOVERY_KDF_PARAMS },
            aadVersion: 1,
            salt: salt.toString('hex'),
            ...wrapped
        };
    }

    private async unwrapRecovery(
        envelope: RecoveryEnvelope,
        code: string,
        vaultId: string,
        keyVersion: number,
        purpose: 'recovery-dek' | 'legacy-transition' = 'recovery-dek'
    ): Promise<Buffer> {
        this.validateRecoveryEnvelope(envelope);
        const salt = Buffer.from(envelope.salt, 'hex');
        const key = await argon2.hash(code, {
            type: argon2.argon2id,
            raw: true,
            salt,
            ...envelope.kdfParams
        });
        return this.aesDecrypt(envelope.wrappedKey, envelope.iv, key, this.recoveryAad(vaultId, keyVersion, purpose));
    }

    private validateRecoveryEnvelope(envelope: RecoveryEnvelope): void {
        const params = envelope?.kdfParams;
        const validHex = (value: unknown, bytes: number) =>
            typeof value === 'string' && value.length === bytes * 2 && /^[0-9a-f]+$/i.test(value);
        if (envelope?.algorithm !== 'aes-256-gcm' || envelope?.kdf !== 'argon2id' || envelope?.aadVersion !== 1 ||
            !validHex(envelope.salt, 16) || !validHex(envelope.iv, 12) ||
            typeof envelope.wrappedKey !== 'string' || envelope.wrappedKey.length !== 96 ||
            !/^[0-9a-f]+$/i.test(envelope.wrappedKey) || !params ||
            !Number.isInteger(params.timeCost) || params.timeCost < 1 || params.timeCost > 10 ||
            !Number.isInteger(params.memoryCost) || params.memoryCost < 8192 || params.memoryCost > 1048576 ||
            !Number.isInteger(params.parallelism) || params.parallelism < 1 || params.parallelism > 16 ||
            params.hashLength !== 32) {
            throw new Error('INVALID_RECOVERY_ENVELOPE');
        }
    }

    private async unwrapLegacy(wrappedKey: string, iv: string, salt: string, secret: string): Promise<Buffer> {
        return this.aesDecrypt(wrappedKey, iv, await this.deriveLegacyKey(secret, Buffer.from(salt, 'hex')));
    }

    private async deriveLegacyKey(secret: string, salt: Buffer): Promise<Buffer> {
        return argon2.hash(secret, { type: argon2.argon2id, raw: true, salt });
    }

    private aesEncrypt(data: Buffer, key: Buffer, aad?: Buffer): { wrappedKey: string; iv: string } {
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        if (aad) cipher.setAAD(aad);
        const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
        return { wrappedKey: Buffer.concat([cipher.getAuthTag(), ciphertext]).toString('hex'), iv: iv.toString('hex') };
    }

    private aesDecrypt(value: string, ivHex: string, key: Buffer, aad?: Buffer): Buffer {
        const valueBuffer = Buffer.from(value, 'hex');
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
        if (aad) decipher.setAAD(aad);
        decipher.setAuthTag(valueBuffer.subarray(0, 16));
        return Buffer.concat([decipher.update(valueBuffer.subarray(16)), decipher.final()]);
    }

    private bindVault(vaultId: string, keyVersion: number, create: boolean): void {
        if (create) {
            this.db.exec(`CREATE TABLE IF NOT EXISTS ${VAULT_TABLE} (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), vault_id TEXT NOT NULL, key_version INTEGER NOT NULL)`);
        }
        let row;
        try {
            row = this.db.prepare(`SELECT vault_id, key_version FROM ${VAULT_TABLE} WHERE singleton = 1`).get();
        } catch {
            throw new Error('VAULT_BINDING_MISMATCH');
        }
        if (!row && create) {
            this.db.prepare(`INSERT INTO ${VAULT_TABLE} (singleton, vault_id, key_version) VALUES (1, ?, ?)`).run(vaultId, keyVersion);
            return;
        }
        if (!row || row.vault_id !== vaultId || row.key_version !== keyVersion) throw new Error('VAULT_BINDING_MISMATCH');
    }

    private initDb(filePath: string, key: Buffer): void {
        // Never enable verbose SQL logging here: SQLCipher's key PRAGMA would
        // disclose the live DEK to logs even in a development build.
        const db = new Database(filePath);
        try {
            db.pragma(`key = "x'${key.toString('hex')}'"`);
            db.prepare('SELECT count(*) FROM sqlite_master').get();
            this.db = db;
        } catch (error: any) {
            db.close();
            if (String(error?.message).includes('file is not a database')) throw new Error('INVALID_PASSWORD');
            throw error;
        }
    }

    private configurePaths(dbPath: string, userDataPath: string): void {
        this.dbPath = dbPath;
        this.appUserDataPath = userDataPath;
    }

    private assertDeviceStoreAvailable(): void {
        const status = this.deviceKeyStore.status();
        if (!status.available) throw new Error(status.message || status.reason || 'DEVICE_KEY_UNAVAILABLE');
    }

    private loadConfigV3(): SecurityConfigV3 {
        const config = JSON.parse(fs.readFileSync(path.join(this.appUserDataPath, CONFIG_FILE), 'utf8')) as SecurityConfigV3;
        if (config.version !== 3) throw new Error('LEGACY_MIGRATION_REQUIRED');
        if (!config.vaultId || !Number.isInteger(config.keyVersion) || config.keyVersion < 1 ||
            !config.device?.protectedPayload || !config.recovery?.wrappedKey || !config.recovery?.kdfParams) {
            throw new Error('SECURITY_CONFIG_CORRUPT');
        }
        if (config.slots !== undefined) {
            const ids = new Set<string>();
            const valid = Array.isArray(config.slots) && config.slots.every((slot) =>
                slot && typeof slot.id === 'string' && /^[a-f0-9]{16}$/.test(slot.id) && !ids.has(slot.id) &&
                ids.add(slot.id) && typeof slot.provider === 'string' && typeof slot.protectedPayload === 'string' &&
                slot.protectedPayload.length > 0 && typeof slot.createdAt === 'string');
            if (!valid) throw new Error('SECURITY_CONFIG_CORRUPT');
        }
        return config;
    }

    private saveConfigAtomic(config: SecurityConfigV3): void {
        fs.mkdirSync(this.appUserDataPath, { recursive: true });
        const target = path.join(this.appUserDataPath, CONFIG_FILE);
        const temporary = `${target}.tmp`;
        const fd = fs.openSync(temporary, 'w', 0o600);
        try {
            fs.writeFileSync(fd, JSON.stringify(config, null, 2), 'utf8');
            this.fsyncDescriptor(fd);
        } finally { fs.closeSync(fd); }
        fs.renameSync(temporary, target);
        this.fsyncDirectory();
    }

    private failEnrollment(dek: Buffer, previousConfigText?: string): void {
        this.closeDb();
        dek.fill(0);
        const target = path.join(this.appUserDataPath, CONFIG_FILE);
        const temporary = `${target}.tmp`;
        if (previousConfigText === undefined) {
            for (const file of [target, temporary]) {
                if (fs.existsSync(file)) fs.unlinkSync(file);
            }
            this.fsyncDirectory();
            return;
        }
        this.saveTextAtomic(target, previousConfigText);
    }

    private saveTextAtomic(target: string, text: string): void {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const temporary = `${target}.tmp`;
        const fd = fs.openSync(temporary, 'w', 0o600);
        try {
            fs.writeFileSync(fd, text, 'utf8');
            this.fsyncDescriptor(fd);
        } finally { fs.closeSync(fd); }
        fs.renameSync(temporary, target);
        this.fsyncDirectory();
    }

    private journalPath(): string { return path.join(this.appUserDataPath, JOURNAL_FILE); }
    private saveJournal(journal: MigrationJournal): void {
        const target = this.journalPath();
        const temporary = `${target}.tmp`;
        const fd = fs.openSync(temporary, 'w', 0o600);
        try {
            fs.writeFileSync(fd, JSON.stringify(journal, null, 2), 'utf8');
            this.fsyncDescriptor(fd);
        } finally { fs.closeSync(fd); }
        fs.renameSync(temporary, target);
        this.fsyncDirectory();
    }

    private hasV3Config(): boolean {
        try {
            const config = JSON.parse(fs.readFileSync(path.join(this.appUserDataPath, CONFIG_FILE), 'utf8'));
            return config.version === 3 && !!config.vaultId && !!config.device?.protectedPayload;
        } catch { return false; }
    }

    private restoreMigrationSnapshot(journal: MigrationJournal): void {
        if (!fs.existsSync(journal.databaseBackup)) throw new Error('MIGRATION_SNAPSHOT_MISSING');
        if (journal.configBackup && !fs.existsSync(journal.configBackup)) throw new Error('MIGRATION_SNAPSHOT_MISSING');
        for (const suffix of ['-wal', '-shm']) {
            const sidecar = `${this.dbPath}${suffix}`;
            if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar);
        }
        if (fs.existsSync(journal.databaseBackup)) fs.copyFileSync(journal.databaseBackup, this.dbPath);
        const configPath = path.join(this.appUserDataPath, CONFIG_FILE);
        if (journal.configBackup && fs.existsSync(journal.configBackup)) {
            fs.copyFileSync(journal.configBackup, configPath);
        } else if (fs.existsSync(configPath)) {
            fs.unlinkSync(configPath);
        }
        journal.phase = 'rollback-restored';
        this.saveJournal(journal);
    }

    private createDeviceEnvelope(
        dek: Buffer, vaultId: string, keyVersion: number, store: DeviceKeyStore = this.deviceKeyStore
    ): SecurityConfigV3['device'] {
        const payload = Buffer.from(JSON.stringify({
            version: 1,
            purpose: 'device-dek',
            vaultId,
            keyVersion,
            dek: dek.toString('base64')
        }), 'utf8');
        return {
            provider: store.status().provider,
            protectedPayload: store.protect(payload).toString('base64')
        };
    }

    private createPendingRecoveryAck(
        recoveryCode: string,
        vaultId: string,
        keyVersion: number,
        reason: PendingRecoveryAck['reason'],
        nextRecovery?: RecoveryEnvelope
    ): PendingRecoveryAck {
        return {
            protectedPayload: this.protectContextPayload({
                version: 1,
                purpose: 'recovery-ack',
                vaultId,
                keyVersion,
                recoveryCode
            }),
            createdAt: new Date().toISOString(),
            reason,
            ...(nextRecovery ? { nextRecovery } : {})
        };
    }

    private async createTransitionRecoveryEnvelope(
        dek: Buffer,
        legacySecret: string,
        vaultId: string,
        keyVersion: number
    ): Promise<TransitionRecoveryEnvelope> {
        return {
            ...await this.createRecoveryEnvelope(
                dek, legacySecret, vaultId, keyVersion, 'legacy-transition'
            ),
            purpose: 'legacy-transition'
        };
    }

    /**
     * Opens the primary slot, then any extra slot, with this service's key
     * store. A slot that decrypts but names another vault is tampering and
     * stops the search; one that fails to decrypt belongs to another provider
     * or machine, so the next slot is tried.
     */
    private unprotectAnySlot(config: SecurityConfigV3): { dek: Buffer; slotId: string } {
        const candidates: { id: string; protectedPayload: string }[] = [
            { id: PRIMARY_SLOT_ID, protectedPayload: config.device.protectedPayload },
            ...(config.slots ?? []).map((slot) => ({ id: slot.id, protectedPayload: slot.protectedPayload }))
        ];
        for (const candidate of candidates) {
            let payload: any;
            try {
                payload = this.unprotectContextPayload(candidate.protectedPayload);
            } catch {
                continue;
            }
            return { dek: this.dekFromPayload(payload, config), slotId: candidate.id };
        }
        throw new Error('INVALID_DEVICE_ENVELOPE');
    }

    private dekFromPayload(payload: any, config: SecurityConfigV3): Buffer {
        if (payload?.version !== 1 || payload.purpose !== 'device-dek' ||
            payload.vaultId !== config.vaultId || payload.keyVersion !== config.keyVersion ||
            typeof payload.dek !== 'string') {
            throw new Error('VAULT_BINDING_MISMATCH');
        }
        const dek = Buffer.from(payload.dek, 'base64');
        if (dek.length !== 32) throw new Error('INVALID_DEVICE_ENVELOPE');
        return dek;
    }

    private protectContextPayload(payload: Record<string, unknown>): string {
        return this.deviceKeyStore.protect(Buffer.from(JSON.stringify(payload), 'utf8')).toString('base64');
    }

    private unprotectContextPayload(value: string): any {
        try {
            return JSON.parse(this.deviceKeyStore.unprotect(Buffer.from(value, 'base64')).toString('utf8'));
        } catch { throw new Error('INVALID_DEVICE_ENVELOPE'); }
    }

    private recoveryAad(
        vaultId: string,
        keyVersion: number,
        purpose: 'recovery-dek' | 'legacy-transition' = 'recovery-dek'
    ): Buffer {
        return Buffer.from(`nalamdesk|v3|${purpose}|${vaultId}|${keyVersion}`, 'utf8');
    }

    private constantTimeEqual(left: string, right: string): boolean {
        const leftBuffer = Buffer.from(left, 'utf8');
        const rightBuffer = Buffer.from(right, 'utf8');
        if (leftBuffer.length !== rightBuffer.length) {
            // Keep a fixed-cost comparison even when lengths differ.
            crypto.timingSafeEqual(leftBuffer, Buffer.alloc(leftBuffer.length));
            return false;
        }
        return crypto.timingSafeEqual(leftBuffer, rightBuffer);
    }

    private cleanupCommittedMigration(journal: MigrationJournal, saltPath?: string): void {
        let clean = true;
        const attempt = (step: SecurityStep, action: () => void) => {
            try { this.step(step); action(); } catch { clean = false; }
        };
        if (saltPath && fs.existsSync(saltPath)) {
            attempt('cleanup-legacy-salt', () => fs.renameSync(saltPath, `${saltPath}.migrated`));
        }
        if (fs.existsSync(journal.databaseBackup)) {
            attempt('cleanup-database-backup', () => fs.unlinkSync(journal.databaseBackup));
        }
        if (journal.configBackup && fs.existsSync(journal.configBackup)) {
            attempt('cleanup-config-backup', () => fs.unlinkSync(journal.configBackup!));
        }
        if (clean && fs.existsSync(this.journalPath())) {
            attempt('cleanup-journal', () => fs.unlinkSync(this.journalPath()));
        }
    }

    private cleanupRollbackArtifacts(journal: MigrationJournal): void {
        let clean = true;
        const attempt = (step: SecurityStep, file?: string) => {
            if (!file || !fs.existsSync(file)) return;
            try { this.step(step); fs.unlinkSync(file); } catch { clean = false; }
        };
        attempt('cleanup-rollback-database-backup', journal.databaseBackup);
        attempt('cleanup-rollback-config-backup', journal.configBackup);
        if (clean) attempt('cleanup-rollback-journal', this.journalPath());
    }

    private setupJournalPath(): string { return path.join(this.appUserDataPath, SETUP_JOURNAL_FILE); }
    private saveSetupJournal(journal: SetupJournal): void {
        this.saveJsonAtomic(this.setupJournalPath(), journal);
    }

    private loadSetupJournal(): SetupJournal | null {
        try { return JSON.parse(fs.readFileSync(this.setupJournalPath(), 'utf8')) as SetupJournal; }
        catch { return null; }
    }

    private reconcileSetupJournal(): void {
        const journalPath = this.setupJournalPath();
        if (!fs.existsSync(journalPath)) return;
        const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as SetupJournal;
        if (journal.phase === 'complete') this.cleanupSetupJournal();
        else this.rollbackSetup(journal);
    }

    private rollbackSetup(journal: SetupJournal): void {
        this.closeDb();
        if (journal.databaseCreated) {
            for (const file of [this.dbPath, `${this.dbPath}-wal`, `${this.dbPath}-shm`]) {
                if (fs.existsSync(file)) fs.unlinkSync(file);
            }
        }
        const configPath = path.join(this.appUserDataPath, CONFIG_FILE);
        for (const file of [configPath, `${configPath}.tmp`]) {
            if (fs.existsSync(file)) fs.unlinkSync(file);
        }
        this.cleanupSetupJournal();
    }

    private cleanupSetupJournal(): void {
        try {
            this.step('cleanup-setup-journal');
            if (fs.existsSync(this.setupJournalPath())) fs.unlinkSync(this.setupJournalPath());
        } catch { /* committed setup is authoritative; reconcile cleanup on next start */ }
    }

    private saveJsonAtomic(target: string, value: unknown): void {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const temporary = `${target}.tmp`;
        const fd = fs.openSync(temporary, 'w', 0o600);
        try {
            fs.writeFileSync(fd, JSON.stringify(value, null, 2), 'utf8');
            this.fsyncDescriptor(fd);
        } finally { fs.closeSync(fd); }
        fs.renameSync(temporary, target);
        this.fsyncDirectory();
    }

    private step(step: SecurityStep): void { this.hooks.onStep?.(step); }

    private fsyncFile(filePath: string): void {
        // Windows FlushFileBuffers requires a handle opened with write access.
        // POSIX accepts a read-only descriptor and avoids broadening access.
        const platform = this.hooks.platform ?? process.platform;
        const fd = fs.openSync(filePath, platform === 'win32' ? 'r+' : 'r');
        try { this.fsyncDescriptor(fd); } finally { fs.closeSync(fd); }
    }

    private fsyncDirectory(): void {
        const platform = this.hooks.platform ?? process.platform;
        try {
            const directory = fs.openSync(this.appUserDataPath, 'r');
            try { this.fsyncDescriptor(directory); } finally { fs.closeSync(directory); }
        } catch (error) {
            // Windows does not expose directory handles compatible with fsync.
            // All other failures remain fatal so supported platforms retain
            // the durability guarantee.
            if (!this.isUnsupportedWindowsFsync(error, platform)) throw error;
        }
    }

    private fsyncDescriptor(fd: number): void {
        // Regular files are opened writable (including r+ on Windows), so an
        // fsync failure is a real durability failure and must never be hidden.
        (this.hooks.fsync ?? fs.fsyncSync)(fd);
    }

    private isUnsupportedWindowsFsync(error: unknown, platform: NodeJS.Platform): boolean {
        if (platform !== 'win32' || !error || typeof error !== 'object') return false;
        const code = (error as NodeJS.ErrnoException).code;
        return code === 'EPERM' || code === 'EINVAL' || code === 'ENOSYS' || code === 'ENOTSUP';
    }
}
