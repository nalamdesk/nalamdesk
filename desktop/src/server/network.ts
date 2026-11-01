// Network configuration for NalamDesk Server (#193): turns the server's
// config (environment variables today) into ApiServer options, and issues
// join codes for the `join-code` CLI and the admin API.
//
//   NALAMDESK_TLS_CERT / NALAMDESK_TLS_KEY  operator certificate and key (PEM files)
//   NALAMDESK_TLS=proxy                     TLS ends at a reverse proxy in front;
//                                           serve plain HTTP and trust X-Forwarded-*
//   NALAMDESK_PUBLIC_HOSTNAMES              extra names/IPs for the self-signed certificate

import * as crypto from 'node:crypto';
import { base32Encode, formatJoinCode, JOIN_SECRET_LENGTH } from '../shared/join-code';
import { loadOrCreateTls, TlsMaterial } from './tls';
import type { ServerAuthStore, SessionPolicy } from './auth-store';
import type { LoginLimiter } from './rate-limit';

export interface ApiServerOptions {
    /** Serve HTTPS with this certificate. */
    tls?: TlsMaterial | null;
    /** TLS is terminated by a reverse proxy; trust its forwarded headers. */
    behindProxy?: boolean;
    /** Only joined computers may sign in (NalamDesk Server). */
    requireDevice?: boolean;
    /** Access token lifetime; clients refresh before it ends. */
    accessTokenTtlSec?: number;
    sessionPolicy?: SessionPolicy;
    joinCodeTtlMs?: number;
    loginLimiter?: LoginLimiter;
    now?: () => number;
}

/** Fingerprint prefix meaning "no pin: verify the certificate against system CAs". */
export const NO_PIN_FINGERPRINT = '0'.repeat(64);

export const DEFAULT_JOIN_CODE_TTL_MS = 15 * 60_000;

export interface BuildNetworkOptionsInput {
    dataDir: string;
    env?: NodeJS.ProcessEnv;
}

/** Options for the headless server: HTTPS only, joined computers only. */
export function buildNetworkOptions({ dataDir, env = process.env }: BuildNetworkOptionsInput): ApiServerOptions {
    const behindProxy = String(env['NALAMDESK_TLS'] ?? '').toLowerCase() === 'proxy';
    const hostnames = String(env['NALAMDESK_PUBLIC_HOSTNAMES'] ?? '').split(',').map((h) => h.trim()).filter(Boolean);
    const tls = behindProxy
        ? null
        : loadOrCreateTls({
            dataDir,
            certFile: env['NALAMDESK_TLS_CERT'] || undefined,
            keyFile: env['NALAMDESK_TLS_KEY'] || undefined,
            hostnames
        });
    return { tls, behindProxy, requireDevice: true };
}

/** The fingerprint a join code carries for this server's certificate. */
export function joinFingerprint(options: Pick<ApiServerOptions, 'tls'>): string {
    // Only a self-signed certificate is pinned. Operator certificates (and
    // proxies, whose certificate the server cannot see) are verified against
    // the system's trusted CAs, and keep working across renewals.
    return options.tls?.selfSigned ? options.tls.fingerprint256 : NO_PIN_FINGERPRINT;
}

export function generateJoinSecret(): string {
    return base32Encode(crypto.randomBytes(5)).slice(0, JOIN_SECRET_LENGTH);
}

export interface IssuedJoinCode {
    code: string;
    expiresAt: number;
    deviceName: string | null;
}

/** Issues a one-time join code; shared by the admin API and the `join-code` CLI. */
export function issueJoinCode(
    store: ServerAuthStore,
    options: Pick<ApiServerOptions, 'tls'>,
    input: { createdBy: number | null; deviceName?: string | null; ttlMs?: number } = { createdBy: null }
): IssuedJoinCode {
    const secret = generateJoinSecret();
    const deviceName = input.deviceName ? String(input.deviceName).trim().slice(0, 100) || null : null;
    const { expiresAt } = store.issueJoinCode({
        secret,
        createdBy: input.createdBy,
        deviceName,
        ttlMs: input.ttlMs ?? DEFAULT_JOIN_CODE_TTL_MS
    });
    return { code: formatJoinCode(secret, joinFingerprint(options)), expiresAt, deviceName };
}
