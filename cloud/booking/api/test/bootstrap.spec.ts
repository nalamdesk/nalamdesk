import { describe, expect, it } from 'vitest';
import { activeDevicesFromEnv, adaptersFromEnv, buildServerApp, deviceAuthenticatorFromEnv, listenAddress, mailboxFromEnv } from '../src/bootstrap.js';
import { MemoryBookingStore, MemoryClinicStore, MemorySlotStore } from '../src/memory.js';

const base = { clinics: new MemoryClinicStore(), slots: new MemorySlotStore(), bookings: new MemoryBookingStore(), phonePepper: Buffer.alloc(32, 1) };

describe('bootstrap', () => {
    it('serves a 503 holding app naming what is missing until every adapter exists', async () => {
        const { app, missing } = buildServerApp(base, {});
        expect(missing).toEqual(['device authenticator (DEVICES_TABLE, NONCES_TABLE)', 'mailbox (MAILBOX_TABLE, MAILBOX_BUCKET)', 'doorbell (IOT_DATA_ENDPOINT, DOORBELL_TOPIC_PREFIX)']);
        const health = await app.request('/api/health');
        expect(health.status).toBe(503);
        expect(await health.json()).toEqual({ ok: false, missing });
        expect((await app.request('/api/clinics')).status).toBe(503);
        expect((await app.request('/api/book', { method: 'POST' })).status).toBe(503);
    });

    it('builds the signed-request verifier from the Core table names', () => {
        expect(deviceAuthenticatorFromEnv({ DEVICES_TABLE: 'd', NONCES_TABLE: 'n' })).toBeDefined();
        expect(deviceAuthenticatorFromEnv({ DEVICES_TABLE: 'd' })).toBeUndefined();
    });

    it('builds the mailbox and doorbell from the Core names', () => {
        const adapters = adaptersFromEnv({
            DEVICES_TABLE: 'd', NONCES_TABLE: 'n', MAILBOX_TABLE: 'm', MAILBOX_BUCKET: 'b',
            IOT_DATA_ENDPOINT: 'x-ats.iot.ap-south-1.amazonaws.com', DOORBELL_TOPIC_PREFIX: 'nalamdesk/sandbox/clinic'
        });
        expect(buildServerApp(base, adapters).missing).toEqual([]);
        expect(adaptersFromEnv({ MAILBOX_TABLE: 'm' }).mailbox).toBeUndefined();
        expect(adaptersFromEnv({ IOT_DATA_ENDPOINT: 'x' }).doorbell).toBeUndefined();
    });

    it('serves the booking app once the adapters are wired', async () => {
        const { app, missing } = buildServerApp(base, {
            devices: { authenticate: async () => ({ ok: false, status: 401, code: 'no' }) },
            activeDevices: { isActive: async () => true },
            mailbox: { put: async () => undefined },
            doorbell: { ring: async () => undefined }
        } as any);
        expect(missing).toEqual([]);
        expect((await app.request('/api/health')).status).toBe(200);
    });

    it('checks the device row with a consistent read, and takes items back with a row delete', async () => {
        const sent: any[] = [];
        const dynamo = { send: async (command: any) => { sent.push(command); return {}; } };
        const mailbox = mailboxFromEnv({ MAILBOX_TABLE: 'm', MAILBOX_BUCKET: 'b' }, dynamo as never)!;
        await mailbox.remove('cln_1', ['item-a']);
        expect(sent[0].input).toEqual({ TableName: 'm', Key: { clinicId: { S: 'cln_1' }, itemId: { S: 'item-a' } } });
        expect(activeDevicesFromEnv({})).toBeUndefined();
        expect(buildServerApp(base, { ...adaptersFromEnv({ NONCES_TABLE: 'n' }), devices: {} as never }).missing[0]).toContain('device authenticator');
    });

    it('listens where the Web Function runtime says, else on PORT locally', () => {
        expect(listenAddress({ AWS_LAMBDA_HTTP_ENDPOINT: '127.0.0.1:9001' })).toEqual({ hostname: '127.0.0.1', port: 9001 });
        expect(listenAddress({ AWS_LAMBDA_HTTP_ENDPOINT: 'http://[::1]:9002/' })).toEqual({ hostname: '::1', port: 9002 });
        expect(listenAddress({ PORT: '8787' })).toEqual({ hostname: '127.0.0.1', port: 8787 });
    });
});
