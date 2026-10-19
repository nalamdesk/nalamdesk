import * as path from 'path';
import { loadDevelopmentEnv } from './load-env';

loadDevelopmentEnv();

/**
 * NalamDesk local port map
 * ─────────────────────────────────────────────────────────────────────────
 * Port | Service                         | Config / consumer
 * -----|---------------------------------|----------------------------------
 * 3000 | Installed desktop local API     | NALAMDESK_DESKTOP_PROD_API_PORT
 * 3002 | Desktop dev local API           | NALAMDESK_DESKTOP_DEV_API_PORT
 * 4200 | Desktop Angular dev server      | NALAMDESK_DESKTOP_ANGULAR_PORT
 *
 * Override any value in repo-root `.env.local` (gitignored).
 * Defaults live in repo-root `.env.development` (committed).
 */

export const PROD_API_PORT = parsePort(
    process.env['NALAMDESK_DESKTOP_PROD_API_PORT'],
    3000
);

export const DEV_API_PORT = parsePort(
    process.env['NALAMDESK_DESKTOP_DEV_API_PORT'],
    3002
);

export const DESKTOP_ANGULAR_PORT = parsePort(
    process.env['NALAMDESK_DESKTOP_ANGULAR_PORT'],
    4200
);

export const DEV_USER_DATA_DIR = 'NalamDesk-Dev';
export const DEV_APP_NAME = 'NalamDesk Dev';

export function isDevRuntime(isPackaged: boolean): boolean {
    return !isPackaged;
}

export function getApiPort(isPackaged: boolean): number {
    return isPackaged ? PROD_API_PORT : DEV_API_PORT;
}

export type CloudAudience = 'relay' | 'booking';

/**
 * NalamDesk Cloud addresses (#154): the relay (ABDM bridge, pairing,
 * mailbox) and the online booking API. A release build carries them in
 * build-identity.json (stamped from the same variables); the environment
 * overrides that for development. Without one, pairing is unavailable.
 */
export function getCloudServiceUrl(
    audience: CloudAudience,
    stamped: { relayUrl?: string | null; bookingApiUrl?: string | null } | null = null,
    env: NodeJS.ProcessEnv = process.env
): string | null {
    const raw = audience === 'relay'
        ? env['NALAMDESK_RELAY_URL'] || stamped?.relayUrl
        : env['NALAMDESK_BOOKING_API_URL'] || stamped?.bookingApiUrl;
    return normalizeCloudUrl(raw);
}

function normalizeCloudUrl(raw: string | null | undefined): string | null {
    if (!raw) return null;
    try {
        const url = new URL(raw);
        const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
        if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) return null;
        if (url.search || url.hash || url.username || url.password) return null;
        return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
    } catch {
        return null;
    }
}

export function getDevUiProxyUrl(): string {
    return `http://127.0.0.1:${DESKTOP_ANGULAR_PORT}`;
}

export function getDevUserDataPath(appDataPath: string): string {
    return path.join(appDataPath, DEV_USER_DATA_DIR);
}

export function getDatabasePath(userDataPath: string, dbName: string): string {
    return path.join(userDataPath, dbName);
}

function parsePort(raw: string | undefined, fallback: number): number {
    if (!raw) {
        return fallback;
    }
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed > 0 && parsed < 65536) {
        return parsed;
    }
    return fallback;
}

export { parsePort };
