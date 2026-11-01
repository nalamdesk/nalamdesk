import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseService } from '../services/DatabaseService';
import { TestDatabase } from '../testing/TestDatabase';
import { ApiServer } from '../../server/app';
import { certificateFingerprint, generateSelfSignedCertificate } from '../../server/tls';
import { formatJoinCode } from '../../shared/join-code';
import { ServerClient, type SessionTokens } from '../../shared/server-client';
import { joinServer } from './join';
import { createPinnedTransport, normalizeServerUrl } from './pinned-transport';
import { ClientStreams, sanitizeRendererRequest } from './client-bridge';
import { forgetServerConnection, hasServerConnection, loadServerConnection, saveServerConnection, type SecretCipher } from './connection-store';
import { handleJoinRequest } from './join-ipc';

delete process.env['JWT_SECRET'];
const PASSWORD = 'correct horse battery staple';

const fakeCipher: SecretCipher = {
    available: () => true,
    encrypt: (plain) => Buffer.from(plain).toString('base64').split('').reverse().join(''),
    decrypt: (sealed) => Buffer.from(sealed.split('').reverse().join(''), 'base64').toString()
};

function memoryTokens() {
    let value: SessionTokens | null = null;
    return { get: () => value, set: (t: SessionTokens | null) => { value = t; } };
}

describe('normalizeServerUrl', () => {
    it('accepts host, host:port and https URLs', () => {
        expect(normalizeServerUrl('nalamdesk.clinic.in')).toBe('https://nalamdesk.clinic.in');
        expect(normalizeServerUrl(' 192.168.1.20:3443 ')).toBe('https://192.168.1.20:3443');
        expect(normalizeServerUrl('https://server.local/')).toBe('https://server.local');
    });
    it('refuses plain HTTP, credentials, paths and junk', () => {
        expect(normalizeServerUrl('http://server.local')).toBeNull();
        expect(normalizeServerUrl('https://user:pw@server.local')).toBeNull();
        expect(normalizeServerUrl('https://server.local/api')).toBeNull();
        expect(normalizeServerUrl('')).toBeNull();
        expect(normalizeServerUrl('https://')).toBeNull();
    });
});

describe('sanitizeRendererRequest', () => {
    it('passes API requests with allowed headers only', () => {
        expect(sanitizeRendererRequest({
            method: 'POST', path: '/api/ipc/getQueue', body: '[]',
            headers: { Authorization: 'Bearer t', 'X-NalamDesk-Device': 'stolen', Cookie: 'x', 'content-type': 'application/json' }
        })).toEqual({ method: 'POST', path: '/api/ipc/getQueue', body: '[]', headers: { authorization: 'Bearer t', 'content-type': 'application/json' } });
    });
    it('refuses other paths, methods and header injection', () => {
        expect(sanitizeRendererRequest({ method: 'GET', path: '/index.html', headers: {} })).toBeNull();
        expect(sanitizeRendererRequest({ method: 'GET', path: '/api/../secret', headers: {} })).toBeNull();
        expect(sanitizeRendererRequest({ method: 'PUT', path: '/api/ipc/x', headers: {} })).toBeNull();
        expect(sanitizeRendererRequest({ method: 'GET', path: 'https://evil/api/x', headers: {} })).toBeNull();
        expect(sanitizeRendererRequest({ method: 'GET', path: '/api/x', headers: { authorization: 'a\r\nx: y' } })?.headers).toEqual({});
        expect(sanitizeRendererRequest(null)).toBeNull();
    });
});

describe('connection store', () => {
    it('keeps the device credential sealed on disk and can forget it', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-client-'));
        const connection = {
            serverUrl: 'https://server.local', deviceId: 'd1', deviceName: 'Front desk', deviceToken: 'secret-token',
            pinnedCert: null, fingerprint256: null, joinedAt: 1
        };
        expect(hasServerConnection(dir)).toBe(false);
        saveServerConnection(dir, connection, fakeCipher);
        expect(hasServerConnection(dir)).toBe(true);
        expect(fs.readFileSync(path.join(dir, 'server-connection.json'), 'utf8')).not.toContain('secret-token');
        expect(loadServerConnection(dir, fakeCipher)).toEqual(connection);
        forgetServerConnection(dir);
        expect(hasServerConnection(dir)).toBe(false);
        expect(loadServerConnection(dir, fakeCipher)).toBeNull();
    });

    it('refuses to store the credential without a keychain', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-client-'));
        expect(() => saveServerConnection(dir, {
            serverUrl: 'https://s', deviceId: 'd', deviceName: 'n', deviceToken: 't', pinnedCert: null, fingerprint256: null, joinedAt: 1
        }, { ...fakeCipher, available: () => false })).toThrow('SECURE_STORAGE_UNAVAILABLE');
    });
});

describe('client mode against a real NalamDesk Server', () => {
    let server: ApiServer;
    let serverUrl: string;
    let cert: string;
    let key: string;
    let fingerprint: string;

    beforeAll(() => {
        const generated = generateSelfSignedCertificate({ hostnames: ['localhost', '127.0.0.1'] });
        cert = generated.cert;
        key = generated.key;
        fingerprint = certificateFingerprint(cert);
    });

    afterEach(async () => {
        await server?.close();
    });

    async function startServer() {
        const raw = new TestDatabase();
        const db = new DatabaseService();
        db.setDb(raw);
        await db.migrate({ skipBackup: true });
        await db.ensureAdminUser(PASSWORD);
        server = new ApiServer(db, os.tmpdir(), undefined, undefined, {
            requireDevice: true,
            tls: { key, cert, selfSigned: true, fingerprint256: fingerprint }
        });
        await server.start(0, '127.0.0.1');
        const port = (server as any).fastify.server.address().port as number;
        serverUrl = `https://127.0.0.1:${port}`;
        return db;
    }

    it('joins with a pinned certificate, signs in, calls the API and follows events', async () => {
        const db = await startServer();
        const saved: any = db.savePatient({ name: 'Client Patient', age: 30, gender: 'Female', mobile: '9876500002' });
        const patientId = Number(saved?.id ?? saved?.lastInsertRowid);

        const { code } = server.issueJoinCode({ createdBy: null });
        const joined = await joinServer({ serverUrl: serverUrl.replace('https://', ''), code, deviceName: 'Reception' });
        expect(joined.ok).toBe(true);
        if (!joined.ok) return;
        expect(joined.connection).toMatchObject({ serverUrl, deviceName: 'Reception', fingerprint256: fingerprint });
        expect(joined.connection.pinnedCert).toContain('BEGIN CERTIFICATE');

        // The code works once.
        expect(await joinServer({ serverUrl, code, deviceName: 'Again' })).toEqual({ ok: false, error: 'INVALID_CODE' });

        const transport = createPinnedTransport(joined.connection);
        const client = new ServerClient({ transport, tokens: memoryTokens() });
        expect((await client.hello()).requireDevice).toBe(true);
        expect(await client.login('admin', PASSWORD)).toMatchObject({ ok: true, user: { username: 'admin' } });

        const abort = new AbortController();
        const topics: string[] = [];
        const watching = client.watchEvents((event) => {
            topics.push(event.topic);
            if (event.topic === 'queue') abort.abort();
        }, abort.signal);
        await new Promise((resolve) => setTimeout(resolve, 100));
        await client.invoke('addToQueue', [{ patientId, priority: 1 }]);
        await watching;
        expect(topics).toContain('queue');
        const queue = await client.invoke<any[]>('getQueue', []);
        expect(queue.some((entry) => entry.patient_id === patientId)).toBe(true);

        // The admin removes the computer: the client is told so.
        expect(server.revokeDevice(joined.connection.deviceId, null)).toBe(true);
        await expect(client.invoke('getQueue', [])).rejects.toThrow();
        expect(client.connectionState.kind).toBe('device-revoked');
    });

    it('streams through the main-process bridge and closes on request', async () => {
        await startServer();
        const { code } = server.issueJoinCode({ createdBy: null });
        const joined = await joinServer({ serverUrl, code, deviceName: 'Doctor room' });
        if (!joined.ok) throw new Error(joined.error);
        const transport = createPinnedTransport(joined.connection);
        const client = new ServerClient({ transport, tokens: memoryTokens() });
        await client.login('admin', PASSWORD);
        const login = await transport.request({
            method: 'POST', path: '/api/auth/login', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ username: 'admin', password: PASSWORD })
        });
        const token = JSON.parse(login.body).token;

        const streams = new ClientStreams(() => transport);
        const chunks: string[] = [];
        const ended = new Promise<{ status: number }>((resolve) => {
            expect(streams.start('s1', { method: 'GET', path: '/api/events', headers: { authorization: `Bearer ${token}` } }, {
                chunk: (_id, text) => {
                    chunks.push(text);
                    if (text.includes('retry:')) streams.stop('s1');
                },
                end: (_id, result) => resolve(result)
            })).toBe(true);
        });
        expect((await ended).status).toBe(200);
        expect(chunks.join('')).toContain('retry: 3000');
        expect(streams.start('s2', { method: 'POST', path: '/api/events', headers: {} }, { chunk: () => undefined, end: () => undefined })).toBe(false);
    });

    it('refuses a server whose certificate does not match the code', async () => {
        await startServer();
        const { code } = server.issueJoinCode({ createdBy: null });
        const other = certificateFingerprint(generateSelfSignedCertificate({ hostnames: ['localhost'] }).cert);
        const forged = formatJoinCode(code.replace(/-/g, '').slice(0, 8), other);
        expect(await joinServer({ serverUrl, code: forged, deviceName: 'x' })).toEqual({ ok: false, error: 'WRONG_SERVER' });
    });

    it('refuses a pinned connection when the server certificate changes', async () => {
        await startServer();
        const other = generateSelfSignedCertificate({ hostnames: ['127.0.0.1'] });
        const transport = createPinnedTransport({ serverUrl, pinnedCert: other.cert, fingerprint256: certificateFingerprint(other.cert) });
        await expect(transport.request({ method: 'GET', path: '/api/server/hello', headers: {} })).rejects.toThrow();
    });

    it('reports bad input and unreachable servers', async () => {
        expect(await joinServer({ serverUrl: 'http://x', code: 'AAAAA-AAAAA-AAAAA-AAAAA', deviceName: '' })).toEqual({ ok: false, error: 'INVALID_ADDRESS' });
        expect(await joinServer({ serverUrl: 'server.local', code: 'nope', deviceName: '' })).toEqual({ ok: false, error: 'INVALID_CODE' });
        const pinnedCode = formatJoinCode('ABCDEFGH', fingerprint);
        expect(await joinServer({ serverUrl: 'https://127.0.0.1:1', code: pinnedCode, deviceName: '' })).toEqual({ ok: false, error: 'UNREACHABLE' });
    });

    it('saves the connection and restarts after a join from the first-run screen', async () => {
        await startServer();
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-client-'));
        let restarted = false;
        const deps = { userDataPath: dir, cipher: fakeCipher, canJoin: () => true, restart: () => { restarted = true; } };
        const { code } = server.issueJoinCode({ createdBy: null });
        const result = await handleJoinRequest({ serverUrl, code, deviceName: 'Lab' }, deps);
        expect(result).toEqual({ ok: true, serverUrl, deviceName: 'Lab' });
        expect(loadServerConnection(dir, fakeCipher)?.deviceName).toBe('Lab');
        await new Promise((resolve) => setTimeout(resolve, 800));
        expect(restarted).toBe(true);
        expect(await handleJoinRequest({ serverUrl, code, deviceName: 'Lab' }, { ...deps, canJoin: () => false }))
            .toEqual({ ok: false, error: 'ALREADY_SET_UP' });
    });
});
