/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBridgeTransport, createFetchTransport, readBrowserDevice, BROWSER_DEVICE_KEY, type NalamdeskClientBridge } from './server-transport';
import { ServerConnectionService, sessionTokenStore } from './server-connection.service';
import { bannerFor } from '../shared/components/connection-banner/connection-banner.component';
import { joinErrorMessage } from '../login/login.component';
import { connectErrorMessage } from '../setup/setup.component';
import { JoinedComputersComponent } from '../settings/joined-computers.component';

const zone = { run: (fn: () => unknown) => fn() } as any;

afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    delete (globalThis as any).nalamdeskClient;
    vi.restoreAllMocks();
});

describe('fetch transport', () => {
    it('adds the browser device credential and returns status, headers and body', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200, headers: { 'X-NalamDesk-Protocol': '1' } }));
        const transport = createFetchTransport(() => 'dev-token', fetchImpl as any);
        const res = await transport.request({ method: 'POST', path: '/api/ipc/getQueue', headers: { authorization: 'Bearer t' }, body: '[]' });
        expect(res).toEqual({ status: 200, headers: expect.objectContaining({ 'x-nalamdesk-protocol': '1' }), body: '{"ok":true}' });
        expect(fetchImpl.mock.calls[0][1].headers).toEqual({ authorization: 'Bearer t', 'x-nalamdesk-device': 'dev-token' });
    });

    it('reads a stream chunk by chunk and returns error bodies', async () => {
        const encoder = new TextEncoder();
        const parts = [encoder.encode('id: 1\n'), encoder.encode('event: queue\n\n')];
        const streamed = {
            status: 200,
            headers: new Headers(),
            body: { getReader: () => ({ read: async () => (parts.length ? { done: false, value: parts.shift() } : { done: true, value: undefined }) }) },
            text: async () => ''
        };
        const chunks: string[] = [];
        const ok = createFetchTransport(() => null, vi.fn().mockResolvedValue(streamed) as any);
        expect(await ok.stream({ method: 'GET', path: '/api/events', headers: {} }, (t) => chunks.push(t), new AbortController().signal)).toEqual({ status: 200 });
        expect(chunks.join('')).toBe('id: 1\nevent: queue\n\n');

        const denied = createFetchTransport(() => null, vi.fn().mockResolvedValue(new Response('{"error":"Unauthorized"}', { status: 401 })) as any);
        expect(await denied.stream({ method: 'GET', path: '/api/events', headers: {} }, () => undefined, new AbortController().signal))
            .toEqual({ status: 401, body: '{"error":"Unauthorized"}' });
    });
});

describe('bridge transport', () => {
    function fakeBridge() {
        let chunk: (id: string, text: string) => void = () => undefined;
        let end: (id: string, result: any) => void = () => undefined;
        const bridge = {
            request: vi.fn().mockResolvedValue({ status: 200, headers: {}, body: '[]' }),
            openStream: vi.fn().mockResolvedValue(true),
            closeStream: vi.fn().mockResolvedValue(undefined),
            onStreamChunk: (l: any) => { chunk = l; return () => { chunk = () => undefined; }; },
            onStreamEnd: (l: any) => { end = l; return () => { end = () => undefined; }; },
            info: vi.fn(),
            disconnect: vi.fn()
        };
        return { bridge: bridge as unknown as NalamdeskClientBridge & typeof bridge, emit: (id: string, t: string) => chunk(id, t), finish: (id: string, r: any) => end(id, r) };
    }

    it('forwards requests to the main process', async () => {
        const { bridge } = fakeBridge();
        const transport = createBridgeTransport(bridge);
        await transport.request({ method: 'GET', path: '/api/server/hello', headers: {} });
        expect(bridge.request).toHaveBeenCalledWith({ method: 'GET', path: '/api/server/hello', headers: {} });
    });

    it('relays only its own stream and closes it on abort', async () => {
        const { bridge, emit, finish } = fakeBridge();
        const transport = createBridgeTransport(bridge);
        const abort = new AbortController();
        const chunks: string[] = [];
        const done = transport.stream({ method: 'GET', path: '/api/events', headers: {} }, (t) => chunks.push(t), abort.signal);
        const id = bridge.openStream.mock.calls[0][0];
        emit('other', 'nope');
        emit(id, 'yes');
        abort.abort();
        expect(bridge.closeStream).toHaveBeenCalledWith(id);
        finish(id, { status: 200 });
        expect(await done).toEqual({ status: 200, body: undefined });
        expect(chunks).toEqual(['yes']);
    });

    it('rejects when the main process refuses or loses the stream', async () => {
        const { bridge, finish } = fakeBridge();
        bridge.openStream.mockResolvedValueOnce(false);
        const transport = createBridgeTransport(bridge);
        await expect(transport.stream({ method: 'GET', path: '/api/events', headers: {} }, () => undefined, new AbortController().signal)).rejects.toThrow('STREAM_REFUSED');
        const lost = transport.stream({ method: 'GET', path: '/api/events', headers: {} }, () => undefined, new AbortController().signal);
        finish(bridge.openStream.mock.calls[1][0], { status: 0, error: 'ECONNRESET' });
        await expect(lost).rejects.toThrow('ECONNRESET');
    });
});

describe('ServerConnectionService', () => {
    it('keeps tokens per tab in sessionStorage', () => {
        const store = sessionTokenStore();
        store.set({ token: 't', expiresAt: 5 });
        expect(store.get()).toEqual({ token: 't', expiresAt: 5 });
        sessionStorage.setItem('nalamdesk_session', '{bad');
        expect(store.get()).toBeNull();
        store.set(null);
        expect(sessionStorage.getItem('nalamdesk_session')).toBeNull();
    });

    it('joins a browser and keeps its credential', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ deviceId: 'd1', deviceName: 'Chrome browser', deviceToken: 'tok' }), { status: 200 }));
        const service = new ServerConnectionService(zone);
        expect(service.isAppClient).toBe(false);
        expect(await service.joinBrowser('AAAAA-AAAAA-AAAAA-AAAAA', 'Chrome browser')).toEqual({ ok: true, device: { deviceId: 'd1', deviceName: 'Chrome browser', deviceToken: 'tok' } });
        expect(readBrowserDevice()?.deviceToken).toBe('tok');
        expect(service.browserDevice()?.deviceId).toBe('d1');
        service.forgetBrowserDevice();
        expect(localStorage.getItem(BROWSER_DEVICE_KEY)).toBeNull();
    });

    it('reports join failures', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"error":"INVALID_CODE"}', { status: 401 }));
        const service = new ServerConnectionService(zone);
        expect(await service.joinBrowser('x', 'y')).toEqual({ ok: false, error: 'INVALID_CODE' });
        fetchSpy.mockResolvedValue(new Response('{}', { status: 429 }));
        expect(await service.joinBrowser('x', 'y')).toEqual({ ok: false, error: 'TOO_MANY_ATTEMPTS' });
        fetchSpy.mockRejectedValue(new Error('down'));
        expect(await service.joinBrowser('x', 'y')).toEqual({ ok: false, error: 'UNREACHABLE' });
    });

    it('uses the app bridge inside client mode', async () => {
        (globalThis as any).nalamdeskClient = {
            request: vi.fn().mockResolvedValue({ status: 200, headers: {}, body: JSON.stringify({ token: 't', refreshToken: 'r', expiresIn: 900, user: { id: 1, username: 'admin', role: 'admin' } }) }),
            openStream: vi.fn().mockResolvedValue(true),
            closeStream: vi.fn().mockResolvedValue(undefined),
            onStreamChunk: () => () => undefined,
            onStreamEnd: () => () => undefined
        };
        const service = new ServerConnectionService(zone);
        expect(service.isAppClient).toBe(true);
        expect(service.browserDevice()).toBeNull();
        const result = await service.login('admin', 'pw');
        service.stopEvents();
        expect(result.ok).toBe(true);
        expect(service.signedIn).toBe(true);
        expect(service.state()).toMatchObject({ kind: 'connected' });
    });
});

describe('connection messages', () => {
    it('banners only the states that stop work', () => {
        expect(bannerFor({ kind: 'connected' }, false)).toBeNull();
        expect(bannerFor({ kind: 'signed-out' }, false)).toBeNull();
        expect(bannerFor({ kind: 'unreachable', since: 1 }, true)?.tone).toBe('warning');
        expect(bannerFor({ kind: 'upgrade', side: 'client' }, true)?.detail).toContain('Update NalamDesk');
        expect(bannerFor({ kind: 'upgrade', side: 'client' }, false)?.detail).toContain('Reload');
        expect(bannerFor({ kind: 'upgrade', side: 'server', serverVersion: '0.0.9' }, false)?.detail).toContain('0.0.9');
        expect(bannerFor({ kind: 'device-revoked' }, true)?.detail).toContain('Disconnect');
        expect(bannerFor({ kind: 'device-revoked' }, false)?.detail).toContain('browser');
    });

    it('explains join errors in plain words', () => {
        expect(joinErrorMessage('WRONG_SERVER')).toContain('different');
        expect(joinErrorMessage('???')).toContain('Could not join');
        expect(connectErrorMessage('UNREACHABLE')).toContain('Cannot reach');
        expect(connectErrorMessage(undefined)).toContain('Could not connect');
    });
});

describe('JoinedComputersComponent', () => {
    it('lists computers, issues codes and removes a computer', async () => {
        const computers = [{ id: 'd1', name: 'Front desk', joinedAt: 1, lastSeenAt: null, lastIp: null, revokedAt: null }];
        const server = {
            call: vi.fn(async (method: string, path: string) => {
                if (method === 'GET') return computers;
                if (path === '/api/admin/join-codes') return { code: 'AAAAA-BBBBB-CCCCC-DDDDD', expiresAt: 2, deviceName: 'Lab' };
                return { revoked: true };
            })
        };
        const dialog = { open: vi.fn().mockResolvedValue(true) };
        const component = new JoinedComputersComponent(server as any, dialog as any);
        await component.load();
        expect(component.computers).toEqual(computers);
        component.deviceName = ' Lab ';
        await component.issueCode();
        expect(server.call).toHaveBeenCalledWith('POST', '/api/admin/join-codes', { deviceName: 'Lab' });
        expect(component.issued?.code).toBe('AAAAA-BBBBB-CCCCC-DDDDD');
        await component.revoke(computers[0]);
        expect(server.call).toHaveBeenCalledWith('DELETE', '/api/admin/devices/d1');
    });

    it('shows errors instead of throwing', async () => {
        const server = { call: vi.fn().mockRejectedValue(new Error('Forbidden')) };
        const component = new JoinedComputersComponent(server as any, { open: vi.fn().mockResolvedValue(false) } as any);
        await component.load();
        expect(component.error).toContain('Could not load');
        await component.issueCode();
        expect(component.error).toContain('join code');
        await component.revoke({ id: 'x', name: 'x', joinedAt: 1, lastSeenAt: null, lastIp: null, revokedAt: null });
        expect(server.call).toHaveBeenCalledTimes(2);
    });
});
