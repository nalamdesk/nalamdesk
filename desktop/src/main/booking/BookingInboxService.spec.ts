import * as crypto from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { BookingInboxService, BookingError, openSealed, parseBookingPayload, type CloudResponse, type MailboxEntry } from './BookingInboxService';

vi.mock('electron-log', () => ({ default: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const CLINIC = 'clinic-1';
const REF = '7K3P9QXA2B4M';

// Same format as the browser sealer (cloud/booking/web/src/lib/seal.ts).
function seal(plaintext: Buffer, recipientRaw: string, clinicId: string, type: string): string {
    const peer = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), Buffer.from(recipientRaw, 'base64')]), format: 'der', type: 'spki' });
    const eph = crypto.generateKeyPairSync('x25519');
    const shared = crypto.diffieHellman({ publicKey: peer, privateKey: eph.privateKey });
    const salt = crypto.randomBytes(16);
    const key = Buffer.from(crypto.hkdfSync('sha256', shared, salt, Buffer.from('nalamdesk-mailbox-v1'), 32));
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(`nalamdesk-mailbox-v1|${clinicId}|${type}`));
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.from(JSON.stringify({
        v: 1,
        epk: eph.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64'),
        salt: salt.toString('base64'), iv: iv.toString('base64'), ct: ct.toString('base64'), tag: cipher.getAuthTag().toString('base64')
    })).toString('base64');
}

function setup() {
    const pair = crypto.generateKeyPairSync('x25519');
    const publicRaw = pair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
    const inbox: MailboxEntry[] = [];
    const acked: string[] = [];
    const sent: { method: string; path: string; body?: unknown }[] = [];
    let respond: (method: string, path: string) => CloudResponse = () => ({ status: 200, body: {} });
    const saved: any[] = [];
    const statuses: Record<string, string> = {};
    const accepted: { id: string; date: string; time: string }[] = [];
    let saveFails = false;
    const service = new BookingInboxService({
        transport: {
            send: async (method, path, body) => {
                sent.push({ method, path, body });
                return respond(method, path);
            },
            fetchInbox: async () => inbox.filter((i) => !acked.includes(i.id)),
            ack: async (ids) => { acked.push(...ids); }
        },
        key: { clinicId: () => CLINIC, publicKeyRaw: () => publicRaw, privateKey: () => pair.privateKey },
        store: {
            saveAppointmentRequest: (req) => {
                if (saveFails) throw new Error('disk full');
                saved.push(req);
            },
            updateAppointmentRequestStatus: (id, status) => { statuses[id] = status; },
            acceptAppointmentRequest: (id, slot) => { accepted.push({ id, ...slot }); statuses[id] = 'accepted'; }
        }
    });
    const booking = (overrides: Record<string, unknown> = {}, clinicId = CLINIC) => seal(Buffer.from(JSON.stringify({
        v: 1, ref: REF, clinicId: CLINIC, slotId: '2026-10-20T10:00', slot: { date: '2026-10-20', time: '10:00' },
        name: 'Asha  Raman', phone: '9876543210', reason: 'Fever', sentAt: '2026-10-19T06:00:00Z', ...overrides
    })), publicRaw, clinicId, 'booking-request');
    return {
        service, inbox, acked, sent, saved, statuses, accepted, booking, publicRaw, pair,
        respond: (fn: typeof respond) => { respond = fn; },
        failSaves: () => { saveFails = true; }
    };
}

describe('BookingInboxService', () => {
    it('opens booking requests, saves them under their reference and acknowledges them', async () => {
        const h = setup();
        h.inbox.push({ id: 'm1', type: 'booking-request', sealed: h.booking() });
        h.inbox.push({ id: 'm2', type: 'abdm-callback', sealed: 'not-ours' });
        expect(await h.service.sync()).toBe(1);
        expect(h.saved).toEqual([{ id: REF, patient_name: 'Asha Raman', phone: '9876543210', date: '2026-10-20', time: '10:00', reason: 'Fever' }]);
        // ABDM items are left for their own reader.
        expect(h.acked).toEqual(['m1']);
    });

    it('saves call-back requests with no slot', async () => {
        const h = setup();
        h.inbox.push({ id: 'm1', type: 'booking-request', sealed: h.booking({ slotId: null, slot: null }) });
        await h.service.sync();
        expect(h.saved[0]).toMatchObject({ id: REF, date: null, time: null });
    });

    it('drops items that can never be opened or are for another clinic', async () => {
        const h = setup();
        h.inbox.push({ id: 'm1', type: 'booking-request', sealed: h.booking({}, 'clinic-2') });
        h.inbox.push({ id: 'm2', type: 'booking-request', sealed: h.booking({ clinicId: 'clinic-2' }) });
        h.inbox.push({ id: 'm3', type: 'booking-request', sealed: 'garbage' });
        expect(await h.service.sync()).toBe(0);
        expect(h.saved).toEqual([]);
        expect(h.acked.sort()).toEqual(['m1', 'm2', 'm3']);
    });

    it('keeps an item in the mailbox when saving fails, so the next fetch retries', async () => {
        const h = setup();
        h.failSaves();
        h.inbox.push({ id: 'm1', type: 'booking-request', sealed: h.booking() });
        expect(await h.service.sync()).toBe(0);
        expect(h.acked).toEqual([]);
    });

    it('folds a doorbell that rings mid-fetch into one more pass', async () => {
        const h = setup();
        h.inbox.push({ id: 'm1', type: 'booking-request', sealed: h.booking() });
        const first = h.service.sync();
        h.inbox.push({ id: 'm2', type: 'booking-request', sealed: h.booking({ ref: 'ABCDEFGHJKMN' }) });
        h.service.onDoorbell();
        expect(await first).toBe(2);
    });

    it('lists the clinic with its sealing key and publishes slots', async () => {
        const h = setup();
        await h.service.enableListing({ name: 'Arogya', city: 'Chennai' });
        expect(h.sent[0]).toEqual({ method: 'PUT', path: '/api/clinic/listing', body: { name: 'Arogya', city: 'Chennai', specialty: undefined, sealingPublicKey: h.publicRaw } });
        h.respond(() => ({ status: 200, body: { published: 2 } }));
        expect(await h.service.publishSlots(['2026-10-20'], [{ date: '2026-10-20', time: '10:00' }, { date: '2026-10-20', time: '10:30' }])).toBe(2);
        h.respond(() => ({ status: 401, body: { error: 'bad_signature' } }));
        await expect(h.service.disableListing()).rejects.toMatchObject({ code: 'bad_signature' });
    });

    it('reports a decision to the cloud before recording it locally', async () => {
        const h = setup();
        h.respond(() => ({ status: 200, body: { ref: REF, status: 'Accepted' } }));
        await h.service.decide(REF, 'accepted');
        expect(h.sent[0]).toEqual({ method: 'POST', path: `/api/clinic/bookings/${REF}/decision`, body: { decision: 'accepted' } });
        expect(h.statuses[REF]).toBe('accepted');
        await h.service.decide(REF, 'declined');
        expect(h.statuses[REF]).toBe('rejected');
    });

    it('books the appointment with an acceptance, and once more when only the cloud saw it', async () => {
        const h = setup();
        h.respond(() => ({ status: 200, body: { ref: REF, status: 'Accepted' } }));
        await h.service.decide(REF, 'accepted', { date: '2026-10-20', time: '10:00' });
        expect(h.accepted).toEqual([{ id: REF, date: '2026-10-20', time: '10:00' }]);

        // A crash after the cloud accepted: the retry finds it already accepted
        // there and still books it here (the store ignores a repeat).
        h.respond(() => ({ status: 409, body: { error: 'already_decided', status: 'Accepted' } }));
        await h.service.decide(REF, 'accepted', { date: '2026-10-20', time: '10:00' });
        expect(h.accepted).toHaveLength(2);
        expect(h.statuses[REF]).toBe('accepted');
    });

    it('does not record a decision the cloud refused', async () => {
        const h = setup();
        h.respond(() => ({ status: 409, body: { error: 'slot_lost' } }));
        await expect(h.service.decide(REF, 'accepted')).rejects.toMatchObject({ code: 'slot_lost' });
        h.respond(() => ({ status: 404, body: { error: 'unknown_ref' } }));
        await expect(h.service.decide(REF, 'accepted', { date: '2026-10-20', time: '10:00' })).rejects.toMatchObject({ code: 'expired' });
        expect(h.statuses).toEqual({});
        expect(h.accepted).toEqual([]);
        await expect(h.service.decide('not-a-ref', 'accepted')).rejects.toBeInstanceOf(BookingError);
    });

    it('syncs the local status when the request was already decided elsewhere', async () => {
        const h = setup();
        h.respond(() => ({ status: 409, body: { error: 'already_decided', status: 'Declined' } }));
        await expect(h.service.decide(REF, 'accepted')).rejects.toMatchObject({ code: 'already_decided' });
        expect(h.statuses[REF]).toBe('rejected');
    });
});

describe('payload checks', () => {
    it('rejects a slot that does not match its ID, or a bad phone', () => {
        const pair = crypto.generateKeyPairSync('x25519');
        const base = { v: 1, ref: REF, clinicId: CLINIC, name: 'A', phone: '9876543210' };
        expect(() => parseBookingPayload(Buffer.from(JSON.stringify({ ...base, slotId: '2026-10-21T10:00', slot: { date: '2026-10-20', time: '10:00' } })), CLINIC)).toThrow('bad_slot');
        expect(() => parseBookingPayload(Buffer.from(JSON.stringify({ ...base, phone: '123' })), CLINIC)).toThrow('bad_contact');
        expect(() => openSealed(Buffer.from('{"v":2}').toString('base64'), pair.privateKey, CLINIC, 'booking-request')).toThrow('Unsupported');
    });
});
