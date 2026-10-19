import * as crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
    canonicalRequest, createDeviceAuthenticator, ed25519PublicKey, ed25519PublicKeyRaw, signRequest,
    TokenBucketLimiter, verifyCanonical, type Audience, type DeviceRecord, type DesktopRequest
} from '../src/index.js';

const vectors = JSON.parse(readFileSync(new URL('./vectors.json', import.meta.url), 'utf8'));
const NOW = 1_792_400_000_000;

function keyPair() {
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    return { privateKey, raw: ed25519PublicKeyRaw(privateKey) };
}

function harness(overrides: { device?: Partial<DeviceRecord>; audience?: Audience; limiter?: TokenBucketLimiter } = {}) {
    const key = keyPair();
    let now = NOW;
    const device: DeviceRecord = {
        deviceId: 'dev_0123456789',
        clinicId: 'cln_1',
        hipId: 'IN2710000123',
        status: 'active',
        signingPublicKey: key.raw,
        ...overrides.device
    };
    const seen = new Set<string>();
    const auth = createDeviceAuthenticator({
        audience: overrides.audience ?? 'relay',
        devices: { get: async (id) => (id === device.deviceId ? device : null) },
        nonces: { claim: async (k) => (seen.has(k) ? false : (seen.add(k), true)) },
        limiter: overrides.limiter,
        nowMs: () => now
    });
    const request = (input: {
        method?: string; path?: string; query?: string; body?: string; hipId?: string;
        signedAt?: number; audience?: Audience; privateKey?: crypto.KeyObject; nonce?: string;
        tamper?: (r: DesktopRequest) => void;
    } = {}) => {
        const body = new TextEncoder().encode(input.body ?? '');
        const headers = signRequest({
            privateKey: input.privateKey ?? key.privateKey,
            deviceId: device.deviceId,
            audience: input.audience ?? 'relay',
            method: input.method ?? 'POST',
            path: input.path ?? '/abdm/gateway/v3/hip/patient/care-context/link',
            query: input.query,
            body,
            hipId: input.hipId ?? device.hipId,
            nowMs: input.signedAt ?? now,
            nonce: input.nonce
        });
        const req: DesktopRequest = {
            method: input.method ?? 'POST',
            path: input.path ?? '/abdm/gateway/v3/hip/patient/care-context/link',
            query: input.query ?? '',
            headers: new Headers(headers),
            body
        };
        input.tamper?.(req);
        return auth.authenticate(req);
    };
    return { request, device, key, advance: (ms: number) => { now += ms; } };
}

describe('canonical string', () => {
    it('matches the shared test vectors', () => {
        const publicKey = ed25519PublicKey(vectors.publicKeyRaw);
        for (const c of vectors.cases) {
            const fields = { ...c };
            expect(canonicalRequest(fields)).toBe(c.canonical);
            expect(verifyCanonical(publicKey, fields, c.signature)).toBe(true);
        }
    });

    it('signs the same bytes the vectors pin', () => {
        const seed = Buffer.from(vectors.seedHex, 'hex');
        const privateKey = crypto.createPrivateKey({
            key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8'
        });
        const c = vectors.cases[0];
        const headers = signRequest({
            privateKey, deviceId: 'dev_0123456789', audience: c.audience, method: c.method, path: c.path, query: c.query,
            body: new TextEncoder().encode(c.body), hipId: c.hipId, nowMs: Number(c.timestamp), nonce: c.nonce
        });
        expect(headers['x-nd-signature']).toBe(c.signature);
        expect(ed25519PublicKeyRaw(privateKey)).toBe(vectors.publicKeyRaw);
    });
});

describe('device authenticator', () => {
    it('accepts a correctly signed request and names the device', async () => {
        const { request } = harness();
        expect(await request({ body: '{"a":1}' })).toEqual({ ok: true, deviceId: 'dev_0123456789', clinicId: 'cln_1', hipId: 'IN2710000123' });
    });

    it('rejects missing or malformed headers', async () => {
        const { request } = harness();
        expect(await request({ tamper: (r) => r.headers.delete('x-nd-signature') })).toMatchObject({ ok: false, status: 401, code: 'unsigned' });
        expect(await request({ tamper: (r) => r.headers.set('x-nd-timestamp', 'yesterday') })).toMatchObject({ code: 'unsigned' });
        expect(await request({ tamper: (r) => r.headers.set('x-nd-nonce', 'short') })).toMatchObject({ code: 'unsigned' });
    });

    it('rejects a bad signature', async () => {
        const { request } = harness();
        expect(await request({ privateKey: keyPair().privateKey })).toMatchObject({ status: 401, code: 'bad_signature' });
    });

    it('rejects a tampered body, path, query, method or X-HIP-ID', async () => {
        const { request } = harness();
        const swapBody = (r: DesktopRequest) => { r.body = new TextEncoder().encode('{"a":2}'); };
        expect(await request({ body: '{"a":1}', tamper: swapBody })).toMatchObject({ code: 'bad_signature' });
        expect(await request({ tamper: (r) => { r.path = '/abdm/gateway/v3/other'; } })).toMatchObject({ code: 'bad_signature' });
        expect(await request({ query: 'a=1', tamper: (r) => { r.query = 'a=2'; } })).toMatchObject({ code: 'bad_signature' });
        expect(await request({ tamper: (r) => { r.method = 'GET'; } })).toMatchObject({ code: 'bad_signature' });
        expect(await request({ tamper: (r) => r.headers.set('x-hip-id', 'IN9999999999') })).toMatchObject({ code: 'bad_signature' });
    });

    it('rejects a request signed for the other service', async () => {
        const { request } = harness();
        expect(await request({ audience: 'booking' })).toMatchObject({ code: 'bad_signature' });
    });

    it('rejects a stale or future timestamp and returns server time', async () => {
        const { request } = harness();
        expect(await request({ signedAt: NOW - 61_000 })).toEqual({ ok: false, status: 401, code: 'clock_skew', serverTimeMs: NOW });
        expect(await request({ signedAt: NOW + 61_000 })).toMatchObject({ code: 'clock_skew' });
        expect(await request({ signedAt: NOW - 59_000 })).toMatchObject({ ok: true });
    });

    it('rejects a reused nonce', async () => {
        const { request } = harness();
        const nonce = crypto.randomBytes(16).toString('base64url');
        expect(await request({ nonce })).toMatchObject({ ok: true });
        expect(await request({ nonce })).toMatchObject({ status: 401, code: 'replay' });
    });

    it('rejects an unknown or revoked device', async () => {
        expect(await harness().request({ tamper: (r) => r.headers.set('x-nd-device', 'dev_unknown000') })).toMatchObject({ code: 'device_unknown' });
        expect(await harness({ device: { status: 'revoked' } }).request()).toMatchObject({ status: 401, code: 'device_revoked' });
    });

    it('accepts the previous key only until its overlap ends', async () => {
        const old = keyPair();
        const { request, advance } = harness({ device: { previousSigningPublicKey: old.raw, previousKeyValidUntil: NOW + 10_000 } });
        expect(await request({ privateKey: old.privateKey })).toMatchObject({ ok: true });
        advance(10_001);
        expect(await request({ privateKey: old.privateKey })).toMatchObject({ code: 'bad_signature' });
        expect(await request()).toMatchObject({ ok: true });
    });

    it('re-reads the device once when a cached row predates a key rotation', async () => {
        const rotated = keyPair();
        const stale = keyPair();
        const reads: boolean[] = [];
        const auth = createDeviceAuthenticator({
            audience: 'relay',
            devices: {
                get: async (deviceId, options) => {
                    reads.push(!!options?.fresh);
                    return { deviceId, clinicId: 'cln_1', hipId: 'IN2710000123', status: 'active', signingPublicKey: options?.fresh ? rotated.raw : stale.raw };
                }
            },
            nonces: { claim: async () => true },
            nowMs: () => NOW
        });
        const send = (privateKey: crypto.KeyObject) => {
            const headers = signRequest({ privateKey, deviceId: 'dev_0123456789', audience: 'relay', method: 'GET', path: '/x', nowMs: NOW });
            return auth.authenticate({ method: 'GET', path: '/x', query: '', headers: new Headers(headers), body: new Uint8Array() });
        };
        expect(await send(rotated.privateKey)).toMatchObject({ ok: true });
        expect(reads).toEqual([false, true]);
        expect(await send(keyPair().privateKey)).toMatchObject({ code: 'bad_signature' });
    });

    it('rate limits per device', async () => {
        const { request } = harness({ limiter: new TokenBucketLimiter(1, 2) });
        expect(await request()).toMatchObject({ ok: true });
        expect(await request()).toMatchObject({ ok: true });
        expect(await request()).toMatchObject({ status: 429, code: 'rate_limited' });
    });

    it('does not spend a nonce on a request that fails its signature', async () => {
        const { request } = harness();
        const nonce = crypto.randomBytes(16).toString('base64url');
        expect(await request({ nonce, privateKey: keyPair().privateKey })).toMatchObject({ code: 'bad_signature' });
        expect(await request({ nonce })).toMatchObject({ ok: true });
    });
});

describe('token bucket', () => {
    it('refills over time', () => {
        const limiter = new TokenBucketLimiter(10, 1);
        expect(limiter.allow('a', 0)).toBe(true);
        expect(limiter.allow('a', 50)).toBe(false);
        expect(limiter.allow('a', 100)).toBe(true);
        expect(limiter.allow('b', 100)).toBe(true);
    });
});
