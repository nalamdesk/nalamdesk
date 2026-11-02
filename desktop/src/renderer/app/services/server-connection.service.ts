import { Injectable, NgZone, signal } from '@angular/core';
import { Subject } from 'rxjs';
import {
    ServerClient,
    type ConnectionState,
    type LoginResult,
    type ServerEventMessage,
    type ServerHello,
    type SessionTokens,
    type TokenStore
} from '../../../shared/server-client';
import { PROTOCOL_HEADER, PROTOCOL_VERSION } from '../../../shared/protocol';
import {
    BROWSER_DEVICE_KEY,
    clientBridge,
    createBridgeTransport,
    createFetchTransport,
    readBrowserDevice,
    type BrowserDevice,
    type NalamdeskClientBridge
} from './server-transport';

const TOKENS_KEY = 'nalamdesk_session';
/** Pre-#194 key; still cleared on sign-out. */
const LEGACY_TOKEN_KEY = 'nalamdesk_token';

/**
 * Access and refresh tokens live in sessionStorage: each tab or window has
 * its own session, so two tabs never race to rotate one refresh token.
 */
export function sessionTokenStore(storage: Storage = sessionStorage): TokenStore {
    return {
        get(): SessionTokens | null {
            try {
                const parsed = JSON.parse(storage.getItem(TOKENS_KEY) ?? 'null');
                return parsed && typeof parsed.token === 'string' ? parsed : null;
            } catch {
                return null;
            }
        },
        set(tokens) {
            if (tokens) storage.setItem(TOKENS_KEY, JSON.stringify(tokens));
            else storage.removeItem(TOKENS_KEY);
        }
    };
}

export type JoinBrowserResult = { ok: true; device: BrowserDevice } | { ok: false; error: string };

/**
 * The UI's connection to a NalamDesk Server: the browser client, and the
 * app in client mode. Not used by the single-PC app, which talks to its own
 * main process over IPC.
 */
@Injectable({ providedIn: 'root' })
export class ServerConnectionService {
    readonly state = signal<ConnectionState>({ kind: 'connecting' });
    readonly events = new Subject<ServerEventMessage>();
    readonly bridge: NalamdeskClientBridge | null = clientBridge();
    private readonly client: ServerClient;
    private eventsAbort: AbortController | null = null;

    constructor(private readonly zone: NgZone) {
        const transport = this.bridge
            ? createBridgeTransport(this.bridge)
            : createFetchTransport(() => readBrowserDevice()?.deviceToken ?? null);
        this.client = new ServerClient({
            transport,
            tokens: sessionTokenStore(),
            onState: (state) => this.zone.run(() => this.state.set(state))
        });
    }

    /** True inside the app joined to a server. */
    get isAppClient(): boolean {
        return !!this.bridge;
    }

    get signedIn(): boolean {
        return this.client.signedIn;
    }

    hello(): Promise<ServerHello> {
        return this.client.hello();
    }

    browserDevice(): BrowserDevice | null {
        return this.bridge ? null : readBrowserDevice();
    }

    /** Joins this browser with a code from an admin (the app joins from its first-run screen). */
    async joinBrowser(code: string, deviceName: string): Promise<JoinBrowserResult> {
        let response: Response;
        try {
            response = await fetch('/api/devices/join', {
                method: 'POST',
                headers: { 'content-type': 'application/json', [PROTOCOL_HEADER]: String(PROTOCOL_VERSION) },
                body: JSON.stringify({ code, name: deviceName })
            });
        } catch {
            return { ok: false, error: 'UNREACHABLE' };
        }
        const body = await response.json().catch(() => null);
        if (!response.ok || typeof body?.deviceToken !== 'string') {
            return { ok: false, error: response.status === 429 ? 'TOO_MANY_ATTEMPTS' : (body?.error ?? 'JOIN_FAILED') };
        }
        const device: BrowserDevice = { deviceId: body.deviceId, deviceName: body.deviceName, deviceToken: body.deviceToken };
        localStorage.setItem(BROWSER_DEVICE_KEY, JSON.stringify(device));
        return { ok: true, device };
    }

    /** Forgets this browser's credential, after the server revoked it. */
    forgetBrowserDevice(): void {
        localStorage.removeItem(BROWSER_DEVICE_KEY);
    }

    async login(username: string, password: string): Promise<LoginResult> {
        const result = await this.client.login(username, password);
        if (result.ok) this.startEvents();
        return result;
    }

    switchFacility(facilityId: number): Promise<{ facilityId: number; role: string }> {
        return this.client.switchFacility(facilityId);
    }

    async logout(): Promise<void> {
        this.stopEvents();
        await this.client.logout();
        localStorage.removeItem(LEGACY_TOKEN_KEY);
    }

    invoke<T = unknown>(method: string, args: unknown[]): Promise<T> {
        return this.client.invoke<T>(method, args);
    }

    call<T = unknown>(method: 'GET' | 'POST' | 'DELETE', path: string, payload?: unknown): Promise<T> {
        return this.client.call<T>(method, path, payload);
    }

    /** Follows live changes while signed in; safe to call more than once. */
    startEvents(): void {
        if (this.eventsAbort || !this.client.signedIn) return;
        const abort = new AbortController();
        this.eventsAbort = abort;
        void this.client.watchEvents((event) => this.zone.run(() => this.events.next(event)), abort.signal)
            .finally(() => { if (this.eventsAbort === abort) this.eventsAbort = null; });
    }

    stopEvents(): void {
        this.eventsAbort?.abort();
        this.eventsAbort = null;
    }
}
