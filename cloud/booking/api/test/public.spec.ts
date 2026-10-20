import { describe, expect, it } from 'vitest';
import { CLINIC_ID, harness, NOW, TOMORROW } from './helpers.js';

describe('public directory and slots', () => {
    it('lists listed clinics with their sealing key and a 30-second cache', async () => {
        const h = await harness();
        await h.clinics.upsertListing('clinic-2', { name: 'Zen Clinic', city: 'Madurai', specialty: 'ENT', sealingPublicKey: h.clinic.publicRaw, deviceId: 'dev-2' }, NOW);
        await h.clinics.unlist('clinic-2', NOW);
        const res = await h.app.request('/api/clinics');
        expect(res.status).toBe(200);
        expect(res.headers.get('cache-control')).toBe('public, max-age=30');
        const body = await res.json();
        expect(body.clinics).toEqual([{
            clinicId: CLINIC_ID,
            name: 'Arogya Clinic',
            city: 'Chennai',
            specialty: 'General Practice',
            online: true,
            sealingPublicKey: h.clinic.publicRaw
        }]);
    });

    it('shows a clinic offline once its desktop has been quiet for 5 minutes, unless IoT says it is connected', async () => {
        const h = await harness();
        h.setNow(NOW + 6 * 60 * 1000);
        expect((await (await h.app.request('/api/clinics')).json()).clinics[0].online).toBe(false);
        await h.clinics.setPresence(CLINIC_ID, true, NOW + 60_000);
        expect((await (await h.app.request('/api/clinics')).json()).clinics[0].online).toBe(true);
    });

    it('returns only open future slots for the next 14 days', async () => {
        const h = await harness();
        await h.book({ slotId: `${TOMORROW}T10:30` });
        const res = await h.app.request(`/api/slots/${CLINIC_ID}`);
        expect(res.status).toBe(200);
        expect(res.headers.get('cache-control')).toBe('public, max-age=30');
        const body = await res.json();
        // 08:30 today has passed (it is 09:00 IST) and 10:30 tomorrow is held.
        expect(body.slots.map((s: { slotId: string }) => s.slotId)).toEqual(['2026-10-19T10:00', '2026-10-20T10:00']);
    });

    it('refuses slots for unknown or unlisted clinics', async () => {
        const h = await harness();
        expect((await h.app.request('/api/slots/nope')).status).toBe(404);
        expect((await h.app.request('/api/slots/bad%20id')).status).toBe(404);
        await h.clinics.unlist(CLINIC_ID, NOW);
        expect((await h.app.request(`/api/slots/${CLINIC_ID}`)).status).toBe(404);
    });
});
