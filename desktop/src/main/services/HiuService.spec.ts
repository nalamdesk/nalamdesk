import * as crypto from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import { HIU_ON_FETCH_PATH, HIU_ON_INIT_PATH, HIU_ON_REQUEST_PATH, HiuService } from './HiuService';
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
        expect(Buffer.from(first.publicKey, 'base64')).toHaveLength(309);
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
        const fidelius = new FideliusService();
        const envelope = fidelius.encryptBundle({ hello: 'hiu' }, svc.keyMaterial());
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
        const fidelius = new FideliusService();
        const envelope = fidelius.encryptBundle({ hello: 'hiu' }, svc.keyMaterial());
        envelope.encryptedData = Buffer.from('tampered-with-enough-bytes').toString('base64');
        expect(() => svc.decryptForTest(envelope)).toThrow();
    });

    it('rejects malformed envelopes before touching crypto', () => {
        const svc = new HiuService({ ...memoryStore(), keyStore: fakeKeyStore() as any });
        expect(() => svc.decryptRecord(null as any)).toThrow('envelope is required');
        expect(() => svc.decryptRecord({} as any)).toThrow('missing keyMaterial');
        expect(() => svc.decryptRecord({ keyMaterial: {} } as any)).toThrow('missing encryptedData');
    });

    it('advertises its public key in its key material', () => {
        const svc = new HiuService({ ...memoryStore(), keyStore: fakeKeyStore() as any });
        const material = svc.keyMaterial();
        expect(material.dhPublicKey.keyValue).toBe(svc.getPublicKey());
        expect(Buffer.from(material.nonce, 'base64')).toHaveLength(32);
        // Stable per key, so a sender can use material fetched earlier.
        expect(svc.keyMaterial().nonce).toBe(material.nonce);
    });

    it('re-encodes a key stored before Fidelius interop instead of rotating it', () => {
        const store = memoryStore();
        const keyStore = fakeKeyStore();
        const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519', {
            privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
        });
        const wrapped = keyStore.protect(Buffer.from(privateKey, 'utf8')).toString('base64');
        store.settings.abdm_hiu_private_protected = wrapped;
        store.settings.abdm_hiu_public_key = publicKey.export({ type: 'spki', format: 'der' })
            .subarray(-32).toString('base64');
        const svc = new HiuService({ ...store, keyStore: keyStore as any });

        const upgraded = svc.ensureKeypair();

        expect(Buffer.from(upgraded.publicKey, 'base64')).toHaveLength(309);
        expect(store.settings.abdm_hiu_public_key).toBe(upgraded.publicKey);
        expect(store.settings.abdm_hiu_private_protected).toBe(wrapped);
        const fidelius = new FideliusService();
        expect(svc.decryptForTest(fidelius.encryptBundle({ ok: 1 }, svc.keyMaterial()))).toEqual({ ok: 1 });
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
            relay: { isMockMode: () => true },
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
            relay: { isMockMode: () => true },
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
        expect(svc.decryptForTest(fidelius.encryptBundle({ ok: 1 }, svc.keyMaterial()))).toEqual({ ok: 1 });
    });

    it('regenerates when the private blob cannot be unwrapped', () => {
        const store = memoryStore();
        const svc = new HiuService({ ...store, keyStore: fakeKeyStore() as any });
        svc.ensureKeypair();
        // Simulate a clean-machine restore: foreign keychain blob.
        store.settings.abdm_hiu_private_protected = Buffer.from('foreign-blob').toString('base64');
        const healed = svc.ensureKeypair();
        const fidelius = new FideliusService();
        expect(svc.decryptForTest(fidelius.encryptBundle({ ok: 1 }, svc.keyMaterial()))).toEqual({ ok: 1 });
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

function liveStore() {
    const base = consentStore();
    const artefacts = new Map<string, any>();
    const store = {
        ...base,
        artefacts,
        getConsentByRequestId: (requestId: string) =>
            [...base.consents.values()].find((c) => c.gatewayRequestId === requestId || c.consent_request_id === requestId) ?? null,
        setConsentRequestId: vi.fn((id: number, cmId: string) => Object.assign(base.consents.get(id), { consent_request_id: cmId })),
        failConsentRequest: vi.fn((id: number, error: string) => Object.assign(base.consents.get(id), { status: 'failed', error })),
        discardConsentRequest: vi.fn((id: number) => base.consents.delete(id)),
        saveHiuArtefacts: vi.fn((consentId: number, ids: string[], status: string) => {
            for (const id of ids) artefacts.set(id, { ...(artefacts.get(id) ?? { id, consent_id: consentId }), status });
            return [...artefacts.values()];
        }),
        getHiuArtefacts: (consentId: number) => [...artefacts.values()].filter((a) => a.consent_id === consentId),
        findHiuArtefact: (field: string, value: string) => [...artefacts.values()].find((a) => a[field] === value) ?? null,
        updateHiuArtefact: vi.fn((id: string, patch: Record<string, unknown>) => Object.assign(artefacts.get(id), patch)),
        getPendingInbox: vi.fn(() => [] as any[])
    };
    return store;
}

describe('HiuService (live through the relay)', () => {
    const NOW = Date.parse('2026-10-20T10:00:00Z');

    function live(overrides: Record<string, any> = {}) {
        const keys = memoryStore();
        const store = liveStore();
        const send = vi.fn(async () => ({}));
        let n = 0;
        const svc = new HiuService({
            getSettings: keys.getSettings,
            getHiuPrivateProtected: keys.getHiuPrivateProtected,
            saveHiuPrivateProtected: keys.saveHiuPrivateProtected,
            saveSettingsPatch: keys.saveSettingsPatch,
            keyStore: fakeKeyStore() as any,
            store,
            relay: { isMockMode: () => false, send },
            hiuId: () => 'IN3310000001',
            dataPushUrl: () => 'https://relay.test/hiu/data-push/tok',
            requester: () => ({ name: 'Dr. Asha', hprId: '71-0000-0000-0001' }),
            newRequestId: () => `req-${++n}`,
            nowMs: () => NOW,
            ...overrides
        });
        return { svc, store, send };
    }

    async function granted() {
        const ctx = live();
        const row = await ctx.svc.requestConsent({ patientId: 1, abhaAddress: 'asha@sbx', hiTypes: ['Prescription'] }, 10);
        ctx.svc.applyCallback(HIU_ON_INIT_PATH, { consentRequest: { id: 'cm-1' }, response: { requestId: 'req-1' } });
        ctx.svc.handleNotify('consent-granted', { requestId: 'cm-1', consentHandle: 'art-1', artefactIds: ['art-1', 'art-2'] });
        return { ...ctx, row };
    }

    it('sends a consent request as the paired facility with the clinician and dates', async () => {
        const { svc, send, store } = live();
        const row = await svc.requestConsent({
            patientId: 1, abhaAddress: ' asha@sbx ', hiTypes: ['Prescription', 'DiagnosticReport'], dateFrom: '2025-01-01', dateTo: '2025-12-31'
        }, 10);

        expect(row.gatewayRequestId).toBe('req-1');
        const [upstream, method, path, body, headers] = send.mock.calls[0] as any[];
        expect([upstream, method, path, headers]).toEqual(['gateway', 'POST', '/consent/v3/request/init', { 'request-id': 'req-1' }]);
        expect(body.consent).toMatchObject({
            purpose: { code: 'CAREMGT' },
            patient: { id: 'asha@sbx' },
            hiu: { id: 'IN3310000001' },
            requester: { name: 'Dr. Asha', identifier: { type: 'REGNO', value: '71-0000-0000-0001' } },
            hiTypes: ['Prescription', 'DiagnosticReport'],
            permission: {
                accessMode: 'VIEW',
                dateRange: { from: '2025-01-01T00:00:00.000Z', to: '2025-12-31T23:59:59.999Z' },
                dataEraseAt: '2026-11-19T10:00:00.000Z'
            }
        });
        expect(store.consents.size).toBe(1);
    });

    it('defaults to the last five years and leaves out an unknown HPR ID', async () => {
        const { svc, send } = live({ requester: undefined });
        await svc.requestConsent({ abhaAddress: 'a@sbx', hiTypes: ['OPConsultation'] });
        const body = (send.mock.calls[0] as any[])[3];
        expect(body.consent.requester).toEqual({ name: 'Clinic' });
        expect(body.consent.permission.dateRange).toEqual({ from: '2021-10-21T10:00:00.000Z', to: '2026-10-20T10:00:00.000Z' });
    });

    it('refuses unknown types, bad dates, an unpaired facility, and drops a request the gateway refused', async () => {
        const { svc, store, send } = live();
        await expect(svc.requestConsent({ abhaAddress: 'a@sbx', hiTypes: ['XRay'] })).rejects.toThrow('Unknown health information type');
        await expect(svc.requestConsent({ abhaAddress: 'a@sbx', hiTypes: ['Prescription'], dateFrom: 'soon' })).rejects.toThrow('Invalid date');
        await expect(svc.requestConsent({ abhaAddress: 'a@sbx', hiTypes: ['Prescription'], dateFrom: '2026-02-01', dateTo: '2026-01-01' }))
            .rejects.toThrow('start date is after');
        send.mockRejectedValueOnce(new Error('ABDM request rejected (HTTP 400).'));
        await expect(svc.requestConsent({ abhaAddress: 'a@sbx', hiTypes: ['Prescription'] })).rejects.toThrow('HTTP 400');
        expect(store.discardConsentRequest).toHaveBeenCalled();
        expect(store.consents.size).toBe(0);

        const unpaired = live({ hiuId: () => null });
        await expect(unpaired.svc.requestConsent({ abhaAddress: 'a@sbx', hiTypes: ['Prescription'] })).rejects.toThrow('not paired');
        const noSend = live({ relay: { isMockMode: () => false } });
        await expect(noSend.svc.requestConsent({ abhaAddress: 'a@sbx', hiTypes: ['Prescription'] })).rejects.toThrow('mock mode');
        const oldStore = live({ store: consentStore() });
        await expect(oldStore.svc.requestConsent({ abhaAddress: 'a@sbx', hiTypes: ['Prescription'] })).rejects.toThrow('not configured for live');
    });

    it('records the consent manager ID from on-init and applies a notify that came first', async () => {
        const { svc, store } = live();
        const row = await svc.requestConsent({ abhaAddress: 'a@sbx', hiTypes: ['Prescription'] });
        store.getPendingInbox.mockReturnValue([{ kind: 'consent-granted', payload: JSON.stringify({ requestId: 'cm-9', artefactIds: ['art-9'] }) }]);

        const result = svc.applyCallback(HIU_ON_INIT_PATH, { consentRequest: { id: 'cm-9' }, response: { requestId: 'req-1' } });

        expect(store.setConsentRequestId).toHaveBeenCalledWith(row.id, 'cm-9');
        expect(store.consents.get(row.id).status).toBe('granted');
        expect(store.artefacts.get('art-9')).toMatchObject({ consent_id: row.id, status: 'granted' });
        expect(typeof result?.followUp).toBe('function');
    });

    it('marks a request the consent manager refused, and fails an on-init it does not know', async () => {
        const { svc, store } = live();
        const row = await svc.requestConsent({ abhaAddress: 'a@sbx', hiTypes: ['Prescription'] });
        svc.applyCallback(HIU_ON_INIT_PATH, { error: { code: 1400, message: 'Invalid patient' }, response: { requestId: 'req-1' } });
        expect(store.consents.get(row.id)).toMatchObject({ status: 'failed', error: 'Invalid patient' });
        expect(() => svc.applyCallback(HIU_ON_INIT_PATH, { consentRequest: { id: 'x' }, response: { requestId: 'nope' } }))
            .toThrow('not found');
        expect(svc.applyCallback('/api/v3/hip/other', {})).toBeNull();
    });

    it('fetches each granted artefact once, and keeps its HIP and dates from on-fetch', async () => {
        const { svc, store, send } = await granted();
        send.mockClear();

        await svc.fetchArtefactDetails(1);
        expect(send.mock.calls.map((call: any[]) => [call[2], call[3]])).toEqual([
            ['/consent/v3/fetch', { consentId: 'art-1' }],
            ['/consent/v3/fetch', { consentId: 'art-2' }]
        ]);

        svc.applyCallback(HIU_ON_FETCH_PATH, {
            consent: {
                status: 'GRANTED',
                consentDetail: {
                    consentId: 'art-1', hip: { id: 'HIP-A' },
                    permission: { dateRange: { from: '2024-01-01T00:00:00Z', to: '2026-01-01T00:00:00Z' }, dataEraseAt: '2026-11-01T00:00:00Z' }
                }
            },
            response: { requestId: store.artefacts.get('art-1').fetch_request_id }
        });
        expect(store.artefacts.get('art-1')).toMatchObject({
            hip_id: 'HIP-A', date_from: '2024-01-01T00:00:00Z', date_to: '2026-01-01T00:00:00Z', data_erase_at: '2026-11-01T00:00:00Z'
        });
        svc.applyCallback(HIU_ON_FETCH_PATH, { error: { message: 'Consent expired' }, response: { requestId: store.artefacts.get('art-2').fetch_request_id } });
        expect(store.artefacts.get('art-2').error).toBe('Consent expired');
        expect(() => svc.applyCallback(HIU_ON_FETCH_PATH, {
            consent: { consentDetail: { consentId: 'other' } }, response: { requestId: store.artefacts.get('art-1').fetch_request_id }
        })).toThrow('different consent artefact');
        expect(() => svc.applyCallback(HIU_ON_FETCH_PATH, { response: { requestId: 'nope' } })).toThrow('not found');

        send.mockClear();
        await svc.fetchArtefactDetails(1);
        expect(send.mock.calls.map((call: any[]) => call[3])).toEqual([{ consentId: 'art-2' }]);
    });

    it('asks each HIP for records with the HIU key and the relay push address', async () => {
        const { svc, store, send } = await granted();
        store.updateHiuArtefact('art-1', { hip_id: 'HIP-A', date_from: '2024-01-01T00:00:00Z', date_to: '2026-01-01T00:00:00Z' });
        send.mockClear();

        expect(await svc.fetchForConsent(1)).toEqual({ requested: 2 });

        const requests = send.mock.calls.filter((call: any[]) => call[2] === '/data-flow/v3/health-information/request');
        expect(requests).toHaveLength(2);
        const first = (requests[0] as any[])[3].hiRequest;
        expect(first).toMatchObject({
            consent: { id: 'art-1' },
            dateRange: { from: '2024-01-01T00:00:00Z', to: '2026-01-01T00:00:00Z' },
            dataPushUrl: 'https://relay.test/hiu/data-push/tok',
            keyMaterial: { cryptoAlg: 'ECDH', curve: 'Curve25519' }
        });
        expect((requests[1] as any[])[3].hiRequest.dateRange.to).toBe('2026-10-20T10:00:00.000Z');
        expect(store.artefacts.get('art-1')).toMatchObject({ transfer_status: 'requested', hi_request_id: (requests[0] as any[])[4]['request-id'] });

        svc.applyCallback(HIU_ON_REQUEST_PATH, { hiRequest: { transactionId: 'txn-1', sessionStatus: 'REQUESTED' }, response: { requestId: store.artefacts.get('art-1').hi_request_id } });
        expect(store.artefacts.get('art-1')).toMatchObject({ transaction_id: 'txn-1', transfer_status: 'acknowledged' });
        svc.applyCallback(HIU_ON_REQUEST_PATH, { error: { code: 'X' }, response: { requestId: store.artefacts.get('art-2').hi_request_id } });
        expect(store.artefacts.get('art-2')).toMatchObject({ transfer_status: 'failed', error: 'Error X' });
        expect(() => svc.applyCallback(HIU_ON_REQUEST_PATH, { response: { requestId: 'nope' } })).toThrow('not found');
    });

    it('refuses a fetch before the grant arrives, without a push address, or for a consent not granted', async () => {
        const { svc, store } = live();
        await svc.requestConsent({ abhaAddress: 'a@sbx', hiTypes: ['Prescription'] });
        await expect(svc.fetchForConsent(1)).rejects.toThrow('granted consent');
        store.consents.get(1).status = 'granted';
        await expect(svc.fetchForConsent(1)).rejects.toThrow('has not sent the granted consent');
        const noUrl = await granted();
        (noUrl.svc as any).deps.dataPushUrl = () => null;
        await expect(noUrl.svc.fetchForConsent(1)).rejects.toThrow('no data push address');
    });

    it('matches a push to its transfer, notifies on the last page, and refuses a revoked artefact', async () => {
        const { svc, store, send } = await granted();
        store.updateHiuArtefact('art-1', { transaction_id: 'txn-1', hip_id: 'HIP-A', data_erase_at: '2026-11-01T00:00:00Z' });

        expect(svc.transferFor('unknown')).toBeNull();
        const page1 = svc.transferFor('txn-1', { pageNumber: 1, pageCount: 2 })!;
        expect(page1).toMatchObject({ artefactId: 'art-1', lastPage: false, dataEraseAt: '2026-11-01T00:00:00Z' });
        expect(svc.completeTransfer(page1, ['cc-1'], true, 'txn-1')).toBeNull();

        const last = svc.transferFor('txn-1', { pageNumber: 2, pageCount: 2 })!;
        send.mockClear();
        await svc.completeTransfer(last, ['cc-1', null], true, 'txn-1')!();
        expect(store.artefacts.get('art-1').transfer_status).toBe('transferred');
        expect((send.mock.calls[0] as any[])[2]).toBe('/data-flow/v3/health-information/notify');
        expect((send.mock.calls[0] as any[])[3].notification).toMatchObject({
            consentId: 'art-1', transactionId: 'txn-1', notifier: { type: 'HIU', id: 'IN3310000001' },
            statusNotification: { sessionStatus: 'TRANSFERRED', hipId: 'HIP-A', statusResponses: [{ careContextReference: 'cc-1', hiStatus: 'OK' }] }
        });

        send.mockClear();
        await svc.completeTransfer(page1, ['cc-2'], false, 'txn-1')!();
        expect(store.artefacts.get('art-1').transfer_status).toBe('failed');
        expect((send.mock.calls[0] as any[])[3].notification.statusNotification).toMatchObject({ sessionStatus: 'FAILED', statusResponses: [{ hiStatus: 'ERRORED' }] });

        store.artefacts.get('art-1').status = 'revoked';
        expect(() => svc.transferFor('txn-1')).toThrow('granted consent');
        expect(live({ store: consentStore() }).svc.transferFor('txn-1')).toBeNull();
    });

    it('acknowledges a notification with each artefact ID', async () => {
        const { svc, send } = live();
        await svc.acknowledgeNotify('cb-1', ['art-1']);
        expect(send).toHaveBeenCalledWith('gateway', 'POST', '/consent/v3/request/hiu/on-notify',
            { acknowledgement: [{ status: 'OK', consentId: 'art-1' }], response: { requestId: 'cb-1' } }, { 'request-id': 'req-1' });
    });

    it('marks revoked artefacts and skips artefact details in mock mode', async () => {
        const { svc, store, send } = await granted();
        svc.handleNotify('consent-expired', { requestId: 'cm-1', artefactIds: ['art-1'] });
        expect(store.artefacts.get('art-1').status).toBe('revoked');
        (svc as any).deps.relay.isMockMode = () => true;
        send.mockClear();
        await svc.fetchArtefactDetails(1);
        expect(send).not.toHaveBeenCalled();
    });
});
