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

    it('rejects malformed envelopes before touching crypto', () => {
        const svc = new HiuService({ ...memoryStore(), keyStore: fakeKeyStore() as any });
        expect(() => svc.decryptRecord(null as any)).toThrow('envelope is required');
        expect(() => svc.decryptRecord({} as any)).toThrow('missing ephemeralPublicKey');
        expect(() => svc.decryptRecord({ ephemeralPublicKey: 'x' } as any)).toThrow('missing nonce');
    });
});

function consentStore() {
    const consents = new Map<number, any>();
    const records: any[] = [];
    let nextId = 1;
    return {
        consents,
        records,
        createConsentRequest: (input: any) => {
            if (!input?.abhaAddress?.trim()) throw new Error('Health ID is required for a consent request.');
            if (!input?.hiTypes?.length) throw new Error('At least one health information type is required.');
            const row = { id: nextId++, status: 'requested', patient_id: input.patientId ?? null, ...input };
            consents.set(row.id, row);
            return row;
        },
        getConsentById: (id: number) => consents.get(Number(id)) ?? null,
        getConsentByRequestId: (requestId: string) =>
            [...consents.values()].find((c) => c.gatewayRequestId === requestId) ?? null,
        updateConsentStatus: (id: number, status: string, handle?: string | null) => {
            const row = consents.get(Number(id));
            if (!row) throw new Error('Consent request not found.');
            row.status = status;
            row.consent_handle = handle ?? row.consent_handle ?? null;
            return row;
        },
        storeFetchedRecord: (input: any) => {
            const row = { id: records.length + 1, status: 'cached', ...input };
            records.push(row);
            return row;
        }
    };
}

describe('HiuService (consent flow, mock gateway)', () => {
    function svcWithStore() {
        const keys = memoryStore();
        const records = consentStore();
        const svc = new HiuService({
            getSettings: keys.getSettings,
            getHiuPrivateProtected: keys.getHiuPrivateProtected,
            saveHiuPrivateProtected: keys.saveHiuPrivateProtected,
            saveSettingsPatch: keys.saveSettingsPatch,
            store: {
                createConsentRequest: records.createConsentRequest,
                getConsentById: records.getConsentById,
                getConsentByRequestId: records.getConsentByRequestId,
                updateConsentStatus: records.updateConsentStatus,
                storeFetchedRecord: records.storeFetchedRecord
            },
            session: { getSessionToken: async () => ({ token: 'mock', mock: true }), gatewayBaseUrl: () => '' },
            keyStore: fakeKeyStore() as any
        });
        return { svc, store: records };
    }

    it('records a consent request locally in mock mode', async () => {
        const { svc } = svcWithStore();
        const row = await svc.requestConsent({
            patientId: 1, abhaAddress: 'asha@sbx', hiTypes: ['DiagnosticReport', 'Prescription'], dateFrom: '2026-01-01'
        }, 10);
        expect(row.status).toBe('requested');
        expect(row.gatewayRequestId.startsWith('mock-consent-')).toBe(true);
        expect(row.hiTypes).toEqual(['DiagnosticReport', 'Prescription']);
        await expect(svc.requestConsent({ abhaAddress: '', hiTypes: ['Prescription'] })).rejects.toThrow();
        await expect(svc.requestConsent({ abhaAddress: 'a@sbx', hiTypes: [] })).rejects.toThrow();
    });

    it('refuses live consent without gateway certification', async () => {
        const { svc } = svcWithStore();
        (svc as any).deps.session = {
            getSessionToken: async () => ({ token: 'live', mock: false }),
            gatewayBaseUrl: () => 'https://gateway.example'
        };
        await expect(svc.requestConsent({ abhaAddress: 'a@sbx', hiTypes: ['Prescription'] }))
            .rejects.toThrow('not certified');
    });

    it('issues unique mock request ids for rapid requests', async () => {
        const { svc } = svcWithStore();
        const ids = new Set<string>();
        for (let i = 0; i < 5; i += 1) {
            const row = await svc.requestConsent({ abhaAddress: 'a@sbx', hiTypes: ['Prescription'] }, 10);
            ids.add(row.gatewayRequestId);
        }
        expect(ids.size).toBe(5);
    });

    it('reconciles out-of-order notifications waiting in the inbox', () => {
        const pending = [{
            kind: 'consent-granted',
            payload: JSON.stringify({ requestId: 'late-1', consentHandle: 'h-9' })
        }];
        const created: any[] = [];
        const svc = new HiuService({
            store: {
                createConsentRequest: (input: any) => created[0],
                getConsentById: (id: number) => created[0],
                getConsentByRequestId: () => null,
                updateConsentStatus: (id: number, status: string) => {
                    created[0].status = status;
                    return created[0];
                },
                storeFetchedRecord: (input: any) => input,
                getPendingInbox: () => pending
            },
            session: { getSessionToken: async () => ({ token: 'mock', mock: true }), gatewayBaseUrl: () => '' },
            keyStore: fakeKeyStore() as any
        });
        expect(svc.reconcilePendingNotifies()).toEqual({ applied: 0, skipped: 1 });
        created.push({ id: 7, status: 'requested' });
        (svc as any).deps.store.getConsentByRequestId = () => created[0];
        expect(svc.reconcilePendingNotifies()).toEqual({ applied: 1, skipped: 0 });
        expect(created[0].status).toBe('granted');
    });

    it('applies grant/deny/expire notifications to the matching request', async () => {
        const { svc, store } = svcWithStore();
        const row = await svc.requestConsent({ abhaAddress: 'a@sbx', hiTypes: ['Prescription'] }, 10);
        const done = svc.handleNotify('consent-granted', { requestId: row.gatewayRequestId, consentHandle: 'h-1' }, 10);
        expect(done).toEqual({ handled: true, consentId: row.id });
        expect(store.consents.get(row.id).status).toBe('granted');
        svc.handleNotify('consent-denied', { requestId: row.gatewayRequestId }, 10);
        expect(store.consents.get(row.id).status).toBe('denied');
        expect(() => svc.handleNotify('consent-something', { requestId: row.gatewayRequestId }, 10))
            .toThrow('Unsupported consent notification');
        expect(() => svc.handleNotify('consent-granted', {}, 10)).toThrow('no request id');
        expect(() => svc.handleNotify('consent-granted', { requestId: 'nope' }, 10))
            .toThrow('not found');
    });

    it('fetches records for a granted consent through encrypt-decrypt into cache', async () => {
        const { svc, store } = svcWithStore();
        const row = await svc.requestConsent({ patientId: 1, abhaAddress: 'a@sbx', hiTypes: ['Prescription'] }, 10);
        await expect(svc.fetchForConsent(row.id, 10)).rejects.toThrow('granted');
        svc.handleNotify('consent-granted', { requestId: row.gatewayRequestId }, 10);
        const cached = await svc.fetchForConsent(row.id, 10);
        expect(cached.status).toBe('cached');
        expect(cached.patientId).toBe(1);
        expect(cached.expiresAt).toBeTruthy();
        const bundle = JSON.parse(cached.bundleJson);
        expect(bundle.resourceType).toBe('Bundle');
        expect(store.records).toHaveLength(1);
        await expect(svc.fetchForConsent(999, 10)).rejects.toThrow('not found');
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
