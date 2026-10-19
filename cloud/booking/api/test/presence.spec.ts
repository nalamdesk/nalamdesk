import { describe, expect, it } from 'vitest';
import { applyPresenceEvent } from '../src/presence.js';
import { CLINIC_ID, harness, NOW } from './helpers.js';

describe('IoT presence events', () => {
    it('marks the clinic online and offline, ignoring stale or unknown events', async () => {
        const h = await harness();
        const lookup = async (deviceId: string) => (deviceId === 'dev-1' ? CLINIC_ID : null);
        expect(await applyPresenceEvent(h.clinics, lookup, { clientId: 'dev-1', eventType: 'connected', timestamp: NOW + 1000 })).toBe(true);
        expect((await h.clinics.get(CLINIC_ID))!.online).toBe(true);
        expect(await applyPresenceEvent(h.clinics, lookup, { clientId: 'dev-9', eventType: 'connected', timestamp: NOW })).toBe(false);
        expect(await applyPresenceEvent(h.clinics, lookup, { clientId: 'dev-1', eventType: 'subscribed', timestamp: NOW })).toBe(false);
        await applyPresenceEvent(h.clinics, lookup, { clientId: 'dev-1', eventType: 'disconnected', timestamp: NOW + 2000 });
        expect((await h.clinics.get(CLINIC_ID))!.online).toBe(false);
    });
});
