import type * as crypto from 'node:crypto';
import { bodySha256, ed25519PublicKey, SIGNATURE_HEADERS, verifyCanonical, type Audience, type CanonicalFields } from './signing.js';

export interface DesktopRequest {
    method: string;
    /** URL path as received, without the query string. */
    path: string;
    /** Raw query string without the leading `?`; empty if none. */
    query: string;
    headers: Headers;
    body: Uint8Array;
}

export type DeviceAuthResult =
    | { ok: true; deviceId: string; clinicId: string; hipId: string }
    | { ok: false; status: number; code: string; serverTimeMs?: number };

export interface DeviceAuthenticator {
    authenticate(request: DesktopRequest): Promise<DeviceAuthResult>;
}

export type DeviceStatus = 'active' | 'revoked';

/** The fields of a Core devices table row that request checks need. */
export interface DeviceRecord {
    deviceId: string;
    clinicId: string;
    hipId: string;
    status: DeviceStatus;
    /** Raw 32-byte Ed25519 public key, base64. */
    signingPublicKey: string;
    /** The key before the last rotation, accepted until previousKeyValidUntil (epoch ms). */
    previousSigningPublicKey?: string;
    previousKeyValidUntil?: number;
}

export interface DeviceRegistry {
    /** `fresh` skips any cache, for a retry after a key rotation. */
    get(deviceId: string, options?: { fresh?: boolean }): Promise<DeviceRecord | null>;
}

export interface NonceStore {
    /** Records the nonce; false if it was already seen. */
    claim(key: string, expiresAtMs: number): Promise<boolean>;
}

export interface RateLimiter {
    allow(key: string, nowMs: number): boolean;
}

export const VERIFIER_LIMITS = {
    /** Accepted distance between X-ND-Timestamp and server time. */
    clockWindowMs: 60_000,
    /** Nonces outlive the whole clock window on both sides. */
    nonceTtlMs: 5 * 60_000,
    /** Device rows (including revocations) are cached this long. */
    deviceCacheMs: 30_000
};

const DEVICE_ID = /^[A-Za-z0-9_-]{8,64}$/;
const TIMESTAMP = /^\d{13}$/;
const NONCE = /^[A-Za-z0-9_-]{22,64}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/;

/**
 * In-memory token bucket per key. Each Web Function environment keeps its
 * own buckets, so the effective limit is this times the environment count;
 * that is close enough for abuse control and costs no extra writes.
 */
export class TokenBucketLimiter implements RateLimiter {
    private readonly buckets = new Map<string, { tokens: number; at: number }>();

    constructor(private readonly perSecond = 20, private readonly burst = 60) {}

    allow(key: string, nowMs: number): boolean {
        const bucket = this.buckets.get(key) ?? { tokens: this.burst, at: nowMs };
        bucket.tokens = Math.min(this.burst, bucket.tokens + ((nowMs - bucket.at) / 1000) * this.perSecond);
        bucket.at = nowMs;
        if (this.buckets.size > 10_000 && !this.buckets.has(key)) this.buckets.clear();
        this.buckets.set(key, bucket);
        if (bucket.tokens < 1) return false;
        bucket.tokens -= 1;
        return true;
    }
}

export interface AuthenticatorOptions {
    audience: Audience;
    devices: DeviceRegistry;
    nonces: NonceStore;
    limiter?: RateLimiter;
    nowMs?: () => number;
}

const fail = (status: number, code: string, serverTimeMs?: number): DeviceAuthResult =>
    serverTimeMs === undefined ? { ok: false, status, code } : { ok: false, status, code, serverTimeMs };

/**
 * Checks a signed desktop request, cheapest first so junk never costs a
 * database write: header shape, clock window, device status, signature,
 * rate limit, then the nonce. The caller still checks X-HIP-ID against the
 * returned facility and the path against its own allowlist.
 */
export function createDeviceAuthenticator(options: AuthenticatorOptions): DeviceAuthenticator {
    const nowMs = options.nowMs ?? Date.now;
    const limiter = options.limiter ?? new TokenBucketLimiter();
    const keys = new Map<string, crypto.KeyObject>();
    const publicKey = (raw: string) => {
        let key = keys.get(raw);
        if (!key) {
            key = ed25519PublicKey(raw);
            if (keys.size > 5000) keys.clear();
            keys.set(raw, key);
        }
        return key;
    };

    return {
        async authenticate(request) {
            const header = (name: string) => request.headers.get(name) ?? '';
            const deviceId = header(SIGNATURE_HEADERS.device);
            const timestamp = header(SIGNATURE_HEADERS.timestamp);
            const nonce = header(SIGNATURE_HEADERS.nonce);
            const signature = header(SIGNATURE_HEADERS.signature);
            if (!DEVICE_ID.test(deviceId) || !TIMESTAMP.test(timestamp) || !NONCE.test(nonce) || !SIGNATURE.test(signature)) {
                return fail(401, 'unsigned');
            }

            const now = nowMs();
            if (Math.abs(now - Number(timestamp)) > VERIFIER_LIMITS.clockWindowMs) return fail(401, 'clock_skew', now);

            let device = await options.devices.get(deviceId);
            if (!device) return fail(401, 'device_unknown');
            if (device.status !== 'active') return fail(401, 'device_revoked');

            const fields: CanonicalFields = {
                audience: options.audience,
                method: request.method,
                path: request.path,
                query: request.query,
                bodySha256: bodySha256(request.body),
                timestamp,
                nonce,
                hipId: header('x-hip-id')
            };
            const signedBy = (record: DeviceRecord) =>
                verifyCanonical(publicKey(record.signingPublicKey), fields, signature) ||
                (!!record.previousSigningPublicKey && (record.previousKeyValidUntil ?? 0) > now &&
                    verifyCanonical(publicKey(record.previousSigningPublicKey), fields, signature));
            let valid = signedBy(device);
            if (!valid) {
                // A cached row may predate a key rotation done through another
                // environment; read it once more before refusing.
                const fresh = await options.devices.get(deviceId, { fresh: true });
                if (fresh && fresh.status === 'active' && fresh.signingPublicKey !== device.signingPublicKey) {
                    device = fresh;
                    valid = signedBy(device);
                }
            }
            if (!valid) return fail(401, 'bad_signature');

            if (!limiter.allow(deviceId, now)) return fail(429, 'rate_limited');
            if (!(await options.nonces.claim(`${deviceId}#${nonce}`, now + VERIFIER_LIMITS.nonceTtlMs))) return fail(401, 'replay');

            return { ok: true, deviceId, clinicId: device.clinicId, hipId: device.hipId };
        }
    };
}
