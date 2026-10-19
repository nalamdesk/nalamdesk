import { describe, expect, it } from 'vitest';
import { buildServerApp, listenAddress } from '../src/bootstrap.js';
import { MemoryBookingStore, MemoryClinicStore, MemorySlotStore } from '../src/memory.js';

const base = { clinics: new MemoryClinicStore(), slots: new MemorySlotStore(), bookings: new MemoryBookingStore(), phonePepper: Buffer.alloc(32, 1) };

describe('bootstrap', () => {
    it('serves a 503 holding app naming what is missing until every adapter exists', async () => {
        const { app, missing } = buildServerApp(base, {});
        expect(missing).toEqual(['device authenticator (#154)', 'mailbox (#155)', 'doorbell (#155)']);
        const health = await app.request('/api/health');
        expect(health.status).toBe(503);
        expect(await health.json()).toEqual({ ok: false, missing });
        expect((await app.request('/api/clinics')).status).toBe(503);
        expect((await app.request('/api/book', { method: 'POST' })).status).toBe(503);
    });

    it('serves the booking app once the adapters are wired', async () => {
        const { app, missing } = buildServerApp(base, {
            devices: { authenticate: async () => ({ ok: false, status: 401, code: 'no' }) },
            mailbox: { put: async () => undefined },
            doorbell: { ring: async () => undefined }
        } as any);
        expect(missing).toEqual([]);
        expect((await app.request('/api/health')).status).toBe(200);
    });

    it('listens where the Web Function runtime says, else on PORT locally', () => {
        expect(listenAddress({ AWS_LAMBDA_HTTP_ENDPOINT: '127.0.0.1:9001' })).toEqual({ hostname: '127.0.0.1', port: 9001 });
        expect(listenAddress({ AWS_LAMBDA_HTTP_ENDPOINT: 'http://[::1]:9002/' })).toEqual({ hostname: '::1', port: 9002 });
        expect(listenAddress({ PORT: '8787' })).toEqual({ hostname: '127.0.0.1', port: 8787 });
    });
});
