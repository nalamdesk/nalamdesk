import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as https from 'node:https';
import * as os from 'node:os';
import { DatabaseService } from '../main/services/DatabaseService';
import { TestDatabase } from '../main/testing/TestDatabase';
import { ApiServer } from './app';
import { LoginLimiter } from './rate-limit';
import { generateSelfSignedCertificate, certificateFingerprint } from './tls';
import { formatJoinCode } from '../shared/join-code';
import { DEVICE_HEADER, PROTOCOL_HEADER, PROTOCOL_VERSION } from '../shared/protocol';
import { NO_PIN_FINGERPRINT } from './network';

// These specs exercise the vault-held signing key, not the env override.
delete process.env['JWT_SECRET'];

const PASSWORD = 'correct horse battery staple';

async function freshDb(): Promise<{ service: DatabaseService; raw: TestDatabase }> {
    const raw = new TestDatabase();
    const service = new DatabaseService();
    service.setDb(raw);
    await service.migrate({ skipBackup: true });
    await service.ensureAdminUser(PASSWORD);
    return { service, raw };
}

describe('NalamDesk Server network and auth', () => {
    let db: { service: DatabaseService; raw: TestDatabase };
    let server: ApiServer;
    let now: number;

    beforeEach(async () => {
        db = await freshDb();
        now = Date.UTC(2026, 10, 1, 9, 0, 0);
        server = new ApiServer(db.service, os.tmpdir(), undefined, undefined, {
            requireDevice: true,
            now: () => now,
            loginLimiter: new LoginLimiter({ now: () => now })
        });
    });

    afterEach(async () => {
        await server.close();
    });

    const post = (url: string, payload: unknown, headers: Record<string, string> = {}) =>
        server.inject({ method: 'POST', url, payload: payload as any, headers: { 'content-type': 'application/json', ...headers } });

    async function joinComputer(name = 'Front desk') {
        const { code } = server.issueJoinCode({ createdBy: null });
        const res = await post('/api/devices/join', { code, name });
        expect(res.statusCode).toBe(200);
        return res.json() as { deviceId: string; deviceToken: string; deviceName: string };
    }

    async function signIn(deviceToken: string, password = PASSWORD) {
        return post('/api/auth/login', { username: 'admin', password }, { [DEVICE_HEADER]: deviceToken });
    }

    it('says hello with its protocol and refuses clients outside the window', async () => {
        const hello = await server.inject({ method: 'GET', url: '/api/server/hello' });
        expect(hello.statusCode).toBe(200);
        expect(hello.headers[PROTOCOL_HEADER]).toBe(String(PROTOCOL_VERSION));
        expect(hello.json()).toMatchObject({ product: 'nalamdesk-server', protocol: PROTOCOL_VERSION, requireDevice: true });

        const tooNew = await server.inject({ method: 'GET', url: '/api/server/hello', headers: { [PROTOCOL_HEADER]: String(PROTOCOL_VERSION + 1) } });
        expect(tooNew.statusCode).toBe(426);
        expect(tooNew.json()).toMatchObject({ upgrade: 'server' });
    });

    it('lets only joined computers sign in', async () => {
        const res = await post('/api/auth/login', { username: 'admin', password: PASSWORD });
        expect(res.statusCode).toBe(401);
        expect(res.json()).toEqual({ error: 'DEVICE_NOT_JOINED' });
        const bogus = await signIn('ndd_nope.nope');
        expect(bogus.statusCode).toBe(401);
    });

    it('redeems a join code once and binds sessions to the computer', async () => {
        const { code } = server.issueJoinCode({ createdBy: null, deviceName: 'Reception PC' });
        const joined = await post('/api/devices/join', { code: code.toLowerCase(), name: 'ignored' });
        expect(joined.statusCode).toBe(200);
        const device = joined.json();
        expect(device.deviceName).toBe('Reception PC');
        expect(device.deviceToken).toMatch(/^ndd_/);

        const again = await post('/api/devices/join', { code, name: 'x' });
        expect(again.statusCode).toBe(401);

        const login = await signIn(device.deviceToken);
        expect(login.statusCode).toBe(200);
        const { token, refreshToken, expiresIn } = login.json();
        expect(expiresIn).toBe(15 * 60);
        expect(refreshToken).toMatch(/^ndr_/);

        const call = (headers: Record<string, string>) => post('/api/ipc/getQueue', [], { authorization: `Bearer ${token}`, ...headers });
        expect((await call({ [DEVICE_HEADER]: device.deviceToken })).statusCode).toBe(200);
        // The same token from another computer (or none) is refused.
        expect((await call({})).statusCode).toBe(401);
        const other = await joinComputer('Other');
        expect((await call({ [DEVICE_HEADER]: other.deviceToken })).statusCode).toBe(401);
    });

    it('rejects a code meant for another server and expired codes', async () => {
        const wrong = formatJoinCode('ABCDEFGH', 'ab'.repeat(32));
        expect((await post('/api/devices/join', { code: wrong })).json()).toEqual({ error: 'WRONG_SERVER' });

        const { code } = server.issueJoinCode({ createdBy: null });
        now += 16 * 60_000;
        expect((await post('/api/devices/join', { code })).statusCode).toBe(401);
    });

    it('voids outstanding codes after repeated wrong guesses', async () => {
        const { code } = server.issueJoinCode({ createdBy: null });
        for (let i = 0; i < 20; i++) {
            const guess = formatJoinCode(`GUESS${String(i).padStart(3, '0')}`.replace(/[ILOU]/g, 'X'), NO_PIN_FINGERPRINT);
            await server.inject({
                method: 'POST', url: '/api/devices/join', payload: { code: guess },
                headers: { 'content-type': 'application/json' }, remoteAddress: `10.0.0.${i}`
            } as any);
        }
        const res = await post('/api/devices/join', { code });
        expect(res.statusCode).toBe(401);
    });

    it('refreshes with rotation and ends the session when a refresh token is reused', async () => {
        const device = await joinComputer();
        const first = (await signIn(device.deviceToken)).json();
        const headers = { [DEVICE_HEADER]: device.deviceToken };

        const second = await post('/api/auth/refresh', { refreshToken: first.refreshToken }, headers);
        expect(second.statusCode).toBe(200);
        const rotated = second.json();
        expect(rotated.refreshToken).not.toBe(first.refreshToken);

        // Refresh from another computer is refused.
        const other = await joinComputer('Other');
        expect((await post('/api/auth/refresh', { refreshToken: rotated.refreshToken }, { [DEVICE_HEADER]: other.deviceToken })).statusCode).toBe(401);

        // Replaying the old refresh token revokes the whole session.
        expect((await post('/api/auth/refresh', { refreshToken: first.refreshToken }, headers)).statusCode).toBe(401);
        expect((await post('/api/ipc/getQueue', [], { authorization: `Bearer ${rotated.token}`, ...headers })).statusCode).toBe(401);
        expect((await post('/api/auth/refresh', { refreshToken: rotated.refreshToken }, headers)).statusCode).toBe(401);
    });

    it('picks up role changes and deactivation at refresh', async () => {
        const device = await joinComputer();
        const headers = { [DEVICE_HEADER]: device.deviceToken };
        const first = (await signIn(device.deviceToken)).json();
        db.raw.prepare(`UPDATE users SET active = 0 WHERE username = 'admin'`).run();
        expect((await post('/api/auth/refresh', { refreshToken: first.refreshToken }, headers)).statusCode).toBe(401);
    });

    it('ends sessions at once when the user is deactivated or their password changes', async () => {
        const device = await joinComputer();
        const headers = { [DEVICE_HEADER]: device.deviceToken };
        const call = (token: string) => post('/api/ipc/getQueue', [], { authorization: `Bearer ${token}`, ...headers });

        const a = (await signIn(device.deviceToken)).json();
        db.raw.prepare(`UPDATE users SET password = 'changed-elsewhere' WHERE username = 'admin'`).run();
        expect((await call(a.token)).statusCode).toBe(401);
        expect((await post('/api/auth/refresh', { refreshToken: a.refreshToken }, headers)).statusCode).toBe(401);

        await db.service.saveUser({ username: 'nurse2', password: PASSWORD, role: 'nurse', name: 'Nurse' } as any, 1);
        const b = (await post('/api/auth/login', { username: 'nurse2', password: PASSWORD }, headers)).json();
        db.raw.prepare(`UPDATE users SET active = 0 WHERE username = 'nurse2'`).run();
        expect((await call(b.token)).statusCode).toBe(401);
    });

    it('makes a role change take effect through refresh', async () => {
        const device = await joinComputer();
        const headers = { [DEVICE_HEADER]: device.deviceToken };
        await db.service.saveUser({ username: 'desk2', password: PASSWORD, role: 'receptionist', name: 'Desk' } as any, 1);
        const a = (await post('/api/auth/login', { username: 'desk2', password: PASSWORD }, headers)).json();
        db.raw.prepare(`UPDATE users SET role = 'nurse' WHERE username = 'desk2'`).run();
        expect((await post('/api/ipc/getQueue', [], { authorization: `Bearer ${a.token}`, ...headers })).statusCode).toBe(401);
        const refreshed = await post('/api/auth/refresh', { refreshToken: a.refreshToken }, headers);
        expect(refreshed.statusCode).toBe(200);
        expect(refreshed.json().user.role).toBe('nurse');
    });

    it('applies the admin address restriction at refresh too', async () => {
        const device = await joinComputer();
        const headers = { [DEVICE_HEADER]: device.deviceToken };
        const a = (await signIn(device.deviceToken)).json();
        process.env['STRICT_ADMIN_IP'] = 'true';
        try {
            const res = await server.inject({
                method: 'POST', url: '/api/auth/refresh', payload: { refreshToken: a.refreshToken },
                headers: { 'content-type': 'application/json', ...headers }, remoteAddress: '192.168.1.20'
            } as any);
            expect(res.statusCode).toBe(403);
        } finally {
            delete process.env['STRICT_ADMIN_IP'];
        }
    });

    it('signs out on logout and when an admin revokes the computer', async () => {
        const device = await joinComputer();
        const headers = { [DEVICE_HEADER]: device.deviceToken };
        const a = (await signIn(device.deviceToken)).json();
        const logout = await post('/api/auth/logout', {}, { authorization: `Bearer ${a.token}`, ...headers });
        expect(logout.statusCode).toBe(200);
        expect((await post('/api/ipc/getQueue', [], { authorization: `Bearer ${a.token}`, ...headers })).statusCode).toBe(401);

        const b = (await signIn(device.deviceToken)).json();
        const admin = { authorization: `Bearer ${b.token}`, ...headers };
        const list = await server.inject({ method: 'GET', url: '/api/admin/devices', headers: admin });
        expect(list.json().map((d: any) => d.id)).toContain(device.deviceId);
        const issued = await post('/api/admin/join-codes', { deviceName: 'Lab' }, admin);
        expect(issued.json()).toMatchObject({ deviceName: 'Lab' });

        const revoked = await server.inject({ method: 'DELETE', url: `/api/admin/devices/${device.deviceId}`, headers: admin });
        expect(revoked.json()).toEqual({ revoked: true });
        expect((await post('/api/ipc/getQueue', [], admin)).statusCode).toBe(401);
        expect((await signIn(device.deviceToken)).statusCode).toBe(401);
    });

    it('keeps sessions across a restart (signing key in the vault)', async () => {
        const device = await joinComputer();
        const { token } = (await signIn(device.deviceToken)).json();
        await server.close();
        server = new ApiServer(db.service, os.tmpdir(), undefined, undefined, { requireDevice: true, now: () => now });
        const res = await post('/api/ipc/getQueue', [], { authorization: `Bearer ${token}`, [DEVICE_HEADER]: device.deviceToken });
        expect(res.statusCode).toBe(200);
        const secret = db.raw.prepare(`SELECT value FROM server_secrets WHERE name = 'session_signing_key'`).get() as any;
        expect(secret.value.length).toBeGreaterThan(40);
    });

    it('locks sign-in after repeated wrong passwords and audits with the computer', async () => {
        const device = await joinComputer();
        for (let i = 0; i < 5; i++) {
            expect((await signIn(device.deviceToken, 'wrong')).statusCode).toBe(401);
        }
        const locked = await signIn(device.deviceToken);
        expect(locked.statusCode).toBe(429);
        expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
        now += 61_000;
        expect((await signIn(device.deviceToken)).statusCode).toBe(200);

        const rows = db.raw.prepare(`SELECT action, device_id FROM audit_logs WHERE table_name = 'server_auth' ORDER BY id`).all() as any[];
        const actions = rows.map((r) => r.action);
        expect(actions).toEqual(expect.arrayContaining(['DEVICE_JOIN', 'LOGIN_FAILED', 'LOGIN_LOCKED', 'LOGIN']));
        expect(rows.find((r) => r.action === 'LOGIN').device_id).toBe(device.deviceId);
        const logs = db.service.getAuditLogs(50) as any[];
        expect(logs.find((l) => l.action === 'LOGIN').device_name).toBe('Front desk');
    });

    it('records the computer on audit rows written by API calls', async () => {
        const device = await joinComputer();
        const { token } = (await signIn(device.deviceToken)).json();
        const res = await post('/api/ipc/saveRole', [{ name: 'triage', permissions: ['getQueue'] }],
            { authorization: `Bearer ${token}`, [DEVICE_HEADER]: device.deviceToken });
        expect(res.statusCode).toBe(200);
        const row = db.raw.prepare(`SELECT device_id FROM audit_logs WHERE table_name = 'roles' ORDER BY id DESC LIMIT 1`).get() as any;
        expect(row?.device_id).toBe(device.deviceId);
    });

    it('refuses non-admins on admin routes', async () => {
        const device = await joinComputer();
        await db.service.saveUser({ username: 'nurse1', password: PASSWORD, role: 'nurse', name: 'Nurse' } as any, 1);
        const login = await post('/api/auth/login', { username: 'nurse1', password: PASSWORD }, { [DEVICE_HEADER]: device.deviceToken });
        expect(login.statusCode).toBe(200);
        const res = await server.inject({ method: 'GET', url: '/api/admin/devices', headers: { authorization: `Bearer ${login.json().token}`, [DEVICE_HEADER]: device.deviceToken } });
        expect(res.statusCode).toBe(403);
    });

    it('answers 503 until the vault is open', async () => {
        const locked = new DatabaseService();
        const early = new ApiServer(locked, os.tmpdir(), undefined, undefined, { requireDevice: true });
        try {
            const res = await early.inject({ method: 'POST', url: '/api/devices/join', payload: { code: 'x' }, headers: { 'content-type': 'application/json' } });
            expect(res.statusCode).toBe(503);
        } finally {
            await early.close();
        }
    });
});

describe('HTTPS and the live events stream', () => {
    let server: ApiServer;
    let fingerprint: string;
    let cert: string;
    let db: { service: DatabaseService; raw: TestDatabase };

    beforeAll(() => {
        const generated = generateSelfSignedCertificate({ hostnames: ['localhost', '127.0.0.1'] });
        cert = generated.cert;
        fingerprint = certificateFingerprint(cert);
        process.env['NALAMDESK_TEST_TLS_KEY'] = generated.key;
    });

    afterEach(async () => {
        await server?.close();
    });

    function request(port: number, method: string, path: string, headers: Record<string, string>, body?: unknown) {
        return new Promise<{ status: number; body: string; peerFingerprint: string }>((resolve, reject) => {
            const req = https.request({
                host: '127.0.0.1', port, method, path, headers: { 'content-type': 'application/json', ...headers },
                // Pin the certificate the way a client does after reading the join code.
                ca: cert, checkServerIdentity: () => undefined
            }, (res) => {
                const peerFingerprint = String((res.socket as any).getPeerCertificate().fingerprint256 ?? '').replace(/:/g, '').toLowerCase();
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data, peerFingerprint }));
            });
            req.on('error', reject);
            if (body !== undefined) req.write(JSON.stringify(body));
            req.end();
        });
    }

    it('serves HTTPS with the pinned certificate and streams change events', async () => {
        db = await freshDb();
        server = new ApiServer(db.service, os.tmpdir(), undefined, undefined, {
            requireDevice: true,
            tls: { key: process.env['NALAMDESK_TEST_TLS_KEY']!, cert, selfSigned: true, fingerprint256: fingerprint }
        });
        await server.start(0, '127.0.0.1');
        const port = (server as any).fastify.server.address().port as number;

        const saved: any = db.service.savePatient({ name: 'Stream Patient', age: 40, gender: 'Male', mobile: '9876500001' });
        const patientId = Number(saved?.id ?? saved?.lastInsertRowid);
        const { code } = server.issueJoinCode({ createdBy: null });
        const joined = await request(port, 'POST', '/api/devices/join', {}, { code, name: 'Doctor room' });
        expect(joined.status).toBe(200);
        const device = JSON.parse(joined.body);
        expect(device.tls).toEqual({ selfSigned: true, fingerprint256: fingerprint });
        expect(joined.peerFingerprint).toBe(fingerprint);

        const login = await request(port, 'POST', '/api/auth/login', { [DEVICE_HEADER]: device.deviceToken }, { username: 'admin', password: PASSWORD });
        const { token } = JSON.parse(login.body);
        const headers = { authorization: `Bearer ${token}`, [DEVICE_HEADER]: device.deviceToken };

        const received = await new Promise<string>((resolve, reject) => {
            const req = https.request({
                host: '127.0.0.1', port, method: 'GET', path: '/api/events', headers,
                ca: cert, checkServerIdentity: () => undefined
            }, (res) => {
                expect(res.statusCode).toBe(200);
                expect(res.headers['content-type']).toContain('text/event-stream');
                let data = '';
                res.on('data', (chunk) => {
                    data += chunk;
                    if (data.includes('event: queue')) {
                        req.destroy();
                        resolve(data);
                    }
                });
                // Once subscribed, change the queue through the API.
                setTimeout(() => {
                    request(port, 'POST', '/api/ipc/addToQueue', headers, [{ patientId, priority: 1 }]).catch(reject);
                }, 50);
            });
            req.on('error', (e: any) => { if (e.code !== 'ECONNRESET') reject(e); });
            req.end();
        });
        expect(received).toMatch(/id: \d+\nevent: queue\ndata: \{.*"method":"addToQueue"/);
        expect(received).not.toMatch(/patientId/);
    });
});
