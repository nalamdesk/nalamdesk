import { describe, expect, it } from 'vitest';
import { AbdmMailboxProcessor } from '../cloud/AbdmMailboxProcessor';
import { MIGRATIONS } from '../schema/migrations';
import { DatabaseService } from './DatabaseService';
import { FideliusService } from './FideliusService';
import { HiuService } from './HiuService';

const { DatabaseSync } = require('node:sqlite');

/** Minimal better-sqlite3-compatible adapter backed by Node's real SQLite engine. */
class TestDatabase {
    private readonly sqlite = new DatabaseSync(':memory:');
    readonly name = ':memory:';

    exec(sql: string) { return this.sqlite.exec(sql); }
    prepare(sql: string) { return this.sqlite.prepare(sql); }
    close() { return this.sqlite.close(); }
    pragma(sql: string, options?: { simple?: boolean }) {
        const assignment = sql.match(/^user_version\s*=\s*(\d+)$/);
        if (assignment) {
            this.sqlite.exec(`PRAGMA user_version = ${assignment[1]}`);
            return;
        }
        const row = this.sqlite.prepare(`PRAGMA ${sql}`).get() as any;
        return options?.simple ? row?.user_version : row;
    }
    transaction<T extends (...args: any[]) => any>(operation: T): T & { immediate: T } {
        const run = ((...args: any[]) => {
            this.sqlite.exec('BEGIN IMMEDIATE');
            try {
                const value = operation(...args);
                this.sqlite.exec('COMMIT');
                return value;
            } catch (error) {
                this.sqlite.exec('ROLLBACK');
                throw error;
            }
        }) as T & { immediate: T };
        run.immediate = run;
        return run;
    }
}

describe('cloud mailbox ABDM items on a real database', () => {
    it('saves an item once after every migration, beside the older callback queue', async () => {
        const db = new TestDatabase();
        const service = new DatabaseService();
        service.setDb(db);
        await service.migrate();
        const row = { id: 'm1', type: 'abdm-callback' as const, path: '/api/v3/hip/patient/share', request_id: 'r1', received_at: '2026-10-19T00:00:00Z', payload: '{}' };
        service.saveAbdmInboxItem(row);
        service.saveAbdmInboxItem(row);
        expect(db.prepare('SELECT id, type, path, status FROM abdm_mailbox').all())
            .toEqual([{ id: 'm1', type: 'abdm-callback', path: '/api/v3/hip/patient/share', status: 'new' }]);
        // v20's queue keeps working as before.
        service.receiveInboxCallback('consent-notify', { requestId: 'q1' });
        expect(service.getPendingInbox()).toHaveLength(1);
        db.close();
    });

    it('applies a scan from the mailbox once, as a front-desk token', async () => {
        const db = new TestDatabase();
        const service = new DatabaseService();
        service.setDb(db);
        await service.migrate();
        const share = {
            metaData: { context: 'Counter-1' },
            profile: { patient: { name: 'Ramesh Kumar', gender: 'M', abhaAddress: 'ramesh@sbx' } }
        };
        const payload = JSON.stringify({ headers: { 'request-id': 'r1' }, body: JSON.stringify(share) });
        for (const id of ['m1', 'm2']) {
            service.saveAbdmInboxItem({ id, type: 'abdm-callback', path: '/api/v3/hip/patient/share', request_id: 'r1', received_at: null, payload });
        }
        const send = async () => ({ status: 202, body: null });
        const processor = new AbdmMailboxProcessor({
            store: service,
            hiu: { handleNotify: () => undefined, decryptRecord: () => ({}) },
            relay: () => send
        });

        expect(await processor.drain()).toEqual({ processed: 2, failed: 0 });

        expect(service.getPendingShareTokens()).toMatchObject([{ token_no: 1, patient_name: 'Ramesh Kumar', gender: 'Male', abha_address: 'ramesh@sbx' }]);
        expect(db.prepare('SELECT id, status FROM abdm_mailbox ORDER BY id').all())
            .toEqual([{ id: 'm1', status: 'processed' }, { id: 'm2', status: 'processed' }]);
        expect(service.getNewAbdmMailboxItems(10)).toEqual([]);
        db.close();
    });
});

describe('ABDM credentials after the move to the relay', () => {
    it('clears the Client ID, secret, callback password and gateway choice from an existing install', async () => {
        const db = new TestDatabase();
        const service = new DatabaseService();
        service.setDb(db);
        await service.migrate();
        db.prepare(`INSERT INTO settings (clinic_name, abdm_client_id, abdm_client_secret_protected, abdm_callback_secret, abdm_gateway_env, abdm_mock, abdm_hip_id)
            VALUES ('Clinic', 'CID', 'wrapped', 'shared-password-123', 'production', 1, 'H1')`).run();

        MIGRATIONS.find((m) => m.version === 46)!.up(db);
        MIGRATIONS.find((m) => m.version === 47)!.up(db);

        expect(db.prepare(`SELECT clinic_name, abdm_client_id, abdm_client_secret_protected, abdm_callback_secret, abdm_gateway_env, abdm_mock, abdm_hip_id
            FROM settings`).get()).toEqual({
            clinic_name: 'Clinic', abdm_client_id: null, abdm_client_secret_protected: null, abdm_callback_secret: null,
            abdm_gateway_env: null, abdm_mock: null, abdm_hip_id: 'H1'
        });
        // Generic reads and writes no longer carry the old columns either.
        service.saveSettings({ abdm_client_id: 'again', abdm_gateway_env: 'staging' });
        expect(db.prepare('SELECT abdm_client_id, abdm_gateway_env FROM settings').get()).toEqual({ abdm_client_id: null, abdm_gateway_env: null });
        expect(service.getSettings()).not.toHaveProperty('abdm_client_id');
        db.close();
    });
});

describe('live HIU consent through the relay on a real database (#164)', () => {
    const keyStore = {
        protect: (value: Buffer) => Buffer.from(value.toString('base64')),
        unprotect: (value: Buffer) => Buffer.from(value.toString(), 'base64')
    };

    async function setupLive() {
        const db = new TestDatabase();
        const service = new DatabaseService();
        service.setDb(db);
        await service.migrate();
        db.prepare(`INSERT INTO settings (clinic_name, doctor_name, abdm_hpr_id) VALUES ('Clinic', 'Dr. Asha', '71-0001')`).run();
        const calls: Array<{ path: string; body: any; requestId?: string }> = [];
        let n = 0;
        const hiu = new HiuService({
            getSettings: () => service.getSettings(),
            getHiuPrivateProtected: () => service.getHiuPrivateProtected(),
            saveHiuKeypair: (publicKey, wrapped) => service.saveHiuKeypair(publicKey, wrapped),
            keyStore: keyStore as any,
            store: service,
            relay: {
                isMockMode: () => false,
                send: async (_upstream, _method, path, body, headers) => {
                    calls.push({ path, body, requestId: headers?.['request-id'] });
                    return {};
                }
            },
            hiuId: () => 'IN3310000001',
            dataPushUrl: () => 'https://relay.test/hiu/data-push/tok',
            requester: (userId) => service.getHiuRequester(userId),
            newRequestId: () => `req-${++n}`
        });
        const processor = new AbdmMailboxProcessor({ store: service, hiu, relay: () => async () => ({ status: 202, body: null }) });
        let item = 0;
        const deliver = async (path: string | null, body: unknown, requestId: string | null = null) => {
            item += 1;
            service.saveAbdmInboxItem(path
                ? { id: `m${item}`, type: 'abdm-callback', path, request_id: requestId, received_at: null, payload: JSON.stringify({ headers: {}, body: JSON.stringify(body) }) }
                : { id: `m${item}`, type: 'abdm-data-push', path: null, request_id: null, received_at: null, payload: JSON.stringify(body) });
            return processor.drain();
        };
        return { db, service, hiu, calls, deliver };
    }

    it('runs consent, artefact fetch, records request, data push and transfer notice end to end', async () => {
        const { db, service, hiu, calls, deliver } = await setupLive();

        const consent = await hiu.requestConsent({ abhaAddress: 'asha@sbx', hiTypes: ['Prescription'] });
        expect(calls[0]).toMatchObject({ path: '/consent/v3/request/init', requestId: 'req-1' });
        expect(calls[0].body.consent.requester).toEqual({ name: 'Dr. Asha', identifier: { type: 'REGNO', value: '71-0001', system: 'https://www.mciindia.org' } });

        // The grant arrives before on-init: it waits, then applies.
        const notify = { notification: { consentRequestId: 'cm-1', status: 'GRANTED', consentArtefacts: [{ id: 'art-1' }] } };
        await deliver('/api/v3/hiu/consent/request/notify', notify, 'cb-1');
        expect(service.getConsentById(consent.id).status).toBe('requested');
        await deliver('/api/v3/hiu/consent/request/on-init', { consentRequest: { id: 'cm-1' }, response: { requestId: 'req-1' } });
        expect(service.getConsentById(consent.id)).toMatchObject({ status: 'granted', consent_request_id: 'cm-1', consent_handle: 'art-1' });
        expect(service.getConsentByRequestId('cm-1').id).toBe(consent.id);
        expect(calls.map((c) => c.path)).toEqual(['/consent/v3/request/init', '/consent/v3/request/hiu/on-notify', '/consent/v3/fetch']);

        await deliver('/api/v3/hiu/consent/on-fetch', {
            consent: { status: 'GRANTED', consentDetail: { consentId: 'art-1', hip: { id: 'HIP-A' }, permission: { dateRange: { from: '2024-01-01T00:00:00Z', to: '2026-01-01T00:00:00Z' }, dataEraseAt: '2099-01-01T00:00:00Z' } } },
            response: { requestId: calls[2].requestId }
        });
        expect(service.findHiuArtefact('id', 'art-1')).toMatchObject({ hip_id: 'HIP-A', date_from: '2024-01-01T00:00:00Z' });

        expect(await hiu.fetchForConsent(consent.id)).toEqual({ requested: 1 });
        const request = calls.at(-1)!;
        expect(request.path).toBe('/data-flow/v3/health-information/request');
        await deliver('/api/v3/hiu/health-information/on-request', { hiRequest: { transactionId: 'txn-1', sessionStatus: 'REQUESTED' }, response: { requestId: request.requestId } });
        expect(service.findHiuArtefact('transaction_id', 'txn-1')).toMatchObject({ id: 'art-1', transfer_status: 'acknowledged' });

        const envelope = new FideliusService().encryptBundle({ resourceType: 'Bundle', id: 'outside' }, request.body.hiRequest.keyMaterial);
        await deliver(null, { transactionId: 'txn-1', pageNumber: 1, pageCount: 1, keyMaterial: envelope.keyMaterial, entries: [{ content: envelope.encryptedData, careContextReference: 'cc-1' }] });

        const records = db.prepare('SELECT consent_id, care_context_ref, bundle_json FROM abdm_fetched_records').all();
        expect(records).toEqual([{ consent_id: consent.id, care_context_ref: 'cc-1', bundle_json: JSON.stringify({ resourceType: 'Bundle', id: 'outside' }) }]);
        expect(service.findHiuArtefact('id', 'art-1').transfer_status).toBe('transferred');
        expect(calls.at(-1)).toMatchObject({ path: '/data-flow/v3/health-information/notify', body: { notification: { statusNotification: { sessionStatus: 'TRANSFERRED', hipId: 'HIP-A' } } } });
        db.close();
    });

    it('keeps a refused or unsent request out of the way', async () => {
        const { db, service, hiu, deliver } = await setupLive();
        const refused = await hiu.requestConsent({ abhaAddress: 'asha@sbx', hiTypes: ['Prescription'] });
        await deliver('/api/v3/hiu/consent/request/on-init', { error: { code: 1000, message: 'Patient not found' }, response: { requestId: 'req-1' } });
        expect(service.getConsentById(refused.id)).toMatchObject({ status: 'failed', error: 'Patient not found' });
        expect(service.failConsentRequest(refused.id, 'again').error).toBe('Patient not found');
        expect(() => service.updateConsentStatus(refused.id, 'granted')).toThrow('failed');
        expect(() => service.failConsentRequest(999, 'x')).toThrow('not found');

        const other = service.createConsentRequest({ abhaAddress: 'b@sbx', hiTypes: ['Prescription'], gatewayRequestId: 'x-1' });
        service.discardConsentRequest(other.id);
        expect(service.getConsentById(other.id)).toBeUndefined();

        expect(() => service.findHiuArtefact('status' as any, 'x')).toThrow('Unknown artefact lookup');
        expect(service.findHiuArtefact('id', '  ')).toBeNull();
        expect(service.updateHiuArtefact('none', { bogus: 'x' })).toBeNull();
        expect(service.getHiuRequester(12345)).toEqual({ name: 'Dr. Asha', hprId: '71-0001' });
        db.close();
    });
});
