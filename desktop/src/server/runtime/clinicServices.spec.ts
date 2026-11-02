import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron-log', () => ({ default: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { createClinicServices, facilityScoped } from './clinicServices';
import { currentFacilityId, runWithContext } from '../../shared/request-context';

function fakeDb(overrides: Record<string, unknown> = {}) {
    return {
        getSettings: vi.fn(() => ({ cloud_enabled: 1 })),
        getCloudDevice: vi.fn(() => null),
        saveCloudDevice: vi.fn(),
        clearCloudDevice: vi.fn(),
        getNewAbdmMailboxItems: vi.fn(() => []),
        listCloudDeviceFacilities: vi.fn(() => [] as number[]),
        listFacilitiesForCloud: vi.fn(() => [{ id: 1, code: 'MAIN', name: 'Main' }, { id: 2, code: 'ANN', name: 'Anna Nagar' }]),
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

    describe('per facility (#215)', () => {
        const as = <T>(facilityId: number, run: () => T) => runWithContext({ userId: 1, facilityId }, run);

        it('gives each facility its own cloud link, resolved from the request', () => {
            const services = createClinicServices({ db: fakeDb() as any, keyStore, appVersion: '1.0.0', baseUrl: () => null });
            const first = as(1, () => services.cloudLink);
            const second = as(2, () => services.cloudLink);
            expect(first).not.toBe(second);
            expect(second).toBe(services.cloudLinkFor(2));
            expect(as(2, () => services.cloudLink)).toBe(second);
        });

        it('reads and writes each link\'s pairing as its facility, whoever calls', () => {
            const seen: number[] = [];
            const db = fakeDb({ getCloudDevice: vi.fn(() => { seen.push(currentFacilityId()); return null; }) });
            const services = createClinicServices({ db: db as any, keyStore, appVersion: '1.0.0', baseUrl: () => null });
            as(1, () => services.cloudLinkFor(2).pairing.status());
            expect(seen).toEqual([2]);
            expect(as(2, () => services.cloudStatus())).toMatchObject({ facilityId: 2, state: 'unpaired' });
        });

        it('sends ABDM through the relay as the request\'s facility', async () => {
            const services = createClinicServices({ db: fakeDb() as any, keyStore, appVersion: '1.0.0', baseUrl: () => null });
            const send = vi.fn(async () => ({ status: 200, body: { ok: true } }));
            vi.spyOn(services.cloudLinkFor(2), 'abdmRelay').mockReturnValue(send as any);
            vi.spyOn(services.cloudLinkFor(2).pairing, 'status').mockReturnValue({ state: 'paired', configured: true, hfrId: 'IN3310000002' });

            expect(as(1, () => services.relay.status())).toMatchObject({ mode: 'mock', hfr_id: null });
            expect(as(2, () => services.relay.status())).toMatchObject({ mode: 'relay', hfr_id: 'IN3310000002' });
            await as(2, () => services.relay.send('gateway', 'POST', '/x', {}));
            expect(send).toHaveBeenCalledWith('POST', '/abdm/gateway/x', {});
            await expect(as(1, () => services.relay.send('gateway', 'POST', '/x', {}))).rejects.toThrow(/not paired/);
        });

        it('starts the link of every facility with a cloud identity and lists each facility\'s state', () => {
            const db = fakeDb({ listCloudDeviceFacilities: vi.fn(() => [1, 3]) });
            const services = createClinicServices({ db: db as any, keyStore, appVersion: '1.0.0', baseUrl: () => null });
            const start = vi.spyOn(services.cloudLinkFor(3), 'start');
            services.start();
            expect(start).toHaveBeenCalledTimes(1);
            // A link first needed after start starts straight away.
            const later = services.cloudLinkFor(4);
            expect(later).toBe(services.cloudLinkFor(4));
            expect(services.cloudFacilities()).toEqual([
                { facilityId: 1, code: 'MAIN', name: 'Main', state: 'unpaired', hfrId: null, label: null, listingEnabled: true },
                { facilityId: 2, code: 'ANN', name: 'Anna Nagar', state: 'unpaired', hfrId: null, label: null, listingEnabled: true }
            ]);
            const stop = vi.spyOn(services.cloudLinkFor(3), 'stop');
            services.stop();
            expect(stop).toHaveBeenCalled();
        });
    });
});

describe('facilityScoped', () => {
    it('runs each method as the facility and passes other properties through', () => {
        const target = { name: 'db', where() { return currentFacilityId(); } };
        const scoped = facilityScoped(target, 7);
        expect(scoped.where()).toBe(7);
        expect(scoped.name).toBe('db');
    });
});
