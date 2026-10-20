import * as crypto from 'node:crypto';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { resolveRoute } from './allowlist.js';
import type { AbdmEnvironment } from './environments.js';
import type { FetchFn, GatewaySession } from './gatewaySession.js';
import type { GatewayJwtVerifier } from './gatewayJwt.js';
import { stdoutLogger, type RelayLogEntry, type RelayLogger } from './log.js';
import type { DeviceAuthenticator, Doorbell, Facility, FacilityDirectory, Mailbox, MailboxItemType } from './ports.js';
import { registerInboxRoutes, type InboxRouteDeps } from './inboxRoutes.js';
import { registerPairingRoutes, type PairingRouteDeps } from './pairingRoutes.js';
import { seal } from './seal.js';

export interface RelayDeps {
    env: AbdmEnvironment;
    session: Pick<GatewaySession, 'token' | 'invalidate'>;
    devices: DeviceAuthenticator;
    facilities: FacilityDirectory;
    mailbox: Mailbox;
    doorbell: Doorbell;
    verifyGatewayJwt: GatewayJwtVerifier;
    /** Pairing, the ops console and key rotation (#154). */
    pairing?: PairingRouteDeps;
    /** The desktop's mailbox and doorbell certificate endpoints (#155). */
    inbox?: InboxRouteDeps;
    logger?: RelayLogger;
    fetchFn?: FetchFn;
    nowMs?: () => number;
}

export const LIMITS = {
    proxyBodyBytes: 256 * 1024,
    callbackBodyBytes: 256 * 1024,
    dataPushBodyBytes: 5 * 1024 * 1024,
    upstreamTimeoutMs: 25_000
};

// Desktop headers that may travel upstream. Authorization, X-CM-ID,
// X-HIP-ID and X-HIU-ID are always set by the relay, never passed through.
const FORWARDED_REQUEST_HEADERS = ['content-type', 'accept', 'request-id', 'timestamp', 'x-token', 't-token', 'transaction_id'];
const FORWARDED_RESPONSE_HEADERS = ['content-type', 'content-disposition', 'request-id', 'timestamp'];
// Callback headers worth sealing for the desktop; the gateway JWT is not one.
const SEALED_CALLBACK_HEADERS = ['request-id', 'timestamp', 'x-hip-id', 'x-hiu-id', 'x-cm-id', 'content-type'];

const CALLBACK_PATH = /^\/api\/v3(\/[A-Za-z0-9._-]+){1,8}$/;
const HIP_ID = /^[A-Za-z0-9._-]{1,64}$/;

function refuse(c: Context, status: number, code: string, extra: Record<string, unknown> = {}): Response {
    return c.json({ error: code, ...extra }, status as 400);
}

/**
 * The zero-knowledge ABDM relay as a plain Hono app, so it runs unchanged on
 * a Lambda Web Function or a local Node server.
 *
 * - `/abdm/{abha|gateway}/...`: signed desktop calls, checked and forwarded
 *   with the vendor token, response streamed back.
 * - `/api/v3/...`: gateway callbacks, JWT-verified, sealed to the clinic's
 *   key, stored in the mailbox and announced on the doorbell.
 * - `/hiu/data-push/:token`: Fidelius ciphertext from an HIP, sealed as-is.
 */
export function createRelayApp(deps: RelayDeps): Hono {
    const app = new Hono();
    const log = deps.logger ?? stdoutLogger;
    const fetchFn = deps.fetchFn ?? fetch;
    const nowMs = deps.nowMs ?? Date.now;

    const timed = (entry: Omit<RelayLogEntry, 'ms'>, started: number) => log({ ...entry, ms: nowMs() - started });

    app.get('/health', (c) => c.json({ ok: true }));

    app.on(['GET', 'POST'], '/abdm/*', bodyLimit({
        maxSize: LIMITS.proxyBodyBytes,
        onError: (c) => refuse(c, 413, 'body_too_large')
    }), async (c) => {
        const started = nowMs();
        const path = c.req.path;
        // Unauthenticated paths are caller-chosen, so only a bounded prefix is logged.
        const loggedPath = path.slice(0, 120);
        const body = new Uint8Array(await c.req.arrayBuffer());
        const query = new URL(c.req.url).search.slice(1);
        const auth = await deps.devices.authenticate({ method: c.req.method, path, query, headers: c.req.raw.headers, body });
        if (!auth.ok) {
            timed({ route: 'proxy', path: loggedPath, status: auth.status, code: auth.code }, started);
            return refuse(c, auth.status, auth.code, auth.serverTimeMs ? { serverTime: auth.serverTimeMs } : {});
        }
        if (c.req.header('x-hip-id') !== auth.hipId) {
            timed({ route: 'proxy', path: loggedPath, hipId: auth.hipId, status: 403, code: 'hip_mismatch' }, started);
            return refuse(c, 403, 'hip_mismatch');
        }
        const resolved = resolveRoute(c.req.method, path);
        if (!resolved) {
            timed({ route: 'proxy', path: loggedPath, hipId: auth.hipId, status: 403, code: 'path_not_allowed' }, started);
            return refuse(c, 403, 'path_not_allowed');
        }

        const base = resolved.upstream === 'abha' ? deps.env.abhaBaseUrl : deps.env.gatewayBaseUrl;
        const search = c.req.method === 'GET' && query ? `?${query}` : '';
        const target = `${base}${resolved.upstreamPath}${search}`;
        const send = async (token: string) => {
            const headers = new Headers();
            for (const name of FORWARDED_REQUEST_HEADERS) {
                const value = c.req.header(name);
                if (value) headers.set(name, value);
            }
            if (!headers.has('request-id')) headers.set('REQUEST-ID', crypto.randomUUID());
            if (!headers.has('timestamp')) headers.set('TIMESTAMP', new Date(nowMs()).toISOString());
            headers.set('Authorization', `Bearer ${token}`);
            if (resolved.upstream === 'gateway') {
                headers.set('X-CM-ID', deps.env.cmId);
                headers.set(resolved.route.milestone === 'M3' ? 'X-HIU-ID' : 'X-HIP-ID', auth.hipId);
            }
            return fetchFn(target, {
                method: c.req.method,
                headers,
                body: c.req.method === 'GET' ? undefined : body,
                signal: AbortSignal.timeout(LIMITS.upstreamTimeoutMs)
            });
        };

        let upstream: Response;
        try {
            upstream = await send(await deps.session.token());
            if (upstream.status === 401) {
                // An expired or revoked vendor token: refresh once and retry.
                await upstream.body?.cancel();
                deps.session.invalidate();
                upstream = await send(await deps.session.token());
            }
        } catch {
            timed({ route: 'proxy', path: resolved.upstreamPath, hipId: auth.hipId, status: 502, code: 'upstream_unreachable' }, started);
            return refuse(c, 502, 'upstream_unreachable');
        }

        const headers = new Headers();
        for (const name of FORWARDED_RESPONSE_HEADERS) {
            const value = upstream.headers.get(name);
            if (value) headers.set(name, value);
        }
        timed({ route: 'proxy', path: resolved.upstreamPath, hipId: auth.hipId, status: upstream.status }, started);
        return new Response(upstream.body, { status: upstream.status, headers });
    });

    // Stores before answering: a 202 is only sent once the sealed item is in
    // the mailbox, because ABDM does not resend a callback we acknowledged.
    // Sealing and one mailbox write keep this well inside the gateway's
    // timeout. The doorbell is best effort; the desktop also fetches on
    // connect and every 30 minutes.
    async function deliver(facility: Facility, type: MailboxItemType, plaintext: Uint8Array): Promise<void> {
        const sealed = seal(plaintext, facility.sealingPublicKey, facility.clinicId, type);
        const itemId = await deps.mailbox.put({ clinicId: facility.clinicId, type, sealed });
        // The lookup may be up to 30 seconds old. If the device was replaced
        // meanwhile, this item is sealed to a key nobody holds and may be
        // dated after the replacement's purge: drop it and answer 503 so
        // ABDM sends it again, to be sealed for the new device.
        if (!(await deps.facilities.stillCurrent(facility))) {
            await deps.mailbox.remove(facility.clinicId, [itemId]).catch(() => undefined);
            throw new Error('facility_changed');
        }
        deps.doorbell.ring(facility.clinicId).catch(() => undefined);
    }

    app.post('/api/v3/*', bodyLimit({
        maxSize: LIMITS.callbackBodyBytes,
        onError: (c) => refuse(c, 413, 'body_too_large')
    }), async (c) => {
        const started = nowMs();
        const path = c.req.path;
        if (!CALLBACK_PATH.test(path)) {
            timed({ route: 'callback', path: '/api/v3/*', status: 404, code: 'unknown_path' }, started);
            return refuse(c, 404, 'unknown_path');
        }
        if (!(await deps.verifyGatewayJwt(c.req.header('authorization')))) {
            timed({ route: 'callback', path, status: 401, code: 'bad_gateway_jwt' }, started);
            return refuse(c, 401, 'unauthorized');
        }
        const hipId = c.req.header('x-hip-id') || c.req.header('x-hiu-id') || '';
        const facility = HIP_ID.test(hipId) ? await deps.facilities.byHipId(hipId) : null;
        if (!facility || !facility.linkedToBridge) {
            timed({ route: 'callback', path, status: 404, code: 'unknown_facility' }, started);
            return refuse(c, 404, 'unknown_facility');
        }
        const headers: Record<string, string> = {};
        for (const name of SEALED_CALLBACK_HEADERS) {
            const value = c.req.header(name);
            if (value) headers[name] = value;
        }
        const envelope = Buffer.from(JSON.stringify({
            path,
            receivedAt: new Date(nowMs()).toISOString(),
            headers,
            body: Buffer.from(await c.req.arrayBuffer()).toString('utf8')
        }), 'utf8');
        try {
            await deliver(facility, 'abdm-callback', envelope);
        } catch {
            timed({ route: 'callback', path, hipId, status: 503, code: 'mailbox_unavailable' }, started);
            return refuse(c, 503, 'mailbox_unavailable');
        } finally {
            envelope.fill(0);
        }
        timed({ route: 'callback', path, hipId, status: 202 }, started);
        return c.body(null, 202);
    });

    app.post('/hiu/data-push/:token', bodyLimit({
        maxSize: LIMITS.dataPushBodyBytes,
        onError: (c) => refuse(c, 413, 'body_too_large')
    }), async (c) => {
        const started = nowMs();
        const token = c.req.param('token');
        const facility = /^[A-Za-z0-9_-]{32,128}$/.test(token) ? await deps.facilities.byDataPushToken(token) : null;
        if (!facility) {
            timed({ route: 'data-push', path: '/hiu/data-push', status: 404, code: 'unknown_target' }, started);
            return refuse(c, 404, 'unknown_target');
        }
        const body = new Uint8Array(await c.req.arrayBuffer());
        // The records inside are Fidelius ciphertext the relay cannot open;
        // the envelope is only checked to be JSON, then sealed byte for byte.
        try {
            const parsed = JSON.parse(Buffer.from(body).toString('utf8'));
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
        } catch {
            timed({ route: 'data-push', path: '/hiu/data-push', hipId: facility.hipId, status: 400, code: 'not_json' }, started);
            return refuse(c, 400, 'not_json');
        }
        try {
            await deliver(facility, 'abdm-data-push', body);
        } catch {
            timed({ route: 'data-push', path: '/hiu/data-push', hipId: facility.hipId, status: 503, code: 'mailbox_unavailable' }, started);
            return refuse(c, 503, 'mailbox_unavailable');
        }
        timed({ route: 'data-push', path: '/hiu/data-push', hipId: facility.hipId, status: 202 }, started);
        return c.body(null, 202);
    });

    if (deps.pairing) registerPairingRoutes(app, deps.pairing, { devices: deps.devices, log, nowMs });
    if (deps.inbox) registerInboxRoutes(app, deps.inbox, { devices: deps.devices, log, nowMs });

    app.notFound((c) => refuse(c, 404, 'not_found'));
    app.onError((_error, c) => refuse(c, 500, 'internal_error'));
    return app;
}
