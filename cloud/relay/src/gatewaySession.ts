import * as crypto from 'node:crypto';
import type { AbdmEnvironment } from './environments.js';
import type { VendorCredentials } from './ports.js';

const DEFAULT_TTL_MS = 20 * 60 * 1000;
const REFRESH_EARLY_MS = 2 * 60 * 1000;

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Vendor session token for the ABDM gateway (client credentials). Cached
 * until shortly before expiry; concurrent callers share one request. The
 * token is only ever attached to upstream calls and is never handed back to
 * a desktop.
 */
export class GatewaySession {
    private cached: { token: string; expiresAt: number } | null = null;
    private inflight: Promise<string> | null = null;

    constructor(
        private readonly env: AbdmEnvironment,
        private readonly credentials: VendorCredentials,
        private readonly fetchFn: FetchFn = fetch,
        private readonly nowMs: () => number = Date.now
    ) { }

    async token(): Promise<string> {
        const cached = this.cached;
        if (cached && this.nowMs() < cached.expiresAt - REFRESH_EARLY_MS) return cached.token;
        if (!this.inflight) {
            this.inflight = this.open().finally(() => { this.inflight = null; });
        }
        return this.inflight;
    }

    /** Drops the cached token, for example after the gateway answers 401. */
    invalidate(): void {
        this.cached = null;
    }

    private async open(): Promise<string> {
        const { clientId, clientSecret } = await this.credentials.load();
        const response = await this.fetchFn(`${this.env.gatewayBaseUrl}/gateway/v3/sessions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'REQUEST-ID': crypto.randomUUID(),
                'TIMESTAMP': new Date(this.nowMs()).toISOString(),
                'X-CM-ID': this.env.cmId
            },
            body: JSON.stringify({ clientId, clientSecret, grantType: 'client_credentials' }),
            signal: AbortSignal.timeout(10_000)
        });
        if (!response.ok) throw new Error(`gateway_session_rejected:${response.status}`);
        const body = await response.json() as { accessToken?: string; expiresIn?: number };
        if (!body?.accessToken) throw new Error('gateway_session_missing_token');
        const ttlMs = Number(body.expiresIn) > 0 ? Number(body.expiresIn) * 1000 : DEFAULT_TTL_MS;
        this.cached = { token: body.accessToken, expiresAt: this.nowMs() + ttlMs };
        return body.accessToken;
    }
}
