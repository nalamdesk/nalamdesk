import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const JWT_SECRET = vi.hoisted(() => {
    const secret = process.env['JWT_SECRET'] || 'ipc-queue-http-test-secret';
    process.env['JWT_SECRET'] = secret;
    return secret;
});

import * as jwt from 'jsonwebtoken';
import * as os from 'node:os';
import { ApiServer } from './app';
import { FideliusService } from '../main/services/FideliusService';

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
            getAllRoles: vi.fn().mockReturnValue([
                { name: 'doctor', permissions: ['addToQueue', 'updateQueueStatus', 'removeFromQueue', 'beginConsultation'] },
                { name: 'receptionist', permissions: ['addToQueue', 'updateQueueStatus', 'removeFromQueue', 'beginConsultation'] }
            ]),
            getAllOverrides: vi.fn().mockReturnValue([]),
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
        expect(db.removeFromQueue).toHaveBeenCalledWith(9, 7, '');
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
            getAllRoles: vi.fn().mockReturnValue([
                { name: 'doctor', permissions: ['searchConditions', 'createCondition', 'createMedicine'] }
            ]),
            getAllOverrides: vi.fn().mockReturnValue([]),
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

describe('HTTP /api/ipc ABDM flows for LAN clients', () => {
    let server: ApiServer;
    let db: any;
    let savedSettings: any[];
    let rolePerms: Record<string, string[]>;

    beforeEach(() => {
        savedSettings = [];
        rolePerms = {
            receptionist: ['abdmAbhaLookup', 'abdmLinkAbha', 'abdmGetConfig'],
            doctor: ['abdmAbhaLookup', 'abdmLinkAbha', 'abdmGetConfig', 'abdmTransferBundle']
        };
        db = {
            beginWork: vi.fn(),
            endWork: vi.fn(),
            getPermissions: vi.fn().mockImplementation((role: string) => rolePerms[role] || []),
            getAllRoles: vi.fn().mockImplementation(() => Object.entries(rolePerms).map(([name, permissions]) => ({ name, permissions }))),
            getAllOverrides: vi.fn().mockReturnValue([]),
            getSettings: vi.fn().mockReturnValue({}),
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

    it('accepts the production gateway and ignores unknown environments', async () => {
        await postIpc('abdmSaveConfig', [{ gateway_env: 'production' }]);
        await postIpc('abdmSaveConfig', [{ gateway_env: 'elsewhere' }]);
        expect(savedSettings[0]).toMatchObject({ abdm_gateway_env: 'production' });
        expect(savedSettings[1]).not.toHaveProperty('abdm_gateway_env');
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
        rolePerms.receptionist = ['abdmHiuGetExternalRecords'];
        const response = await postIpc('abdmHiuGetExternalRecords', [{ patientId: 1 }], 'receptionist');
        expect(response.statusCode).toBe(200);
        expect(db.expireFetchedRecords).toHaveBeenCalled();
        const rows = response.json();
        expect(rows).toHaveLength(1);
        expect(rows[0].parsed.diagnoses).toEqual([{ text: 'Asthma', code: undefined, status: 'active' }]);
    });

    it('restricts cache clearing to clinical roles over LAN', async () => {
        rolePerms.receptionist = ['abdmHiuGetExternalRecords'];
        rolePerms.doctor = [...rolePerms.doctor, 'abdmHiuClearExternalRecords'];
        const denied = await postIpc('abdmHiuClearExternalRecords', [{ patientId: 1 }], 'receptionist');
        expect(denied.statusCode).toBe(403);
        expect(db.clearFetchedRecords).not.toHaveBeenCalled();

        const allowed = await postIpc('abdmHiuClearExternalRecords', [{ patientId: 1 }], 'doctor');
        expect(allowed.statusCode).toBe(200);
        expect(db.clearFetchedRecords).toHaveBeenCalledWith(1, expect.anything());
    });

    it('imports outside medications over LAN through the safety gate', async () => {
        rolePerms.receptionist = ['abdmHiuGetExternalRecords'];
        rolePerms.doctor = [...rolePerms.doctor, 'abdmHiuImportMedication'];
        const denied = await postIpc('abdmHiuImportMedication', [{ patientId: 1, medicine_name: 'Amlodipine' }], 'receptionist');
        expect(denied.statusCode).toBe(403);

        db.importExternalMedication = vi.fn().mockReturnValue({ id: 31, medicine_name: 'Amlodipine' });
        const allowed = await postIpc('abdmHiuImportMedication', [{
            patientId: 1, medicine_name: 'Amlodipine', dosage: '5mg', frequency: '1-0-0', source: 'Outside record #4'
        }], 'doctor');
        expect(allowed.statusCode).toBe(200);
        expect(db.importExternalMedication).toHaveBeenCalledWith(1, expect.objectContaining({
            medicine_name: 'Amlodipine', source: 'Outside record #4'
        }), null, expect.anything());
    });

    it('transfers bundles over LAN without exposing the recipient key', async () => {
        const { keyMaterial } = new FideliusService().generateKeyMaterial();
        db.getSettings = vi.fn().mockReturnValue({
            abdm_recipient_key: JSON.stringify(keyMaterial),
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

describe('HTTP /api/ipc override admin over LAN', () => {
    let server: ApiServer;
    let db: any;

    beforeEach(() => {
        db = {
            beginWork: vi.fn(),
            endWork: vi.fn(),
            getAllRoles: vi.fn().mockReturnValue([]),
            getAllOverrides: vi.fn().mockReturnValue([]),
            getUserOverrides: vi.fn().mockReturnValue([]),
            saveUserOverride: vi.fn().mockReturnValue({ id: 3 }),
            deleteUserOverride: vi.fn().mockReturnValue({ changes: 1 })
        };
        server = new ApiServer(db, os.tmpdir());
    });

    afterEach(async () => {
        await server.close();
    });

    async function postIpc(method: string, args: unknown[]) {
        return server.inject({
            method: 'POST',
            url: `/api/ipc/${method}`,
            headers: {
                authorization: authHeader({ id: 1, role: 'admin' }),
                'content-type': 'application/json'
            },
            payload: args
        });
    }

    it('routes saveUserOverride through the DB alias instead of 404', async () => {
        const input = { userId: 20, action: 'updateQueueStatus', effect: 'allow', reason: 'Covers Tuesdays' };
        const response = await postIpc('saveUserOverride', [input]);
        expect(response.statusCode).toBe(200);
        expect(db.saveUserOverride).toHaveBeenCalledWith(input, 1);
    });

    it('unpacks deleteUserOverride to positional args instead of silent no-op', async () => {
        const response = await postIpc('deleteUserOverride', [{ userId: 20, action: 'updateQueueStatus' }]);
        expect(response.statusCode).toBe(200);
        expect(db.deleteUserOverride).toHaveBeenCalledWith(20, 'updateQueueStatus', 1);
    });
});

describe('HTTP /api/ipc billing ledger over LAN', () => {
    let server: ApiServer;
    let db: any;

    beforeEach(() => {
        db = {
            beginWork: vi.fn(),
            endWork: vi.fn(),
            getAllRoles: vi.fn().mockReturnValue([
                { name: 'doctor', permissions: ['createInvoice', 'recordPayment'] },
                { name: 'receptionist', permissions: ['createInvoice', 'recordPayment', 'refundPayment', 'voidInvoice'] }
            ]),
            getAllOverrides: vi.fn().mockReturnValue([]),
            getInvoice: vi.fn().mockReturnValue({ id: 1 }),
            createInvoice: vi.fn().mockReturnValue({ id: 2 }),
            recordPayment: vi.fn().mockReturnValue({ id: 3 }),
            refundPayment: vi.fn().mockReturnValue({ id: 4 }),
            voidInvoice: vi.fn().mockReturnValue({ id: 2 })
        };
        server = new ApiServer(db, os.tmpdir());
    });

    afterEach(async () => {
        await server.close();
    });

    async function postIpc(method: string, args: unknown[], role = 'receptionist') {
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

    it('unpacks billing calls through shared arg routes', async () => {
        const created = await postIpc('createInvoice', [{ visitId: 9, items: [] }]);
        expect(created.statusCode).toBe(200);
        expect(db.createInvoice).toHaveBeenCalledWith({ visitId: 9, items: [] }, 7);

        const paid = await postIpc('recordPayment', [{ invoiceId: 2, amount: 100, method: 'upi' }]);
        expect(paid.statusCode).toBe(200);

        const denied = await postIpc('refundPayment', [{ paymentId: 3, reason: 'x' }], 'doctor');
        expect(denied.statusCode).toBe(403);
        expect(db.refundPayment).not.toHaveBeenCalled();
    });
});
