import { describe, expect, it, vi } from 'vitest';
import {
    AbdmMailboxProcessor,
    HIU_CONSENT_NOTIFY_PATH,
    ON_SHARE_PATH,
    SHARE_PATH,
    kindFor,
    shareProfile,
    type AbdmMailboxItem
} from './AbdmMailboxProcessor';

vi.mock('electron-log', () => ({ default: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const NOW = Date.parse('2026-10-20T10:00:00Z');

function callback(id: string, path: string, body: unknown, requestId: string | null = `req-${id}`): AbdmMailboxItem {
    return {
        id, type: 'abdm-callback', path, request_id: requestId, received_at: '2026-10-20T10:00:00Z', status: 'new',
        payload: JSON.stringify({ headers: requestId ? { 'request-id': requestId } : {}, body: JSON.stringify(body) })
    };
}

function push(id: string, body: unknown): AbdmMailboxItem {
    return { id, type: 'abdm-data-push', path: null, request_id: null, received_at: null, status: 'new', payload: JSON.stringify(body) };
}

const SHARE_BODY = {
    intent: 'PROFILE_SHARE',
    metaData: { hipId: 'IN3310000001', context: 'Counter-1' },
    profile: { patient: { name: 'Ramesh Kumar', gender: 'M', yearOfBirth: 1990, phoneNumber: '+91-98765-00000', abhaAddress: 'ramesh@sbx', abhaNumber: '91-1111-2222-3333' } }
};

function setup(items: AbdmMailboxItem[], overrides: Record<string, any> = {}) {
    const statuses: Record<string, string> = {};
    let tokenNo = 0;
    const store = {
        getNewAbdmMailboxItems: vi.fn((limit: number) => items.filter((item) => !statuses[item.id]).slice(0, limit)),
        setAbdmMailboxStatus: vi.fn((id: string, status: string) => { statuses[id] = status; }),
        abdmMailboxRequestSeen: vi.fn((path: string, requestId: string, exceptId: string) =>
            items.some((item) => item.id !== exceptId && item.path === path && item.request_id === requestId && statuses[item.id] === 'processed')),
        receiveAbhaShare: vi.fn((payload: any) => {
            if (!payload.name) throw new Error('Shared profile must include a patient name.');
            tokenNo += 1;
            return { id: tokenNo, token_no: tokenNo };
        }),
        receiveInboxCallback: vi.fn(() => ({ id: 1 })),
        getConsentByRequestId: vi.fn((id: string) => (id === 'consent-1' ? { id: 7, status: 'granted', patient_id: 3 } : id === 'consent-denied' ? { id: 8, status: 'denied' } : null)),
        storeFetchedRecordBatch: vi.fn((rows: any[]) => rows),
        ...overrides.store
    };
    const hiu = {
        handleNotify: vi.fn(),
        decryptRecord: vi.fn((envelope: any) => {
            if (envelope.encryptedData === 'bad') throw new Error('Could not decrypt.');
            return { resourceType: 'Bundle', from: envelope.encryptedData };
        }),
        ...overrides.hiu
    };
    const send = overrides.send ?? vi.fn(async () => ({ status: 202, body: null }));
    const onShare = vi.fn();
    const runWork = vi.fn(<T>(work: () => Promise<T>) => work());
    const processor = new AbdmMailboxProcessor({
        store, hiu, relay: () => (overrides.unpaired ? null : send), onShare, runWork, nowMs: () => NOW
    });
    return { processor, store, hiu, send, onShare, runWork, statuses };
}

describe('AbdmMailboxProcessor', () => {
    describe('scan and share', () => {
        it('queues a token, tells the desk at once, and answers the gateway with the token number', async () => {
            const { processor, store, send, onShare, statuses } = setup([callback('m1', SHARE_PATH, SHARE_BODY)]);

            expect(await processor.drain()).toEqual({ processed: 1, failed: 0 });

            expect(store.receiveAbhaShare).toHaveBeenCalledWith(expect.objectContaining({
                name: 'Ramesh Kumar', age: 36, gender: 'Male', mobile: '+919876500000', abhaAddress: 'ramesh@sbx', abhaName: 'Ramesh Kumar'
            }));
            expect(statuses).toEqual({ m1: 'processed' });
            expect(onShare).toHaveBeenCalledTimes(1);
            expect(send).toHaveBeenCalledWith('POST', ON_SHARE_PATH, {
                acknowledgement: { abhaAddress: 'ramesh@sbx', status: 'SUCCESS', profile: { context: 'Counter-1', tokenNumber: '1', expiry: '900' } },
                response: { requestId: 'req-m1' }
            });
        });

        it('refuses a profile it cannot queue and says so to the gateway', async () => {
            const body = { metaData: { context: 'Counter-1' }, profile: { patient: { abhaAddress: 'nobody@sbx' } } };
            const { processor, send, onShare, statuses } = setup([callback('m1', SHARE_PATH, body)]);

            expect(await processor.drain()).toEqual({ processed: 0, failed: 1 });

            expect(statuses).toEqual({ m1: 'failed' });
            expect(onShare).not.toHaveBeenCalled();
            expect(send).toHaveBeenCalledWith('POST', ON_SHARE_PATH, expect.objectContaining({
                acknowledgement: { abhaAddress: 'nobody@sbx', status: 'FAILURE' },
                error: expect.objectContaining({ message: 'Shared profile must include a patient name.' }),
                response: { requestId: 'req-m1' }
            }));
        });

        it('queues one token when the gateway sends the same scan twice', async () => {
            const items = [callback('m1', SHARE_PATH, SHARE_BODY, 'same'), callback('m2', SHARE_PATH, SHARE_BODY, 'same')];
            const { processor, store, send, statuses } = setup(items);

            expect(await processor.drain()).toEqual({ processed: 2, failed: 0 });

            expect(store.receiveAbhaShare).toHaveBeenCalledTimes(1);
            expect(send).toHaveBeenCalledTimes(1);
            expect(statuses).toEqual({ m1: 'processed', m2: 'processed' });
        });

        it('keeps the token when the gateway answer cannot be sent', async () => {
            const unpaired = setup([callback('m1', SHARE_PATH, SHARE_BODY)], { unpaired: true });
            expect(await unpaired.processor.drain()).toEqual({ processed: 1, failed: 0 });
            expect(unpaired.onShare).toHaveBeenCalled();

            const refused = setup([callback('m1', SHARE_PATH, SHARE_BODY)], { send: vi.fn(async () => ({ status: 403, body: { error: 'path_not_allowed' } })) });
            expect(await refused.processor.drain()).toEqual({ processed: 1, failed: 0 });

            const offline = setup([callback('m1', SHARE_PATH, SHARE_BODY)], { send: vi.fn(async () => { throw new Error('offline'); }) });
            expect(await offline.processor.drain()).toEqual({ processed: 1, failed: 0 });
        });
    });

    describe('consent notifications', () => {
        const notify = (status: string, consentRequestId = 'consent-1') => ({
            notification: { consentRequestId, status, consentArtefacts: [{ id: 'artefact-1' }] }
        });

        it('updates the consent request and keeps the notice in the inbox', async () => {
            const { processor, store, hiu } = setup([callback('m1', HIU_CONSENT_NOTIFY_PATH, notify('GRANTED'))]);

            expect(await processor.drain()).toEqual({ processed: 1, failed: 0 });

            const payload = { requestId: 'consent-1', status: 'GRANTED', consentHandle: 'artefact-1', artefactIds: ['artefact-1'] };
            expect(store.receiveInboxCallback).toHaveBeenCalledWith('consent-granted', payload, undefined, 'consent-1');
            expect(hiu.handleNotify).toHaveBeenCalledWith('consent-granted', payload);
        });

        it('maps denied, expired and revoked, and only queues a status it does not know', async () => {
            const items = [
                callback('m1', HIU_CONSENT_NOTIFY_PATH, notify('DENIED')),
                callback('m2', HIU_CONSENT_NOTIFY_PATH, notify('EXPIRED')),
                callback('m3', HIU_CONSENT_NOTIFY_PATH, notify('REVOKED')),
                callback('m4', HIU_CONSENT_NOTIFY_PATH, { notification: { consentRequestId: 'consent-1', status: 'PAUSED' } })
            ];
            const { processor, store, hiu } = setup(items);

            await processor.drain();

            expect(hiu.handleNotify.mock.calls.map((call: any[]) => call[0])).toEqual(['consent-denied', 'consent-expired', 'consent-expired']);
            expect(store.receiveInboxCallback).toHaveBeenLastCalledWith('consent-notify', { requestId: 'consent-1', status: 'PAUSED', consentHandle: null, artefactIds: [] }, undefined, 'consent-1');
        });

        it('keeps a notice for an unknown request for the desk', async () => {
            const { processor, statuses } = setup([callback('m1', HIU_CONSENT_NOTIFY_PATH, notify('GRANTED', 'elsewhere'))], {
                hiu: { handleNotify: vi.fn(() => { throw new Error('Consent request not found for this notification.'); }) }
            });

            expect(await processor.drain()).toEqual({ processed: 1, failed: 0 });
            expect(statuses).toEqual({ m1: 'processed' });
        });

        it('fails a notice with no consent request ID', async () => {
            const { processor, store } = setup([callback('m1', HIU_CONSENT_NOTIFY_PATH, { notification: { status: 'GRANTED' } })]);

            expect(await processor.drain()).toEqual({ processed: 0, failed: 1 });
            expect(store.receiveInboxCallback).not.toHaveBeenCalled();
        });
    });

    it('queues any other callback in the inbox under a kind named for its path', async () => {
        const body = { requestId: 'r-9', status: 'OK' };
        const { processor, store } = setup([callback('m1', '/api/v3/hip/consent/request/notify', body)]);

        expect(await processor.drain()).toEqual({ processed: 1, failed: 0 });
        expect(store.receiveInboxCallback).toHaveBeenCalledWith('hip-consent-request-notify', body, undefined, 'req-m1');
    });

    it('fails a callback whose body is not JSON, and moves on to the next', async () => {
        const broken: AbdmMailboxItem = { ...callback('m1', '/api/v3/x', {}), payload: JSON.stringify({ headers: {}, body: '{not json' }) };
        const { processor, statuses } = setup([broken, callback('m2', '/api/v3/y', { ok: true })]);

        expect(await processor.drain()).toEqual({ processed: 1, failed: 1 });
        expect(statuses).toEqual({ m1: 'failed', m2: 'processed' });
    });

    describe('HIU data pushes', () => {
        const keyMaterial = { cryptoAlg: 'ECDH', curve: 'Curve25519', nonce: 'n' };

        it('decrypts and caches records for a granted consent', async () => {
            const { processor, store } = setup([push('d1', { requestId: 'consent-1', records: [{ keyMaterial, encryptedData: 'one' }] })]);

            expect(await processor.drain()).toEqual({ processed: 1, failed: 0 });
            expect(store.storeFetchedRecordBatch).toHaveBeenCalledWith([{
                consentId: 7, patientId: 3, careContextRef: null,
                bundleJson: JSON.stringify({ resourceType: 'Bundle', from: 'one' }), expiresAt: '2026-11-19 10:00:00'
            }]);
        });

        it('reads the ABDM entries shape with one sender key', async () => {
            const body = {
                transactionId: 'consent-1', keyMaterial,
                entries: [{ content: 'a', careContextReference: 'OP-2026-0001' }, { content: 'b' }, { link: 'https://elsewhere' }]
            };
            const { processor, store, hiu } = setup([push('d1', body)]);

            await processor.drain();

            expect(hiu.decryptRecord).toHaveBeenCalledWith({ keyMaterial, encryptedData: 'a', keyId: '' });
            expect(store.storeFetchedRecordBatch.mock.calls[0][0].map((row: any) => row.careContextRef)).toEqual(['OP-2026-0001', null]);
        });

        it('keeps nothing without a matching granted consent, envelopes, or a readable record', async () => {
            const items = [
                push('d1', { requestId: 'nope', records: [{ keyMaterial, encryptedData: 'x' }] }),
                push('d2', { requestId: 'consent-denied', records: [{ keyMaterial, encryptedData: 'x' }] }),
                push('d3', { records: [{ keyMaterial, encryptedData: 'x' }] }),
                push('d4', { requestId: 'consent-1', records: [] }),
                push('d5', { requestId: 'consent-1', envelope: { keyMaterial, encryptedData: 'bad' } }),
                push('d6', { requestId: 'consent-1', records: Array.from({ length: 101 }, () => ({ keyMaterial, encryptedData: 'x' })) })
            ];
            const { processor, store } = setup(items);

            expect(await processor.drain()).toEqual({ processed: 0, failed: 6 });
            expect(store.storeFetchedRecordBatch).not.toHaveBeenCalled();
        });
    });

    describe('live HIU (#164)', () => {
        const keyMaterial = { cryptoAlg: 'ECDH', curve: 'Curve25519', nonce: 'n' };
        const transfer = (overrides: Record<string, unknown> = {}) => ({
            artefactId: 'art-1', consent: { id: 7, status: 'granted', patient_id: 3 }, dataEraseAt: '2026-10-25T00:00:00Z', lastPage: true, ...overrides
        });

        it('hands HIU callbacks to the HIU and sends its follow-up after the work', async () => {
            const followUp = vi.fn(async () => undefined);
            const applyCallback = vi.fn((path: string) => (path === '/api/v3/hiu/consent/request/on-init' ? { followUp } : null));
            const { processor, store } = setup([
                callback('m1', '/api/v3/hiu/consent/request/on-init', { consentRequest: { id: 'cm-1' } }),
                callback('m2', '/api/v3/hip/other', {})
            ], { hiu: { applyCallback } });

            expect(await processor.drain()).toEqual({ processed: 2, failed: 0 });
            expect(applyCallback).toHaveBeenCalledWith('/api/v3/hiu/consent/request/on-init', { consentRequest: { id: 'cm-1' } });
            expect(followUp).toHaveBeenCalledOnce();
            expect(store.receiveInboxCallback).toHaveBeenCalledTimes(1);
        });

        it('acknowledges a grant and then asks for its artefacts', async () => {
            const acknowledgeNotify = vi.fn(async () => undefined);
            const fetchArtefactDetails = vi.fn(async () => undefined);
            const body = { notification: { consentRequestId: 'consent-1', status: 'GRANTED', consentArtefacts: [{ id: 'art-1' }, { id: 'art-2' }, {}] } };
            const { processor } = setup([callback('m1', HIU_CONSENT_NOTIFY_PATH, body, 'cb-1')], {
                hiu: { handleNotify: vi.fn(() => ({ handled: true, consentId: 7 })), acknowledgeNotify, fetchArtefactDetails }
            });

            await processor.drain();

            expect(acknowledgeNotify).toHaveBeenCalledWith('cb-1', ['art-1', 'art-2']);
            expect(fetchArtefactDetails).toHaveBeenCalledWith(7);
        });

        it('acknowledges a revocation without fetching, and nothing without artefacts', async () => {
            const acknowledgeNotify = vi.fn(async () => undefined);
            const fetchArtefactDetails = vi.fn(async () => undefined);
            const { processor } = setup([
                callback('m1', HIU_CONSENT_NOTIFY_PATH, { notification: { consentRequestId: 'consent-1', status: 'REVOKED', consentArtefacts: [{ id: 'art-1' }] } }),
                callback('m2', HIU_CONSENT_NOTIFY_PATH, { notification: { consentRequestId: 'consent-1', status: 'DENIED' } })
            ], { hiu: { handleNotify: vi.fn(() => ({ handled: true, consentId: 7 })), acknowledgeNotify, fetchArtefactDetails } });

            await processor.drain();

            expect(acknowledgeNotify).toHaveBeenCalledTimes(1);
            expect(fetchArtefactDetails).not.toHaveBeenCalled();
        });

        it('caches a push for its transfer, never past the consent erase date, and notifies the consent manager', async () => {
            const notify = vi.fn(async () => undefined);
            const transferFor = vi.fn(() => transfer());
            const completeTransfer = vi.fn(() => notify);
            const body = { transactionId: 'txn-1', pageNumber: 1, pageCount: 1, keyMaterial, entries: [{ content: 'a', careContextReference: 'cc-1' }] };
            const { processor, store } = setup([push('d1', body)], { hiu: { transferFor, completeTransfer } });

            expect(await processor.drain()).toEqual({ processed: 1, failed: 0 });

            expect(transferFor).toHaveBeenCalledWith('txn-1', body);
            expect(store.getConsentByRequestId).not.toHaveBeenCalled();
            expect(store.storeFetchedRecordBatch.mock.calls[0][0][0]).toMatchObject({ consentId: 7, careContextRef: 'cc-1', expiresAt: '2026-10-25 00:00:00' });
            expect(completeTransfer).toHaveBeenCalledWith(expect.objectContaining({ artefactId: 'art-1' }), ['cc-1'], true, 'txn-1');
            expect(notify).toHaveBeenCalledOnce();
        });

        it('keeps the 30-day limit when the erase date is later or unreadable', async () => {
            const body = { transactionId: 'txn-1', keyMaterial, entries: [{ content: 'a' }] };
            for (const dataEraseAt of ['2027-01-01T00:00:00Z', 'someday']) {
                const { processor, store } = setup([push('d1', body)], { hiu: { transferFor: () => transfer({ dataEraseAt }) } });
                await processor.drain();
                expect(store.storeFetchedRecordBatch.mock.calls[0][0][0].expiresAt).toBe('2026-11-19 10:00:00');
            }
        });

        it('tells the consent manager when a push cannot be read', async () => {
            const notify = vi.fn(async () => undefined);
            const completeTransfer = vi.fn(() => notify);
            const body = { transactionId: 'txn-1', keyMaterial, entries: [{ content: 'bad', careContextReference: 'cc-1' }] };
            const { processor, store } = setup([push('d1', body)], { hiu: { transferFor: () => transfer(), completeTransfer } });

            expect(await processor.drain()).toEqual({ processed: 0, failed: 1 });
            expect(store.storeFetchedRecordBatch).not.toHaveBeenCalled();
            expect(completeTransfer).toHaveBeenCalledWith(expect.anything(), ['cc-1'], false, 'txn-1');
            expect(notify).toHaveBeenCalledOnce();
        });

        it('falls back to the request ID when the transaction is not a live transfer', async () => {
            const { processor, store } = setup([push('d1', { transactionId: 'consent-1', records: [{ keyMaterial, encryptedData: 'one' }] })], {
                hiu: { transferFor: () => null }
            });
            expect(await processor.drain()).toEqual({ processed: 1, failed: 0 });
            expect(store.getConsentByRequestId).toHaveBeenCalledWith('consent-1');
        });
    });

    it('runs inside restore-drained work and folds overlapping calls into one more pass', async () => {
        const items = [callback('m1', '/api/v3/a', {})];
        const { processor, store, runWork } = setup(items);

        const first = processor.drain();
        items.push(callback('m2', '/api/v3/b', {}));
        const second = processor.drain();

        expect(second).toBe(first);
        expect(await first).toEqual({ processed: 2, failed: 0 });
        expect(runWork).toHaveBeenCalledTimes(2);
        expect(store.receiveInboxCallback).toHaveBeenCalledTimes(2);
        expect(await processor.drain()).toEqual({ processed: 0, failed: 0 });
    });

    it('reads past a full batch', async () => {
        const items = Array.from({ length: 51 }, (_, i) => callback(`m${i}`, '/api/v3/a', {}, null));
        const { processor } = setup(items);

        expect(await processor.drain()).toEqual({ processed: 51, failed: 0 });
    });
});

describe('ABDM mailbox helpers', () => {
    it('names inbox kinds after the callback path', () => {
        expect(kindFor('/api/v3/hip/consent/request/notify')).toBe('hip-consent-request-notify');
        expect(kindFor(null)).toBe('callback');
        expect(kindFor(`/api/v3/${'a'.repeat(80)}`)).toHaveLength(64);
    });

    it('maps a shared profile, leaving out what the patient did not share', () => {
        expect(shareProfile({ name: ' Asha ', gender: 'f' }, NOW)).toEqual({
            name: 'Asha', age: null, gender: 'Female', mobile: null, abhaAddress: null, abhaName: 'Asha', abhaNumber: null
        });
        expect(shareProfile(undefined, NOW)).toMatchObject({ name: '', gender: null, abhaName: null });
    });
});
