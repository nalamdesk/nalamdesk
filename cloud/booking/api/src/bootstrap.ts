import { createDeviceAuthenticator, DynamoDeviceRegistry, DynamoNonceStore } from '@nalamdesk/cloud-shared';
import { Hono } from 'hono';
import { createBookingApp, type BookingDeps } from './app.js';
import type { DeviceAuthenticator, Doorbell, Mailbox } from './ports.js';

export interface Adapters {
    devices?: DeviceAuthenticator;
    mailbox?: Mailbox;
    doorbell?: Doorbell;
}

/** The signed-request verifier (#154), from the Core table names. */
export function deviceAuthenticatorFromEnv(env: NodeJS.ProcessEnv): DeviceAuthenticator | undefined {
    if (!env.DEVICES_TABLE || !env.NONCES_TABLE) return undefined;
    return createDeviceAuthenticator({
        audience: 'booking',
        devices: new DynamoDeviceRegistry(env.DEVICES_TABLE),
        nonces: new DynamoNonceStore(env.NONCES_TABLE)
    });
}

/**
 * The booking app when every adapter exists; otherwise a holding app that
 * answers 503 on every route and names what is missing on /api/health, so
 * the API never accepts a booking it cannot deliver or a clinic call it
 * cannot verify. The mailbox and doorbell arrive with #155.
 */
export function buildServerApp(base: Omit<BookingDeps, 'devices' | 'mailbox' | 'doorbell'>, adapters: Adapters): { app: Hono; missing: string[] } {
    const missing = [
        adapters.devices ? null : 'device authenticator (DEVICES_TABLE, NONCES_TABLE)',
        adapters.mailbox ? null : 'mailbox (#155)',
        adapters.doorbell ? null : 'doorbell (#155)'
    ].filter((name): name is string => name !== null);
    if (adapters.devices && adapters.mailbox && adapters.doorbell) {
        return { app: createBookingApp({ ...base, devices: adapters.devices, mailbox: adapters.mailbox, doorbell: adapters.doorbell }), missing };
    }
    const holding = new Hono();
    holding.get('/api/health', (c) => c.json({ ok: false, missing }, 503));
    holding.all('*', (c) => c.json({ error: 'not_ready' }, 503));
    return { app: holding, missing };
}

/**
 * The Web Function runtime sets AWS_LAMBDA_HTTP_ENDPOINT and only forwards
 * requests there; locally the API falls back to PORT or 127.0.0.1:8080.
 * Same rule as cloud/relay/src/bootstrap.ts.
 */
export function listenAddress(env: NodeJS.ProcessEnv): { hostname: string; port: number } {
    const endpoint = String(env.AWS_LAMBDA_HTTP_ENDPOINT || '').replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '');
    const match = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(endpoint);
    if (match) return { hostname: (match[1] as string).replace(/^\[|\]$/g, ''), port: Number(match[2]) };
    return { hostname: '127.0.0.1', port: Number(env.PORT) || 8080 };
}
