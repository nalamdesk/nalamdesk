import * as crypto from 'node:crypto';
import { createDeviceAuthenticator, ed25519PublicKeyRaw, signRequest } from '@nalamdesk/cloud-shared';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { createOpsTokenVerifier } from '../src/opsAuth.js';
import { keyFingerprint, normalizeCode, pairingMessages, PAIRING_LIMITS, PairingService } from '../src/pairing.js';
import { harness } from './helpers.js';
import { MemoryPairingStore, MemoryRateLimiter } from './memoryPairing.js';

const HFR = 'IN2710000123';
const START = Date.UTC(2026, 9, 19, 6, 0);
const POOL = 'ap-south-1_TestPool';
const ISSUER = `https://cognito-idp.ap-south-1.amazonaws.com/${POOL}`;

/** A NalamDesk install: its own Ed25519 and X25519 keys. */
function install(label = 'Front desk PC') {
    const signing = crypto.generateKeyPairSync('ed25519').privateKey;
    const sealing = crypto.generateKeyPairSync('x25519').publicKey;
    return {
        label,
        signing,
        signingPublicKey: ed25519PublicKeyRaw(signing),
        sealingPublicKey: sealing.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64'),
        sign: (message: string) => crypto.sign(null, Buffer.from(message), signing).toString('base64url')
    };
}
type Install = ReturnType<typeof install>;

async function relayWithPairing(options: { ipLimit?: number } = {}) {
    let now = START;
    const store = new MemoryPairingStore();
    const limiter = new MemoryRateLimiter(options.ipLimit ?? 100);
    const codes: string[] = [];
    const revoked: string[] = [];
    const service = new PairingService({
        store,
        ipLimiter: limiter,
        pepper: async () => Buffer.alloc(32, 9),
        bridgeUrl: 'https://abdm-sandbox.example.in',
        lifecycle: { revoked: async (device) => { revoked.push(device.deviceId); } },
        nowMs: () => now,
        generateCode: () => { const c = ['K7QM3XRA', 'P2V9WN4D', 'H8JT6CZ1'][codes.length % 3]!; codes.push(c); return c; }
    });

    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(publicKey)), kid: 'ops-1', alg: 'RS256' };
    const verifyOps = createOpsTokenVerifier({ region: 'ap-south-1', userPoolId: POOL, clientId: 'ops-client', keys: createLocalJWKSet({ keys: [jwk] }) });
    const opsToken = (claims: Record<string, unknown> = {}, issuer = ISSUER) => new SignJWT({
        token_use: 'access', client_id: 'ops-client', 'cognito:groups': ['ops'], username: 'asha', ...claims
    }).setProtectedHeader({ alg: 'RS256', kid: 'ops-1' }).setIssuer(issuer).setSubject('staff-sub-1').setIssuedAt().setExpirationTime('5m').sign(privateKey);

    const seen = new Set<string>();
    const devices = createDeviceAuthenticator({
        audience: 'relay',
        devices: {
            get: async (id) => {
                const d = await store.getDevice(id);
                return d && { deviceId: d.deviceId, clinicId: d.clinicId, hipId: d.hipId, status: d.status, signingPublicKey: d.signingPublicKey,
                    previousSigningPublicKey: d.previousSigningPublicKey, previousKeyValidUntil: d.previousKeyValidUntil };
            }
        },
        nonces: { claim: async (key) => (seen.has(key) ? false : (seen.add(key), true)) },
        nowMs: () => now
    });
    const h = await harness({
        devices,
        nowMs: () => now,
        pairing: { service, verifyOps, console: { authDomain: 'nalamdesk-ops-sandbox.auth.ap-south-1.amazoncognito.com', clientId: 'ops-client' } }
    });

    const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
        h.app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-nd-viewer-ip': '203.0.113.7', ...headers }, body: JSON.stringify(body) });
    const ts = () => String(now);

    const requestPairing = (who: Install, hfrId = HFR, overrides: Record<string, unknown> = {}) => {
        const fields = { hfrId, signingPublicKey: who.signingPublicKey, sealingPublicKey: who.sealingPublicKey, label: who.label, appVersion: '2.4.0', timestamp: ts() };
        return post('/pairing/request', { ...fields, signature: who.sign(pairingMessages.request(fields)), ...overrides });
    };
    const activate = (who: Install, code: string, hfrId = HFR, signer: Install = who) => {
        const typed = normalizeCode(code);
        const message = pairingMessages.activate({ hfrId, code: typed, signingPublicKey: who.signingPublicKey, sealingPublicKey: who.sealingPublicKey, timestamp: ts() });
        return post('/pairing/activate', { hfrId, code, timestamp: ts(), signature: signer.sign(message) });
    };
    const ops = async (method: string, path: string, body?: unknown, token?: string) => h.app.request(`/ops/api${path}`, {
        method,
        headers: { authorization: `Bearer ${token ?? await opsToken()}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    const approve = async (hfrId = HFR) => {
        const { requests } = await (await ops('GET', '/pairing-requests')).json() as { requests: { hfrId: string; requestId: string }[] };
        const request = requests.find((r) => r.hfrId === hfrId)!;
        const res = await ops('POST', `/pairing-requests/${hfrId}/approve`, { requestId: request.requestId });
        return { res, body: await res.json() as { code: string; expiresAt: number } };
    };
    const pair = async (who: Install, hfrId = HFR) => {
        expect((await requestPairing(who, hfrId)).status).toBe(202);
        const { body } = await approve(hfrId);
        const res = await activate(who, body.code, hfrId);
        expect(res.status).toBe(200);
        return await res.json() as { deviceId: string; clinicId: string; hipId: string; dataPushUrl: string; serverTimeMs: number };
    };
    const signedCall = (who: Install, deviceId: string, key: crypto.KeyObject = who.signing) => {
        const body = '{"loginId":"x"}';
        const path = '/abdm/abha/v3/enrollment/request/otp';
        const headers = { 'content-type': 'application/json', ...signRequest({ privateKey: key, deviceId, audience: 'relay', method: 'POST', path, body: new TextEncoder().encode(body), hipId: HFR, nowMs: now }) };
        return h.app.request(path, { method: 'POST', headers, body });
    };

    return {
        h, store, limiter, codes, revoked, opsToken, post, requestPairing, activate, ops, approve, pair, signedCall,
        advance: (ms: number) => { now += ms; },
        now: () => now
    };
}

describe('pairing a desktop', () => {
    it('pairs after staff approval and the code, then the device can sign calls', async () => {
        const r = await relayWithPairing();
        const pc = install();
        const requested = await r.requestPairing(pc);
        expect(requested.status).toBe(202);
        const { requestId } = await requested.json() as { requestId: string };

        const list = await (await r.ops('GET', '/pairing-requests')).json() as { requests: Record<string, unknown>[] };
        expect(list.requests).toEqual([expect.objectContaining({
            hfrId: HFR, requestId, status: 'pending', label: 'Front desk PC', appVersion: '2.4.0', keyFingerprint: keyFingerprint(pc.signingPublicKey)
        })]);
        expect(JSON.stringify(list)).not.toContain(pc.signingPublicKey);

        const { res, body } = await r.approve();
        expect(res.status).toBe(200);
        expect(body).toEqual({ code: 'K7QM-3XRA', expiresAt: START + PAIRING_LIMITS.codeTtlMs });
        expect(JSON.stringify([...r.store.requests.values()])).not.toContain('K7QM3XRA');

        // What a person types: lower case, no dash.
        const activated = await r.activate(pc, 'k7qm3xra');
        expect(activated.status).toBe(200);
        const device = await activated.json() as { deviceId: string; clinicId: string; dataPushUrl: string };
        expect(device).toMatchObject({ hipId: HFR, clinicId: 'cln_1', serverTimeMs: START });
        expect(device.dataPushUrl).toMatch(/^https:\/\/abdm-sandbox\.example\.in\/hiu\/data-push\/[A-Za-z0-9_-]{43}$/);
        expect(r.store.requests.size).toBe(0);
        expect(r.store.devices.get(device.deviceId)).toMatchObject({ status: 'active', approvedBy: 'staff-sub-1', linkedToBridge: true, sealingPublicKey: pc.sealingPublicKey });

        expect((await r.signedCall(pc, device.deviceId)).status).toBe(200);
        // Spending the code again creates nothing; the same install just hears its device again.
        expect(await (await r.activate(pc, 'K7QM3XRA')).json()).toMatchObject({ deviceId: device.deviceId });
        expect(r.store.devices.size).toBe(1);
    });

    it('revokes the first install when a second one pairs for the same HFR ID', async () => {
        const r = await relayWithPairing();
        const first = install('Old PC');
        const second = install('New PC');
        const a = await r.pair(first);
        const b = await r.pair(second);
        expect(b.clinicId).toBe(a.clinicId);
        expect(r.store.devices.get(a.deviceId)).toMatchObject({ status: 'revoked', revokedReason: 'replaced' });
        expect(r.revoked).toEqual([a.deviceId]);

        r.advance(31_000);
        const old = await r.signedCall(first, a.deviceId);
        expect(old.status).toBe(401);
        expect(await old.json()).toEqual({ error: 'device_revoked' });
        expect((await r.signedCall(second, b.deviceId)).status).toBe(200);
    });

    it('checks the HFR ID, the keys and the proof signature', async () => {
        const r = await relayWithPairing();
        const pc = install();
        expect((await r.requestPairing(pc, 'IN27100')).status).toBe(400);
        expect(await (await r.requestPairing(pc, 'XX2710000123')).json()).toEqual({ error: 'bad_hfr_id' });
        expect((await r.requestPairing(pc, HFR, { sealingPublicKey: 'AAAA' })).status).toBe(400);
        const forged = await r.requestPairing(pc, HFR, { signature: install().sign('anything') });
        expect(forged.status).toBe(401);
        expect(await forged.json()).toEqual({ error: 'bad_signature' });
        const stale = await r.requestPairing(pc, HFR, { timestamp: String(START - 120_000) });
        expect(stale.status).toBe(401);
        expect(await stale.json()).toEqual({ error: 'clock_skew', serverTime: START });
        expect(r.store.requests.size).toBe(0);
    });

    it('keeps one pending request per HFR ID, answers a retry the same way, and lets a lapsed one be replaced', async () => {
        const r = await relayWithPairing();
        const pc = install();
        const first = await (await r.requestPairing(pc)).json() as { requestId: string };
        const retry = await (await r.requestPairing(pc)).json() as { requestId: string };
        expect(retry.requestId).toBe(first.requestId);
        const other = await r.requestPairing(install('Someone else'));
        expect(other.status).toBe(409);
        expect(await other.json()).toEqual({ error: 'pending_exists' });

        r.advance(PAIRING_LIMITS.requestTtlMs + 1);
        expect((await r.requestPairing(install('Someone else'))).status).toBe(202);
    });

    it('rate limits pairing requests per client IP', async () => {
        const r = await relayWithPairing({ ipLimit: 2 });
        expect((await r.requestPairing(install(), 'IN2710000001')).status).toBe(202);
        expect((await r.requestPairing(install(), 'IN2710000002')).status).toBe(202);
        const limited = await r.requestPairing(install(), 'IN2710000003');
        expect(limited.status).toBe(429);
        expect([...r.limiter.hits.keys()]).toHaveLength(1);
        expect([...r.limiter.hits.keys()][0]).not.toContain('203.0.113.7');
    });

    it('lets only the requesting install cancel its request', async () => {
        const r = await relayWithPairing();
        const pc = install();
        await r.requestPairing(pc);
        const cancel = (who: Install) => r.h.app.request('/pairing/request', {
            method: 'DELETE',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ hfrId: HFR, timestamp: String(r.now()), signature: who.sign(pairingMessages.cancel({ hfrId: HFR, timestamp: String(r.now()) })) })
        });
        expect((await cancel(install())).status).toBe(401);
        expect((await cancel(pc)).status).toBe(204);
        expect(r.store.requests.size).toBe(0);
    });
});

describe('activation', () => {
    it('refuses before approval, and refuses a code signed by another key without spending attempts', async () => {
        const r = await relayWithPairing();
        const pc = install();
        await r.requestPairing(pc);
        expect(await (await r.activate(pc, 'K7QM3XRA')).json()).toEqual({ error: 'not_approved' });
        const { body } = await r.approve();
        const thief = install('Attacker');
        const stolen = await r.activate(pc, body.code, HFR, thief);
        expect(stolen.status).toBe(401);
        expect(await stolen.json()).toEqual({ error: 'bad_signature' });
        expect(r.store.requests.get(HFR)!.codeAttempts).toBe(0);
        expect((await r.activate(pc, body.code)).status).toBe(200);
    });

    it('voids the request after five wrong codes', async () => {
        const r = await relayWithPairing();
        const pc = install();
        await r.requestPairing(pc);
        await r.approve();
        for (let left = 4; left >= 1; left--) {
            const res = await r.activate(pc, 'AAAA-AAAA');
            expect(res.status).toBe(401);
            expect(await res.json()).toEqual({ error: 'bad_code', attemptsLeft: left });
        }
        const last = await r.activate(pc, 'AAAA-AAAA');
        expect(last.status).toBe(410);
        expect(await last.json()).toEqual({ error: 'request_voided' });
        expect(r.store.requests.size).toBe(0);
        expect((await r.activate(pc, 'K7QM3XRA')).status).toBe(404);
    });

    it('refuses an expired code, and staff can issue a new one', async () => {
        const r = await relayWithPairing();
        const pc = install();
        await r.requestPairing(pc);
        const first = await r.approve();
        r.advance(PAIRING_LIMITS.codeTtlMs + 1);
        expect(await (await r.activate(pc, first.body.code)).json()).toEqual({ error: 'code_expired' });
        const second = await r.approve();
        expect(second.body.code).toBe('P2V9-WN4D');
        expect((await r.activate(pc, first.body.code)).status).toBe(401);
        expect((await r.activate(pc, second.body.code)).status).toBe(200);
    });
});

describe('ops console', () => {
    it('refuses calls without a valid ops token', async () => {
        const r = await relayWithPairing();
        expect((await r.h.app.request('/ops/api/pairing-requests')).status).toBe(401);
        expect((await r.ops('GET', '/pairing-requests', undefined, await r.opsToken({ 'cognito:groups': ['clinic'] }))).status).toBe(401);
        expect((await r.ops('GET', '/pairing-requests', undefined, await r.opsToken({ client_id: 'other' }))).status).toBe(401);
        expect((await r.ops('GET', '/pairing-requests', undefined, await r.opsToken({ token_use: 'id' }))).status).toBe(401);
        expect((await r.ops('GET', '/pairing-requests', undefined, await r.opsToken({}, 'https://evil.example/pool'))).status).toBe(401);
        expect((await r.ops('GET', '/pairing-requests')).status).toBe(200);
    });

    it('rejects a request', async () => {
        const r = await relayWithPairing();
        await r.requestPairing(install());
        const { requestId } = r.store.requests.get(HFR)!;
        expect((await r.ops('POST', `/pairing-requests/${HFR}/reject`, { requestId: 'pr_wrongwrongwr' })).status).toBe(404);
        expect((await r.ops('POST', `/pairing-requests/${HFR}/reject`, { requestId })).status).toBe(204);
        expect(r.store.requests.size).toBe(0);
    });

    it('lists devices without their data push token, and revokes one', async () => {
        const r = await relayWithPairing();
        const pc = install();
        const { deviceId } = await r.pair(pc);
        const list = await (await r.ops('GET', `/devices?hipId=${HFR}`)).json() as { devices: Record<string, unknown>[] };
        expect(list.devices).toEqual([expect.objectContaining({ deviceId, status: 'active' })]);
        expect(list.devices[0]).not.toHaveProperty('dataPushToken');

        expect((await r.ops('POST', `/devices/${deviceId}/revoke`)).status).toBe(204);
        expect(r.store.devices.get(deviceId)).toMatchObject({ status: 'revoked', revokedReason: 'ops', revokedBy: 'staff-sub-1' });
        expect(r.revoked).toEqual([deviceId]);
        expect((await r.ops('POST', `/devices/${deviceId}/revoke`)).status).toBe(409);
        r.advance(31_000);
        expect((await r.signedCall(pc, deviceId)).status).toBe(401);
    });

    it('serves the console page with a strict CSP', async () => {
        const r = await relayWithPairing();
        const page = await r.h.app.request('/ops/');
        expect(page.status).toBe(200);
        const csp = page.headers.get('content-security-policy')!;
        expect(csp).toContain("default-src 'none'");
        expect(csp).toContain("script-src 'self'");
        expect(csp).toContain('connect-src \'self\' https://nalamdesk-ops-sandbox.auth.ap-south-1.amazoncognito.com');
        expect(page.headers.get('x-frame-options')).toBe('DENY');
        expect(await (await r.h.app.request('/ops/config.json')).json()).toEqual({
            authDomain: 'nalamdesk-ops-sandbox.auth.ap-south-1.amazoncognito.com', clientId: 'ops-client'
        });
        const js = await (await r.h.app.request('/ops/app.js')).text();
        expect(js).not.toContain('innerHTML');
        expect(() => new Function(js)).not.toThrow();
    });
});

describe('the active device per HFR ID', () => {
    it('revokes the device the clinic row names even when the HIP ID index has not caught up', async () => {
        const r = await relayWithPairing();
        const first = install('Old PC');
        const { deviceId: oldId } = await r.pair(first);
        r.store.devicesFor = async () => [];
        const { deviceId: newId } = await r.pair(install('New PC'));
        expect(r.store.devices.get(oldId)).toMatchObject({ status: 'revoked', revokedReason: 'replaced' });
        expect(r.store.activeDevice.get(HFR)).toBe(newId);
        expect(r.revoked).toEqual([oldId]);
    });
});

describe('a lost activation answer', () => {
    it('gives the same install the same device again, and nobody else anything', async () => {
        const r = await relayWithPairing();
        const pc = install();
        expect((await r.requestPairing(pc)).status).toBe(202);
        const { body } = await r.approve();
        const first = await (await r.activate(pc, body.code)).json() as Record<string, unknown>;

        r.advance(5_000);
        const retried = await r.activate(pc, body.code);
        expect(retried.status).toBe(200);
        expect(await retried.json()).toEqual({ ...first, serverTimeMs: START + 5_000 });
        expect(r.store.devices.size).toBe(1);

        const stranger = install('Other PC');
        expect((await r.activate(pc, body.code, HFR, stranger)).status).toBe(404);
    });
});

describe('signing key rotation', () => {
    it('swaps the key with proof from the new key and keeps the old one for the overlap', async () => {
        const r = await relayWithPairing();
        const pc = install();
        const { deviceId } = await r.pair(pc);
        const next = crypto.generateKeyPairSync('ed25519').privateKey;
        const newKey = ed25519PublicKeyRaw(next);
        const rotate = (proofKey: crypto.KeyObject) => {
            const proof = crypto.sign(null, Buffer.from(pairingMessages.rotate({ deviceId, oldKey: pc.signingPublicKey, newKey })), proofKey).toString('base64url');
            const body = JSON.stringify({ signingPublicKey: newKey, proof });
            const headers = { 'content-type': 'application/json', ...signRequest({ privateKey: pc.signing, deviceId, audience: 'relay', method: 'POST', path: '/device/rotate-key', body: new TextEncoder().encode(body), nowMs: r.now() }) };
            return r.h.app.request('/device/rotate-key', { method: 'POST', headers, body });
        };
        expect((await rotate(pc.signing)).status).toBe(401);
        expect((await rotate(next)).status).toBe(204);
        expect(r.store.devices.get(deviceId)).toMatchObject({ signingPublicKey: newKey, previousSigningPublicKey: pc.signingPublicKey });

        expect((await r.signedCall(pc, deviceId, next)).status).toBe(200);
        expect((await r.signedCall(pc, deviceId)).status).toBe(200);

        // A second rotation waits until the first key's overlap ends.
        const third = crypto.generateKeyPairSync('ed25519').privateKey;
        const thirdKey = ed25519PublicKeyRaw(third);
        const proof = crypto.sign(null, Buffer.from(pairingMessages.rotate({ deviceId, oldKey: newKey, newKey: thirdKey })), third).toString('base64url');
        const again = JSON.stringify({ signingPublicKey: thirdKey, proof });
        const againHeaders = { 'content-type': 'application/json', ...signRequest({ privateKey: next, deviceId, audience: 'relay', method: 'POST', path: '/device/rotate-key', body: new TextEncoder().encode(again), nowMs: r.now() }) };
        const refused = await r.h.app.request('/device/rotate-key', { method: 'POST', headers: againHeaders, body: again });
        expect(refused.status).toBe(409);
        expect(await refused.json()).toEqual({ error: 'rotation_in_progress' });

        r.advance(PAIRING_LIMITS.rotationOverlapMs + 31_000);
        expect((await r.signedCall(pc, deviceId)).status).toBe(401);
        expect((await r.signedCall(pc, deviceId, next)).status).toBe(200);
    });
});
