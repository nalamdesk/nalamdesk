import { describe, expect, it } from 'vitest';
import { CLINIC_ID, harness, newRef, NOW, TODAY, TOMORROW } from './helpers.js';

describe('signed clinic routes', () => {
    it('refuses unsigned or rejected device calls with the authenticator code', async () => {
        const h = await harness();
        h.setAuth({ ok: false, status: 401, code: 'clock_skew', serverTimeMs: NOW });
        const res = await h.clinicCall('DELETE', '/api/clinic/listing');
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: 'clock_skew', serverTime: NOW });
        expect((await h.clinics.get(CLINIC_ID))!.listed).toBe(true);
    });

    it('lists and unlists the clinic of the signing device only', async () => {
        const h = await harness();
        h.setAuth({ ok: true, deviceId: 'dev-2', clinicId: 'clinic-2', hipId: 'IN2' });
        const res = await h.clinicCall('PUT', '/api/clinic/listing', { name: '  Zen   Clinic ', city: 'Madurai', sealingPublicKey: h.clinic.publicRaw });
        expect(res.status).toBe(200);
        expect(await h.clinics.get('clinic-2')).toMatchObject({ name: 'Zen Clinic', city: 'Madurai', specialty: 'General Practice', listed: true, deviceId: 'dev-2' });
        expect((await h.clinicCall('DELETE', '/api/clinic/listing')).status).toBe(200);
        expect((await h.clinics.get('clinic-2'))!.listed).toBe(false);
        expect((await h.clinics.get(CLINIC_ID))!.listed).toBe(true);
    });

    it('refuses a listing without a valid sealing key or name', async () => {
        const h = await harness();
        expect((await h.clinicCall('PUT', '/api/clinic/listing', { name: 'A', city: 'B', sealingPublicKey: 'AAAA' })).status).toBe(400);
        expect((await h.clinicCall('PUT', '/api/clinic/listing', { name: '', city: 'B', sealingPublicKey: h.clinic.publicRaw })).status).toBe(400);
    });

    it('republishes slots without dropping held or booked ones', async () => {
        const h = await harness();
        const ref = newRef();
        await h.book({ ref });
        const res = await h.clinicCall('PUT', '/api/clinic/slots', {
            dates: [TOMORROW],
            slots: [{ date: TOMORROW, time: '11:00' }, { date: TOMORROW, time: '11:00' }]
        });
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ published: 1 });
        const list = await (await h.clinicCall('GET', `/api/clinic/slots?from=${TOMORROW}&to=${TOMORROW}`)).json();
        expect(list.slots.map((s: { slotId: string; state: string }) => `${s.slotId}:${s.state}`).sort())
            .toEqual(['2026-10-20T10:00:held', '2026-10-20T11:00:available']);
        // Today's slots were not in `dates`, so they stay.
        expect(await h.slots.get(CLINIC_ID, `${TODAY}T10:00`)).not.toBeNull();
    });

    it('refuses slots outside the next 14 days or not on a listed date', async () => {
        const h = await harness();
        const bad = [
            { dates: ['2026-10-18'], slots: [] },
            { dates: ['2026-11-05'], slots: [] },
            { dates: [TOMORROW], slots: [{ date: TODAY, time: '10:00' }] },
            { dates: [TOMORROW], slots: [{ date: TOMORROW, time: '25:00' }] },
            { dates: ['2026-02-30'], slots: [] }
        ];
        for (const body of bad) expect((await h.clinicCall('PUT', '/api/clinic/slots', body)).status).toBe(400);
    });

    it('accept books the slot and the patient sees Accepted', async () => {
        const h = await harness();
        const ref = newRef();
        await h.book({ ref });
        const res = await h.clinicCall('POST', `/api/clinic/bookings/${ref}/decision`, { decision: 'accepted' });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ref, status: 'Accepted' });
        expect((await h.slots.get(CLINIC_ID, `${TOMORROW}T10:00`))!.state).toBe('booked');
        expect((await (await h.app.request(`/api/booking/${ref}`)).json()).status).toBe('Accepted');
        expect(h.bookings.rows.get(ref)!.phoneKey).toBeUndefined();
        // A retry is answered the same; a change of mind is refused.
        expect((await h.clinicCall('POST', `/api/clinic/bookings/${ref}/decision`, { decision: 'accepted' })).status).toBe(200);
        expect((await h.clinicCall('POST', `/api/clinic/bookings/${ref}/decision`, { decision: 'declined' })).status).toBe(409);
    });

    it('decline releases the slot for the next patient', async () => {
        const h = await harness();
        const ref = newRef();
        await h.book({ ref });
        expect((await h.clinicCall('POST', `/api/clinic/bookings/${ref}/decision`, { decision: 'declined' })).status).toBe(200);
        expect((await h.slots.get(CLINIC_ID, `${TOMORROW}T10:00`))!.state).toBe('available');
        expect((await (await h.app.request(`/api/booking/${ref}`)).json()).status).toBe('Declined');
        expect((await h.book({ phone: '9000000003' })).status).toBe(201);
    });

    it('cannot decide another clinic\'s booking', async () => {
        const h = await harness();
        const ref = newRef();
        await h.book({ ref });
        h.setAuth({ ok: true, deviceId: 'dev-2', clinicId: 'clinic-2', hipId: 'IN2' });
        expect((await h.clinicCall('POST', `/api/clinic/bookings/${ref}/decision`, { decision: 'declined' })).status).toBe(404);
        expect((await h.slots.get(CLINIC_ID, `${TOMORROW}T10:00`))!.state).toBe('held');
    });

    it('records the desktop as seen on every signed call', async () => {
        const h = await harness();
        h.setNow(NOW + 10 * 60 * 1000);
        await h.clinicCall('GET', '/api/clinic/slots');
        expect((await h.clinics.get(CLINIC_ID))!.lastSeenAt).toBe(NOW + 10 * 60 * 1000);
    });
});
