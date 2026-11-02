// Client side of a NalamDesk Server connection (#194), shared by the app in
// client mode and the browser client. It owns the access and refresh
// tokens, the protocol handshake, the connection state shown in the banner
// and the live events stream. How bytes reach the server is a transport:
// the browser uses fetch on the page's origin; the app's main process uses
// pinned HTTPS and adds the computer's device credential.
//
// No Node-only or Angular imports: this runs in the renderer and in tests.

import { PROTOCOL_HEADER, PROTOCOL_VERSION, type ProtocolVerdict } from './protocol';

export interface TransportRequest {
    method: 'GET' | 'POST' | 'DELETE';
    path: string;
    headers: Record<string, string>;
    body?: string;
}

export interface TransportResponse {
    status: number;
    headers: Record<string, string>;
    body: string;
}

export interface ServerTransport {
    /** Rejects only when the server cannot be reached. */
    request(req: TransportRequest): Promise<TransportResponse>;
    /**
     * Opens a streaming GET. Resolves with the status once the stream ends
     * (or at once with the error body for a non-200 answer); rejects when
     * the server cannot be reached. Aborting ends it quietly.
     */
    stream(req: TransportRequest, onChunk: (text: string) => void, signal: AbortSignal): Promise<{ status: number; body?: string }>;
}

export interface SessionTokens {
    token: string;
    refreshToken?: string;
    /** Epoch ms when the access token expires. */
    expiresAt: number;
}

export interface TokenStore {
    get(): SessionTokens | null;
    set(tokens: SessionTokens | null): void;
}

export type ConnectionState =
    | { kind: 'connecting' }
    | { kind: 'connected'; serverVersion?: string }
    | { kind: 'unreachable'; since: number }
    | { kind: 'upgrade'; side: 'client' | 'server'; serverVersion?: string }
    | { kind: 'signed-out' }
    | { kind: 'device-revoked' };

export interface ServerHello {
    product: string;
    protocol: number;
    minProtocol: number;
    serverVersion: string;
    requireDevice: boolean;
    tls: { selfSigned: boolean; fingerprint256: string } | null;
}

export interface SignedInUser {
    id: number;
    username: string;
    role: string;
    name?: string;
}

/** A facility the user can work in, with their role there (#195). */
export interface FacilityChoice {
    id: number;
    code: string;
    name: string;
    kind: string;
    role: string;
}

export type LoginResult =
    | { ok: true; user: SignedInUser; facilityId?: number; facilities?: FacilityChoice[] }
    | { ok: false; error: string; retryAfterSec?: number };

export interface ServerEventMessage {
    id: number | null;
    /** A topic such as `queue`, or `resync` when the client must refetch everything. */
    topic: string;
    method?: string;
}

export class ServerUnreachableError extends Error {
    constructor() { super('SERVER_UNREACHABLE'); this.name = 'ServerUnreachableError'; }
}

export class UpgradeRequiredError extends Error {
    constructor(readonly side: 'client' | 'server') { super(side === 'client' ? 'CLIENT_UPGRADE_REQUIRED' : 'SERVER_UPGRADE_REQUIRED'); this.name = 'UpgradeRequiredError'; }
}

export class SessionExpiredError extends Error {
    constructor(message = 'SESSION_EXPIRED') { super(message); this.name = 'SessionExpiredError'; }
}

/**
 * Whether this client and a server can talk, from the server's hello. Same
 * window the server applies to clients: its own protocol and the one before.
 */
export function checkServerHello(hello: Pick<ServerHello, 'protocol' | 'minProtocol'>): ProtocolVerdict {
    const protocol = Number(hello?.protocol);
    const minProtocol = Number(hello?.minProtocol ?? protocol);
    if (!Number.isInteger(protocol) || protocol < 1) {
        return { ok: false, upgrade: 'server', error: 'INVALID_PROTOCOL' };
    }
    if (PROTOCOL_VERSION < minProtocol) return { ok: false, upgrade: 'client', error: 'CLIENT_TOO_OLD' };
    if (PROTOCOL_VERSION > protocol) return { ok: false, upgrade: 'server', error: 'SERVER_TOO_OLD' };
    return { ok: true, version: PROTOCOL_VERSION };
}

/** Incremental Server-Sent Events parser: feed it text as it arrives. */
export function createSseParser(onEvent: (event: { id: string | null; event: string; data: string }) => void): (text: string) => void {
    let buffer = '';
    let id: string | null = null;
    let event = '';
    let data: string[] = [];
    const dispatch = () => {
        if (data.length > 0 || event) onEvent({ id, event: event || 'message', data: data.join('\n') });
        event = '';
        data = [];
    };
    const handleLine = (line: string) => {
        if (line === '') return dispatch();
        if (line.startsWith(':')) return;
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'id') id = value;
        else if (field === 'event') event = value;
        else if (field === 'data') data.push(value);
    };
    return (text: string) => {
        buffer += text;
        let newline = buffer.search(/\r?\n/);
        while (newline !== -1) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(buffer[newline] === '\r' ? newline + 2 : newline + 1);
            handleLine(line);
            newline = buffer.search(/\r?\n/);
        }
    };
}

function parseJson(body: string): any {
    if (!body) return null;
    try {
        return JSON.parse(body);
    } catch {
        return body;
    }
}

function errorOf(body: unknown, fallback: string): string {
    if (body && typeof body === 'object' && typeof (body as any).error === 'string') return (body as any).error;
    if (typeof body === 'string' && body) return body;
    return fallback;
}

export interface ServerClientOptions {
    transport: ServerTransport;
    tokens: TokenStore;
    now?: () => number;
    /** Waits between reconnect attempts; replaced in tests. */
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    onState?: (state: ConnectionState) => void;
    /** Refresh this long before the access token expires. */
    refreshMarginMs?: number;
    /** Reconnect delays grow from min to max. */
    retryMinMs?: number;
    retryMaxMs?: number;
}

const defaultSleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
});

export class ServerClient {
    private state: ConnectionState = { kind: 'connecting' };
    private refreshing: Promise<boolean> | null = null;
    private probing = false;
    private readonly now: () => number;
    private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
    private readonly refreshMarginMs: number;
    private readonly retryMinMs: number;
    private readonly retryMaxMs: number;

    constructor(private readonly options: ServerClientOptions) {
        this.now = options.now ?? Date.now;
        this.sleep = options.sleep ?? defaultSleep;
        this.refreshMarginMs = options.refreshMarginMs ?? 60_000;
        this.retryMinMs = options.retryMinMs ?? 1_000;
        this.retryMaxMs = options.retryMaxMs ?? 30_000;
    }

    get connectionState(): ConnectionState {
        return this.state;
    }

    get signedIn(): boolean {
        return !!this.options.tokens.get();
    }

    /** Unauthenticated: who the server is and whether we can talk to it. */
    async hello(): Promise<ServerHello> {
        const res = await this.send({ method: 'GET', path: '/api/server/hello', headers: {} });
        const hello = parseJson(res.body) as ServerHello;
        const verdict = checkServerHello(hello);
        if (!verdict.ok) {
            this.setState({ kind: 'upgrade', side: verdict.upgrade, serverVersion: hello?.serverVersion });
            throw new UpgradeRequiredError(verdict.upgrade);
        }
        this.setState({ kind: 'connected', serverVersion: hello.serverVersion });
        return hello;
    }

    async login(username: string, password: string): Promise<LoginResult> {
        const res = await this.send({
            method: 'POST',
            path: '/api/auth/login',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        const body = parseJson(res.body);
        if (res.status !== 200) {
            if (res.status === 401 && errorOf(body, '') === 'DEVICE_NOT_JOINED') this.setState({ kind: 'device-revoked' });
            const retryAfter = Number(res.headers['retry-after']);
            return { ok: false, error: errorOf(body, 'LOGIN_FAILED'), ...(retryAfter > 0 ? { retryAfterSec: retryAfter } : {}) };
        }
        this.storeTokens(body);
        this.setState({ kind: 'connected', serverVersion: res.headers['x-nalamdesk-server-version'] });
        return {
            ok: true,
            user: body.user,
            ...(Number(body.facilityId) > 0 ? { facilityId: Number(body.facilityId) } : {}),
            ...(Array.isArray(body.facilities) ? { facilities: body.facilities } : {})
        };
    }

    /**
     * Moves this session to another facility (#195). The server reissues the
     * access token; the refresh token stays the same.
     */
    async switchFacility(facilityId: number): Promise<{ facilityId: number; role: string }> {
        const body = await this.call<any>('POST', '/api/auth/facility', { facilityId });
        const refreshToken = this.options.tokens.get()?.refreshToken;
        this.storeTokens({ ...body, ...(refreshToken ? { refreshToken } : {}) });
        return { facilityId: Number(body.facilityId), role: String(body.role) };
    }

    async logout(): Promise<void> {
        const tokens = this.options.tokens.get();
        this.options.tokens.set(null);
        if (!tokens) return;
        try {
            await this.options.transport.request(this.withProtocol({
                method: 'POST', path: '/api/auth/logout',
                headers: { authorization: `Bearer ${tokens.token}`, 'content-type': 'application/json' },
                body: '{}'
            }));
        } catch {
            // Signing out locally is enough when the server is away; the
            // session ends on its own.
        }
    }

    /** Calls an allowlisted data method, the same contract as Electron IPC. */
    async invoke<T = unknown>(method: string, args: unknown[] = []): Promise<T> {
        const res = await this.authorized({
            method: 'POST',
            path: `/api/ipc/${encodeURIComponent(method)}`,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(args)
        });
        const body = parseJson(res.body);
        if (res.status !== 200) throw new Error(errorOf(body, 'Server Error'));
        return body as T;
    }

    /** Signed-in request to any API path; returns the parsed body. */
    async call<T = unknown>(method: TransportRequest['method'], path: string, payload?: unknown): Promise<T> {
        const res = await this.authorized({
            method,
            path,
            headers: payload === undefined ? {} : { 'content-type': 'application/json' },
            ...(payload === undefined ? {} : { body: JSON.stringify(payload) })
        });
        const body = parseJson(res.body);
        if (res.status < 200 || res.status >= 300) throw new Error(errorOf(body, 'Server Error'));
        return body as T;
    }

    /**
     * Follows the live events stream until the signal aborts, reconnecting
     * with growing delays and resuming from the last event seen.
     */
    async watchEvents(onEvent: (event: ServerEventMessage) => void, signal: AbortSignal): Promise<void> {
        let lastEventId: string | null = null;
        let delay = this.retryMinMs;
        while (!signal.aborted) {
            if (!this.signedIn || this.state.kind === 'upgrade' || this.state.kind === 'device-revoked') return;
            const outcome = await this.streamOnce(onEvent, signal, lastEventId, (id) => { lastEventId = id; delay = this.retryMinMs; });
            if (outcome === 'stop' || signal.aborted) return;
            await this.sleep(delay, signal);
            delay = Math.min(delay * 2, this.retryMaxMs);
        }
    }

    private async streamOnce(
        onEvent: (event: ServerEventMessage) => void,
        signal: AbortSignal,
        lastEventId: string | null,
        onId: (id: string) => void
    ): Promise<'retry' | 'stop'> {
        if (!(await this.ensureFreshToken())) return 'stop';
        const tokens = this.options.tokens.get();
        if (!tokens) return 'stop';
        const parse = createSseParser(({ id, event, data }) => {
            if (id) onId(id);
            const payload = parseJson(data);
            onEvent({
                id: id ? Number(id) : null,
                topic: event,
                ...(payload && typeof payload === 'object' && typeof payload.method === 'string' ? { method: payload.method } : {})
            });
        });
        const headers: Record<string, string> = { authorization: `Bearer ${tokens.token}`, accept: 'text/event-stream' };
        if (lastEventId) headers['last-event-id'] = lastEventId;
        try {
            const result = await this.options.transport.stream(this.withProtocol({ method: 'GET', path: '/api/events', headers }), (text) => {
                if (this.state.kind !== 'connected') this.setState({ kind: 'connected' });
                parse(text);
            }, signal);
            return this.afterStream(result);
        } catch {
            if (signal.aborted) return 'stop';
            this.markUnreachable();
            return 'retry';
        }
    }

    private async afterStream(result: { status: number; body?: string }): Promise<'retry' | 'stop'> {
        if (result.status === 401) {
            if (errorOf(parseJson(result.body ?? ''), '') === 'DEVICE_NOT_JOINED') {
                this.setState({ kind: 'device-revoked' });
                return 'stop';
            }
            return (await this.refresh()) ? 'retry' : 'stop';
        }
        if (result.status === 426) {
            this.handleUpgrade(result.body ?? '');
            return 'stop';
        }
        return 'retry';
    }

    private async authorized(req: TransportRequest): Promise<TransportResponse> {
        if (!(await this.ensureFreshToken())) throw new SessionExpiredError();
        const first = await this.sendWithToken(req);
        if (first.status !== 401) return first;
        if (errorOf(parseJson(first.body), '') === 'DEVICE_NOT_JOINED') {
            this.setState({ kind: 'device-revoked' });
            throw new SessionExpiredError('DEVICE_NOT_JOINED');
        }
        if (!(await this.refresh())) throw new SessionExpiredError();
        const second = await this.sendWithToken(req);
        if (second.status === 401) {
            this.endSession();
            throw new SessionExpiredError();
        }
        return second;
    }

    private async sendWithToken(req: TransportRequest): Promise<TransportResponse> {
        const tokens = this.options.tokens.get();
        if (!tokens) throw new SessionExpiredError();
        return this.send({ ...req, headers: { ...req.headers, authorization: `Bearer ${tokens.token}` } });
    }

    /** Refreshes ahead of expiry; false when there is no session left. */
    private async ensureFreshToken(): Promise<boolean> {
        const tokens = this.options.tokens.get();
        if (!tokens) {
            this.endSession();
            return false;
        }
        if (tokens.expiresAt - this.now() > this.refreshMarginMs) return true;
        if (!tokens.refreshToken) return tokens.expiresAt > this.now();
        return this.refresh();
    }

    /** One refresh at a time: refresh tokens rotate and a replay ends the session. */
    private refresh(): Promise<boolean> {
        this.refreshing ??= this.doRefresh().finally(() => { this.refreshing = null; });
        return this.refreshing;
    }

    private async doRefresh(): Promise<boolean> {
        const refreshToken = this.options.tokens.get()?.refreshToken;
        if (!refreshToken) {
            this.endSession();
            return false;
        }
        const res = await this.send({
            method: 'POST',
            path: '/api/auth/refresh',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ refreshToken })
        });
        const body = parseJson(res.body);
        if (res.status !== 200) {
            if (errorOf(body, '') === 'DEVICE_NOT_JOINED') this.setState({ kind: 'device-revoked' });
            this.endSession();
            return false;
        }
        this.storeTokens(body);
        return true;
    }

    private storeTokens(body: any): void {
        const expiresIn = Number(body?.expiresIn) > 0 ? Number(body.expiresIn) : 900;
        this.options.tokens.set({
            token: String(body.token),
            ...(typeof body.refreshToken === 'string' ? { refreshToken: body.refreshToken } : {}),
            expiresAt: this.now() + expiresIn * 1000
        });
    }

    private endSession(): void {
        const hadSession = !!this.options.tokens.get();
        this.options.tokens.set(null);
        if (hadSession && this.state.kind !== 'device-revoked') this.setState({ kind: 'signed-out' });
    }

    /** Every request: protocol header in, network failure and 426 handled. */
    private async send(req: TransportRequest): Promise<TransportResponse> {
        let res: TransportResponse;
        try {
            res = await this.options.transport.request(this.withProtocol(req));
        } catch {
            this.markUnreachable();
            throw new ServerUnreachableError();
        }
        if (res.status === 426) {
            throw new UpgradeRequiredError(this.handleUpgrade(res.body));
        }
        if (this.state.kind === 'unreachable' || this.state.kind === 'connecting') {
            this.setState({ kind: 'connected', serverVersion: res.headers['x-nalamdesk-server-version'] });
        }
        return res;
    }

    private handleUpgrade(body: string): 'client' | 'server' {
        const parsed = parseJson(body);
        const side = parsed?.upgrade === 'server' ? 'server' : 'client';
        this.setState({ kind: 'upgrade', side, serverVersion: parsed?.serverVersion });
        return side;
    }

    private withProtocol(req: TransportRequest): TransportRequest {
        return { ...req, headers: { ...req.headers, [PROTOCOL_HEADER]: String(PROTOCOL_VERSION) } };
    }

    private markUnreachable(): void {
        if (this.state.kind !== 'unreachable') this.setState({ kind: 'unreachable', since: this.now() });
        void this.probeUntilReachable();
    }

    /** While the server is away, knock on its hello until it answers. */
    private async probeUntilReachable(): Promise<void> {
        if (this.probing) return;
        this.probing = true;
        let delay = this.retryMinMs;
        try {
            while (this.state.kind === 'unreachable') {
                await this.sleep(delay);
                delay = Math.min(delay * 2, this.retryMaxMs);
                try {
                    const res = await this.options.transport.request(this.withProtocol({ method: 'GET', path: '/api/server/hello', headers: {} }));
                    if (res.status === 426) this.handleUpgrade(res.body);
                    else this.setState({ kind: 'connected', serverVersion: res.headers['x-nalamdesk-server-version'] });
                } catch {
                    // Still away; try again after the next delay.
                }
            }
        } finally {
            this.probing = false;
        }
    }

    private setState(state: ConnectionState): void {
        this.state = state;
        this.options.onState?.(state);
    }
}
