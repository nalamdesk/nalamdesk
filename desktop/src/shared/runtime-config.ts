import * as path from 'path';
import { loadDevelopmentEnv } from './load-env';

loadDevelopmentEnv();

/**
 * NalamDesk local port map
 * ─────────────────────────────────────────────────────────────────────────
 * Port | Service                         | Config / consumer
 * -----|---------------------------------|----------------------------------
 * 3000 | Installed desktop local API     | NALAMDESK_DESKTOP_PROD_API_PORT
 * 3001 | Cloud sync API                  | NALAMDESK_CLOUD_API_PORT
 *      |   desktop CloudSyncService      |   CLOUD_API_URL
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

export const CLOUD_API_PORT = parsePort(
    process.env['NALAMDESK_CLOUD_API_PORT'],
    3001
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

export function getCloudApiUrl(): string {
    const configured = process.env['CLOUD_API_URL'];
    if (configured) {
        return configured;
    }
    return `http://127.0.0.1:${CLOUD_API_PORT}/api/v1`;
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
