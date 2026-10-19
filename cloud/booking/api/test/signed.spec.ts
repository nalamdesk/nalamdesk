import * as crypto from 'node:crypto';
import { createDeviceAuthenticator, ed25519PublicKeyRaw, signRequest, type Audience } from '@nalamdesk/cloud-shared';
import { describe, expect, it } from 'vitest';
import { CLINIC_ID, harness, NOW } from './helpers.js';

// The clinic routes with the real request verifier from cloud/shared (#154).
async function signedBooking() {
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    const seen = new Set<string>();
    const devices = createDeviceAuthenticator({
        audience: 'booking',
        devices: {
            get: async (id) => (id === 'dev_clinic1_main'
                ? { deviceId: id, clinicId: CLINIC_ID, hipId: 'IN2710000123', status: 'active', signingPublicKey: ed25519PublicKeyRaw(privateKey) }
                : null)
        },
        nonces: { claim: async (key) => (seen.has(key) ? false : (seen.add(key), true)) },
        nowMs: () => NOW
    });
    const h = await harness({ devices });
    const call = (method: string, path: string, input: { body?: unknown; query?: string; audience?: Audience } = {}) => {
        const body = input.body === undefined ? undefined : JSON.stringify(input.body);
        const headers = {
            'content-type': 'application/json',
            ...signRequest({
                privateKey, deviceId: 'dev_clinic1_main', audience: input.audience ?? 'booking', method, path,
                query: input.query, body: body ? new TextEncoder().encode(body) : undefined, nowMs: NOW
            })
        };
        return h.app.request(`${path}${input.query ? `?${input.query}` : ''}`, { method, headers, body });
    };
    return { h, call };
}

describe('signed clinic routes with the real verifier', () => {
    it('accepts a correctly signed listing change', async () => {
        const { h, call } = await signedBooking();
        expect((await call('DELETE', '/api/clinic/listing')).status).toBe(200);
        expect((await h.clinics.get(CLINIC_ID))!.listed).toBe(false);
    });

    it('accepts a signed GET with a query string', async () => {
        const { call } = await signedBooking();
        expect((await call('GET', '/api/clinic/slots', { query: 'from=2026-10-19&to=2026-10-20' })).status).not.toBe(401);
    });

    it('refuses a request signed for the relay', async () => {
        const { h, call } = await signedBooking();
        const res = await call('DELETE', '/api/clinic/listing', { audience: 'relay' });
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: 'bad_signature' });
        expect((await h.clinics.get(CLINIC_ID))!.listed).toBe(true);
    });

    it('refuses an unsigned request', async () => {
        const { h } = await signedBooking();
        const res = await h.app.request('/api/clinic/listing', { method: 'DELETE' });
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: 'unsigned' });
    });
});
