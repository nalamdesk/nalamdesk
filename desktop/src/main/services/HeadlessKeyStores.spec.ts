import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    KEY_FILE_PROVIDER,
    KeyFileStore,
    PASSPHRASE_PROVIDER,
    PassphraseKeyStore,
    createHeadlessKeyStore
} from './HeadlessKeyStores';

// The lowest allowed scrypt cost keeps the suite fast; production uses 2^17.
const FAST = { logN: 14 };
const secret = Buffer.from('{"purpose":"device-dek","dek":"AAAA"}', 'utf8');

describe('KeyFileStore', () => {
    let directory: string;
    let keyPath: string;

    beforeEach(() => {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nalamdesk-keyfile-'));
        keyPath = path.join(directory, 'keys', 'vault.key');
    });
    afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

    it('creates a 32-byte key readable only by its owner and round-trips values', () => {
        const store = KeyFileStore.create(keyPath);
        expect(fs.statSync(keyPath).size).toBe(32);
        if (process.platform !== 'win32') expect(fs.statSync(keyPath).mode & 0o777).toBe(0o600);
        expect(store.status()).toEqual({ available: true, provider: KEY_FILE_PROVIDER });

        const sealed = store.protect(secret);
        expect(sealed.includes(secret)).toBe(false);
        expect(new KeyFileStore(keyPath).unprotect(sealed)).toEqual(secret);
    });

    it('never overwrites an existing key file', () => {
        KeyFileStore.create(keyPath);
        const before = fs.readFileSync(keyPath);
        expect(() => KeyFileStore.create(keyPath)).toThrow(/EEXIST/);
        expect(fs.readFileSync(keyPath)).toEqual(before);
    });

    it('reports a missing key file as unavailable', () => {
        const store = new KeyFileStore(keyPath);
        expect(store.status()).toMatchObject({ available: false, reason: 'ENCRYPTION_UNAVAILABLE' });
        expect(() => store.protect(secret)).toThrow(/key file not found/);
    });

    it.skipIf(process.platform === 'win32')('refuses a key file other users can read', () => {
        KeyFileStore.create(keyPath);
        fs.chmodSync(keyPath, 0o644);
        const store = new KeyFileStore(keyPath);
        expect(store.status()).toMatchObject({ available: false });
        expect(store.status().message).toMatch(/chmod 600/);
        expect(() => store.unprotect(Buffer.alloc(64))).toThrow();
    });

    it('rejects a file of the wrong size', () => {
        fs.mkdirSync(path.dirname(keyPath), { recursive: true });
        fs.writeFileSync(keyPath, Buffer.alloc(16), { mode: 0o600 });
        expect(new KeyFileStore(keyPath).status()).toMatchObject({ available: false });
    });

    it('fails to open values sealed with a different key or tampered with', () => {
        const sealed = KeyFileStore.create(keyPath).protect(secret);
        const otherPath = path.join(directory, 'other.key');
        expect(() => KeyFileStore.create(otherPath).unprotect(sealed)).toThrow(/DEVICE_UNLOCK_FAILED/);

        const tampered = Buffer.from(sealed);
        tampered[tampered.length - 1] ^= 0x01;
        expect(() => new KeyFileStore(keyPath).unprotect(tampered)).toThrow(/DEVICE_UNLOCK_FAILED/);
    });

    it('rejects payloads from another provider', () => {
        const store = KeyFileStore.create(keyPath);
        const passphraseSealed = new PassphraseKeyStore('correct horse battery', FAST).protect(secret);
        expect(() => store.unprotect(passphraseSealed)).toThrow('INVALID_PROTECTED_PAYLOAD');
    });
});

describe('PassphraseKeyStore', () => {
    it('round-trips with the same passphrase and a fresh salt each time', () => {
        const store = new PassphraseKeyStore('correct horse battery', FAST);
        const first = store.protect(secret);
        const second = store.protect(secret);
        expect(first.equals(second)).toBe(false);
        expect(new PassphraseKeyStore('correct horse battery', FAST).unprotect(first)).toEqual(secret);
        expect(store.status()).toEqual({ available: true, provider: PASSPHRASE_PROVIDER });
    });

    it('fails with the wrong passphrase', () => {
        const sealed = new PassphraseKeyStore('correct horse battery', FAST).protect(secret);
        expect(() => new PassphraseKeyStore('correct horse batterz', FAST).unprotect(sealed))
            .toThrow(/DEVICE_UNLOCK_FAILED/);
    });

    it('detects a tampered cost or salt', () => {
        const sealed = new PassphraseKeyStore('correct horse battery', FAST).protect(secret);
        const store = new PassphraseKeyStore('correct horse battery', FAST);
        const cost = Buffer.from(sealed);
        cost[4] = 15;
        expect(() => store.unprotect(cost)).toThrow(/DEVICE_UNLOCK_FAILED/);
        const salt = Buffer.from(sealed);
        salt[6] ^= 0xff;
        expect(() => store.unprotect(salt)).toThrow(/DEVICE_UNLOCK_FAILED/);
        const tooCheap = Buffer.from(sealed);
        tooCheap[4] = 4;
        expect(() => store.unprotect(tooCheap)).toThrow('INVALID_PROTECTED_PAYLOAD');
    });

    it('treats Unicode-equivalent passphrases as the same', () => {
        const composed = 'pässwort-sicher-1';
        const decomposed = composed.normalize('NFD');
        expect(decomposed).not.toBe(composed);
        const sealed = new PassphraseKeyStore(composed, FAST).protect(secret);
        expect(new PassphraseKeyStore(decomposed, FAST).unprotect(sealed)).toEqual(secret);
    });

    it('refuses short passphrases and out-of-range costs', () => {
        expect(() => new PassphraseKeyStore('short')).toThrow(/PASSPHRASE_TOO_SHORT/);
        expect(() => new PassphraseKeyStore('correct horse battery', { logN: 10 })).toThrow('INVALID_PASSPHRASE_COST');
        // 12 UTF-16 units before NFKC, 6 characters after.
        expect(() => new PassphraseKeyStore('e\u0301'.repeat(6))).toThrow(/PASSPHRASE_TOO_SHORT/);
        expect(() => new PassphraseKeyStore('😀'.repeat(6))).toThrow(/PASSPHRASE_TOO_SHORT/);
    });

    it('becomes unavailable once cleared', () => {
        const store = new PassphraseKeyStore('correct horse battery', FAST);
        const sealed = store.protect(secret);
        store.clear();
        expect(store.status()).toMatchObject({ available: false });
        expect(() => store.unprotect(sealed)).toThrow(/cleared/);
    });
});

describe('createHeadlessKeyStore', () => {
    it('builds the configured provider', () => {
        expect(createHeadlessKeyStore({ provider: 'key-file', keyPath: '/nonexistent/vault.key' }))
            .toBeInstanceOf(KeyFileStore);
        expect(createHeadlessKeyStore({ provider: 'passphrase', passphrase: 'correct horse battery', logN: 14 }))
            .toBeInstanceOf(PassphraseKeyStore);
        expect(() => createHeadlessKeyStore({ provider: 'tpm' } as any)).toThrow('UNKNOWN_KEY_PROVIDER: tpm');
    });
});
