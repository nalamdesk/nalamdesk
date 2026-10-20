import type { DeviceAuthenticator } from '@nalamdesk/cloud-shared';
import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { RelayLogEntry, RelayLogger } from './log.js';
import { OPS_CSS, OPS_HTML, OPS_JS } from './opsConsole.js';
import type { OpsTokenVerifier } from './opsAuth.js';
import { HFR_ID, type PairingResult, type PairingService } from './pairing.js';

export interface OpsConsoleConfig {
    /** Cognito managed login domain, such as `nalamdesk-ops-sandbox.auth.ap-south-1.amazoncognito.com`. */
    authDomain: string;
    clientId: string;
}

export interface PairingRouteDeps {
    service: PairingService;
    verifyOps: OpsTokenVerifier;
    console: OpsConsoleConfig;
}

const SMALL_BODY = 8 * 1024;
const ID = /^[a-z]{2,3}_[a-z0-9]{8,40}$/;

function refuse(c: Context, status: number, code: string, extra: Record<string, unknown> = {}): Response {
    return c.json({ error: code, ...extra }, status as 400);
}

async function jsonBody(c: Context): Promise<Record<string, unknown> | null> {
    try {
        const value = await c.req.json();
        return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
    } catch {
        return null;
    }
}

/**
 * The client's IP as CloudFront saw it. A CloudFront Function on the
 * distribution writes it to `x-nd-viewer-ip` on every request, replacing
 * anything the client sent, so it cannot be spoofed from outside.
 */
function clientIp(c: Context): string {
    return c.req.header('x-nd-viewer-ip') ?? 'unknown';
}

const consoleHeaders = (authDomain: string) => ({
    'cache-control': 'no-store',
    'content-security-policy': [
        "default-src 'none'", "script-src 'self'", "style-src 'self'", `connect-src 'self' https://${authDomain}`,
        "img-src 'self'", "form-action 'none'", "frame-ancestors 'none'", "base-uri 'none'"
    ].join('; '),
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'strict-transport-security': 'max-age=31536000'
});

/**
 * Pairing (unauthenticated, rate limited), the ops console and its API
 * (Cognito, `ops` group) and signed device key rotation, on the relay (#154).
 */
export function registerPairingRoutes(app: Hono, deps: PairingRouteDeps, ctx: {
    devices: DeviceAuthenticator;
    log: RelayLogger;
    nowMs: () => number;
}): void {
    const { service } = deps;
    const timed = (entry: Omit<RelayLogEntry, 'ms'>, started: number) => ctx.log({ ...entry, ms: ctx.nowMs() - started });
    const small = bodyLimit({ maxSize: SMALL_BODY, onError: (c) => refuse(c, 413, 'body_too_large') });
    const answer = <T>(c: Context, result: PairingResult<T>, ok: (value: T) => Response, entry: Omit<RelayLogEntry, 'ms' | 'status' | 'code'>, started: number) => {
        if (!result.ok) {
            timed({ ...entry, status: result.status, code: result.code }, started);
            return refuse(c, result.status, result.code, result.extra);
        }
        const res = ok(result.value);
        timed({ ...entry, status: res.status }, started);
        return res;
    };

    // ---- Desktop, before it has a device ID ----

    app.post('/pairing/request', small, async (c) => {
        const started = ctx.nowMs();
        const body = await jsonBody(c);
        if (!body) return refuse(c, 400, 'bad_request');
        const result = await service.request(body, clientIp(c));
        return answer(c, result, (value) => c.json(value, 202), { route: 'pairing', path: '/pairing/request' }, started);
    });

    app.delete('/pairing/request', small, async (c) => {
        const started = ctx.nowMs();
        const body = await jsonBody(c);
        if (!body) return refuse(c, 400, 'bad_request');
        const result = await service.cancel(body);
        return answer(c, result, () => c.body(null, 204), { route: 'pairing', path: '/pairing/request' }, started);
    });

    app.post('/pairing/activate', small, async (c) => {
        const started = ctx.nowMs();
        const body = await jsonBody(c);
        if (!body) return refuse(c, 400, 'bad_request');
        const result = await service.activate(body);
        return answer(c, result, (value) => c.json(value, 200), {
            route: 'pairing', path: '/pairing/activate', ...(result.ok ? { hipId: result.value.hipId } : {})
        }, started);
    });

    // ---- Paired desktop ----

    app.post('/device/rotate-key', small, async (c) => {
        const started = ctx.nowMs();
        const raw = new Uint8Array(await c.req.arrayBuffer());
        const auth = await ctx.devices.authenticate({ method: 'POST', path: c.req.path, query: new URL(c.req.url).search.slice(1), headers: c.req.raw.headers, body: raw });
        if (!auth.ok) {
            timed({ route: 'device', path: '/device/rotate-key', status: auth.status, code: auth.code }, started);
            return refuse(c, auth.status, auth.code, auth.serverTimeMs ? { serverTime: auth.serverTimeMs } : {});
        }
        let body: Record<string, unknown> | null = null;
        try {
            const parsed = JSON.parse(new TextDecoder().decode(raw));
            body = parsed && typeof parsed === 'object' ? parsed : null;
        } catch { /* refused below */ }
        if (!body) return refuse(c, 400, 'bad_request');
        const result = await service.rotateKey(auth.deviceId, body);
        return answer(c, result, () => c.body(null, 204), { route: 'device', path: '/device/rotate-key', hipId: auth.hipId }, started);
    });

    // ---- Ops console ----

    const page = (c: Context, body: string, type: string) =>
        c.body(body, 200, { 'content-type': type, ...consoleHeaders(deps.console.authDomain) });
    app.get('/ops', (c) => c.redirect('/ops/', 302));
    app.get('/ops/', (c) => page(c, OPS_HTML, 'text/html; charset=utf-8'));
    app.get('/ops/app.js', (c) => page(c, OPS_JS, 'text/javascript; charset=utf-8'));
    app.get('/ops/app.css', (c) => page(c, OPS_CSS, 'text/css; charset=utf-8'));
    app.get('/ops/config.json', (c) => c.json(deps.console, 200, { 'cache-control': 'no-store' }));

    type OpsEnv = { Variables: { actor: string } };
    const ops = app as unknown as Hono<OpsEnv>;
    ops.use('/ops/api/*', small, async (c, next) => {
        const user = await deps.verifyOps(c.req.header('authorization'));
        if (!user) {
            ctx.log({ route: 'ops', path: '/ops/api/*', status: 401, code: 'unauthorized', ms: 0 });
            return refuse(c, 401, 'unauthorized');
        }
        c.set('actor', user.sub);
        c.header('cache-control', 'no-store');
        await next();
    });

    ops.get('/ops/api/pairing-requests', async (c) => c.json({ requests: await service.listRequests() }));

    ops.post('/ops/api/pairing-requests/:hfrId/approve', async (c) => {
        const started = ctx.nowMs();
        const hfrId = c.req.param('hfrId');
        const body = await jsonBody(c);
        const requestId = typeof body?.requestId === 'string' ? body.requestId : '';
        if (!HFR_ID.test(hfrId) || !ID.test(requestId)) return refuse(c, 400, 'bad_request');
        const result = await service.approve(hfrId, requestId, c.get('actor'));
        return answer(c, result, (value) => c.json(value), { route: 'ops', path: '/ops/api/pairing-requests/approve', hipId: hfrId, actor: c.get('actor') }, started);
    });

    ops.post('/ops/api/pairing-requests/:hfrId/reject', async (c) => {
        const started = ctx.nowMs();
        const hfrId = c.req.param('hfrId');
        const body = await jsonBody(c);
        const requestId = typeof body?.requestId === 'string' ? body.requestId : '';
        if (!HFR_ID.test(hfrId) || !ID.test(requestId)) return refuse(c, 400, 'bad_request');
        const result = await service.reject(hfrId, requestId);
        return answer(c, result, () => c.body(null, 204), { route: 'ops', path: '/ops/api/pairing-requests/reject', hipId: hfrId, actor: c.get('actor') }, started);
    });

    ops.get('/ops/api/devices', async (c) => {
        const result = await service.devices(String(c.req.query('hipId') ?? '').trim().toUpperCase());
        if (!result.ok) return refuse(c, result.status, result.code);
        return c.json({ devices: result.value });
    });

    ops.post('/ops/api/devices/:deviceId/revoke', async (c) => {
        const started = ctx.nowMs();
        const deviceId = c.req.param('deviceId');
        if (!ID.test(deviceId)) return refuse(c, 400, 'bad_request');
        const result = await service.revoke(deviceId, c.get('actor'));
        return answer(c, result, () => c.body(null, 204), { route: 'ops', path: '/ops/api/devices/revoke', actor: c.get('actor') }, started);
    });
}
