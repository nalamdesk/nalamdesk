import { describe, expect, it } from 'vitest';
import { adaptersFromEnv, buildServerApp, listenAddress } from '../src/bootstrap.js';

describe('bootstrap', () => {
    it('listens where the Web Function runtime says', () => {
        expect(listenAddress({ AWS_LAMBDA_HTTP_ENDPOINT: '127.0.0.1:9001' })).toEqual({ hostname: '127.0.0.1', port: 9001 });
        expect(listenAddress({ AWS_LAMBDA_HTTP_ENDPOINT: 'http://0.0.0.0:8080/' })).toEqual({ hostname: '0.0.0.0', port: 8080 });
        expect(listenAddress({ AWS_LAMBDA_HTTP_ENDPOINT: '[::1]:7000' })).toEqual({ hostname: '::1', port: 7000 });
        expect(listenAddress({ PORT: '3005' })).toEqual({ hostname: '127.0.0.1', port: 3005 });
    });

    it('wires devices, facilities and credentials from the environment', () => {
        const adapters = adaptersFromEnv({ DEVICES_TABLE: 't', NONCES_TABLE: 'n', ABDM_CLIENT_ID_PARAM: '/a', ABDM_CLIENT_SECRET_PARAM: '/b' });
        expect(adapters.devices).toBeDefined();
        expect(adapters.facilities).toBeDefined();
        expect(adaptersFromEnv({ DEVICES_TABLE: 't' }).devices).toBeUndefined();
        expect(adapters.credentials).toBeDefined();
        expect(adaptersFromEnv({}).credentials).toBeUndefined();
    });

    it('serves a 503 holding app that names what is missing', async () => {
        const { app, missing } = buildServerApp({}, adaptersFromEnv({ DEVICES_TABLE: 't', NONCES_TABLE: 'n', ABDM_CLIENT_ID_PARAM: '/a', ABDM_CLIENT_SECRET_PARAM: '/b' }));
        expect(missing).toEqual(['mailbox (#155)', 'doorbell (#155)']);
        const health = await app.request('/health');
        expect(health.status).toBe(503);
        expect(await health.json()).toEqual({ ok: false, missing });
        const callback = await app.request('/api/v3/hip/patient/share', { method: 'POST', body: '{}' });
        expect(callback.status).toBe(503);
    });

    it('builds the real relay once every adapter exists', async () => {
        const stub = {} as any;
        const { app, missing } = buildServerApp({}, {
            devices: stub, facilities: stub, mailbox: stub, doorbell: stub, credentials: stub
        });
        expect(missing).toEqual([]);
        expect((await app.request('/health')).status).toBe(200);
    });
});
