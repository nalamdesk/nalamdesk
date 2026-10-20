import { describe, expect, it, vi } from 'vitest';
import { adaptersFromEnv, buildServerApp, listenAddress, pairingFromEnv, revocationLifecycle } from '../src/bootstrap.js';

const MAILBOX_ENV = {
    MAILBOX_TABLE: 'm', MAILBOX_BUCKET: 'b', IOT_DATA_ENDPOINT: 'x-ats.iot.ap-south-1.amazonaws.com',
    DOORBELL_TOPIC_PREFIX: 'nalamdesk/sandbox/clinic', IOT_POLICY_NAME: 'nalamdesk-sandbox-device'
};

const PAIRING_ENV = {
    DEVICES_TABLE: 't', NONCES_TABLE: 'n', PAIRING_TABLE: 'p', CLINIC_IDS_TABLE: 'c', PAIRING_PEPPER_PARAM: '/pepper',
    BRIDGE_URL: 'https://abdm-sandbox.example.in/', OPS_USER_POOL_ID: 'ap-south-1_abc', OPS_CLIENT_ID: 'client', OPS_AUTH_DOMAIN: 'ops.auth.example'
};

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

    it('wires pairing and the ops console only when every name is set', () => {
        expect(pairingFromEnv(PAIRING_ENV)).toMatchObject({ console: { authDomain: 'ops.auth.example', clientId: 'client' } });
        expect(pairingFromEnv({ ...PAIRING_ENV, OPS_CLIENT_ID: '' })).toBeUndefined();
        expect(adaptersFromEnv(PAIRING_ENV).pairing).toBeDefined();
    });

    it('serves a 503 holding app that names what is missing', async () => {
        const { app, missing } = buildServerApp({}, adaptersFromEnv({ DEVICES_TABLE: 't', NONCES_TABLE: 'n', ABDM_CLIENT_ID_PARAM: '/a', ABDM_CLIENT_SECRET_PARAM: '/b' }));
        expect(missing).toEqual([
            expect.stringMatching(/^mailbox \(MAILBOX_TABLE/), expect.stringMatching(/^doorbell \(IOT_DATA_ENDPOINT/),
            expect.stringMatching(/^inbox and IoT certificates/), expect.stringMatching(/^pairing \(PAIRING_TABLE/)
        ]);
        const health = await app.request('/health');
        expect(health.status).toBe(503);
        expect(await health.json()).toEqual({ ok: false, missing });
        const callback = await app.request('/api/v3/hip/patient/share', { method: 'POST', body: '{}' });
        expect(callback.status).toBe(503);
    });

    it('builds the real relay once every adapter exists', async () => {
        const stub = {} as any;
        const { app, missing } = buildServerApp({}, {
            devices: stub, facilities: stub, mailbox: stub, doorbell: stub, credentials: stub, pairing: pairingFromEnv(PAIRING_ENV), inbox: stub
        });
        expect(missing).toEqual([]);
        expect((await app.request('/health')).status).toBe(200);
        expect((await app.request('/ops/')).status).toBe(200);
    });

    it('wires the mailbox, doorbell and IoT certificates from the environment', () => {
        const adapters = adaptersFromEnv({ ...PAIRING_ENV, ...MAILBOX_ENV });
        expect(adapters.mailbox).toBeDefined();
        expect(adapters.doorbell).toBeDefined();
        expect(adapters.inbox).toMatchObject({ doorbell: { endpoint: MAILBOX_ENV.IOT_DATA_ENDPOINT, topicPrefix: 'nalamdesk/sandbox/clinic' } });
        expect(adaptersFromEnv({ ...MAILBOX_ENV, IOT_POLICY_NAME: '' }).inbox).toBeUndefined();
        expect(buildServerApp({}, { ...adapters, credentials: {} as any }).missing).toEqual([]);
    });

    it('revokes the certificate and purges mail stored before a revocation', async () => {
        const inbox = { inbox: { purge: vi.fn(async () => 2) }, certificates: { revoke: vi.fn(async () => undefined) } } as any;
        await revocationLifecycle(inbox).revoked({ deviceId: 'dev_old', clinicId: 'cln_1', revokedAt: 5 } as any);
        expect(inbox.certificates.revoke).toHaveBeenCalledWith('dev_old');
        expect(inbox.inbox.purge).toHaveBeenCalledWith('cln_1', 5);
    });
});
