import * as crypto from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { DeviceKeyStore } from '../services/DeviceKeyStore';
import { CloudLink } from './CloudLink';
import { SIGNING_KEY_MAX_AGE_MS } from './CloudPairingService';
import type { CloudDeviceRow } from './DeviceIdentity';
import { bodySha256, canonicalRequest, normalizePairingCode, pairingMessages, type Audience } from './requestSigning';

vi.mock('electron-log', () => ({ default: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const HFR = 'IN2710000123';
const ED_SPKI = Buffer.from('302a300506032b6570032100', 'hex');
const edKey = (raw: string) => crypto.createPublicKey({ key: Buffer.concat([ED_SPKI, Buffer.from(raw, 'base64')]), format: 'der', type: 'spki' });
const verify = (raw: string, message: string, signature: string) => {
    try {
        return crypto.verify(null, Buffer.from(message), edKey(raw), Buffer.from(signature, 'base64url'));
    } catch {
        return false;
    }
};

/** A keychain stand-in that really wraps, so the database never holds raw keys. */
function keyStore(available = true): DeviceKeyStore & { mask: number } {
    const store = {
        mask: 0x5a,
        status: () => (available ? { available: true, provider: 'test' } : { available: false, provider: 'test', reason: 'ENCRYPTION_UNAVAILABLE' as const }),
        protect: (value: Buffer) => Buffer.from(value.map((b) => b ^ store.mask)),
        unprotect: (value: Buffer) => Buffer.from(value.map((b) => b ^ store.mask))
    };
    return store;
}

function memoryDb() {
    let row: CloudDeviceRow | null = null;
    const requests: any[] = [];
    return {
        getCloudDevice: () => (row ? { ...row } : null),
        saveCloudDevice: (next: CloudDeviceRow) => { row = { ...next }; },
        clearCloudDevice: () => { row = null; },
        saveAppointmentRequest: (r: any) => { requests.push(r); },
        updateAppointmentRequestStatus: vi.fn(),
        raw: () => row,
        requests
    };
}

/**
 * Just enough of the relay and booking API: pairing as the relay does it
 * (signatures checked, staff approval as a test step) and signed calls
 * verified with the canonical string.
 */
function fakeCloud(clock: { now: number }) {
    const state = {
        request: null as null | { hfrId: string; signingPublicKey: string; sealingPublicKey: string; code?: string; attempts: number },
        device: null as null | { deviceId: string; key: string; previous?: string; status: 'active' | 'revoked' },
        serverOffset: 0,
        calls: [] as { method: string; path: string; audience: Audience }[]
    };
    const json = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status });
    const fetchFn = vi.fn(async (url: string, init: any) => {
        const u = new URL(url);
        const audience: Audience = u.host === 'relay.test' ? 'relay' : 'booking';
        const method = init.method as string;
        state.calls.push({ method, path: u.pathname, audience });
        const bodyBytes = init.body ? Buffer.from(init.body) : Buffer.alloc(0);
        const body = bodyBytes.length ? JSON.parse(bodyBytes.toString()) : {};
        const serverNow = clock.now + state.serverOffset;
        const skewed = (ts: string) => Math.abs(serverNow - Number(ts)) > 60_000;

        if (u.pathname === '/pairing/request' && method === 'POST') {
            if (skewed(body.timestamp)) return json(401, { error: 'clock_skew', serverTime: serverNow });
            const message = pairingMessages.request({ ...body });
            if (!verify(body.signingPublicKey, message, body.signature)) return json(401, { error: 'bad_signature' });
            if (state.request && state.request.signingPublicKey !== body.signingPublicKey) return json(409, { error: 'pending_exists' });
            state.request ??= { hfrId: body.hfrId, signingPublicKey: body.signingPublicKey, sealingPublicKey: body.sealingPublicKey, attempts: 0 };
            return json(202, { requestId: 'pr_abc', expiresAt: serverNow + 86_400_000 });
        }
        if (u.pathname === '/pairing/request' && method === 'DELETE') {
            if (!state.request) return json(404, { error: 'no_request' });
            if (!verify(state.request.signingPublicKey, pairingMessages.cancel(body), body.signature)) return json(401, { error: 'bad_signature' });
            state.request = null;
            return json(204);
        }
        if (u.pathname === '/pairing/activate') {
            const r = state.request;
            if (!r) return json(404, { error: 'no_request' });
            if (skewed(body.timestamp)) return json(401, { error: 'clock_skew', serverTime: serverNow });
            const message = pairingMessages.activate({ ...body, signingPublicKey: r.signingPublicKey, sealingPublicKey: r.sealingPublicKey });
            if (!verify(r.signingPublicKey, message, body.signature)) return json(401, { error: 'bad_signature' });
            if (!r.code) return json(409, { error: 'not_approved' });
            if (body.code !== r.code) {
                r.attempts++;
                if (r.attempts >= 5) {
                    state.request = null;
                    return json(410, { error: 'request_voided' });
                }
                return json(401, { error: 'bad_code', attemptsLeft: 5 - r.attempts });
            }
            state.device = { deviceId: 'dev_abcdefghjkmnpqrs', key: r.signingPublicKey, status: 'active' };
            state.request = null;
            return json(200, { deviceId: state.device.deviceId, clinicId: 'cln_1', hipId: HFR, dataPushUrl: 'https://relay.test/hiu/data-push/x', serverTimeMs: serverNow });
        }

        // Signed calls.
        const h = init.headers as Record<string, string>;
        const d = state.device;
        if (!d || h['x-nd-device'] !== d.deviceId) return json(401, { error: 'device_unknown' });
        if (d.status === 'revoked') return json(401, { error: 'device_revoked' });
        if (skewed(h['x-nd-timestamp'] as string)) return json(401, { error: 'clock_skew', serverTime: serverNow });
        const canonical = canonicalRequest({
            audience, method, path: u.pathname, query: u.search.slice(1), bodySha256: bodySha256(bodyBytes),
            timestamp: h['x-nd-timestamp'] as string, nonce: h['x-nd-nonce'] as string, hipId: h['x-hip-id'] ?? ''
        });
        const signedBy = [d.key, d.previous].find((k) => k && verify(k, canonical, h['x-nd-signature'] as string));
        if (!signedBy) return json(401, { error: 'bad_signature' });
        if (u.pathname === '/device/rotate-key') {
            if (body.signingPublicKey === d.key) return json(400, { error: 'same_key' });
            if (!verify(body.signingPublicKey, pairingMessages.rotate({ deviceId: d.deviceId, oldKey: d.key, newKey: body.signingPublicKey }), body.proof)) {
                return json(401, { error: 'bad_proof' });
            }
            d.previous = d.key;
            d.key = body.signingPublicKey;
            return json(204);
        }
        if (u.pathname === '/inbox') return json(404, { error: 'not_found' });
        if (u.pathname === '/api/clinic/listing') return json(200, { ok: true });
        return json(404, { error: 'not_found' });
    });
    const approve = () => {
        state.request!.code = 'ABCD1234';
        return 'ABCD-1234';
    };
    return { state, fetchFn, approve };
}

function setup(options: { keysAvailable?: boolean } = {}) {
    const clock = { now: 1_792_400_000_000 };
    const db = memoryDb();
    const cloud = fakeCloud(clock);
    const changes: string[] = [];
    const keys = keyStore(options.keysAvailable ?? true);
    const link = new CloudLink({
        store: db,
        keyStore: keys,
        appVersion: '2.4.0',
        baseUrl: (audience) => (audience === 'relay' ? 'https://relay.test' : 'https://book.test'),
        fetchFn: cloud.fetchFn as unknown as typeof fetch,
        nowMs: () => clock.now,
        onPairingChange: (status) => changes.push(status.state)
    });
    return { clock, db, cloud, link, pairing: link.pairing, changes, keys };
}

describe('pairing this computer', () => {
    it('requests, waits for approval, and pairs with the code read to the clinic', async () => {
        const { pairing, cloud, db, changes, link } = setup();
        expect(pairing.status()).toMatchObject({ state: 'unpaired', configured: true });

        const requested = await pairing.request({ hfrId: ' in2710000123 ', label: 'Reception PC' });
        expect(requested).toMatchObject({ state: 'requested', hfrId: HFR, label: 'Reception PC' });
        expect(requested.keyFingerprint).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
        // Only wrapped private keys reach the database.
        const row = db.raw()!;
        expect(row.signing_private_protected).not.toContain(row.signing_public);
        await expect(pairing.activate({ code: 'ABCD-1234' })).rejects.toMatchObject({ code: 'not_approved' });

        const code = cloud.approve();
        await expect(pairing.activate({ code: 'abcd-1235' })).rejects.toMatchObject({ code: 'bad_code', extra: { attemptsLeft: 4 } });
        const paired = await pairing.activate({ code: code.toLowerCase() });
        expect(paired).toMatchObject({ state: 'paired', deviceId: 'dev_abcdefghjkmnpqrs', clinicId: 'cln_1', hfrId: HFR });
        expect(db.raw()).toMatchObject({ state: 'paired', data_push_url: 'https://relay.test/hiu/data-push/x', request_id: null });
        expect(changes).toEqual(['requested', 'paired']);

        // Paired requests are signed and accepted.
        await link.booking.enableListing({ name: 'Arogya', city: 'Chennai' });
        expect(cloud.state.calls.at(-1)).toMatchObject({ audience: 'booking', path: '/api/clinic/listing', method: 'PUT' });
        link.stop();
    });

    it('re-sends an open request with the same keys instead of making new ones', async () => {
        const { pairing, db } = setup();
        await pairing.request({ hfrId: HFR, label: 'PC' });
        const first = db.raw()!.signing_public;
        await pairing.request({ hfrId: HFR, label: 'PC' });
        expect(db.raw()!.signing_public).toBe(first);
    });

    it('repeats a request whose answer was lost with the same keys', async () => {
        const { pairing, cloud, db } = setup();
        const real = cloud.fetchFn.getMockImplementation()!;
        cloud.fetchFn.mockImplementationOnce(async (url: string, init: any) => {
            await real(url, init); // the relay records it, then the answer is lost
            throw new TypeError('fetch failed');
        });
        await expect(pairing.request({ hfrId: HFR, label: 'PC' })).rejects.toThrow('fetch failed');
        expect(db.raw()!.signing_public).toBe(cloud.state.request!.signingPublicKey);
        expect(await pairing.request({ hfrId: HFR, label: 'PC' })).toMatchObject({ state: 'requested' });
        expect(db.raw()!.request_id).toBe('pr_abc');
    });

    it('puts back the earlier state when the cloud refuses a request', async () => {
        const { pairing, cloud, db } = setup();
        cloud.state.request = { hfrId: HFR, signingPublicKey: 'someone-else', sealingPublicKey: 'x', attempts: 0 };
        await expect(pairing.request({ hfrId: HFR, label: 'PC' })).rejects.toMatchObject({ code: 'pending_exists' });
        expect(db.raw()).toBeNull();
    });

    it('keeps a request open when the computer clock is a day ahead', async () => {
        const { pairing, cloud, clock } = setup();
        cloud.state.serverOffset = -(2 * 86_400_000);
        await pairing.request({ hfrId: HFR, label: 'PC' });
        const status = pairing.status();
        expect(status.state).toBe('requested');
        expect(status.requestExpiresAt).toBe(clock.now + 86_400_000);
    });

    it('offers to start over when an open request\'s keys cannot be read', async () => {
        const { pairing, keys } = setup();
        await pairing.request({ hfrId: HFR, label: 'PC' });
        keys.mask = 0x11;
        (pairing as any).cache = null;
        expect(pairing.status().state).toBe('keys_unavailable');
    });

    it('refuses a malformed HFR ID or code before calling the cloud', async () => {
        const { pairing, cloud } = setup();
        await expect(pairing.request({ hfrId: 'HIP-1', label: 'PC' })).rejects.toMatchObject({ code: 'bad_hfr_id' });
        await pairing.request({ hfrId: HFR, label: 'PC' });
        const calls = cloud.fetchFn.mock.calls.length;
        await expect(pairing.activate({ code: '12' })).rejects.toMatchObject({ code: 'bad_code_format' });
        expect(cloud.fetchFn.mock.calls.length).toBe(calls);
    });

    it('drops the local request when five wrong codes void it', async () => {
        const { pairing, cloud } = setup();
        await pairing.request({ hfrId: HFR, label: 'PC' });
        cloud.approve();
        for (let i = 0; i < 4; i++) await expect(pairing.activate({ code: 'ZZZZ-ZZZZ' })).rejects.toMatchObject({ code: 'bad_code' });
        await expect(pairing.activate({ code: 'ZZZZ-ZZZZ' })).rejects.toMatchObject({ code: 'request_voided' });
        expect(pairing.status().state).toBe('unpaired');
    });

    it('cancels an open request', async () => {
        const { pairing, cloud } = setup();
        await pairing.request({ hfrId: HFR, label: 'PC' });
        expect(await pairing.cancel()).toMatchObject({ state: 'unpaired' });
        expect(cloud.state.request).toBeNull();
    });

    it('signs again with the cloud\'s time when the computer clock is off', async () => {
        const { pairing, cloud, link, clock } = setup();
        cloud.state.serverOffset = 5 * 60_000;
        await pairing.request({ hfrId: HFR, label: 'PC' });
        await pairing.activate({ code: cloud.approve() });
        expect(pairing.status().state).toBe('paired');
        expect(link.client.now()).toBe(clock.now + 5 * 60_000);
        await link.booking.enableListing({ name: 'Arogya', city: 'Chennai' });
        link.stop();
    });

    it('marks the computer revoked when the cloud says so, and starts over only after that', async () => {
        const { pairing, cloud, link } = setup();
        await pairing.request({ hfrId: HFR, label: 'PC' });
        await pairing.activate({ code: cloud.approve() });
        expect(() => pairing.forget()).toThrow(/still paired/);

        cloud.state.device!.status = 'revoked';
        await expect(link.booking.enableListing({ name: 'A', city: 'B' })).rejects.toThrow();
        expect(pairing.status()).toMatchObject({ state: 'revoked', revokedReason: 'revoked' });
        expect(pairing.signingIdentity()).toBeNull();
        expect(pairing.forget().state).toBe('unpaired');
        link.stop();
    });

    it('reports keys it cannot read (a backup restored on another computer)', async () => {
        const { pairing, cloud, keys, link } = setup();
        await pairing.request({ hfrId: HFR, label: 'PC' });
        await pairing.activate({ code: cloud.approve() });
        keys.mask = 0x11; // a different keychain
        (pairing as any).cache = null;
        expect(pairing.status().state).toBe('keys_unavailable');
        expect(pairing.signingIdentity()).toBeNull();
        expect(pairing.forget().state).toBe('unpaired');
        link.stop();
    });

    it('will not pair when the OS keychain is unavailable', async () => {
        const { pairing, cloud } = setup({ keysAvailable: false });
        await expect(pairing.request({ hfrId: HFR, label: 'PC' })).rejects.toThrow(/ENCRYPTION_UNAVAILABLE/);
        expect(cloud.state.request).toBeNull();
    });
});

describe('signing key rotation', () => {
    async function paired() {
        const ctx = setup();
        await ctx.pairing.request({ hfrId: HFR, label: 'PC' });
        await ctx.pairing.activate({ code: ctx.cloud.approve() });
        ctx.link.stop();
        return ctx;
    }

    it('waits a year, then swaps the key with the relay', async () => {
        const { pairing, clock, cloud, db } = await paired();
        expect(await pairing.rotateSigningKeyIfDue()).toBe(false);
        const before = db.raw()!.signing_public;
        clock.now += SIGNING_KEY_MAX_AGE_MS + 1;
        expect(await pairing.rotateSigningKeyIfDue()).toBe(true);
        const after = db.raw()!;
        expect(after.signing_public).not.toBe(before);
        expect(cloud.state.device!.key).toBe(after.signing_public);
        expect(after.previous_signing_public).toBeNull();
        expect(pairing.signingIdentity()).not.toBeNull();
    });

    it('keeps signing with the confirmed key until the relay takes the new one', async () => {
        const { pairing, clock, cloud, db, link } = await paired();
        const confirmed = db.raw()!.signing_public;
        clock.now += SIGNING_KEY_MAX_AGE_MS + 1;
        const real = cloud.fetchFn.getMockImplementation()!;
        cloud.fetchFn.mockImplementationOnce(async () => { throw new TypeError('fetch failed'); });
        await expect(pairing.rotateSigningKeyIfDue()).rejects.toThrow('fetch failed');
        expect(db.raw()!.previous_signing_public).toBe(confirmed);
        // Ordinary calls still work with the key the relay knows.
        cloud.fetchFn.mockImplementation(real);
        await link.booking.enableListing({ name: 'Arogya', city: 'Chennai' });
        expect(await pairing.rotateSigningKeyIfDue()).toBe(true);
        expect(cloud.state.device!.key).toBe(db.raw()!.signing_public);
        await link.booking.enableListing({ name: 'Arogya', city: 'Chennai' });
        link.stop();
    });

    it('finishes a rotation that was cut off after the relay accepted it', async () => {
        const { pairing, clock, cloud, db } = await paired();
        clock.now += SIGNING_KEY_MAX_AGE_MS + 1;
        const original = db.saveCloudDevice;
        let saves = 0;
        // Crash on the save that clears the old key.
        db.saveCloudDevice = (row) => {
            if (++saves === 2) throw new Error('crash');
            original(row);
        };
        await expect(pairing.rotateSigningKeyIfDue()).rejects.toThrow('crash');
        db.saveCloudDevice = original;
        expect(db.raw()!.previous_signing_public).not.toBeNull();
        expect(cloud.state.device!.key).toBe(db.raw()!.signing_public);
        // Next start: the relay already holds the new key (same_key) and the rotation completes.
        expect(await pairing.rotateSigningKeyIfDue()).toBe(true);
        expect(db.raw()!.previous_signing_public).toBeNull();
    });
});

describe('cloud link', () => {
    it('treats a relay without a mailbox yet as an empty inbox', async () => {
        const { pairing, cloud, link, db } = setup();
        await pairing.request({ hfrId: HFR, label: 'PC' });
        await pairing.activate({ code: cloud.approve() });
        expect(await link.booking.sync()).toBe(0);
        expect(db.requests).toEqual([]);
        link.stop();
    });

    it('stays off when the build has no cloud address', () => {
        const link = new CloudLink({
            store: memoryDb(), keyStore: keyStore(), appVersion: '2.4.0', baseUrl: () => null
        });
        expect(link.pairing.status()).toMatchObject({ state: 'unpaired', configured: false });
        link.start();
        link.stop();
    });
});

it('normalizes codes the same way as the relay', () => {
    expect(normalizePairingCode('abcd-1234')).toBe('ABCD1234');
});
