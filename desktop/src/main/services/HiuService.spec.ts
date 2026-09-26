import * as crypto from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import { HiuService } from './HiuService';
import { FideliusService } from './FideliusService';

function memoryStore() {
    const settings: Record<string, any> = {};
    return {
        settings,
        getSettings: () => ({ ...settings }),
        getHiuPrivateProtected: () => settings.abdm_hiu_private_protected ?? null,
        saveHiuPrivateProtected: (v: string) => { settings.abdm_hiu_private_protected = v; },
        saveSettingsPatch: (patch: Record<string, unknown>) => Object.assign(settings, patch),
    };
}

function fakeKeyStore() {
    // Test double: opaque wrapping (never used outside specs).
    const wrap = (value: Buffer) => Buffer.from(JSON.stringify({ v: 1, data: value.toString('base64') }));
    return {
        protect: (value: Buffer) => wrap(value),
        unprotect: (value: Buffer) => {
            let parsed: any = null;
            try { parsed = JSON.parse(value.toString('utf8')); } catch { parsed = null; }
            if (!parsed || parsed.v !== 1 || !parsed.data) throw new Error('ENCRYPTION_UNAVAILABLE');
            return Buffer.from(parsed.data, 'base64');
        }
    };
}

describe('HiuService (HIU keypair)', () => {
    it('generates the keypair once and returns the stable public key', () => {
        const store = memoryStore();
        const svc = new HiuService({ ...store, keyStore: fakeKeyStore() as any });
        expect(svc.getPublicKey()).toBeNull();
        const first = svc.ensureKeypair();
        expect(first.publicKey).toMatch(/^[A-Za-z0-9+/=]{43,44}$/);
        expect(svc.getPublicKey()).toBe(first.publicKey);
        const second = svc.ensureKeypair();
        expect(second.publicKey).toBe(first.publicKey);
        // Private half is stored wrapped, never plaintext.
        const storedRaw = Buffer.from(store.settings.abdm_hiu_private_protected, 'base64').toString('utf8');
        expect(storedRaw).not.toContain('PRIVATE KEY');
    });

    it('round-trips a bundle through Fidelius using the stored keypair', () => {
        const store = memoryStore();
        const svc = new HiuService({ ...store, keyStore: fakeKeyStore() as any });
        const { publicKey } = svc.ensureKeypair();
        const fidelius = new FideliusService();
        const envelope = fidelius.encryptBundle({ hello: 'hiu' }, publicKey);
        const decrypted = svc.decryptForTest(envelope);
        expect(decrypted).toEqual({ hello: 'hiu' });
    });

    it('refuses keypair creation when device crypto is unavailable', () => {
        const store = memoryStore();
        const broken = { protect: () => { throw new Error('ENCRYPTION_UNAVAILABLE'); }, unprotect: () => { throw new Error('x'); } };
        const svc = new HiuService({ ...store, keyStore: broken as any });
        expect(() => svc.ensureKeypair()).toThrow('ENCRYPTION_UNAVAILABLE');
        expect(svc.getPublicKey()).toBeNull();
    });

    it('rejects tampered envelopes on the stored key', () => {
        const store = memoryStore();
        const svc = new HiuService({ ...store, keyStore: fakeKeyStore() as any });
        const { publicKey } = svc.ensureKeypair();
        const fidelius = new FideliusService();
        const envelope = fidelius.encryptBundle({ hello: 'hiu' }, publicKey);
        envelope.ciphertext = Buffer.from('tampered').toString('base64');
        expect(() => svc.decryptForTest(envelope)).toThrow();
    });

    it('heals a mismatched stored pair instead of advertising it', () => {
        const store = memoryStore();
        const svc = new HiuService({ ...store, keyStore: fakeKeyStore() as any });
        svc.ensureKeypair();
        // Simulate an edited public key: pair no longer matches.
        store.settings.abdm_hiu_public_key = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
        const healed = svc.ensureKeypair();
        expect(healed.publicKey).not.toBe('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
        // Round trip proves the healed pair belongs together.
        const fidelius = new FideliusService();
        expect(svc.decryptForTest(fidelius.encryptBundle({ ok: 1 }, healed.publicKey))).toEqual({ ok: 1 });
    });

    it('regenerates when the private blob cannot be unwrapped', () => {
        const store = memoryStore();
        const svc = new HiuService({ ...store, keyStore: fakeKeyStore() as any });
        svc.ensureKeypair();
        // Simulate a clean-machine restore: foreign keychain blob.
        store.settings.abdm_hiu_private_protected = Buffer.from('foreign-blob').toString('base64');
        const healed = svc.ensureKeypair();
        const fidelius = new FideliusService();
        expect(svc.decryptForTest(fidelius.encryptBundle({ ok: 1 }, healed.publicKey))).toEqual({ ok: 1 });
    });

    it('writes both halves through the atomic saver when available', () => {
        const store = memoryStore();
        const saved: any[] = [];
        const svc = new HiuService({
            ...store,
            saveHiuKeypair: (pub: string, priv: string) => {
                saved.push([pub, priv]);
                (store as any).saveHiuPrivateProtected(priv);
                (store as any).saveSettingsPatch({ abdm_hiu_public_key: pub });
            },
            keyStore: fakeKeyStore() as any
        });
        const { publicKey } = svc.ensureKeypair();
        expect(saved).toHaveLength(1);
        expect(saved[0][0]).toBe(publicKey);
    });
});
