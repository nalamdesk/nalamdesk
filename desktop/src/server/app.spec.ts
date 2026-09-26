import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const JWT_SECRET = vi.hoisted(() => {
    const secret = process.env['JWT_SECRET'] || 'ipc-queue-http-test-secret';
    process.env['JWT_SECRET'] = secret;
    return secret;
});

import * as jwt from 'jsonwebtoken';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { ApiServer } from './app';

function authHeader(user: { id: number; role: string; username?: string }) {
    const token = jwt.sign(
        { id: user.id, role: user.role, username: user.username || 'admin' },
        JWT_SECRET,
        { expiresIn: '1h' }
    );
    return `Bearer ${token}`;
}

describe('HTTP /api/ipc queue wrapper', () => {
    let server: ApiServer;
    let db: any;

    beforeEach(() => {
        db = {
            beginWork: vi.fn(),
            endWork: vi.fn(),
            getPermissions: vi.fn().mockReturnValue(['addToQueue', 'updateQueueStatus', 'removeFromQueue', 'beginConsultation']),
            addToQueue: vi.fn().mockReturnValue({ lastInsertRowid: 11 }),
            updateQueueStatus: vi.fn().mockReturnValue({ changes: 1 }),
            updateQueueStatusByPatientId: vi.fn().mockReturnValue({ changes: 1 }),
            removeFromQueue: vi.fn().mockReturnValue({ changes: 1 }),
            getQueue: vi.fn().mockReturnValue([]),
            beginConsultation: vi.fn().mockReturnValue({ id: 70 })
        };
        server = new ApiServer(db, os.tmpdir());
    });

    afterEach(async () => {
        await server.close();
    });

    async function postIpc(method: string, args: unknown[], user = { id: 7, role: 'admin' }) {
        return server.inject({
            method: 'POST',
            url: `/api/ipc/${method}`,
            headers: {
                authorization: authHeader(user),
                'content-type': 'application/json'
            },
            payload: args
        });
    }

    it('unpacks addToQueue [{ patientId, priority }] like Electron IPC and appends user.id', async () => {
        const response = await postIpc('addToQueue', [{ patientId: 42, priority: 2 }]);

        expect(response.statusCode).toBe(200);
        expect(db.addToQueue).toHaveBeenCalledWith(42, 2, 7);
        expect(db.addToQueue).not.toHaveBeenCalledWith({ patientId: 42, priority: 2 });
    });

    it('unpacks updateQueueStatus [{ id, status }] like Electron IPC and appends user.id', async () => {
        const response = await postIpc('updateQueueStatus', [{ id: 9, status: 'waiting' }]);

        expect(response.statusCode).toBe(200);
        expect(db.updateQueueStatus).toHaveBeenCalledWith(9, 'waiting', 7);
    });

    it('unpacks updateQueueStatusByPatientId like Electron IPC', async () => {
        const response = await postIpc('updateQueueStatusByPatientId', [{ patientId: 42, status: 'waiting' }]);

        expect(response.statusCode).toBe(200);
        expect(db.updateQueueStatusByPatientId).toHaveBeenCalledWith(42, 'waiting', 7);
    });

    it('appends authenticated user.id to removeFromQueue(id)', async () => {
        const response = await postIpc('removeFromQueue', [9]);

        expect(response.statusCode).toBe(200);
        expect(db.removeFromQueue).toHaveBeenCalledWith(9, 7);
    });

    it('accepts the same renderer payload on Electron IPC and HTTP for a doctor', async () => {
        const response = await postIpc('addToQueue', [{ patientId: 1, priority: 1 }], {
            id: 15,
            role: 'doctor',
            username: 'doc'
        });

        expect(response.statusCode).toBe(200);
        expect(db.addToQueue).toHaveBeenCalledWith(1, 1, 15);
    });

    it('reuses setup across HTTP IPC calls and unpacks beginConsultation like Electron', async () => {
        const first = await postIpc('addToQueue', [{ patientId: 1, priority: 1 }]);
        const second = await postIpc('beginConsultation', [{ patientId: 1, queueEntryId: 9, startRequestId: 'req-1' }]);

        expect(first.statusCode).toBe(200);
        expect(second.statusCode).toBe(200);
        expect(db.beginConsultation).toHaveBeenCalledWith(
            { patientId: 1, queueEntryId: 9, startRequestId: 'req-1' },
            7
        );
    });
});

describe('HTTP /api/ipc catalog methods', () => {
    let server: ApiServer;
    let db: any;

    beforeEach(() => {
        db = {
            beginWork: vi.fn(),
            endWork: vi.fn(),
            getPermissions: vi.fn().mockReturnValue(['searchConditions', 'createCondition', 'createMedicine']),
            searchConditions: vi.fn().mockReturnValue([{ id: 1, name: 'Influenza' }]),
            createCondition: vi.fn().mockReturnValue({ id: 2, name: 'URI' }),
            createMedicine: vi.fn().mockReturnValue({ id: 3, name: 'Paracetamol' })
        };
        server = new ApiServer(db, os.tmpdir());
    });

    afterEach(async () => {
        await server.close();
    });

    it('forwards catalog search and Add new with the same args Electron IPC unpacks', async () => {
        const token = jwt.sign({ id: 15, role: 'doctor', username: 'doc' }, JWT_SECRET, { expiresIn: '1h' });
        const search = await server.inject({
            method: 'POST',
            url: '/api/ipc/searchConditions',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            payload: ['flu']
        });
        const create = await server.inject({
            method: 'POST',
            url: '/api/ipc/createCondition',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            payload: [{ name: 'URI' }]
        });
        expect(search.statusCode).toBe(200);
        expect(create.statusCode).toBe(200);
        expect(db.searchConditions).toHaveBeenCalledWith('flu');
        expect(db.createCondition).toHaveBeenCalledWith({ name: 'URI' });
    });
});

describe('hash SPA fallback', () => {
    let server: ApiServer;

    beforeEach(() => {
        server = new ApiServer({} as any, os.tmpdir());
    });

    afterEach(async () => {
        await server.close();
    });

    it('rewrites /settings to /#/settings before the empty-hash login map', async () => {
        const response = await server.inject({ method: 'GET', url: '/settings' });
        expect(response.statusCode).toBe(302);
        expect(response.headers.location).toBe('/#/settings');
    });

    it('rewrites other app paths the same way', async () => {
        const queue = await server.inject({ method: 'GET', url: '/queue' });
        const visits = await server.inject({ method: 'GET', url: '/visits' });
        expect(queue.headers.location).toBe('/#/queue');
        expect(visits.headers.location).toBe('/#/visits');
    });

    it('does not rewrite API routes', async () => {
        const response = await server.inject({ method: 'GET', url: '/api/missing' });
        expect(response.statusCode).toBe(404);
        expect(response.headers.location).toBeUndefined();
    });

    it('preserves query string on rewrite', async () => {
        const response = await server.inject({ method: 'GET', url: '/patients?editId=5' });
        expect(response.statusCode).toBe(302);
        expect(response.headers.location).toBe('/#/patients?editId=5');
    });
});

describe('ABDM Scan & Share callback', () => {
    let server: ApiServer;
    let db: any;

    beforeEach(() => {
        db = {
            beginWork: vi.fn(),
            endWork: vi.fn(),
            receiveAbhaShare: vi.fn().mockReturnValue({ id: 1, token_no: 3 })
        };
        server = new ApiServer(db, os.tmpdir());
    });

    afterEach(async () => {
        await server.close();
    });

    it('queues a valid profile share with 202 without authentication', async () => {
        const response = await server.inject({
            method: 'POST',
            url: '/abdm/v0.5/patients/profile/share',
            payload: { name: 'Ramesh Kumar', abhaAddress: 'ramesh@sbx' }
        });
        expect(response.statusCode).toBe(202);
        expect(response.json()).toMatchObject({ status: 'queued', tokenNo: 3 });
        expect(db.receiveAbhaShare).toHaveBeenCalledWith(
            expect.objectContaining({ name: 'Ramesh Kumar' })
        );
    });

    it('rejects a nameless payload with 400', async () => {
        db.receiveAbhaShare.mockImplementation(() => {
            throw new Error('Shared profile must include a patient name.');
        });
        const response = await server.inject({
            method: 'POST',
            url: '/abdm/v0.5/patients/profile/share',
            payload: { abhaAddress: 'nobody@sbx' }
        });
        expect(response.statusCode).toBe(400);
        expect(response.json().error).toContain('patient name');
    });

    it('rate-limits share floods with 429', async () => {
        for (let i = 0; i < 30; i += 1) {            const response = await server.inject({
                method: 'POST',
                url: '/abdm/v0.5/patients/profile/share',
                payload: { name: `Patient ${i}` }
            });
            expect(response.statusCode).toBe(202);
        }
        const throttled = await server.inject({
            method: 'POST',
            url: '/abdm/v0.5/patients/profile/share',
            payload: { name: 'Patient overflow' }
        });
        expect(throttled.statusCode).toBe(429);
    });
});

describe('ABDM callback inbox route', () => {
    let server: ApiServer;
    let db: any;

    beforeEach(() => {
        db = {
            beginWork: vi.fn(),
            endWork: vi.fn(),
            receiveInboxCallback: vi.fn().mockReturnValue({ id: 5, status: 'pending' }),
            callbackSecretMatches: vi.fn().mockReturnValue(true)
        };
        server = new ApiServer(db, os.tmpdir());
    });

    afterEach(async () => {
        await server.close();
    });

    it('queues a valid callback with 202', async () => {
        const response = await server.inject({
            method: 'POST',
            url: '/abdm/v0.5/callbacks/consent-request',
            payload: { requestId: 'r-1' }
        });
        expect(response.statusCode).toBe(202);
        expect(response.json()).toMatchObject({ status: 'queued', id: 5 });
        expect(db.receiveInboxCallback).toHaveBeenCalledWith(
            'consent-request', expect.objectContaining({ requestId: 'r-1' }));
    });

    it('rejects invalid callbacks with 400', async () => {
        db.receiveInboxCallback.mockImplementation(() => {
            throw new Error('Callback kind is required.');
        });
        const badKind = await server.inject({
            method: 'POST',
            url: '/abdm/v0.5/callbacks/%20',
            payload: {}
        });
        expect(badKind.statusCode).toBe(400);
    });

    it('enforces the callback password when one is configured', async () => {        db.callbackSecretMatches = vi.fn().mockImplementation((presented: unknown) => presented === 's3cret-token');
        const denied = await server.inject({
            method: 'POST',
            url: '/abdm/v0.5/callbacks/consent-request',
            payload: { requestId: 'r-9' }
        });
        expect(denied.statusCode).toBe(401);

        const wrong = await server.inject({
            method: 'POST',
            url: '/abdm/v0.5/callbacks/consent-request',
            headers: { 'x-callback-token': 'wrong' },
            payload: { requestId: 'r-9' }
        });
        expect(wrong.statusCode).toBe(401);

        const allowed = await server.inject({
            method: 'POST',
            url: '/abdm/v0.5/callbacks/consent-request',
            headers: { 'x-callback-token': 's3cret-token' },
            payload: { requestId: 'r-9' }
        });
        expect(allowed.statusCode).toBe(202);
    });

    it('leaves callbacks open when no password is configured', async () => {
        db.callbackSecretMatches = vi.fn().mockReturnValue(true);
        const response = await server.inject({
            method: 'POST',
            url: '/abdm/v0.5/callbacks/consent-request',
            payload: { requestId: 'r-10' }
        });
        expect(response.statusCode).toBe(202);
        expect(db.callbackSecretMatches).toHaveBeenCalledWith(undefined, false);
    });

    it('rejects live callbacks without a password when none is configured', async () => {
        // Flip this server to live mode with no secret: strict gate applies.
        // The matcher reports no match (mirroring the real method with no
        // secret stored and strict mode on).
        const liveDb = {
            ...db,
            getSettings: vi.fn().mockReturnValue({ abdm_mock: 0, abdm_client_id: 'CID' }),
            callbackSecretMatches: vi.fn().mockReturnValue(false)
        };
        const liveServer = new ApiServer(liveDb, os.tmpdir());
        try {
            const response = await liveServer.inject({
                method: 'POST',
                url: '/abdm/v0.5/callbacks/consent-request',
                payload: { requestId: 'r-11' }
            });
            expect(response.statusCode).toBe(401);
        } finally {
            await liveServer.close();
        }
    });
});

describe('ABDM HIU data transfer route', () => {
    let server: ApiServer;
    let db: any;

    beforeEach(() => {
        db = {
            beginWork: vi.fn(),
            endWork: vi.fn(),
            callbackSecretMatches: vi.fn().mockReturnValue(true),
            getConsentByRequestId: vi.fn().mockReturnValue(null),
            storeFetchedRecord: vi.fn().mockReturnValue({ id: 3, status: 'cached' })
        };
        server = new ApiServer(db, os.tmpdir());
    });

    afterEach(async () => {
        await server.close();
    });

    it('rejects pushes without envelopes', async () => {
        const response = await server.inject({
            method: 'POST',
            url: '/abdm/hiu/data/transfer',
            payload: { requestId: 'req-1', records: [] }
        });
        expect(response.statusCode).toBe(400);
        expect(db.storeFetchedRecord).not.toHaveBeenCalled();
    });

    it('rejects envelopes the HIU key cannot open', async () => {
        const response = await server.inject({
            method: 'POST',
            url: '/abdm/hiu/data/transfer',
            payload: {
                requestId: 'req-2',
                records: [{ ephemeralPublicKey: 'nope', nonce: 'nope', ciphertext: 'nope', tag: 'nope' }]
            }
        });
        expect(response.statusCode).toBe(400);
        expect(db.storeFetchedRecord).not.toHaveBeenCalled();
    });

    it('enforces the callback password when one is configured', async () => {
        db.callbackSecretMatches = vi.fn().mockImplementation((presented: unknown) => presented === 's3cret-token');
        const denied = await server.inject({
            method: 'POST',
            url: '/abdm/hiu/data/transfer',
            payload: { requestId: 'req-3', records: [] }
        });
        expect(denied.statusCode).toBe(401);
    });
});

describe('HTTP /api/ipc ABDM flows for LAN clients', () => {
    let server: ApiServer;
    let db: any;
    let savedSettings: any[];

    beforeEach(() => {
        savedSettings = [];
        db = {
            beginWork: vi.fn(),
            endWork: vi.fn(),
            getPermissions: vi.fn().mockImplementation((role: string) => {
                if (role === 'receptionist') {
                    return ['abdmAbhaLookup', 'abdmLinkAbha', 'abdmGetConfig'];
                }
                if (role === 'doctor') {
                    return ['abdmAbhaLookup', 'abdmLinkAbha', 'abdmGetConfig', 'abdmTransferBundle'];
                }
                return [];
            }),
            getSettings: vi.fn().mockReturnValue({}),
            hasCallbackSecret: vi.fn().mockReturnValue(false),
            saveSettings: vi.fn().mockImplementation((patch: any) => {
                savedSettings.push(patch);
                return { changes: 1 };
            }),
            saveAbdmSecretProtected: vi.fn(),
            linkAbhaAddress: vi.fn().mockReturnValue({ id: 7 }),
            expireFetchedRecords: vi.fn(),
            getFetchedRecords: vi.fn().mockReturnValue([{
                id: 11, consent_id: 2, fetched_at: '2026-09-26 10:00:00',
                expires_at: '2099-01-01 00:00:00', status: 'cached',
                bundle_json: JSON.stringify({
                    resourceType: 'Bundle', type: 'document', entry: [{
                        resource: {
                            resourceType: 'Condition',
                            code: { text: 'Asthma' }, clinicalStatus: 'active'
                        }
                    }]
                })
            }]),
            clearFetchedRecords: vi.fn().mockReturnValue({ changes: 1 })
        };
        server = new ApiServer(db, os.tmpdir());
    });

    afterEach(async () => {
        await server.close();
    });

    function postIpc(method: string, args: unknown[], role = 'admin') {
        return server.inject({
            method: 'POST',
            url: `/api/ipc/${method}`,
            headers: {
                authorization: authHeader({ id: 7, role }),
                'content-type': 'application/json'
            },
            payload: args
        });
    }

    it('serves ABDM config and lookup over LAN in mock mode', async () => {
        const config = await postIpc('abdmGetConfig', []);
        expect(config.statusCode).toBe(200);
        expect(config.json()).toMatchObject({ mock: true });

        const lookup = await postIpc('abdmAbhaLookup', [{ abhaAddress: 'demo@sbx' }]);
        expect(lookup.statusCode).toBe(200);
        expect(lookup.json().mock).toBe(true);
    });

    it('saves ABDM config over LAN for admins', async () => {
        const response = await postIpc('abdmSaveConfig', [{
            gateway_env: 'staging', client_id: 'CID', mock: false
        }]);
        expect(response.statusCode).toBe(200);
        expect(savedSettings[0]).toMatchObject({
            abdm_gateway_env: 'staging', abdm_client_id: 'CID', abdm_mock: 0
        });
    });

    it('forbids ABDM config writes for non-admin LAN roles', async () => {
        const response = await postIpc('abdmSaveConfig', [{ gateway_env: 'staging' }], 'doctor');
        expect(response.statusCode).toBe(403);
    });

    it('links health IDs over LAN for desk roles', async () => {
        const response = await postIpc('abdmLinkAbha', [
            { patientId: 7, abhaAddress: 'asha@sbx', abhaName: 'Asha' }
        ], 'receptionist');
        expect(response.statusCode).toBe(200);
        expect(db.linkAbhaAddress).toHaveBeenCalledWith(
            7,
            expect.objectContaining({ abhaAddress: 'asha@sbx' }),
            expect.anything()
        );
    });

    it('serves parsed external records over LAN to desk readers', async () => {
        db.getPermissions.mockImplementation((role: string) => role === 'admin'
            ? []
            : ['abdmHiuGetExternalRecords']);
        const response = await postIpc('abdmHiuGetExternalRecords', [{ patientId: 1 }], 'receptionist');
        expect(response.statusCode).toBe(200);
        expect(db.expireFetchedRecords).toHaveBeenCalled();
        const rows = response.json();
        expect(rows).toHaveLength(1);
        expect(rows[0].parsed.diagnoses).toEqual([{ text: 'Asthma', code: undefined, status: 'active' }]);
    });

    it('restricts cache clearing to clinical roles over LAN', async () => {
        db.getPermissions.mockImplementation((role: string) => role === 'admin'
            ? []
            : ['abdmHiuGetExternalRecords']);
        const denied = await postIpc('abdmHiuClearExternalRecords', [{ patientId: 1 }], 'receptionist');
        expect(denied.statusCode).toBe(403);
        expect(db.clearFetchedRecords).not.toHaveBeenCalled();

        db.getPermissions.mockImplementation((role: string) => role === 'admin'
            ? []
            : ['abdmHiuGetExternalRecords', 'abdmHiuClearExternalRecords']);
        const allowed = await postIpc('abdmHiuClearExternalRecords', [{ patientId: 1 }], 'doctor');
        expect(allowed.statusCode).toBe(200);
        expect(db.clearFetchedRecords).toHaveBeenCalledWith(1, expect.anything());
    });

    it('transfers bundles over LAN without exposing the recipient key', async () => {
        const { generateKeyPairSync } = await import('node:crypto');
        const { publicKey } = generateKeyPairSync('x25519', {
            publicKeyEncoding: { type: 'spki', format: 'pem' },
            privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
        });
        const raw = crypto.createPublicKey(publicKey)
            .export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
        db.getSettings = vi.fn().mockReturnValue({
            abdm_recipient_key: raw,
            abdm_hip_endpoint: ''
        });
        const response = await postIpc('abdmTransferBundle', [
            { bundle: { resourceType: 'Bundle', entry: [] } }
        ], 'doctor');
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({ status: 'mock-loopback' });
    });

    it('rejects LAN transfers for nurses', async () => {
        const response = await postIpc('abdmTransferBundle', [
            { bundle: { resourceType: 'Bundle', entry: [] } }
        ], 'nurse');
        expect(response.statusCode).toBe(403);
    });
});
