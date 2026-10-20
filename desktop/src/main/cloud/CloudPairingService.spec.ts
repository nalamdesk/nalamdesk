import * as crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { DeviceKeyStore } from '../services/DeviceKeyStore';
import { DatabaseService } from '../services/DatabaseService';
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
    const abdm: any[] = [];
    return {
        getCloudDevice: () => (row ? { ...row } : null),
        saveCloudDevice: (next: CloudDeviceRow) => { row = { ...next }; },
        clearCloudDevice: () => { row = null; },
        saveAppointmentRequest: (r: any) => { requests.push(r); },
        saveAbdmInboxItem: (r: any) => { abdm.push(r); },
        updateAppointmentRequestStatus: vi.fn(),
        acceptAppointmentRequest: vi.fn(),
        raw: () => row,
        requests,
        abdm
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
        mailbox: [] as { id: string; type: string; sealed: string }[],
        csrs: [] as string[],
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
        if (u.pathname === '/inbox') return json(200, { items: state.mailbox.map((m) => ({ ...m, createdAt: 1 })), more: false });
        if (u.pathname === '/inbox/ack') {
            state.mailbox = state.mailbox.filter((m) => !body.ids.includes(m.id));
            return json(204);
        }
        if (u.pathname === '/device/iot-certificate') {
            state.csrs.push(body.csr);
            return json(200, { certificatePem: 'CERT', endpoint: 'iot.test', clientId: d.deviceId, topic: 'nalamdesk/sandbox/clinic/cln_1/mail' });
        }
        if (u.pathname === '/api/clinic/listing') return json(200, { ok: true });
        return json(404, { error: 'not_found' });
    });
    const approve = () => {
        state.request!.code = 'ABCD1234';
        return 'ABCD-1234';
    };
    return { state, fetchFn, approve };
}

// Same format as cloud/relay/src/seal.ts.
function sealFor(plaintext: Buffer, recipientRaw: string, clinicId: string, type: string): string {
    const peer = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), Buffer.from(recipientRaw, 'base64')]), format: 'der', type: 'spki' });
    const eph = crypto.generateKeyPairSync('x25519');
    const shared = crypto.diffieHellman({ publicKey: peer, privateKey: eph.privateKey });
    const salt = crypto.randomBytes(16);
    const key = Buffer.from(crypto.hkdfSync('sha256', shared, salt, Buffer.from('nalamdesk-mailbox-v1'), 32));
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(`nalamdesk-mailbox-v1|${clinicId}|${type}`));
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.from(JSON.stringify({
        v: 1, epk: eph.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64'),
        salt: salt.toString('base64'), iv: iv.toString('base64'), ct: ct.toString('base64'), tag: cipher.getAuthTag().toString('base64')
    })).toString('base64');
}

/** Stands in for mqtt.connect: records options, connects on the next tick. */
function fakeMqtt() {
    const clients: (EventEmitter & { options: any; subscribed: string[]; ended: boolean })[] = [];
    const connect = (options: any) => {
        const client = Object.assign(new EventEmitter(), {
            options, subscribed: [] as string[], ended: false,
            subscribe(topic: string, _opts: unknown, cb: (error?: Error) => void) { client.subscribed.push(topic); cb(); },
            end() { client.ended = true; }
        });
        clients.push(client);
        setTimeout(() => client.emit('connect'), 0);
        return client as any;
    };
    return { connect, clients };
}

function setup(options: { keysAvailable?: boolean; runWork?: <T>(work: () => Promise<T>) => Promise<T> } = {}) {
    const clock = { now: 1_792_400_000_000 };
    const db = memoryDb();
    const cloud = fakeCloud(clock);
    const changes: string[] = [];
    const keys = keyStore(options.keysAvailable ?? true);
    const mqtt = fakeMqtt();
    const link = new CloudLink({
        store: db,
        keyStore: keys,
        appVersion: '2.4.0',
        baseUrl: (audience) => (audience === 'relay' ? 'https://relay.test' : 'https://book.test'),
        fetchFn: cloud.fetchFn as unknown as typeof fetch,
        nowMs: () => clock.now,
        runWork: options.runWork,
        onPairingChange: (status) => changes.push(status.state),
        mqttConnect: mqtt.connect
    });
    return { clock, db, cloud, link, pairing: link.pairing, changes, keys, mqtt };
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

    it('ignores a revocation reply for a device that is no longer the stored one', async () => {
        const { pairing, cloud, link, db } = setup();
        await pairing.request({ hfrId: HFR, label: 'PC' });
        await pairing.activate({ code: cloud.approve() });
        await pairing.markRevoked('revoked', 'dev_restored_elsewhere');
        expect(pairing.status().state).toBe('paired');
        await pairing.markRevoked('revoked', db.raw()!.device_id!);
        expect(pairing.status().state).toBe('revoked');
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
    async function paired(options: Parameters<typeof setup>[0] = {}) {
        const ctx = setup(options);
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

    it('lets a restore drain a rotation in flight, then refuses cloud work', async () => {
        const database = new DatabaseService();
        const { pairing, clock, cloud, db, link } = await paired({ runWork: (work) => database.runWork(work) });
        clock.now += SIGNING_KEY_MAX_AGE_MS + 1;
        const real = cloud.fetchFn.getMockImplementation()!;
        let release!: () => void;
        const held = new Promise<void>((resolve) => { release = resolve; });
        cloud.fetchFn.mockImplementationOnce(async (url: string, init: any) => { await held; return real(url, init); });
        const rotation = pairing.rotateSigningKeyIfDue();
        await new Promise((resolve) => setImmediate(resolve));

        let drained = false;
        const fence = database.fence(1_000).then(() => { drained = true; });
        await new Promise((resolve) => setImmediate(resolve));
        expect(drained).toBe(false);
        release();
        expect(await rotation).toBe(true);
        await fence;
        expect(db.raw()!.previous_signing_public).toBeNull();

        // The restored database goes in now; nothing written before it can follow.
        const restored = { ...db.raw()!, signing_created_at: 0 };
        db.saveCloudDevice(restored);
        await expect(pairing.rotateSigningKeyIfDue()).rejects.toThrow('RESTORE_IN_PROGRESS');
        // Listing an empty mailbox touches no local data, so it may still run.
        await expect(link.mailbox.sync()).resolves.toEqual({});
        expect(db.raw()).toEqual(restored);
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
    it('keeps a doorbell certificate saved while the rotation call was out', async () => {
        const { pairing, clock, cloud, db } = await paired();
        clock.now += SIGNING_KEY_MAX_AGE_MS + 1;
        const real = cloud.fetchFn.getMockImplementation()!;
        let release!: () => void;
        const held = new Promise<void>((resolve) => { release = resolve; });
        cloud.fetchFn.mockImplementationOnce(async (url: string, init: any) => { await held; return real(url, init); });
        const rotation = pairing.rotateSigningKeyIfDue();
        await new Promise((resolve) => setImmediate(resolve));

        const deviceId = db.raw()!.device_id as string;
        const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
        pairing.saveDoorbellIdentity(privateKey, { certificatePem: 'CERT', endpoint: 'x-ats.iot.test', clientId: deviceId, topic: 't/cln/mail' });
        release();
        expect(await rotation).toBe(true);
        const row = db.raw()!;
        expect(row.previous_signing_public).toBeNull();
        expect(row).toMatchObject({ iot_certificate_pem: 'CERT', iot_client_id: deviceId, iot_topic: 't/cln/mail' });
        expect(pairing.doorbellIdentity()?.certificatePem).toBe('CERT');
    });
});

describe('cloud link', () => {
    it('reads booking requests and ABDM callbacks from the mailbox and acknowledges them', async () => {
        const { pairing, cloud, link, db } = setup();
        await pairing.request({ hfrId: HFR, label: 'PC' });
        await pairing.activate({ code: cloud.approve() });
        const sealingRaw = db.raw()!.sealing_public;
        const booking = { v: 1, ref: '7K3P9QXA2B4M', clinicId: 'cln_1', slotId: null, slot: null, name: 'Asha', phone: '9876543210', reason: '' };
        const callback = { path: '/api/v3/hip/patient/share', receivedAt: '2026-10-19T06:00:00Z', headers: { 'request-id': 'r-1' }, body: '{"a":1}' };
        cloud.state.mailbox.push(
            { id: 'm1', type: 'booking-request', sealed: sealFor(Buffer.from(JSON.stringify(booking)), sealingRaw, 'cln_1', 'booking-request') },
            { id: 'm2', type: 'abdm-callback', sealed: sealFor(Buffer.from(JSON.stringify(callback)), sealingRaw, 'cln_1', 'abdm-callback') },
            { id: 'm3', type: 'unknown-type', sealed: 'x' }
        );
        expect(await link.checkMailbox()).toBe(1);
        expect(db.requests).toMatchObject([{ id: '7K3P9QXA2B4M', patient_name: 'Asha' }]);
        expect(db.abdm).toEqual([{ id: 'm2', type: 'abdm-callback', path: '/api/v3/hip/patient/share', request_id: 'r-1', received_at: '2026-10-19T06:00:00Z', payload: JSON.stringify({ headers: { 'request-id': 'r-1' }, body: '{"a":1}' }) }]);
        // Only what was saved is acknowledged; an unknown type waits for an app that can read it.
        expect(cloud.state.mailbox.map((m) => m.id)).toEqual(['m3']);
        expect(link.mailboxStatus().lastCheckedAt).not.toBeNull();
        link.stop();
    });

    it('connects the doorbell with its own certificate and fetches on each ring', async () => {
        const { pairing, cloud, link, db, mqtt } = setup();
        await pairing.request({ hfrId: HFR, label: 'PC' });
        await pairing.activate({ code: cloud.approve() });
        await vi.waitFor(() => expect(link.mailboxStatus().doorbell).toBe('live'));
        expect(cloud.state.csrs).toHaveLength(1);
        expect(cloud.state.csrs[0]).toMatch(/^-----BEGIN CERTIFICATE REQUEST-----/);
        const client = mqtt.clients[0]!;
        expect(client.options).toMatchObject({ host: 'iot.test', port: 8883, clientId: 'dev_abcdefghjkmnpqrs', cert: 'CERT', protocol: 'mqtts' });
        expect(client.options.key).toMatch(/BEGIN PRIVATE KEY/);
        expect(client.subscribed).toEqual(['nalamdesk/sandbox/clinic/cln_1/mail']);
        // The doorbell key is stored wrapped, never as PEM.
        expect(db.raw()!.iot_private_protected).not.toContain('PRIVATE KEY');

        const inboxCalls = () => cloud.state.calls.filter((c) => c.path === '/inbox').length;
        const before = inboxCalls();
        client.emit('message', 'nalamdesk/sandbox/clinic/cln_1/mail', Buffer.alloc(0));
        await vi.waitFor(() => expect(inboxCalls()).toBeGreaterThan(before));
        link.stop();
        expect(client.ended).toBe(true);
        expect(link.mailboxStatus().doorbell).toBe('off');
    });

    it('lets a restore drain a certificate request in flight, and saves nothing after stop', async () => {
        const database = new DatabaseService();
        const { pairing, cloud, link, db } = setup({ runWork: (work) => database.runWork(work) });
        const real = cloud.fetchFn.getMockImplementation()!;
        let release!: () => void;
        const held = new Promise<void>((resolve) => { release = resolve; });
        let asked = false;
        cloud.fetchFn.mockImplementation(async (url: string, init: any) => {
            if (new URL(url).pathname === '/device/iot-certificate') { asked = true; await held; }
            return real(url, init);
        });
        await pairing.request({ hfrId: HFR, label: 'PC' });
        await pairing.activate({ code: cloud.approve() });
        await vi.waitFor(() => expect(asked).toBe(true));

        let drained = false;
        const fence = database.fence(1_000).then(() => { drained = true; });
        await new Promise((resolve) => setImmediate(resolve));
        expect(drained).toBe(false);
        link.stop();
        release();
        await fence;
        expect(cloud.state.csrs).toHaveLength(1);
        expect(db.raw()!.iot_client_id ?? null).toBeNull();
        expect(db.raw()!.iot_certificate_pem ?? null).toBeNull();
        expect(link.mailboxStatus().doorbell).toBe('off');
    });

    it('falls back to port 443 with ALPN when 8883 is blocked', async () => {
        const { pairing, cloud, link, mqtt } = setup();
        const connect = mqtt.connect;
        let first = true;
        (link.doorbell as any).deps.connect = (options: any) => {
            if (!first) return connect(options);
            first = false;
            const blocked = Object.assign(new EventEmitter(), { options, end: () => undefined });
            mqtt.clients.push(blocked as any);
            setTimeout(() => { blocked.emit('error', new Error('ECONNREFUSED')); blocked.emit('close'); }, 0);
            return blocked as any;
        };
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
        try {
            await pairing.request({ hfrId: HFR, label: 'PC' });
            await pairing.activate({ code: cloud.approve() });
            await vi.waitFor(async () => {
                await vi.advanceTimersByTimeAsync(1_000);
                expect(link.mailboxStatus().doorbell).toBe('live');
            }, { timeout: 2_000, interval: 1 });
        } finally {
            link.stop();
            vi.useRealTimers();
        }
        expect(mqtt.clients.map((c) => c.options.port)).toEqual([8883, 443]);
        expect(mqtt.clients[1]!.options.ALPNProtocols).toEqual(['x-amzn-mqtt-ca']);
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
