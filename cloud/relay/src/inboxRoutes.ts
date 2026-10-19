import { MAILBOX_LIMITS, isMailboxItemId, type DeviceAuthenticator } from '@nalamdesk/cloud-shared';
import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { CertificateError } from './iotCertificates.js';
import type { RelayLogEntry, RelayLogger } from './log.js';
import type { DeviceCertificates, DoorbellConnection, Inbox } from './ports.js';

export interface InboxRouteDeps {
    inbox: Inbox;
    certificates: DeviceCertificates;
    doorbell: DoorbellConnection;
    /** The device's current status, read consistently (no cache). */
    deviceStatus: (deviceId: string) => Promise<'active' | 'revoked' | null>;
}

const CSR = /^-----BEGIN CERTIFICATE REQUEST-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE REQUEST-----\r?\n?$/;

/**
 * The paired desktop's mailbox and doorbell endpoints (#155), all signed:
 *   GET  /inbox                  oldest items first; large ones as short-lived links
 *   POST /inbox/ack              { ids } the desktop has saved; they are deleted
 *   POST /device/iot-certificate { csr } for a P-256 key; returns the
 *                                certificate, endpoint, client ID and topic
 */
export function registerInboxRoutes(app: Hono, deps: InboxRouteDeps, ctx: {
    devices: DeviceAuthenticator;
    log: RelayLogger;
    nowMs: () => number;
}): void {
    const refuse = (c: Context, status: number, code: string, extra: Record<string, unknown> = {}) => c.json({ error: code, ...extra }, status as 400);
    const small = bodyLimit({ maxSize: 16 * 1024, onError: (c) => refuse(c, 413, 'body_too_large') });

    const signed = async (c: Context, path: string) => {
        const started = ctx.nowMs();
        const raw = new Uint8Array(await c.req.arrayBuffer());
        const auth = await ctx.devices.authenticate({
            method: c.req.method, path: c.req.path, query: new URL(c.req.url).search.slice(1), headers: c.req.raw.headers, body: raw
        });
        const done = (entry: Omit<RelayLogEntry, 'ms' | 'route' | 'path'>) => ctx.log({ route: 'inbox', path, ...entry, ms: ctx.nowMs() - started });
        if (!auth.ok) {
            done({ status: auth.status, code: auth.code });
            return { response: refuse(c, auth.status, auth.code, auth.serverTimeMs ? { serverTime: auth.serverTimeMs } : {}) } as const;
        }
        let body: Record<string, unknown> | null = null;
        if (raw.length) {
            try {
                const parsed = JSON.parse(new TextDecoder().decode(raw));
                body = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
            } catch { /* refused by the caller */ }
        }
        return { auth, body, done } as const;
    };

    app.get('/inbox', async (c) => {
        const r = await signed(c, '/inbox');
        if ('response' in r) return r.response;
        try {
            const page = await deps.inbox.list(r.auth.clinicId);
            r.done({ hipId: r.auth.hipId, status: 200 });
            c.header('cache-control', 'no-store');
            return c.json(page);
        } catch {
            r.done({ hipId: r.auth.hipId, status: 503, code: 'mailbox_unavailable' });
            return refuse(c, 503, 'mailbox_unavailable');
        }
    });

    app.post('/inbox/ack', small, async (c) => {
        const r = await signed(c, '/inbox/ack');
        if ('response' in r) return r.response;
        const ids = r.body?.ids;
        if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAILBOX_LIMITS.ackMaxIds || !ids.every(isMailboxItemId)) {
            r.done({ hipId: r.auth.hipId, status: 400, code: 'bad_request' });
            return refuse(c, 400, 'bad_request');
        }
        try {
            // Keys are scoped by the authenticated clinic, so another clinic's IDs delete nothing.
            await deps.inbox.ack(r.auth.clinicId, ids as string[]);
        } catch {
            r.done({ hipId: r.auth.hipId, status: 503, code: 'mailbox_unavailable' });
            return refuse(c, 503, 'mailbox_unavailable');
        }
        r.done({ hipId: r.auth.hipId, status: 204 });
        return c.body(null, 204);
    });

    app.post('/device/iot-certificate', small, async (c) => {
        const r = await signed(c, '/device/iot-certificate');
        if ('response' in r) return r.response;
        const csr = r.body?.csr;
        if (typeof csr !== 'string' || csr.length > 4096 || !CSR.test(csr)) {
            r.done({ hipId: r.auth.hipId, status: 400, code: 'bad_csr' });
            return refuse(c, 400, 'bad_csr');
        }
        try {
            const { certificatePem } = await deps.certificates.issue({ deviceId: r.auth.deviceId, clinicId: r.auth.clinicId }, csr);
            // A revocation can land while this request is in flight, after
            // its own certificate cleanup ran: look again now that the new
            // certificate is attached, and take it back if so.
            if ((await deps.deviceStatus(r.auth.deviceId)) !== 'active') {
                await deps.certificates.revoke(r.auth.deviceId);
                r.done({ hipId: r.auth.hipId, status: 401, code: 'device_revoked' });
                return refuse(c, 401, 'device_revoked');
            }
            r.done({ hipId: r.auth.hipId, status: 200 });
            return c.json({
                certificatePem,
                endpoint: deps.doorbell.endpoint,
                clientId: r.auth.deviceId,
                topic: `${deps.doorbell.topicPrefix}/${r.auth.clinicId}/mail`
            });
        } catch (error) {
            if (error instanceof CertificateError) {
                r.done({ hipId: r.auth.hipId, status: 400, code: error.code });
                return refuse(c, 400, error.code);
            }
            r.done({ hipId: r.auth.hipId, status: 503, code: 'iot_unavailable' });
            return refuse(c, 503, 'iot_unavailable');
        }
    });
}
