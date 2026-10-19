import { describe, expect, it, vi } from 'vitest';
import { ABDM_ENVIRONMENTS } from '../src/environments.js';
import { GatewaySession } from '../src/gatewaySession.js';

const credentials = { load: async () => ({ clientId: 'SBX_1', clientSecret: 's3cret' }) };

function sessionWith(fetchFn: any, now = { t: 0 }) {
    return new GatewaySession(ABDM_ENVIRONMENTS.sandbox, credentials, fetchFn, () => now.t);
}

const ok = (token: string, expiresIn = 1200) =>
    new Response(JSON.stringify({ accessToken: token, expiresIn }), { status: 200 });

describe('GatewaySession', () => {
    it('opens a v3 session with client credentials and X-CM-ID', async () => {
        const fetchFn = vi.fn(async () => ok('t1'));
        expect(await sessionWith(fetchFn).token()).toBe('t1');
        const [url, init] = fetchFn.mock.calls[0] as any;
        expect(url).toBe('https://dev.abdm.gov.in/api/hiecm/gateway/v3/sessions');
        expect(init.headers['X-CM-ID']).toBe('sbx');
        expect(JSON.parse(init.body)).toEqual({ clientId: 'SBX_1', clientSecret: 's3cret', grantType: 'client_credentials' });
    });

    it('caches until two minutes before expiry, then refreshes', async () => {
        const now = { t: 0 };
        let n = 0;
        const fetchFn = vi.fn(async () => ok(`t${++n}`, 600));
        const session = sessionWith(fetchFn, now);
        expect(await session.token()).toBe('t1');
        now.t = 7 * 60 * 1000;
        expect(await session.token()).toBe('t1');
        now.t = 8 * 60 * 1000 + 1;
        expect(await session.token()).toBe('t2');
    });

    it('shares one request between concurrent callers', async () => {
        const fetchFn = vi.fn(async () => ok('t1'));
        const session = sessionWith(fetchFn);
        const tokens = await Promise.all([session.token(), session.token(), session.token()]);
        expect(tokens).toEqual(['t1', 't1', 't1']);
        expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it('fetches again after invalidate and surfaces rejections', async () => {
        const fetchFn = vi.fn()
            .mockResolvedValueOnce(ok('t1'))
            .mockResolvedValueOnce(new Response('', { status: 401 }));
        const session = sessionWith(fetchFn);
        await session.token();
        session.invalidate();
        await expect(session.token()).rejects.toThrow('gateway_session_rejected:401');
    });
});
