import { describe, expect, it } from 'vitest';
import { CLINIC_ID, clinicKeys, harness, newRef, NOW, TOMORROW } from './helpers.js';
import { open } from './sealReference.js';
import { POLICY } from '../src/app.js';

describe('POST /api/book', () => {
    it('holds the slot, stores only the sealed request, rings the doorbell and returns the reference', async () => {
        const h = await harness();
        const ref = newRef();
        const res = await h.book({ ref });
        expect(res.status).toBe(201);
        expect(res.headers.get('cache-control')).toBe('no-store');
        expect(await res.json()).toEqual({ ref, status: 'Requested' });

        const slot = await h.slots.get(CLINIC_ID, `${TOMORROW}T10:00`);
        expect(slot).toMatchObject({ state: 'held', ref, heldUntil: NOW + POLICY.requestTtlMs });
        expect(h.rings).toEqual([CLINIC_ID]);
        expect(h.mailbox).toHaveLength(1);
        expect(h.mailbox[0]!.type).toBe('booking-request');

        // Only the clinic's private key opens it, and only for this clinic.
        const plain = JSON.parse(open(h.mailbox[0]!.sealed, h.clinic.privateKey, CLINIC_ID, 'booking-request').toString());
        expect(plain).toMatchObject({ ref, name: 'Asha', phone: '9876543210' });
        expect(() => open(h.mailbox[0]!.sealed, h.clinic.privateKey, 'clinic-2', 'booking-request')).toThrow();

        // Nothing the API keeps carries the phone number or its browser digest.
        const stored = JSON.stringify([...h.bookings.rows.values(), ...h.slots.rows.values()]);
        expect(stored).not.toContain('9876543210');
        expect(stored).not.toContain('Asha');
        expect(JSON.stringify(h.logs)).not.toContain(ref);
    });

    it('lets exactly one of two concurrent bookings for a slot win', async () => {
        const h = await harness();
        const results = await Promise.all([h.book({ phone: '9000000001' }), h.book({ phone: '9000000002' })]);
        expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
        const loser = results.find((r) => r.status === 409)!;
        expect(await loser.json()).toEqual({ error: 'slot_taken' });
        expect(h.mailbox).toHaveLength(1);
        expect(h.bookings.rows.size).toBe(1);
    });

    it('accepts a general callback request with no slot', async () => {
        const h = await harness();
        const res = await h.book({ slotId: null });
        expect(res.status).toBe(201);
        expect(h.mailbox).toHaveLength(1);
    });

    it('allows at most 2 open requests per phone per clinic', async () => {
        const h = await harness();
        expect((await h.book({ slotId: null })).status).toBe(201);
        expect((await h.book({ slotId: null })).status).toBe(201);
        const third = await h.book({ slotId: null });
        expect(third.status).toBe(429);
        expect(await third.json()).toEqual({ error: 'too_many_open_requests' });
        expect((await h.book({ slotId: null, phone: '9123456780' })).status).toBe(201);
        // Requests expire after 48 hours and stop counting.
        h.setNow(NOW + POLICY.requestTtlMs + 1);
        expect((await h.book({ slotId: null })).status).toBe(201);
    });

    it('lets a lapsed hold be taken again', async () => {
        const h = await harness();
        expect((await h.book({ phone: '9000000001' })).status).toBe(201);
        h.setNow(NOW + POLICY.requestTtlMs + 1);
        expect((await h.book({ phone: '9000000002' })).status).toBe(201);
    });

    it('refuses malformed input without touching the slot', async () => {
        const h = await harness();
        const cases = [
            { ref: 'short' },
            { ref: 'ILOU00000000' },
            { sealed: 'not-base64!' },
            { sealed: Buffer.from(JSON.stringify({ v: 1, epk: 'AA==', salt: 'AA==', iv: 'AA==', ct: 'AA==', tag: 'AA==' })).toString('base64') },
            { sealed: Buffer.from(JSON.stringify({ name: 'Asha', phone: '9876543210' })).toString('base64') },
            { clinicId: 'bad id' }
        ];
        for (const input of cases) expect((await h.book(input)).status).toBe(400);
        const plainPhone = await h.app.request('/api/book', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ clinicId: CLINIC_ID, ref: newRef(), slotId: null, phoneDigest: '9876543210', sealed: h.sealFor({}) })
        });
        expect(plainPhone.status).toBe(400);
        expect((await h.slots.get(CLINIC_ID, `${TOMORROW}T10:00`))!.state).toBe('available');
        expect(h.mailbox).toHaveLength(0);
    });

    it('refuses unknown clinics and slots, and oversize bodies', async () => {
        const h = await harness();
        expect((await h.book({ clinicId: 'clinic-9' })).status).toBe(404);
        expect((await h.book({ slotId: '2026-10-21T10:00' })).status).toBe(404);
        const big = await h.app.request('/api/book', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ pad: 'x'.repeat(20_000) })
        });
        expect(big.status).toBe(413);
    });

    it('answers ref_taken on a reference collision and releases the hold', async () => {
        const h = await harness();
        const ref = newRef();
        expect((await h.book({ ref, slotId: null })).status).toBe(201);
        const again = await h.book({ ref, phone: '9000000009' });
        expect(again.status).toBe(409);
        expect(await again.json()).toEqual({ error: 'ref_taken' });
        expect((await h.slots.get(CLINIC_ID, `${TOMORROW}T10:00`))!.state).toBe('available');
    });

    it('rolls back the hold and the record when the mailbox is down', async () => {
        const h = await harness();
        h.failMailbox();
        const res = await h.book();
        expect(res.status).toBe(503);
        expect(h.bookings.rows.size).toBe(0);
        expect((await h.slots.get(CLINIC_ID, `${TOMORROW}T10:00`))!.state).toBe('available');
        expect(h.rings).toEqual([]);
    });

    it('answers with the current key when the request was sealed to an older one, before holding anything', async () => {
        const h = await harness();
        const older = clinicKeys().publicRaw;
        const res = await h.book({ sealedTo: older });
        expect(res.status).toBe(409);
        expect(await res.json()).toEqual({ error: 'clinic_key_changed', sealingPublicKey: h.clinic.publicRaw });
        expect((await h.slots.get(CLINIC_ID, `${TOMORROW}T10:00`))!.state).toBe('available');
        expect(h.mailbox).toHaveLength(0);
        expect((await h.book({ sealedTo: 'AAAA' })).status).toBe(400);
    });

    it('refuses a booking while the listing\'s computer is replaced and not yet listed again', async () => {
        const h = await harness();
        h.revoke('dev-1');
        const res = await h.book();
        expect(res.status).toBe(503);
        expect(await res.json()).toEqual({ error: 'clinic_unavailable' });
        expect(h.mailbox).toHaveLength(0);
        expect(h.bookings.rows.size).toBe(0);
        expect((await h.slots.get(CLINIC_ID, `${TOMORROW}T10:00`))!.state).toBe('available');

        // The replacement lists the clinic again with its own key and device.
        const next = clinicKeys();
        h.setAuth({ ok: true, deviceId: 'dev-2', clinicId: CLINIC_ID, hipId: 'IN2710000123' });
        await h.clinicCall('PUT', '/api/clinic/listing', { name: 'Arogya Clinic', city: 'Chennai', sealingPublicKey: next.publicRaw });
        expect((await h.book()).status).toBe(409);
        expect((await h.book({ sealedTo: next.publicRaw })).status).toBe(201);
    });

    it('takes the request back when the computer is replaced while it is stored', async () => {
        const h = await harness();
        h.revokeAfterPut('dev-1');
        const res = await h.book();
        expect(res.status).toBe(503);
        expect(await res.json()).toEqual({ error: 'clinic_unavailable' });
        expect(h.removed).toEqual(['item-1']);
        expect(h.bookings.rows.size).toBe(0);
        expect((await h.slots.get(CLINIC_ID, `${TOMORROW}T10:00`))!.state).toBe('available');
        expect(h.rings).toEqual([]);
    });

    it('still answers 201 when the doorbell fails', async () => {
        const h = await harness({ doorbell: { ring: async () => { throw new Error('iot down'); } } });
        expect((await h.book()).status).toBe(201);
    });
});

describe('GET /api/booking/:ref', () => {
    it('shows only the status and clinic name, then forgets the request after 48 hours', async () => {
        const h = await harness();
        const ref = newRef();
        await h.book({ ref });
        const res = await h.app.request(`/api/booking/${ref.toLowerCase()}`);
        expect(res.status).toBe(200);
        expect(res.headers.get('cache-control')).toBe('no-store');
        expect(await res.json()).toEqual({ ref, status: 'Requested', clinicName: 'Arogya Clinic' });
        h.setNow(NOW + POLICY.requestTtlMs);
        expect((await h.app.request(`/api/booking/${ref}`)).status).toBe(404);
        expect((await h.app.request('/api/booking/nope')).status).toBe(404);
    });
});
