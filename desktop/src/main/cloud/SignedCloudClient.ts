import type * as crypto from 'node:crypto';
import { signedHeaders, type Audience } from './requestSigning';

export type { Audience } from './requestSigning';

export interface CloudResponse {
    status: number;
    body: any;
}

/** A signed ABDM call through the relay, such as `POST /abdm/gateway/...`, as the paired facility. */
export type AbdmRelaySend = (method: 'GET' | 'POST', path: string, body?: unknown, headers?: AbdmRequestHeaders) => Promise<CloudResponse>;

/**
 * ABDM headers the desktop may set on a relayed call: the REQUEST-ID that
 * gateway callbacks echo back, and the link token for HIP-initiated linking.
 * The relay forwards them; everything else it sets itself.
 */
export interface AbdmRequestHeaders {
    'request-id'?: string;
    'x-link-token'?: string;
}

const ABDM_HEADER_NAMES = ['request-id', 'x-link-token'] as const;

export interface SigningIdentity {
    deviceId: string;
    hipId: string;
    privateKey: crypto.KeyObject;
}

export interface SignedCloudClientDeps {
    /** Base URL per service (no trailing slash), or null when this build has none. */
    baseUrl: (audience: Audience) => string | null;
    /** The paired device, or null before pairing. */
    identity: () => SigningIdentity | null;
    /** Called when the cloud says the device that signed (`deviceId`) was revoked or replaced. */
    onRevoked?: (code: 'device_revoked' | 'device_unknown', deviceId: string) => void | Promise<void>;
    fetchFn?: typeof fetch;
    nowMs?: () => number;
    timeoutMs?: number;
}

export class CloudUnavailableError extends Error {
    constructor(readonly code: 'not_configured' | 'not_paired' | 'network', message: string) {
        super(message);
    }
}

const REQUEST_TIMEOUT_MS = 15_000;

export interface SignedOptions {
    hipId?: string;
    /** Unsigned ABDM headers passed on to the gateway; only the names in `AbdmRequestHeaders` are sent. */
    headers?: AbdmRequestHeaders;
}

function abdmHeaders(headers: AbdmRequestHeaders | undefined): Record<string, string> {
    const out: Record<string, string> = {};
    for (const name of ABDM_HEADER_NAMES) {
        const value = headers?.[name];
        if (typeof value === 'string' && /^[\x21-\x7e]{1,2048}$/.test(value)) out[name] = value;
    }
    return out;
}

/**
 * HTTP to the relay and booking API (#154). Paired calls carry an Ed25519
 * signature over the canonical request; pairing calls are plain JSON whose
 * body the caller signs. If the computer's clock is off by more than the
 * cloud's 60-second window, the cloud answers `clock_skew` with its own
 * time; the client keeps the offset and signs once more.
 */
export class SignedCloudClient {
    private offsetMs = 0;
    private readonly fetchFn: typeof fetch;
    private readonly localNow: () => number;

    constructor(private readonly deps: SignedCloudClientDeps) {
        this.fetchFn = deps.fetchFn ?? fetch;
        this.localNow = deps.nowMs ?? Date.now;
    }

    /** Cloud time as best known: the local clock plus the last offset the cloud reported. */
    now(): number {
        return this.localNow() + this.offsetMs;
    }

    /** Records the cloud's time from a `clock_skew` answer. Returns false if it carried none. */
    adjustClock(response: CloudResponse): boolean {
        const serverTime = Number(response.body?.serverTime);
        if (response.status !== 401 || response.body?.error !== 'clock_skew' || !Number.isFinite(serverTime)) return false;
        this.offsetMs = serverTime - this.localNow();
        return true;
    }

    /** The same client (and clock offset) signing as a given key; used to finish a key rotation. */
    withIdentity(identity: SigningIdentity): Pick<SignedCloudClient, 'signed'> {
        return { signed: (audience, method, path, body, options) => this.signedAs(identity, audience, method, path, body, options) };
    }

    configured(audience: Audience): boolean {
        return !!this.deps.baseUrl(audience);
    }

    /** Unsigned JSON call (pairing endpoints, which carry their own signature in the body). */
    async plain(audience: Audience, method: string, path: string, body: unknown): Promise<CloudResponse> {
        const encoded = Buffer.from(JSON.stringify(body), 'utf8');
        return this.send(audience, method, path, encoded, { 'content-type': 'application/json' });
    }

    /** Signed call as the paired device. `path` may carry a query string. */
    async signed(audience: Audience, method: string, path: string, body?: unknown, options: SignedOptions = {}): Promise<CloudResponse> {
        const identity = this.deps.identity();
        if (!identity) throw new CloudUnavailableError('not_paired', 'This computer is not paired with NalamDesk Cloud.');
        return this.signedAs(identity, audience, method, path, body, options);
    }

    private async signedAs(identity: SigningIdentity, audience: Audience, method: string, path: string, body?: unknown, options: SignedOptions = {}): Promise<CloudResponse> {
        const encoded = body === undefined ? new Uint8Array() : Buffer.from(JSON.stringify(body), 'utf8');
        const [pathOnly, query = ''] = path.split('?', 2) as [string, string?];
        const attempt = () => this.send(audience, method, path, encoded, {
            ...abdmHeaders(options.headers),
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            ...signedHeaders({
                privateKey: identity.privateKey,
                deviceId: identity.deviceId,
                audience,
                method,
                path: pathOnly,
                query,
                body: encoded,
                hipId: options.hipId,
                nowMs: this.now()
            })
        });
        let response = await attempt();
        if (this.adjustClock(response)) response = await attempt();
        if (response.status === 401 && (response.body?.error === 'device_revoked' || response.body?.error === 'device_unknown')) {
            await this.deps.onRevoked?.(response.body.error, identity.deviceId);
        }
        return response;
    }

    private async send(audience: Audience, method: string, path: string, body: Uint8Array, headers: Record<string, string>): Promise<CloudResponse> {
        const base = this.deps.baseUrl(audience);
        if (!base) throw new CloudUnavailableError('not_configured', 'NalamDesk Cloud is not configured in this build.');
        let res: Response;
        try {
            res = await this.fetchFn(`${base}${path}`, {
                method,
                headers: { accept: 'application/json', ...headers },
                body: body.length > 0 ? body : undefined,
                signal: AbortSignal.timeout(this.deps.timeoutMs ?? REQUEST_TIMEOUT_MS)
            });
        } catch (error) {
            throw new CloudUnavailableError('network', `Could not reach NalamDesk Cloud: ${(error as Error).message}`);
        }
        const text = await res.text();
        let parsed: any = null;
        if (text) {
            try {
                parsed = JSON.parse(text);
            } catch {
                parsed = null;
            }
        }
        return { status: res.status, body: parsed };
    }
}
