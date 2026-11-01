import { describe, expect, it, vi } from 'vitest';
import {
    checkServerHello,
    createSseParser,
    ServerClient,
    ServerUnreachableError,
    SessionExpiredError,
    UpgradeRequiredError,
    type ConnectionState,
    type ServerTransport,
    type SessionTokens,
    type TransportRequest,
    type TransportResponse
} from './server-client';
import { PROTOCOL_HEADER, PROTOCOL_VERSION } from './protocol';

function memoryTokens(initial: SessionTokens | null = null) {
    let value = initial;
    return { get: () => value, set: (t: SessionTokens | null) => { value = t; } };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): TransportResponse =>
    ({ status, headers, body: JSON.stringify(body) });

function fakeTransport(handler: (req: TransportRequest) => TransportResponse | Promise<TransportResponse>): ServerTransport & { calls: TransportRequest[] } {
    const calls: TransportRequest[] = [];
    return {
        calls,
        request: async (req) => { calls.push(req); return handler(req); },
        stream: async () => ({ status: 200 })
    };
}

const noSleep = () => Promise.resolve();

describe('checkServerHello', () => {
    it('accepts a server speaking our protocol', () => {
        expect(checkServerHello({ protocol: PROTOCOL_VERSION, minProtocol: PROTOCOL_VERSION })).toEqual({ ok: true, version: PROTOCOL_VERSION });
    });
    it('asks the client to upgrade when the server dropped our protocol', () => {
        expect(checkServerHello({ protocol: PROTOCOL_VERSION + 2, minProtocol: PROTOCOL_VERSION + 1 })).toMatchObject({ ok: false, upgrade: 'client' });
    });
    it('asks the server to upgrade when it is older than us', () => {
        expect(checkServerHello({ protocol: PROTOCOL_VERSION - 1, minProtocol: PROTOCOL_VERSION - 1 })).toMatchObject({ ok: false, upgrade: 'server' });
    });
    it('rejects a hello without a protocol', () => {
        expect(checkServerHello({} as any)).toMatchObject({ ok: false });
    });
});

describe('createSseParser', () => {
    it('parses events split across chunks, skipping comments', () => {
        const events: any[] = [];
        const push = createSseParser((e) => events.push(e));
        push('retry: 3000\n\n: ping\n\nid: 4\nevent: qu');
        push('eue\ndata: {"method":"addToQueue"}\n\n');
        push('event: resync\r\ndata: {}\r\n\r\n');
        expect(events).toEqual([
            { id: '4', event: 'queue', data: '{"method":"addToQueue"}' },
            { id: '4', event: 'resync', data: '{}' }
        ]);
    });
});

describe('ServerClient', () => {
    const now = 1_000_000;

    it('sends the protocol header and stores tokens at sign-in', async () => {
        const tokens = memoryTokens();
        const transport = fakeTransport(() => json(200, { token: 'a1', refreshToken: 'r1', expiresIn: 900, user: { id: 1, username: 'admin', role: 'admin' } }));
        const client = new ServerClient({ transport, tokens, now: () => now });
        const result = await client.login('admin', 'pw');
        expect(result).toEqual({ ok: true, user: { id: 1, username: 'admin', role: 'admin' } });
        expect(transport.calls[0].headers[PROTOCOL_HEADER]).toBe(String(PROTOCOL_VERSION));
        expect(tokens.get()).toEqual({ token: 'a1', refreshToken: 'r1', expiresAt: now + 900_000 });
    });

    it('reports a locked sign-in with its wait', async () => {
        const transport = fakeTransport(() => json(429, { error: 'TOO_MANY_ATTEMPTS' }, { 'retry-after': '60' }));
        const client = new ServerClient({ transport, tokens: memoryTokens(), now: () => now });
        expect(await client.login('admin', 'x')).toEqual({ ok: false, error: 'TOO_MANY_ATTEMPTS', retryAfterSec: 60 });
    });

    it('marks the computer revoked when the server no longer knows it', async () => {
        const states: ConnectionState[] = [];
        const transport = fakeTransport(() => json(401, { error: 'DEVICE_NOT_JOINED' }));
        const client = new ServerClient({ transport, tokens: memoryTokens(), now: () => now, onState: (s) => states.push(s) });
        expect(await client.login('admin', 'x')).toMatchObject({ ok: false, error: 'DEVICE_NOT_JOINED' });
        expect(states.at(-1)).toEqual({ kind: 'device-revoked' });
    });

    it('invokes with the bearer token and refreshes once on 401', async () => {
        const tokens = memoryTokens({ token: 'old', refreshToken: 'r1', expiresAt: now + 600_000 });
        const transport = fakeTransport((req) => {
            if (req.path === '/api/auth/refresh') return json(200, { token: 'new', refreshToken: 'r2', expiresIn: 900 });
            return req.headers['authorization'] === 'Bearer new' ? json(200, [{ id: 1 }]) : json(401, { error: 'Unauthorized' });
        });
        const client = new ServerClient({ transport, tokens, now: () => now });
        await expect(client.invoke('getQueue', [])).resolves.toEqual([{ id: 1 }]);
        expect(transport.calls.map((c) => c.path)).toEqual(['/api/ipc/getQueue', '/api/auth/refresh', '/api/ipc/getQueue']);
        expect(JSON.parse(transport.calls[1].body!)).toEqual({ refreshToken: 'r1' });
        expect(tokens.get()?.refreshToken).toBe('r2');
    });

    it('refreshes ahead of expiry, one refresh for concurrent calls', async () => {
        const tokens = memoryTokens({ token: 'old', refreshToken: 'r1', expiresAt: now + 10_000 });
        let refreshes = 0;
        const transport = fakeTransport((req) => {
            if (req.path === '/api/auth/refresh') { refreshes++; return json(200, { token: 'new', refreshToken: 'r2', expiresIn: 900 }); }
            return json(200, 'ok');
        });
        const client = new ServerClient({ transport, tokens, now: () => now });
        await Promise.all([client.invoke('a'), client.invoke('b'), client.invoke('c')]);
        expect(refreshes).toBe(1);
    });

    it('ends the session when refresh fails', async () => {
        const states: ConnectionState[] = [];
        const tokens = memoryTokens({ token: 'old', refreshToken: 'r1', expiresAt: now + 600_000 });
        const transport = fakeTransport((req) => json(401, { error: req.path === '/api/auth/refresh' ? 'SESSION_EXPIRED' : 'Unauthorized' }));
        const client = new ServerClient({ transport, tokens, now: () => now, onState: (s) => states.push(s) });
        await expect(client.invoke('getQueue')).rejects.toBeInstanceOf(SessionExpiredError);
        expect(tokens.get()).toBeNull();
        expect(states.at(-1)).toEqual({ kind: 'signed-out' });
    });

    it('surfaces server errors from data calls', async () => {
        const tokens = memoryTokens({ token: 't', expiresAt: now + 600_000 });
        const client = new ServerClient({ transport: fakeTransport(() => json(403, { error: 'Forbidden' })), tokens, now: () => now });
        await expect(client.invoke('deleteUser', [2])).rejects.toThrow('Forbidden');
        await expect(client.call('GET', '/api/admin/devices')).rejects.toThrow('Forbidden');
    });

    it('stops on 426 and says which side must upgrade', async () => {
        const states: ConnectionState[] = [];
        const tokens = memoryTokens({ token: 't', expiresAt: now + 600_000 });
        const transport = fakeTransport(() => json(426, { error: 'SERVER_TOO_OLD', upgrade: 'server', serverVersion: '0.0.9' }));
        const client = new ServerClient({ transport, tokens, now: () => now, onState: (s) => states.push(s) });
        const error = await client.invoke('getQueue').catch((e) => e);
        expect(error).toBeInstanceOf(UpgradeRequiredError);
        expect(error.side).toBe('server');
        expect(states.at(-1)).toEqual({ kind: 'upgrade', side: 'server', serverVersion: '0.0.9' });
    });

    it('rejects an incompatible hello', async () => {
        const transport = fakeTransport(() => json(200, { product: 'nalamdesk-server', protocol: PROTOCOL_VERSION + 5, minProtocol: PROTOCOL_VERSION + 5, serverVersion: '9.0.0' }));
        const client = new ServerClient({ transport, tokens: memoryTokens(), now: () => now });
        await expect(client.hello()).rejects.toBeInstanceOf(UpgradeRequiredError);
        expect(client.connectionState).toMatchObject({ kind: 'upgrade', side: 'client' });
    });

    it('waits for an unreachable server and reconnects on its own', async () => {
        const states: ConnectionState[] = [];
        let up = false;
        const transport: ServerTransport = {
            request: async (req) => {
                if (!up) throw new Error('ECONNREFUSED');
                return json(200, req.path === '/api/server/hello' ? { protocol: PROTOCOL_VERSION } : 'ok', { 'x-nalamdesk-server-version': '1.2.3' });
            },
            stream: async () => ({ status: 200 })
        };
        let wake: () => void = () => undefined;
        const sleep = () => new Promise<void>((resolve) => { wake = resolve; });
        const client = new ServerClient({ transport, tokens: memoryTokens(), now: () => now, sleep, onState: (s) => states.push(s) });
        await expect(client.hello()).rejects.toBeInstanceOf(ServerUnreachableError);
        expect(client.connectionState).toEqual({ kind: 'unreachable', since: now });
        up = true;
        wake();
        await vi.waitFor(() => expect(client.connectionState).toEqual({ kind: 'connected', serverVersion: '1.2.3' }));
    });

    it('streams events, resumes from the last id and stops when aborted', async () => {
        const tokens = memoryTokens({ token: 't', expiresAt: now + 600_000 });
        const streamCalls: TransportRequest[] = [];
        const abort = new AbortController();
        const transport: ServerTransport = {
            request: async () => json(200, {}),
            stream: async (req, onChunk) => {
                streamCalls.push(req);
                if (streamCalls.length === 1) {
                    onChunk('id: 7\nevent: queue\ndata: {"id":7,"topic":"queue","method":"addToQueue"}\n\n');
                    return { status: 200 };
                }
                onChunk('id: 8\nevent: bookings\ndata: {"id":8}\n\n');
                abort.abort();
                return { status: 200 };
            }
        };
        const events: unknown[] = [];
        const client = new ServerClient({ transport, tokens, now: () => now, sleep: noSleep });
        await client.watchEvents((e) => events.push(e), abort.signal);
        expect(events).toEqual([{ id: 7, topic: 'queue', method: 'addToQueue' }, { id: 8, topic: 'bookings' }]);
        expect(streamCalls[0].headers['authorization']).toBe('Bearer t');
        expect(streamCalls[0].headers['last-event-id']).toBeUndefined();
        expect(streamCalls[1].headers['last-event-id']).toBe('7');
    });

    it('stops streaming when the computer is revoked', async () => {
        const tokens = memoryTokens({ token: 't', expiresAt: now + 600_000 });
        const transport: ServerTransport = {
            request: async () => json(200, {}),
            stream: async () => ({ status: 401, body: JSON.stringify({ error: 'DEVICE_NOT_JOINED' }) })
        };
        const client = new ServerClient({ transport, tokens, now: () => now, sleep: noSleep });
        await client.watchEvents(() => undefined, new AbortController().signal);
        expect(client.connectionState).toEqual({ kind: 'device-revoked' });
    });

    it('signs out locally even when the server is away', async () => {
        const tokens = memoryTokens({ token: 't', expiresAt: now + 600_000 });
        const transport: ServerTransport = { request: async () => { throw new Error('down'); }, stream: async () => ({ status: 0 }) };
        const client = new ServerClient({ transport, tokens, now: () => now });
        await client.logout();
        expect(tokens.get()).toBeNull();
    });
});
