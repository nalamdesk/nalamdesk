/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { Subject } from 'rxjs';
import { CloudService } from './cloud.service';

describe('CloudService', () => {
    let service: CloudService;
    let data: { invoke: ReturnType<typeof vi.fn> };

    beforeEach(() => {
        data = { invoke: vi.fn().mockResolvedValue('from-server') };
        service = new CloudService(data as any);
        vi.restoreAllMocks();
    });

    afterEach(() => {
        delete (window as any).electron;
    });

    describe('with electron bridge', () => {
        let mockCloud: any;
        let mockDb: any;

        beforeEach(() => {
            mockCloud = {
                publishSlots: vi.fn().mockResolvedValue({ success: true }),
                getPublishedSlots: vi.fn().mockResolvedValue([{ time: '10:00' }]),
                syncNow: vi.fn().mockResolvedValue({ synced: true }),
                decide: vi.fn().mockResolvedValue({ success: true }),
                getStatus: vi.fn().mockResolvedValue({ state: 'paired' }),
                requestPairing: vi.fn().mockResolvedValue({ state: 'requested' }),
                activatePairing: vi.fn().mockResolvedValue({ state: 'paired' })
            };
            mockDb = {
                getAppointmentRequests: vi.fn().mockResolvedValue([{ id: '1', status: 'pending' }]),
                updateAppointmentRequestStatus: vi.fn().mockResolvedValue({ success: true }),
                saveAppointment: vi.fn().mockResolvedValue({ id: 1 }),
                getAppointments: vi.fn().mockResolvedValue([{ id: 1, date: '2026-01-01' }])
            };
            (window as any).electron = { cloud: mockCloud, db: mockDb };
        });

        it('should publish slots via IPC', async () => {
            const slots = [{ date: '2026-01-01', time: '10:00' }];
            const dates = ['2026-01-01'];
            const result = await service.publishSlots(slots, dates);
            expect(mockCloud.publishSlots).toHaveBeenCalledWith(slots, dates);
            expect(result).toEqual({ success: true });
        });

        it('should get published slots via IPC', async () => {
            const result = await service.getPublishedSlots('2026-01-01');
            expect(mockCloud.getPublishedSlots).toHaveBeenCalledWith('2026-01-01');
            expect(result).toEqual([{ time: '10:00' }]);
        });

        it('should get appointment requests via IPC', async () => {
            const result = await service.getAppointmentRequests();
            expect(mockDb.getAppointmentRequests).toHaveBeenCalled();
            expect(result).toEqual([{ id: '1', status: 'pending' }]);
        });

        it('should decide a booking request through the cloud', async () => {
            const result = await service.decide('ABCDEFGHJKMN', 'accepted');
            expect(mockCloud.decide).toHaveBeenCalledWith({ ref: 'ABCDEFGHJKMN', decision: 'accepted' });
            expect(mockDb.updateAppointmentRequestStatus).not.toHaveBeenCalled();
            expect(result).toEqual({ success: true });
        });

        it('should pair through IPC', async () => {
            expect(await service.getStatus()).toEqual({ state: 'paired' });
            await service.requestPairing('IN2710000123', 'Reception');
            await service.activatePairing('ABCD-1234');
            expect(mockCloud.requestPairing).toHaveBeenCalledWith({ hfrId: 'IN2710000123', label: 'Reception' });
            expect(mockCloud.activatePairing).toHaveBeenCalledWith({ code: 'ABCD-1234' });
        });

        it('should sync now via IPC', async () => {
            const result = await service.syncNow();
            expect(mockCloud.syncNow).toHaveBeenCalled();
            expect(result).toEqual({ synced: true });
        });

        it('should save appointment via IPC', async () => {
            const appt = { patient_id: 1, date: '2026-01-01' };
            const result = await service.saveAppointment(appt);
            expect(mockDb.saveAppointment).toHaveBeenCalledWith(appt);
            expect(result).toEqual({ id: 1 });
        });

        it('should get appointments via IPC', async () => {
            const result = await service.getAppointments('2026-01-01');
            expect(mockDb.getAppointments).toHaveBeenCalledWith('2026-01-01');
            expect(result).toEqual([{ id: 1, date: '2026-01-01' }]);
        });
    });

    it('uses the desktop push for booking requests, not the server stream', () => {
        const off = vi.fn();
        const onNewRequests = vi.fn((cb: (data: { count: number }) => void) => { cb({ count: 2 }); return off; });
        (window as any).electron = { cloud: { onNewRequests } };
        const events = new Subject<{ id: number | null; topic: string }>();
        const client = new CloudService(data as any, { events } as any);
        const requests = vi.fn();
        const stop = client.onRequestsChanged(requests);
        events.next({ id: 1, topic: 'bookings' });
        expect(requests).toHaveBeenCalledTimes(1);
        stop();
        expect(off).toHaveBeenCalled();
    });

    describe('without electron bridge (browser on NalamDesk Server)', () => {
        it('calls the server method for each cloud action', async () => {
            await service.publishSlots([{ date: '2026-01-01', time: '10:00' }], ['2026-01-01']);
            expect(data.invoke).toHaveBeenLastCalledWith('cloudPublishSlots', [{ date: '2026-01-01', time: '10:00' }], ['2026-01-01']);
            await service.getPublishedSlots('2026-01-01');
            expect(data.invoke).toHaveBeenLastCalledWith('cloudGetPublishedSlots', '2026-01-01');
            await service.decide('ABCDEFGHJKMN', 'accepted', { date: '2026-01-01', time: '10:00' });
            expect(data.invoke).toHaveBeenLastCalledWith('cloudDecide', { ref: 'ABCDEFGHJKMN', decision: 'accepted', date: '2026-01-01', time: '10:00' });
            expect(await service.getStatus()).toBe('from-server');
            expect(data.invoke).toHaveBeenLastCalledWith('cloudGetStatus');
            await service.requestPairing('IN27', 'Reception');
            expect(data.invoke).toHaveBeenLastCalledWith('cloudRequestPairing', { hfrId: 'IN27', label: 'Reception' });
            await service.activatePairing('ABCD-1234');
            expect(data.invoke).toHaveBeenLastCalledWith('cloudActivatePairing', { code: 'ABCD-1234' });
            await service.cancelPairing();
            expect(data.invoke).toHaveBeenLastCalledWith('cloudCancelPairing');
            await service.forgetPairing();
            expect(data.invoke).toHaveBeenLastCalledWith('cloudForgetPairing');
            await service.enableListing({ name: 'Asha', city: 'Chennai' });
            expect(data.invoke).toHaveBeenLastCalledWith('cloudEnableListing', { name: 'Asha', city: 'Chennai' });
            await service.disableListing();
            expect(data.invoke).toHaveBeenLastCalledWith('cloudDisableListing');
            await service.syncNow();
            expect(data.invoke).toHaveBeenLastCalledWith('cloudSyncNow');
        });

        it('reads and books appointments through the server', async () => {
            await service.getAppointmentRequests();
            expect(data.invoke).toHaveBeenLastCalledWith('getAppointmentRequests');
            await service.saveAppointment({ id: 1 });
            expect(data.invoke).toHaveBeenLastCalledWith('saveAppointment', { id: 1 });
            await service.getAppointments('2026-01-01');
            expect(data.invoke).toHaveBeenLastCalledWith('getAppointments', '2026-01-01');
        });

        it('has no pairing push without the desktop bridge', () => {
            const unsubscribe = service.onPairingChanged(() => undefined);
            expect(unsubscribe()).toBeUndefined();
        });

        it('follows the cloud and bookings events from the server (#216)', () => {
            const events = new Subject<{ id: number | null; topic: string }>();
            const client = new CloudService(data as any, { events } as any);
            const pairing = vi.fn();
            const requests = vi.fn();
            const stopPairing = client.onPairingChanged(pairing);
            const stopRequests = client.onRequestsChanged(requests);

            events.next({ id: 1, topic: 'cloud' });
            events.next({ id: 2, topic: 'bookings' });
            events.next({ id: 3, topic: 'queue' });
            expect(pairing).toHaveBeenCalledTimes(1);
            expect(pairing).toHaveBeenCalledWith();
            expect(requests).toHaveBeenCalledTimes(1);

            events.next({ id: null, topic: 'resync' });
            expect(pairing).toHaveBeenCalledTimes(2);
            expect(requests).toHaveBeenCalledTimes(2);

            stopPairing();
            stopRequests();
            events.next({ id: 4, topic: 'cloud' });
            events.next({ id: 5, topic: 'bookings' });
            expect(pairing).toHaveBeenCalledTimes(2);
            expect(requests).toHaveBeenCalledTimes(2);
        });
    });
});
