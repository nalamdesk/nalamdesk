import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { DeviceKeyStore } from './DeviceKeyStore';
import { SecurityService } from './SecurityService';
import { KeyFileStore, PassphraseKeyStore } from './HeadlessKeyStores';

vi.mock('argon2', () => ({
    argon2id: 2,
    hash: vi.fn(async (secret: string, options: { salt: Buffer }) =>
        crypto.createHash('sha256').update(options.salt).update(secret).digest())
}));

interface DbState { vault?: { vault_id: string; key_version: number } }
const databases = new Map<string, DbState>();
let rejectOpen = false;
let failInsert = false;

vi.mock('better-sqlite3-multiple-ciphers', () => ({
    default: class MockDatabase {
        private state: DbState;
        constructor(private file: string) {
            this.state = databases.get(file) || {};
            databases.set(file, this.state);
        }
        pragma(statement: string) {
            if (rejectOpen && statement.startsWith('key =')) throw new Error('file is not a database');
        }
        exec() { }
        prepare(sql: string) {
            if (sql.includes('count(*)')) return { get: () => ({ count: 1 }) };
            if (sql.startsWith('SELECT vault_id')) return { get: () => this.state.vault };
            if (sql.startsWith('INSERT INTO')) return {
                run: (vaultId: string, keyVersion: number) => {
                    if (failInsert) throw new Error('forced binding failure');
                    this.state.vault = { vault_id: vaultId, key_version: keyVersion };
                }
            };
            throw new Error(`Unexpected SQL: ${sql}`);
        }
        close() { }
    }
}));

/** Authenticated like the real providers, so a foreign payload fails to open. */
class MemoryDeviceKeyStore implements DeviceKeyStore {
    available = true;
    private readonly key = crypto.randomBytes(32);
    constructor(private readonly provider = 'test-device-store') { }
    status() {
        return this.available
            ? { available: true, provider: this.provider }
            : { available: false, provider: this.provider, reason: 'ENCRYPTION_UNAVAILABLE' as const };
    }
    protect(value: Buffer): Buffer {
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
        const body = Buffer.concat([cipher.update(value), cipher.final()]);
        return Buffer.concat([iv, cipher.getAuthTag(), body]);
    }
    unprotect(value: Buffer): Buffer {
        const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, value.subarray(0, 12));
        decipher.setAuthTag(value.subarray(12, 28));
        return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]);
    }
}


describe('SecurityService key slots', () => {
    let directory: string;
    let dbPath: string;
    let primary: MemoryDeviceKeyStore;

    beforeEach(() => {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nalamdesk-slots-'));
        dbPath = path.join(directory, 'nalamdesk.db');
        fs.writeFileSync(dbPath, '');
        databases.clear();
        rejectOpen = false;
        failInsert = false;
        primary = new MemoryDeviceKeyStore('tpm');
    });
    afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

    const readConfig = () => JSON.parse(fs.readFileSync(path.join(directory, 'security.json'), 'utf8'));

    async function provision(): Promise<SecurityService> {
        const service = new SecurityService(primary);
        await service.setup('admin', dbPath, directory);
        service.completeProvisioning();
        return service;
    }

    it('lists the primary and recovery slots of a fresh vault', async () => {
        const service = await provision();
        expect(service.listKeySlots()).toEqual([
            { id: 'primary', provider: 'tpm', kind: 'primary', removable: false, unlockedWith: true },
            { id: 'recovery', provider: 'recovery-code', kind: 'recovery', removable: false, unlockedWith: false }
        ]);
        expect(readConfig().slots).toBeUndefined();
    });

    it('adds a slot that unlocks the same vault on its own, without exposing payloads', async () => {
        const service = await provision();
        const keyFile = KeyFileStore.create(path.join(directory, 'vault.key'));
        const added = service.addKeySlot(keyFile, '  Server key file  ');
        expect(added).toMatchObject({ provider: 'key-file', label: 'Server key file', kind: 'slot', removable: true });
        expect(added.id).toMatch(/^[a-f0-9]{16}$/);
        expect(JSON.stringify(service.listKeySlots())).not.toContain('protectedPayload');
        expect(service.listKeySlots().find((slot) => slot.id === 'primary')!.removable).toBe(true);
        service.closeDb();

        const viaKeyFile = new SecurityService(new KeyFileStore(path.join(directory, 'vault.key')));
        await viaKeyFile.initializeDevice(dbPath, directory);
        expect(viaKeyFile.getUnlockedSlotId()).toBe(added.id);
        viaKeyFile.closeDb();

        const viaPrimary = new SecurityService(primary);
        await viaPrimary.initializeDevice(dbPath, directory);
        expect(viaPrimary.getUnlockedSlotId()).toBe('primary');
    });

    it('supports several providers at once and refuses a store that matches none', async () => {
        const service = await provision();
        service.addKeySlot(new PassphraseKeyStore('correct horse battery', { logN: 14 }), 'Passphrase');
        service.addKeySlot(KeyFileStore.create(path.join(directory, 'vault.key')));
        service.closeDb();

        const viaPassphrase = new SecurityService(new PassphraseKeyStore('correct horse battery', { logN: 14 }));
        await viaPassphrase.initializeDevice(dbPath, directory);
        viaPassphrase.closeDb();

        await expect(new SecurityService(new PassphraseKeyStore('wrong horse battery', { logN: 14 }))
            .initializeDevice(dbPath, directory)).rejects.toThrow('DEVICE_UNLOCK_FAILED');
        await expect(new SecurityService(new MemoryDeviceKeyStore('tpm'))
            .initializeDevice(dbPath, directory)).rejects.toThrow('DEVICE_UNLOCK_FAILED');
    });

    it('stops at a slot that opens but names another vault', async () => {
        const service = await provision();
        const keyFile = KeyFileStore.create(path.join(directory, 'vault.key'));
        service.addKeySlot(keyFile);
        service.closeDb();
        const config = readConfig();
        const forged = Buffer.from(JSON.stringify({
            version: 1, purpose: 'device-dek', vaultId: crypto.randomUUID(), keyVersion: 1,
            dek: crypto.randomBytes(32).toString('base64')
        }));
        config.slots[0].protectedPayload = keyFile.protect(forged).toString('base64');
        fs.writeFileSync(path.join(directory, 'security.json'), JSON.stringify(config));
        await expect(new SecurityService(new KeyFileStore(path.join(directory, 'vault.key')))
            .initializeDevice(dbPath, directory)).rejects.toThrow('VAULT_BINDING_MISMATCH');
    });

    it('refuses to add a slot while locked, from an unavailable store, or with an overlong label', async () => {
        const locked = new SecurityService(primary);
        expect(() => locked.addKeySlot(new MemoryDeviceKeyStore('x'))).toThrow('VAULT_LOCKED');
        const service = await provision();
        const missing = new KeyFileStore(path.join(directory, 'missing.key'));
        expect(() => service.addKeySlot(missing)).toThrow(/key file not found/);
        expect(() => service.addKeySlot(new MemoryDeviceKeyStore('x'), 'x'.repeat(81))).toThrow('KEY_SLOT_LABEL_TOO_LONG');
        expect(readConfig().slots).toBeUndefined();
    });

    it('never saves a slot whose store cannot open what it just protected', async () => {
        const service = await provision();
        const broken = new MemoryDeviceKeyStore('broken');
        broken.unprotect = () => Buffer.from('not json');
        expect(() => service.addKeySlot(broken)).toThrow('KEY_SLOT_VERIFY_FAILED');
        expect(readConfig().slots).toBeUndefined();
    });

    it('removes slots but never the recovery code or the last unlock method', async () => {
        const service = await provision();
        expect(() => service.removeKeySlot('primary')).toThrow('LAST_KEY_SLOT');
        expect(() => service.removeKeySlot('recovery')).toThrow('RECOVERY_SLOT_REQUIRED');
        expect(() => service.removeKeySlot('0123456789abcdef')).toThrow('KEY_SLOT_NOT_FOUND');
        const added = service.addKeySlot(KeyFileStore.create(path.join(directory, 'vault.key')));
        service.removeKeySlot(added.id);
        expect(readConfig().slots).toBeUndefined();
        expect(service.listKeySlots().map((slot) => slot.id)).toEqual(['primary', 'recovery']);
    });

    it('moves to new hardware: add the new key, remove the old primary, which promotes the new one', async () => {
        const service = await provision();
        const added = service.addKeySlot(KeyFileStore.create(path.join(directory, 'vault.key')), 'New server');
        service.removeKeySlot('primary');
        const slots = service.listKeySlots();
        expect(slots[0]).toMatchObject({ id: 'primary', provider: 'key-file', label: 'New server', kind: 'primary' });
        expect(slots.map((slot) => slot.id)).not.toContain(added.id);
        expect(readConfig().slots).toBeUndefined();
        service.closeDb();

        await expect(new SecurityService(primary).initializeDevice(dbPath, directory)).rejects.toThrow('DEVICE_UNLOCK_FAILED');
        const restarted = new SecurityService(new KeyFileStore(path.join(directory, 'vault.key')));
        await restarted.initializeDevice(dbPath, directory);
        expect(restarted.getUnlockedSlotId()).toBe('primary');
    });

    it('keeps slots through recovery onto a replacement device', async () => {
        const service = new SecurityService(primary);
        const code = await service.setup('admin', dbPath, directory);
        service.completeProvisioning();
        service.addKeySlot(KeyFileStore.create(path.join(directory, 'vault.key')));
        service.closeDb();

        const replacement = new SecurityService(new MemoryDeviceKeyStore('tpm'));
        await replacement.recoverDevice(code, directory, dbPath);
        expect(replacement.getUnlockedSlotId()).toBe('primary');
        expect(readConfig().slots).toHaveLength(1);
        replacement.closeDb();
        const viaKeyFile = new SecurityService(new KeyFileStore(path.join(directory, 'vault.key')));
        await viaKeyFile.initializeDevice(dbPath, directory);
    });

    it('re-wraps the slot it unlocked with, never the primary, on device rotation', async () => {
        const service = await provision();
        service.addKeySlot(KeyFileStore.create(path.join(directory, 'vault.key')));
        service.closeDb();
        const before = readConfig();

        const viaKeyFile = new SecurityService(new KeyFileStore(path.join(directory, 'vault.key')));
        await viaKeyFile.initializeDevice(dbPath, directory);
        viaKeyFile.rotateDeviceEnvelope();
        const after = readConfig();
        expect(after.device).toEqual(before.device);
        expect(after.slots[0].protectedPayload).not.toBe(before.slots[0].protectedPayload);
        viaKeyFile.closeDb();
        await new SecurityService(primary).initializeDevice(dbPath, directory);
    });

    it('rejects a config with malformed or duplicate slots', async () => {
        const service = await provision();
        service.closeDb();
        const config = readConfig();
        for (const slots of [
            'nope',
            [{ id: 'short', provider: 'x', createdAt: 'now', protectedPayload: 'AA==' }],
            [{ id: '0123456789abcdef', provider: 'x', createdAt: 'now', protectedPayload: '' }],
            [
                { id: '0123456789abcdef', provider: 'x', createdAt: 'now', protectedPayload: 'AA==' },
                { id: '0123456789abcdef', provider: 'y', createdAt: 'now', protectedPayload: 'AA==' }
            ]
        ]) {
            fs.writeFileSync(path.join(directory, 'security.json'), JSON.stringify({ ...config, slots }));
            await expect(new SecurityService(primary).initializeDevice(dbPath, directory))
                .rejects.toThrow('SECURITY_CONFIG_CORRUPT');
        }
    });
});
