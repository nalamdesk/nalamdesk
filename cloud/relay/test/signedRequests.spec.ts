import * as crypto from 'node:crypto';
import { createDeviceAuthenticator, ed25519PublicKeyRaw, signRequest } from '@nalamdesk/cloud-shared';
import { describe, expect, it } from 'vitest';
import { CLINIC_ID, harness, HIP_ID } from './helpers.js';

// The relay with the real request verifier from cloud/shared (#154), over
// in-memory device and nonce stores.
async function signedRelay() {
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    let now = Date.UTC(2026, 9, 19, 6, 0);
    const seen = new Set<string>();
    const devices = createDeviceAuthenticator({
        audience: 'relay',
        devices: {
            get: async (id) => (id === 'dev_clinic1_main'
                ? { deviceId: id, clinicId: CLINIC_ID, hipId: HIP_ID, status: 'active', signingPublicKey: ed25519PublicKeyRaw(privateKey) }
                : null)
        },
        nonces: { claim: async (key) => (seen.has(key) ? false : (seen.add(key), true)) },
        nowMs: () => now
    });
    const h = await harness({ devices, nowMs: () => now });
    const call = (input: { path?: string; query?: string; sentQuery?: string; body?: string; hipId?: string; signedAt?: number; key?: crypto.KeyObject } = {}) => {
        const path = input.path ?? '/abdm/abha/v3/enrollment/request/otp';
        const body = input.body ?? '{"loginId":"x"}';
        const method = input.query !== undefined ? 'GET' : 'POST';
        const signed = signRequest({
            privateKey: input.key ?? privateKey,
            deviceId: 'dev_clinic1_main',
            audience: 'relay',
            method,
            path,
            query: input.query,
            body: method === 'GET' ? undefined : new TextEncoder().encode(body),
            hipId: input.hipId ?? HIP_ID,
            nowMs: input.signedAt ?? now
        });
        const headers = { 'content-type': 'application/json', ...signed };
        const query = input.sentQuery ?? input.query;
        return h.app.request(`${path}${query ? `?${query}` : ''}`, method === 'GET' ? { headers } : { method, headers, body });
    };
    // Signs one request and returns a sender that repeats it unchanged.
    const replayable = () => {
        const body = '{"loginId":"x"}';
        const path = '/abdm/abha/v3/enrollment/request/otp';
        const headers = {
            'content-type': 'application/json',
            ...signRequest({ privateKey, deviceId: 'dev_clinic1_main', audience: 'relay', method: 'POST', path, body: new TextEncoder().encode(body), hipId: HIP_ID, nowMs: now })
        };
        return () => h.app.request(path, { method: 'POST', headers, body });
    };
    return { h, call, replayable };
}

describe('signed desktop requests through the relay', () => {
    it('forwards a correctly signed call', async () => {
        const { h, call } = await signedRelay();
        expect((await call()).status).toBe(200);
        expect(h.upstreamCalls).toHaveLength(1);
    });

    it('rejects a bad signature and a stale timestamp', async () => {
        const { h, call } = await signedRelay();
        const forged = await call({ key: crypto.generateKeyPairSync('ed25519').privateKey });
        expect(forged.status).toBe(401);
        expect(await forged.json()).toEqual({ error: 'bad_signature' });

        const stale = await call({ signedAt: Date.UTC(2026, 9, 19, 5, 58) });
        expect(stale.status).toBe(401);
        expect(await stale.json()).toEqual({ error: 'clock_skew', serverTime: Date.UTC(2026, 9, 19, 6, 0) });
        expect(h.upstreamCalls).toHaveLength(0);
    });

    it('rejects a replayed request byte for byte', async () => {
        const { h, replayable } = await signedRelay();
        const send = replayable();
        expect((await send()).status).toBe(200);
        const replay = await send();
        expect(replay.status).toBe(401);
        expect(await replay.json()).toEqual({ error: 'replay' });
        expect(h.upstreamCalls).toHaveLength(1);
    });

    it('refuses another clinic\'s X-HIP-ID even when correctly signed', async () => {
        const { h, call } = await signedRelay();
        const res = await call({ hipId: 'IN2710009999' });
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: 'hip_mismatch' });
        expect(h.upstreamCalls).toHaveLength(0);
    });

    it('signs the query string, so it cannot be swapped', async () => {
        const { h, call } = await signedRelay();
        expect((await call({ path: '/abdm/abha/v3/profile/account', query: 'a=1' })).status).toBe(200);
        expect(h.upstreamCalls[0]!.url).toBe('https://abhasbx.abdm.gov.in/abha/api/v3/profile/account?a=1');
        const swapped = await call({ path: '/abdm/abha/v3/profile/account', query: 'a=1', sentQuery: 'a=2' });
        expect(swapped.status).toBe(401);
        expect(h.upstreamCalls).toHaveLength(1);
    });
});
