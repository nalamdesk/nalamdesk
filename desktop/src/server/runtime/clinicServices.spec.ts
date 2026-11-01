import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron-log', () => ({ default: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { createClinicServices } from './clinicServices';

function fakeDb(overrides: Record<string, unknown> = {}) {
    return {
        getSettings: vi.fn(() => ({ cloud_enabled: 1 })),
        getCloudDevice: vi.fn(() => null),
        saveCloudDevice: vi.fn(),
        clearCloudDevice: vi.fn(),
        getNewAbdmMailboxItems: vi.fn(() => []),
        expireFetchedRecords: vi.fn(),
        sweepExpiredMedications: vi.fn(),
        runWork: vi.fn(async (work: () => unknown) => work()),
        ...overrides
    };
}

const keyStore = { status: () => ({ available: true, provider: 'test' }), protect: (v: Buffer) => v, unprotect: (v: Buffer) => v };

describe('createClinicServices', () => {
    afterEach(() => vi.useRealTimers());

    it('wires ABDM to the cloud link: unpaired means the mock gateway and no relay', () => {
        const db = fakeDb();
        const services = createClinicServices({ db: db as any, keyStore, appVersion: '1.0.0', baseUrl: () => null });
        expect(services.cloudLink.abdmRelay()).toBeNull();
        expect(services.relay.status().hfr_id).toBeFalsy();
        const status = services.cloudStatus();
        expect(status.listingEnabled).toBe(true);
        expect(status.mailbox.doorbell).toBeDefined();
    });

    it('sweeps retention, drains the ABDM mailbox and stops cleanly', async () => {
        const db = fakeDb();
        const warn = vi.fn();
        const services = createClinicServices({ db: db as any, keyStore, appVersion: '1.0.0', baseUrl: () => null, warn });
        services.start();
        services.start();
        expect(db.expireFetchedRecords).toHaveBeenCalledTimes(2);
        expect(db.sweepExpiredMedications).toHaveBeenCalledTimes(2);
        await vi.waitFor(() => expect(db.getNewAbdmMailboxItems).toHaveBeenCalled());
        services.stop();
        expect(warn).not.toHaveBeenCalled();
    });

    it('reports a failed retention sweep or mailbox pass without throwing', async () => {
        const db = fakeDb({
            expireFetchedRecords: vi.fn(() => { throw new Error('locked'); }),
            getNewAbdmMailboxItems: vi.fn(() => { throw new Error('no table'); })
        });
        const warn = vi.fn();
        const services = createClinicServices({ db: db as any, keyStore, appVersion: '1.0.0', baseUrl: () => null, warn });
        expect(() => services.start()).not.toThrow();
        await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining('[ABDM mailbox] Pass failed')));
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('[HIU] Retention sweep failed: locked'));
        services.stop();
    });

    it('forwards share events to the host', async () => {
        const notify = vi.fn();
        const services = createClinicServices({ db: fakeDb() as any, keyStore, appVersion: '1.0.0', baseUrl: () => null, notify });
        (services.mailbox as any).deps.onShare();
        expect(notify).toHaveBeenCalledWith('abdm:shareReceived', {});
    });
});
