import { describe, expect, it, vi } from 'vitest';
import { AbdmMailboxProcessor } from '../cloud/AbdmMailboxProcessor';
import { TestDatabase } from '../testing/TestDatabase';
import { DatabaseService } from './DatabaseService';
import { FideliusService } from './FideliusService';
import {
    HIP_CONSENT_NOTIFY_PATH,
    HIP_DISCOVER_PATH,
    HIP_HI_REQUEST_PATH,
    HIP_LINK_CONFIRM_PATH,
    HIP_LINK_INIT_PATH,
    HIP_ON_CARE_CONTEXT_PATH,
    HIP_ON_GENERATE_TOKEN_PATH,
    HipService,
    pinnedPost,
    publicLookup
} from './HipService';

vi.mock('electron-log', () => ({ default: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const NOW = Date.parse('2026-10-20T10:00:00Z');
const PUSH_URL = 'https://hiu.example.in/data/push';

interface Call { path: string; body: any; headers: Record<string, string> }

async function setup(options: { mock?: boolean; pushOk?: boolean; pushHost?: string[] } = {}) {
    const db = new TestDatabase();
    const store = new DatabaseService();
    store.setDb(db);
    await store.migrate();
    db.prepare(`INSERT INTO settings (clinic_name, doctor_name, abdm_hfr_id) VALUES ('Sunrise Clinic', 'Dr. Asha', 'IN3310000001')`).run();
    db.prepare(`INSERT INTO users (id, username, name, role, license_number, abdm_hpr_id) VALUES (5, 'asha', 'Dr. Asha', 'doctor', 'TN-123', '71-0001')`).run();
    const patient = (id: number, values: Record<string, unknown>) => db.prepare(`INSERT INTO patients
        (id, uuid, mrn, name, mobile, age, gender, dob, abha_address, abha_number)
        VALUES (@id, @uuid, @mrn, @name, @mobile, @age, @gender, @dob, @abha_address, @abha_number)`).run({
        id, uuid: `uuid-${id}`, mrn: `ND-${id}`, name: 'Patient', mobile: null, age: null, gender: null, dob: null,
        abha_address: null, abha_number: null, ...values
    });
    patient(1, { name: 'Ravi Kumar', mobile: '+91 98765 43210', gender: 'Male', dob: '1990-04-01', abha_address: 'ravi@sbx', abha_number: '91-1111-2222-3333' });
    patient(2, { name: 'Meena', mobile: '9000000001', gender: 'Female', age: 40 });
    patient(3, { name: 'Meena S', mobile: '9000000001', gender: 'Female', age: 41 });
    const visit = (id: number, patientId: number, ref: string | null, date: string, status = 'finished') => db.prepare(`INSERT INTO visits
        (id, patient_id, doctor_id, date, diagnosis, prescription_json, status, care_context_ref)
        VALUES (?, ?, 5, ?, 'Fever', ?, ?, ?)`).run(id, patientId, date, JSON.stringify([{ medicine: 'Paracetamol 500mg', dosage: '1 tablet', route: 'Oral', frequency: '1-0-1', duration: '3 days' }]), status, ref);
    visit(10, 1, 'OP-2026-0001', '2026-03-01 09:00:00');
    visit(11, 1, 'OP-2026-0002', '2026-09-01 09:00:00');
    visit(12, 1, 'OP-2026-0003', '2026-10-01 09:00:00', 'in-progress');
    visit(13, 2, 'OP-2026-0004', '2026-05-01 09:00:00');

    const calls: Call[] = [];
    const pushes: any[] = [];
    let n = 0;
    const relay = {
        isMockMode: () => !!options.mock,
        send: vi.fn(async (_upstream: 'gateway', _method: 'POST', path: string, body: unknown, headers: Record<string, string> = {}) => {
            calls.push({ path, body, headers });
            return {};
        })
    };
    const fetchFn = vi.fn(async (_url: string, init: any) => {
        pushes.push(JSON.parse(init.body));
        return new Response(null, { status: options.pushOk === false ? 500 : 202 });
    });
    const hip = new HipService({
        store, relay, hipId: () => 'IN3310000001', fetchFn: fetchFn as unknown as typeof fetch,
        lookupHost: async () => options.pushHost ?? ['93.184.216.34'],
        nowMs: () => NOW, newRequestId: () => `req-${++n}`, newOtp: () => '123456'
    });
    let item = 0;
    const processor = new AbdmMailboxProcessor({
        store, hip, hiu: { handleNotify: () => undefined, decryptRecord: () => ({}) }, relay: () => async () => ({ status: 202, body: null })
    });
    const deliver = async (path: string, body: unknown) => {
        item += 1;
        const requestId = `cb-${item}`;
        store.saveAbdmInboxItem({
            id: `m${item}`, type: 'abdm-callback', path, request_id: requestId, received_at: null,
            payload: JSON.stringify({ headers: { 'request-id': requestId }, body: JSON.stringify(body) })
        });
        await processor.drain();
        return requestId;
    };
    return { db, store, hip, calls, pushes, fetchFn, relay, deliver, last: () => calls.at(-1)! };
}

const granted = (overrides: Record<string, any> = {}) => ({
    notification: {
        status: 'GRANTED',
        consentId: 'hip-consent-1',
        consentDetail: {
            consentId: 'hip-consent-1',
            patient: { id: 'ravi@sbx' },
            hip: { id: 'IN3310000001' },
            hiTypes: ['OPConsultation'],
            careContexts: [{ patientReference: 'ND-1', careContextReference: 'OP-2026-0001' }, { patientReference: 'ND-1', careContextReference: 'OP-2026-0002' }],
            permission: { dateRange: { from: '2026-01-01T00:00:00Z', to: '2026-12-31T00:00:00Z' }, dataEraseAt: '2026-12-01T00:00:00Z' },
            ...overrides
        }
    }
});

describe('HIP discovery and linking from the patient app', () => {
    it('offers the unlinked visits of the patient holding the health ID', async () => {
        const { deliver, last, store } = await setup();
        store.saveHipLinks('ravi@sbx', 1, ['OP-2026-0001'], 'clinic');

        const requestId = await deliver(HIP_DISCOVER_PATH, { transactionId: 'txn-d', patient: { id: 'ravi@sbx', name: 'Ravi', gender: 'M', yearOfBirth: 1990 } });

        expect(last().path).toBe('/user-initiated-linking/v3/patient/care-context/on-discover');
        expect(last().body).toEqual({
            transactionId: 'txn-d',
            patient: [{
                referenceNumber: 'ND-1', display: 'Ravi Kumar',
                careContexts: [{ referenceNumber: 'OP-2026-0002', display: 'Outpatient visit on 2026-09-01' }],
                hiType: 'OPConsultation', count: 1
            }],
            matchedBy: ['ABHA_ADDRESS'],
            response: { requestId }
        });
    });

    it('matches on ABHA number, then on mobile, gender and birth year, and refuses no match or several', async () => {
        const { db, deliver, last } = await setup();
        await deliver(HIP_DISCOVER_PATH, { transactionId: 't1', patient: { id: 'new@sbx', verifiedIdentifiers: [{ type: 'ABHA_NUMBER', value: '91111122223333' }] } });
        expect(last().body.matchedBy).toEqual(['ABHA_NUMBER']);

        await deliver(HIP_DISCOVER_PATH, { transactionId: 't2', patient: { id: 'x@sbx', gender: 'M', yearOfBirth: 1991, verifiedIdentifiers: [{ type: 'MOBILE', value: '9876543210' }] } });
        expect(last().body).toMatchObject({ matchedBy: ['MOBILE'], patient: [{ referenceNumber: 'ND-1', count: 2 }] });

        await deliver(HIP_DISCOVER_PATH, { transactionId: 't3', patient: { id: 'x@sbx', gender: 'F', verifiedIdentifiers: [{ type: 'MOBILE', value: '9876543210' }] } });
        expect(last().body).toMatchObject({ transactionId: 't3', error: { message: 'No matching patient record at this facility.' } });

        await deliver(HIP_DISCOVER_PATH, { transactionId: 't4', patient: { id: 'm@sbx', gender: 'F', yearOfBirth: 1986, verifiedIdentifiers: [{ type: 'MOBILE', value: '9000000001' }] } });
        expect(last().body.error.message).toContain('More than one patient');
        // An unverified number never matches a patient.
        await deliver(HIP_DISCOVER_PATH, { transactionId: 't4b', patient: { id: 'x@sbx', gender: 'M', yearOfBirth: 1990, unverifiedIdentifiers: [{ type: 'MOBILE', value: '9876543210' }] } });
        expect(last().body.error.message).toContain('No matching patient');

        await deliver(HIP_DISCOVER_PATH, { transactionId: 't5', patient: { id: 'm@sbx', yearOfBirth: 1950, verifiedIdentifiers: [{ type: 'MOBILE', value: '9000000001' }] } });
        expect(last().body.error.message).toContain('No matching patient');
        // A patient with no birth date or age does not match a given birth year.
        db.prepare(`INSERT INTO patients (id, uuid, mrn, name, mobile, gender) VALUES (4, 'uuid-4', 'ND-4', 'Ravi', '9111111111', 'Male')`).run();
        await deliver(HIP_DISCOVER_PATH, { transactionId: 't5b', patient: { id: 'r@sbx', gender: 'M', yearOfBirth: 1990, verifiedIdentifiers: [{ type: 'MOBILE', value: '9111111111' }] } });
        expect(last().body.error.message).toContain('No matching patient');
        await deliver(HIP_DISCOVER_PATH, { transactionId: 't6', patient: {} });
        expect(last().body.error.message).toContain('No matching patient');
    });

    it('refuses a discovery when every visit is already linked', async () => {
        const { deliver, last, store } = await setup();
        store.saveHipLinks('ravi@sbx', 1, ['OP-2026-0001', 'OP-2026-0002'], 'clinic');
        await deliver(HIP_DISCOVER_PATH, { transactionId: 't', patient: { id: 'ravi@sbx' } });
        expect(last().body.error.message).toBe('No new records to link at this facility.');
    });

    it('links with the one-time code the desk reads to the patient', async () => {
        const { deliver, last, store, hip } = await setup();
        await deliver(HIP_DISCOVER_PATH, { transactionId: 'txn-l', patient: { id: 'ravi@sbx' } });
        await deliver(HIP_LINK_INIT_PATH, {
            transactionId: 'txn-l', abhaAddress: 'ravi@sbx',
            patient: [{ referenceNumber: 'ND-1', careContexts: [{ referenceNumber: 'OP-2026-0002' }], hiType: 'OPConsultation', count: 1 }]
        });
        const init = last().body;
        expect(last().path).toBe('/user-initiated-linking/v3/link/care-context/on-init');
        expect(init).toMatchObject({
            transactionId: 'txn-l',
            link: { authenticationType: 'DIRECT', meta: { communicationMedium: 'MOBILE', communicationHint: 'OTP', communicationExpiry: '2026-10-20T10:10:00.000Z' } }
        });
        // The inbox says who is waiting; the code itself is never stored.
        const inbox = (store.getPendingInbox() as any[]).filter((row) => row.kind === 'hip-link-otp');
        expect(inbox.map((row) => [row.kind, JSON.parse(row.payload)])).toEqual([['hip-link-otp', {
            patientName: 'Ravi Kumar', mobile: '+91 98765 43210', abhaAddress: 'ravi@sbx', expiresAt: '2026-10-20T10:10:00.000Z'
        }]]);
        const linkRefNumber = init.link.referenceNumber;
        expect(inbox[0].request_id).toBe(linkRefNumber);
        expect(hip.linkCode(linkRefNumber)).toBe('123456');

        await deliver(HIP_LINK_CONFIRM_PATH, { confirmation: { linkRefNumber, token: '000000' } });
        expect(last().body.error.message).toBe('The code does not match.');
        await deliver(HIP_LINK_CONFIRM_PATH, { confirmation: { linkRefNumber, token: '123456' } });
        expect(last().path).toBe('/user-initiated-linking/v3/link/care-context/on-confirm');
        expect(last().body.patient).toEqual([{
            referenceNumber: 'ND-1', display: 'Ravi Kumar',
            careContexts: [{ referenceNumber: 'OP-2026-0002', display: 'Outpatient visit on 2026-09-01' }],
            hiType: 'OPConsultation', count: 1
        }]);
        expect(store.getHipLinkedRefs('RAVI@sbx')).toEqual(['OP-2026-0002']);
        // The entry leaves the desk inbox, and the code is forgotten, once linking ends.
        expect((store.getPendingInbox() as any[]).filter((row) => row.kind === 'hip-link-otp')).toEqual([]);
        expect(hip.linkCode(linkRefNumber)).toBeNull();
        await deliver(HIP_LINK_CONFIRM_PATH, { confirmation: { linkRefNumber, token: '123456' } });
        expect(last().body.error.message).toBe('Link request not found.');
    });

    it('locks a link after three wrong codes and refuses an expired one', async () => {
        const { deliver, last, store, db, hip } = await setup();
        await deliver(HIP_DISCOVER_PATH, { transactionId: 't', patient: { id: 'ravi@sbx' } });
        const body = { transactionId: 't', abhaAddress: 'ravi@sbx', patient: { referenceNumber: 'uuid-1', careContexts: [{ referenceNumber: 'OP-2026-0001' }] } };
        await deliver(HIP_LINK_INIT_PATH, body);
        const linkRefNumber = last().body.link.referenceNumber;
        for (let i = 0; i < 3; i += 1) await deliver(HIP_LINK_CONFIRM_PATH, { confirmation: { linkRefNumber, token: '999999' } });
        expect(store.getHipLinkRequest(linkRefNumber)).toMatchObject({ attempts: 3, status: 'failed' });
        const otpRows = () => (db.prepare(`SELECT status FROM abdm_inbox WHERE kind = 'hip-link-otp'`).all() as any[]);
        expect(otpRows().map((row) => row.status)).toEqual(['handled']);
        expect(hip.linkCode(linkRefNumber)).toBeNull();
        await deliver(HIP_LINK_CONFIRM_PATH, { confirmation: { linkRefNumber, token: '123456' } });
        expect(last().body.error.message).toBe('Link request not found.');

        await deliver(HIP_LINK_INIT_PATH, body);
        const second = last().body.link.referenceNumber;
        db.prepare('UPDATE abdm_hip_link_requests SET expires_at = ? WHERE link_ref = ?').run(NOW - 1, second);
        await deliver(HIP_LINK_CONFIRM_PATH, { confirmation: { linkRefNumber: second, token: '123456' } });
        expect(last().body.error.message).toContain('expired');
        expect(store.getHipLinkRequest(second).status).toBe('expired');
        expect(otpRows().every((row) => row.status === 'handled')).toBe(true);
        expect(hip.linkCode(second)).toBeNull();
    });

    it('refuses link requests it cannot honour', async () => {
        const { deliver, last, db, store } = await setup();
        await deliver(HIP_DISCOVER_PATH, { transactionId: 'd', patient: { id: 'ravi@sbx' } });
        await deliver(HIP_DISCOVER_PATH, { transactionId: 'old', patient: { id: 'ravi@sbx' } });
        db.prepare('UPDATE abdm_hip_discoveries SET discovered_at = ? WHERE transaction_id = ?').run(NOW - 31 * 60 * 1000, 'old');
        const context = { careContexts: [{ referenceNumber: 'OP-2026-0001' }] };
        const refusals: Array<[unknown, string]> = [
            [{ transactionId: 'd', patient: [{ referenceNumber: 'ND-1' }] }, 'names no health ID'],
            [{ transactionId: 'd', abhaAddress: 'ravi@sbx', patient: [{ referenceNumber: 'ND-1' }, { referenceNumber: 'ND-2' }] }, 'one patient'],
            [{ transactionId: 'd', abhaAddress: 'ravi@sbx', patient: [{ referenceNumber: 'ND-404' }] }, 'Patient reference not found'],
            // Linking must continue a discovery of the same patient under the same health ID.
            [{ abhaAddress: 'ravi@sbx', patient: [{ referenceNumber: 'ND-1', ...context }] }, 'search for your records'],
            [{ transactionId: 'd', abhaAddress: 'other@sbx', patient: [{ referenceNumber: 'ND-1', ...context }] }, 'search for your records'],
            [{ transactionId: 'd', abhaAddress: 'ravi@sbx', patient: [{ referenceNumber: 'ND-2', careContexts: [{ referenceNumber: 'OP-2026-0004' }] }] }, 'search for your records'],
            [{ transactionId: 'old', abhaAddress: 'ravi@sbx', patient: [{ referenceNumber: 'ND-1', ...context }] }, 'search for your records'],
            [{ transactionId: 'd', abhaAddress: 'ravi@sbx', patient: [{ referenceNumber: 'ND-1', careContexts: [{ referenceNumber: 'OP-2026-0004' }] }] }, 'Care context reference not found'],
            [{ transactionId: 'd', abhaAddress: 'ravi@sbx', patient: [{ referenceNumber: 'ND-1', careContexts: [] }] }, 'Care context reference not found']
        ];
        for (const [body, message] of refusals) {
            await deliver(HIP_LINK_INIT_PATH, body);
            expect(last().body.error.message).toContain(message);
        }

        // A code issued before someone else linked the visit cannot complete.
        await deliver(HIP_LINK_INIT_PATH, { transactionId: 'd', abhaAddress: 'ravi@sbx', patient: [{ referenceNumber: 'ND-1', ...context }] });
        const linkRefNumber = last().body.link.referenceNumber;
        store.saveHipLinks('other@sbx', 1, ['OP-2026-0001'], 'clinic');
        await deliver(HIP_LINK_CONFIRM_PATH, { confirmation: { linkRefNumber, token: '123456' } });
        expect(last().body.error.message).toContain('already linked to another health ID');
        await deliver(HIP_LINK_INIT_PATH, { transactionId: 'd', abhaAddress: 'ravi@sbx', patient: [{ referenceNumber: 'ND-1', ...context }] });
        expect(last().body.error.message).toContain('already linked to another health ID');
    });
});

describe('HIP-initiated linking of a visit', () => {
    it('asks for a link token, then links the visit with it', async () => {
        const { hip, deliver, calls, last, store } = await setup();

        expect(await hip.linkVisit(11)).toEqual({ status: 'token-requested' });
        expect(last()).toMatchObject({
            path: '/v3/token/generate-token',
            body: { abhaNumber: '91111122223333', abhaAddress: 'ravi@sbx', name: 'Ravi Kumar', gender: 'M', yearOfBirth: 1990 },
            headers: { 'request-id': 'req-1' }
        });

        await deliver(HIP_ON_GENERATE_TOKEN_PATH, { abhaAddress: 'ravi@sbx', linkToken: 'link-tok', response: { requestId: 'req-1' } });
        expect(last()).toMatchObject({
            path: '/hip/v3/link/carecontext',
            headers: { 'request-id': 'req-2', 'x-link-token': 'link-tok' },
            body: {
                abhaNumber: '91111122223333', abhaAddress: 'ravi@sbx',
                patient: [{ referenceNumber: 'ND-1', careContexts: [{ referenceNumber: 'OP-2026-0002', display: 'Outpatient visit on 2026-09-01' }], hiType: 'OPConsultation', count: 1 }]
            }
        });
        await deliver(HIP_ON_CARE_CONTEXT_PATH, { abhaAddress: 'ravi@sbx', status: 'Successfully Linked care context', response: { requestId: 'req-2' } });
        expect(store.getHipLinkedRefs('ravi@sbx')).toEqual(['OP-2026-0002']);
        expect(store.getHipRequest('req-2').status).toBe('done');

        // The token is reused for the next visit.
        expect(await hip.linkVisit(10)).toEqual({ status: 'linking' });
        expect(last()).toMatchObject({ path: '/hip/v3/link/carecontext', headers: { 'x-link-token': 'link-tok' } });
        expect(calls.filter((call) => call.path === '/v3/token/generate-token')).toHaveLength(1);
    });

    it('drops a refused token and records the reason, and records a refused token request', async () => {
        const { hip, deliver, store } = await setup();
        store.saveHipLinkToken('ravi@sbx', 'old', NOW + 1000);
        await hip.linkVisit(11);
        await deliver(HIP_ON_CARE_CONTEXT_PATH, { error: { code: 'ABDM-1017', message: 'Invalid link token' }, response: { requestId: 'req-1' } });
        expect(store.getHipLinkToken('ravi@sbx', NOW)).toBeNull();
        expect(store.getHipRequest('req-1')).toMatchObject({ status: 'failed', error: 'Invalid link token' });

        await hip.linkVisit(11);
        await deliver(HIP_ON_GENERATE_TOKEN_PATH, { error: { code: 900 }, response: { requestId: 'req-2' } });
        expect(store.getHipRequest('req-2')).toMatchObject({ status: 'failed', error: 'Error 900' });
    });

    it('refuses visits it cannot link and callbacks it never asked for', async () => {
        const { hip, deliver, store } = await setup();
        await expect(hip.linkVisit(999)).rejects.toThrow('Visit not found');
        await expect(hip.linkVisit(12)).rejects.toThrow('finished visit');
        await expect(hip.linkVisit(13)).rejects.toThrow('health ID first');
        // A visit links to one health ID only.
        store.saveHipLinks('old@sbx', 1, ['OP-2026-0001'], 'clinic');
        await expect(hip.linkVisit(10)).rejects.toThrow('already linked to another health ID');
        expect(() => store.saveHipLinks('ravi@sbx', 1, ['OP-2026-0001'], 'patient')).toThrow('already linked to another health ID');
        store.saveHipLinkToken('Ravi@SBX', 'tok-1', NOW + 1000);
        store.saveHipLinkToken('ravi@sbx', 'tok-2', NOW + 1000);
        expect(store.getHipLinkToken('RAVI@sbx', NOW)).toBe('tok-2');
        store.clearHipLinkToken('ravi@sbx');
        const mock = await setup({ mock: true });
        await expect(mock.hip.linkVisit(11)).rejects.toThrow('paired');

        await deliver(HIP_ON_GENERATE_TOKEN_PATH, { linkToken: 'x', response: { requestId: 'nope' } });
        await deliver(HIP_ON_CARE_CONTEXT_PATH, { response: { requestId: 'nope' } });
        expect(store.getHipLinkToken('ravi@sbx', NOW)).toBeNull();
        expect(hip.applyCallback('/api/v3/hiu/elsewhere', {}, null)).toBeNull();
    });
});

describe('HIP consent and data transfer', () => {
    it('keeps a granted consent, acknowledges it, and follows a revocation', async () => {
        const { deliver, last, store } = await setup();
        const requestId = await deliver(HIP_CONSENT_NOTIFY_PATH, granted());
        expect(last()).toMatchObject({
            path: '/consent/v3/request/hip/on-notify',
            body: { acknowledgement: { status: 'ok', consentId: 'hip-consent-1' }, response: { requestId } }
        });
        expect(store.getHipConsent('hip-consent-1')).toMatchObject({
            status: 'GRANTED', abha_address: 'ravi@sbx', date_from: '2026-01-01T00:00:00Z', data_erase_at: '2026-12-01T00:00:00Z'
        });
        // A later grant for the same consent replaces its scope; a revocation keeps it.
        await deliver(HIP_CONSENT_NOTIFY_PATH, granted({
            hiTypes: ['Prescription'],
            careContexts: [{ patientReference: 'ND-1', careContextReference: 'OP-2026-0002' }],
            permission: { dateRange: { from: '2026-06-01T00:00:00Z', to: '2026-12-31T00:00:00Z' }, dataEraseAt: '2026-11-01T00:00:00Z' }
        }));
        expect(store.getHipConsent('hip-consent-1')).toMatchObject({
            hi_types: '["Prescription"]', care_context_refs: '["OP-2026-0002"]', date_from: '2026-06-01T00:00:00Z', data_erase_at: '2026-11-01T00:00:00Z'
        });
        await deliver(HIP_CONSENT_NOTIFY_PATH, { notification: { status: 'REVOKED', consentId: 'hip-consent-1' } });
        expect(store.getHipConsent('hip-consent-1')).toMatchObject({
            status: 'REVOKED', abha_address: 'ravi@sbx', care_context_refs: '["OP-2026-0002"]', date_from: '2026-06-01T00:00:00Z'
        });
    });

    it('sends each visit as its own encrypted page to the HIU and reports the transfer', async () => {
        const { deliver, calls, pushes, fetchFn } = await setup();
        await deliver(HIP_CONSENT_NOTIFY_PATH, granted());
        const hiu = new FideliusService().generateKeyMaterial();

        const requestId = await deliver(HIP_HI_REQUEST_PATH, {
            transactionId: 'txn-9',
            hiRequest: { consent: { id: 'hip-consent-1' }, dateRange: { from: '2025-01-01T00:00:00Z', to: '2026-10-20T00:00:00Z' }, dataPushUrl: PUSH_URL, keyMaterial: hiu.keyMaterial }
        });

        const onRequest = calls.find((call) => call.path === '/data-flow/v3/health-information/hip/on-request')!;
        expect(onRequest.body).toEqual({ hiRequest: { transactionId: 'txn-9', sessionStatus: 'ACKNOWLEDGED' }, response: { requestId } });
        expect(fetchFn).toHaveBeenCalledTimes(2);
        expect((fetchFn.mock.calls[0] as any[])[0]).toBe(PUSH_URL);
        expect(pushes.map((page) => [page.pageNumber, page.pageCount, page.transactionId, page.entries[0].careContextReference]))
            .toEqual([[1, 2, 'txn-9', 'OP-2026-0001'], [2, 2, 'txn-9', 'OP-2026-0002']]);
        expect(pushes[0].keyMaterial.dhPublicKey.keyValue).not.toBe(pushes[1].keyMaterial.dhPublicKey.keyValue);
        const bundle: any = new FideliusService().decryptEnvelope(
            { keyMaterial: pushes[1].keyMaterial, encryptedData: pushes[1].entries[0].content, keyId: '' }, hiu.privateKeyPem, hiu.keyMaterial.nonce);
        expect(bundle.resourceType).toBe('Bundle');
        expect(JSON.stringify(bundle)).toContain('Paracetamol 500mg');
        expect(pushes[1].entries[0]).toMatchObject({ media: 'application/fhir+json', checksum: expect.stringMatching(/^[0-9a-f]{32}$/) });

        const notify = calls.at(-1)!;
        expect(notify.path).toBe('/data-flow/v3/health-information/notify');
        expect(notify.body.notification).toMatchObject({
            consentId: 'hip-consent-1', transactionId: 'txn-9', doneAt: '2026-10-20T10:00:00.000Z', notifier: { type: 'HIP', id: 'IN3310000001' },
            statusNotification: { sessionStatus: 'TRANSFERRED', hipId: 'IN3310000001', statusResponses: [
                { careContextReference: 'OP-2026-0001', hiStatus: 'DELIVERED' }, { careContextReference: 'OP-2026-0002', hiStatus: 'DELIVERED' }
            ] }
        });
    });

    it('sends only visits inside the requested dates, and reports a failed delivery', async () => {
        const { deliver, calls, pushes } = await setup({ pushOk: false });
        await deliver(HIP_CONSENT_NOTIFY_PATH, granted());
        const hiu = new FideliusService().generateKeyMaterial();
        await deliver(HIP_HI_REQUEST_PATH, {
            transactionId: 'txn-2',
            hiRequest: { consent: { id: 'hip-consent-1' }, dateRange: { from: '2026-06-01T00:00:00Z', to: '2027-06-01T00:00:00Z' }, dataPushUrl: PUSH_URL, keyMaterial: hiu.keyMaterial }
        });
        expect(pushes.map((page) => page.entries[0].careContextReference)).toEqual(['OP-2026-0002']);
        expect(calls.at(-1)!.body.notification.statusNotification).toMatchObject({
            sessionStatus: 'FAILED', statusResponses: [{ careContextReference: 'OP-2026-0002', hiStatus: 'ERRORED' }]
        });
    });

    it('sends nothing for record types it does not keep', async () => {
        const { deliver, calls, fetchFn } = await setup();
        await deliver(HIP_CONSENT_NOTIFY_PATH, granted({ hiTypes: ['DiagnosticReport'] }));
        await deliver(HIP_HI_REQUEST_PATH, {
            transactionId: 'txn-3',
            hiRequest: { consent: { id: 'hip-consent-1' }, dataPushUrl: PUSH_URL, keyMaterial: new FideliusService().generateKeyMaterial().keyMaterial }
        });
        expect(fetchFn).not.toHaveBeenCalled();
        expect(calls.at(-1)!.body.notification.statusNotification).toMatchObject({ sessionStatus: 'TRANSFERRED', statusResponses: [] });
    });

    it('never pushes to a host that resolves to a private address, and refuses redirects', async () => {
        const { deliver, calls, fetchFn } = await setup({ pushHost: ['93.184.216.34', '10.0.0.7'] });
        await deliver(HIP_CONSENT_NOTIFY_PATH, granted());
        await deliver(HIP_HI_REQUEST_PATH, {
            transactionId: 'txn-p',
            hiRequest: { consent: { id: 'hip-consent-1' }, dataPushUrl: PUSH_URL, keyMaterial: new FideliusService().generateKeyMaterial().keyMaterial }
        });
        expect(fetchFn).not.toHaveBeenCalled();
        expect(calls.at(-1)!.body.notification.statusNotification).toMatchObject({
            sessionStatus: 'FAILED', statusResponses: [{ hiStatus: 'ERRORED' }, { hiStatus: 'ERRORED' }]
        });

        for (const address of ['127.0.0.1', '::1', '::ffff:192.168.1.1', 'fd00::1', '169.254.169.254', 'not-an-ip']) {
            const blocked = await setup({ pushHost: [address] });
            await blocked.deliver(HIP_CONSENT_NOTIFY_PATH, granted());
            await blocked.deliver(HIP_HI_REQUEST_PATH, {
                transactionId: 'txn-q',
                hiRequest: { consent: { id: 'hip-consent-1' }, dataPushUrl: PUSH_URL, keyMaterial: new FideliusService().generateKeyMaterial().keyMaterial }
            });
            expect(blocked.fetchFn).not.toHaveBeenCalled();
        }

        const open = await setup({ pushHost: ['2606:2800:220:1::1'] });
        await open.deliver(HIP_CONSENT_NOTIFY_PATH, granted());
        await open.deliver(HIP_HI_REQUEST_PATH, {
            transactionId: 'txn-r',
            hiRequest: { consent: { id: 'hip-consent-1' }, dataPushUrl: PUSH_URL, keyMaterial: new FideliusService().generateKeyMaterial().keyMaterial }
        });
        expect(open.fetchFn).toHaveBeenCalledTimes(2);
        expect((open.fetchFn.mock.calls[0] as any[])[1]).toMatchObject({ redirect: 'error' });
    });

    it('connects only to the public address it checked, and never to a private one', async () => {
        const resolveTo = (address: string, family = 4) => publicLookup((_host, callback) => callback(null, [{ address, family }]));
        const answer = (lookup: ReturnType<typeof publicLookup>, all = false) => new Promise<any[]>((done) =>
            lookup('hiu.example.in', { all }, (error, address, family) => done([error?.message ?? null, address, family])));
        expect(await answer(resolveTo('93.184.216.34'))).toEqual([null, '93.184.216.34', 4]);
        expect(await answer(resolveTo('2606:2800:220:1::1', 6), true)).toEqual([null, [{ address: '2606:2800:220:1::1', family: 6 }], undefined]);
        expect((await answer(resolveTo('127.0.0.1')))[0]).toContain('does not resolve to a public address');
        expect((await answer(publicLookup((_host, callback) => callback(null, []))))[0]).toContain('public address');
        const failing = publicLookup((_host, callback) => callback(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }), []));
        expect((await answer(failing))[0]).toBe('ENOTFOUND');
        // A real request to a host that resolves privately never connects.
        expect(await pinnedPost('https://localhost:9/push', '{}', 2000)).toBe(false);
        expect(await pinnedPost('https://hiu.example.in/push', '{}', 2000, resolveTo('10.0.0.7'))).toBe(false);
    });

    it('refuses a records request it cannot honour, with the reason', async () => {
        const { deliver, calls, fetchFn } = await setup();
        await deliver(HIP_CONSENT_NOTIFY_PATH, granted());
        await deliver(HIP_CONSENT_NOTIFY_PATH, granted({ consentId: 'old' }));
        await deliver(HIP_CONSENT_NOTIFY_PATH, { notification: { status: 'GRANTED', consentId: 'old', consentDetail: { ...granted().notification.consentDetail, consentId: 'old' } } });
        await deliver(HIP_CONSENT_NOTIFY_PATH, { notification: { status: 'GRANTED', consentId: 'erased', consentDetail: { ...granted().notification.consentDetail, permission: { dataEraseAt: '2026-01-01T00:00:00Z' } } } });
        await deliver(HIP_CONSENT_NOTIFY_PATH, { notification: { status: 'EXPIRED', consentId: 'expired' } });
        const key = new FideliusService().generateKeyMaterial().keyMaterial;
        const cases: Array<[Record<string, unknown>, string]> = [
            [{ consent: { id: 'missing' }, dataPushUrl: PUSH_URL, keyMaterial: key }, 'Consent not found'],
            [{ consent: { id: 'expired' }, dataPushUrl: PUSH_URL, keyMaterial: key }, 'not active'],
            [{ consent: { id: 'erased' }, dataPushUrl: PUSH_URL, keyMaterial: key }, 'has expired'],
            [{ consent: { id: 'hip-consent-1' }, dataPushUrl: 'http://hiu.example.in/push', keyMaterial: key }, 'HTTPS address'],
            [{ consent: { id: 'hip-consent-1' }, dataPushUrl: 'https://10.0.0.5/push', keyMaterial: key }, 'HTTPS address'],
            [{ consent: { id: 'hip-consent-1' }, dataPushUrl: 'https://localhost/push', keyMaterial: key }, 'HTTPS address'],
            [{ consent: { id: 'hip-consent-1' }, dataPushUrl: 'not a url', keyMaterial: key }, 'not valid'],
            [{ consent: { id: 'hip-consent-1' }, dataPushUrl: PUSH_URL, keyMaterial: { nonce: 'x' } }, 'Invalid request'],
            [{ consent: { id: 'hip-consent-1' }, dateRange: { from: '2027-01-01T00:00:00Z', to: '2027-02-01T00:00:00Z' }, dataPushUrl: PUSH_URL, keyMaterial: key }, 'outside the consent']
        ];
        for (const [hiRequest, message] of cases) {
            await deliver(HIP_HI_REQUEST_PATH, { transactionId: 'txn-x', hiRequest });
            const answer = calls.at(-1)!;
            expect(answer.path).toBe('/data-flow/v3/health-information/hip/on-request');
            expect(answer.body.hiRequest).toEqual({ transactionId: 'txn-x', sessionStatus: 'ERROR' });
            expect(answer.body.error.message).toContain(message);
        }
        expect(fetchFn).not.toHaveBeenCalled();
    });

    it('fails a consent notification that names no consent', async () => {
        const { store, hip } = await setup();
        expect(() => hip.applyCallback(HIP_CONSENT_NOTIFY_PATH, { notification: { status: 'GRANTED' } }, 'r')).toThrow('names no consent');
        expect(store.getHipConsent('')).toBeNull();
    });
});
