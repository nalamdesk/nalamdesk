import * as crypto from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { SignedCloudClient } from './SignedCloudClient';

function client() {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 202 }));
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    const cloud = new SignedCloudClient({
        baseUrl: () => 'https://relay.test',
        identity: () => ({ deviceId: 'dev_1', hipId: 'IN3310000001', privateKey }),
        fetchFn: fetchFn as unknown as typeof fetch,
        nowMs: () => Date.parse('2026-10-20T10:00:00Z')
    });
    return { cloud, fetchFn };
}

describe('SignedCloudClient ABDM headers', () => {
    it('passes on the REQUEST-ID and link token, and nothing else', async () => {
        const { cloud, fetchFn } = client();
        await cloud.signed('relay', 'POST', '/abdm/gateway/consent/v3/fetch', { consentId: 'a' }, {
            hipId: 'IN3310000001',
            headers: { 'request-id': 'req-1', 'x-link-token': 'tok', authorization: 'Bearer nope' } as any
        });
        const headers = (fetchFn.mock.calls[0] as any)[1].headers as Record<string, string>;
        expect(headers['request-id']).toBe('req-1');
        expect(headers['x-link-token']).toBe('tok');
        expect(headers.authorization).toBeUndefined();
        expect(headers['x-hip-id']).toBe('IN3310000001');
    });

    it('drops a header value that could split the request', async () => {
        const { cloud, fetchFn } = client();
        await cloud.signed('relay', 'POST', '/abdm/gateway/consent/v3/fetch', {}, { headers: { 'request-id': 'a\r\nx: y' } });
        const headers = (fetchFn.mock.calls[0] as any)[1].headers as Record<string, string>;
        expect(headers['request-id']).toBeUndefined();
    });
});
