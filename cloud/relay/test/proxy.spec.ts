import { describe, expect, it } from 'vitest';
import { harness, HIP_ID } from './helpers.js';

const signedHeaders = (extra: Record<string, string> = {}) => ({
    'content-type': 'application/json',
    'x-hip-id': HIP_ID,
    'x-nd-device': 'dev-1',
    'x-nd-signature': 'sig',
    ...extra
});

describe('outbound proxy', () => {
    it('forwards an allowlisted ABHA call with the vendor token and streams the answer back', async () => {
        const h = await harness();
        h.setUpstream(() => new Response(JSON.stringify({ txnId: 't-1' }), {
            status: 200,
            headers: { 'content-type': 'application/json', 'set-cookie': 'a=b', 'x-internal': '1' }
        }));
        const res = await h.app.request('/abdm/abha/v3/enrollment/request/otp', {
            method: 'POST',
            headers: signedHeaders({ authorization: 'Bearer desktop-should-not-pass', 'request-id': 'r-1' }),
            body: JSON.stringify({ loginId: 'rsa-ciphertext' })
        });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ txnId: 't-1' });
        expect(res.headers.get('set-cookie')).toBeNull();
        expect(res.headers.get('x-internal')).toBeNull();

        const call = h.upstreamCalls[0]!;
        expect(call.url).toBe('https://abhasbx.abdm.gov.in/abha/api/v3/enrollment/request/otp');
        const headers = call.init.headers as Headers;
        expect(headers.get('authorization')).toBe('Bearer vendor-token-1');
        expect(headers.get('request-id')).toBe('r-1');
        expect(headers.get('timestamp')).toBeTruthy();
        expect(headers.get('x-cm-id')).toBeNull();
        expect(Buffer.from(call.init.body as Uint8Array).toString()).toBe(JSON.stringify({ loginId: 'rsa-ciphertext' }));
    });

    it('adds X-CM-ID and X-HIP-ID on gateway calls, X-HIU-ID on M3 calls', async () => {
        const h = await harness();
        await h.app.request('/abdm/gateway/patient-share/v3/on-share', { method: 'POST', headers: signedHeaders(), body: '{}' });
        await h.app.request('/abdm/gateway/consent/v3/request/init', { method: 'POST', headers: signedHeaders(), body: '{}' });
        const [m1, m3] = h.upstreamCalls.map((call) => call.init.headers as Headers);
        expect(h.upstreamCalls[0]!.url).toBe('https://dev.abdm.gov.in/api/hiecm/patient-share/v3/on-share');
        expect(m1!.get('x-cm-id')).toBe('sbx');
        expect(m1!.get('x-hip-id')).toBe(HIP_ID);
        expect(m3!.get('x-hiu-id')).toBe(HIP_ID);
        expect(m3!.get('x-hip-id')).toBeNull();
    });

    it('passes the device check failure through, with the relay clock on clock_skew', async () => {
        const h = await harness();
        h.setAuth({ ok: false, status: 401, code: 'clock_skew', serverTimeMs: 1234 });
        const res = await h.app.request('/abdm/abha/v3/profile/login/verify', { method: 'POST', headers: signedHeaders(), body: '{}' });
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: 'clock_skew', serverTime: 1234 });
        expect(h.upstreamCalls).toHaveLength(0);
    });

    it('refuses another clinic\'s X-HIP-ID', async () => {
        const h = await harness();
        const res = await h.app.request('/abdm/abha/v3/profile/login/verify', {
            method: 'POST', headers: signedHeaders({ 'x-hip-id': 'IN9999999999' }), body: '{}'
        });
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: 'hip_mismatch' });
        expect(h.upstreamCalls).toHaveLength(0);
    });

    it('refuses paths off the allowlist, such as bridge registration', async () => {
        const h = await harness();
        const res = await h.app.request('/abdm/gateway/gateway/v3/bridge/url', { method: 'POST', headers: signedHeaders(), body: '{}' });
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: 'path_not_allowed' });
        expect(h.upstreamCalls).toHaveLength(0);
    });

    it('refreshes the vendor token once when the gateway answers 401', async () => {
        const h = await harness();
        let calls = 0;
        h.setUpstream(() => new Response('{}', { status: ++calls === 1 ? 401 : 200 }));
        const res = await h.app.request('/abdm/abha/v3/profile/login/verify', { method: 'POST', headers: signedHeaders(), body: '{}' });
        expect(res.status).toBe(200);
        expect(h.tokens.invalidated).toBe(1);
        expect((h.upstreamCalls[1]!.init.headers as Headers).get('authorization')).toBe('Bearer vendor-token-2');
    });

    it('answers 502 when the gateway is unreachable, without detail', async () => {
        const h = await harness();
        h.setUpstream(() => { throw new Error('ECONNRESET 10.0.0.1'); });
        const res = await h.app.request('/abdm/abha/v3/profile/login/verify', { method: 'POST', headers: signedHeaders(), body: '{}' });
        expect(res.status).toBe(502);
        expect(await res.json()).toEqual({ error: 'upstream_unreachable' });
    });

    it('never puts the vendor token in a response', async () => {
        const h = await harness();
        h.setUpstream(() => new Response('{}', { status: 200, headers: { authorization: 'Bearer vendor-token-1' } }));
        const res = await h.app.request('/abdm/abha/v3/profile/login/verify', { method: 'POST', headers: signedHeaders(), body: '{}' });
        expect(res.headers.get('authorization')).toBeNull();
    });

    it('refuses oversized bodies', async () => {
        const h = await harness();
        const res = await h.app.request('/abdm/abha/v3/profile/login/verify', {
            method: 'POST', headers: signedHeaders(), body: 'x'.repeat(300 * 1024)
        });
        expect(res.status).toBe(413);
        expect(h.upstreamCalls).toHaveLength(0);
    });
});
