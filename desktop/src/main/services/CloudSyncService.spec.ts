import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CloudSyncService } from './CloudSyncService';
import { DatabaseService } from './DatabaseService';

// Mock dependencies
vi.mock('electron-log');

describe('CloudSyncService', () => {
    let service: CloudSyncService;
    let dbService: DatabaseService;
    let mockDb: any;
    let originalFetch: any;

    beforeEach(() => {
        vi.clearAllMocks();

        // Mock DB Setup per test
        mockDb = {
            getSettings: vi.fn(),
            saveSettings: vi.fn(),
            getPatients: vi.fn(),
            savePatient: vi.fn(),
            addToQueue: vi.fn(),
            saveAppointmentRequest: vi.fn()
        };

        dbService = mockDb as unknown as DatabaseService;
        service = new CloudSyncService(dbService);

        // Mock Fetch
        originalFetch = global.fetch;
        global.fetch = vi.fn();
    });

    afterEach(() => {
        global.fetch = originalFetch;
        vi.restoreAllMocks();
    });

    it('should onboard successfully and save settings', async () => {
        // Mock Success Response
        (global.fetch as any).mockResolvedValue({
            ok: true,
            json: async () => ({ clinicId: 'test-id', apiKey: 'test-key' })
        });

        await service.onboard('My Clinic', 'Chennai');

        expect(global.fetch).toHaveBeenCalledWith(
            expect.stringContaining('/onboard'),
            expect.objectContaining({ method: 'POST' })
        );

        expect(mockDb.saveSettings).toHaveBeenCalledWith({
            cloud_clinic_id: 'test-id',
            cloud_api_key: 'test-key',
            cloud_enabled: 1
        });
    });

    it('should handle poll with no settings', async () => {
        mockDb.getSettings.mockReturnValue(null);
        await service.poll();
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it('should poll, process appointment request, and ack', async () => {
        // 1. Setup Settings
        mockDb.getSettings.mockReturnValue({
            cloud_enabled: 1,
            cloud_clinic_id: 'cid',
            cloud_api_key: 'key'
        });

        // 2. Mock Sync Response
        (global.fetch as any)
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ([{
                    id: 'msg_1',
                    type: 'APPOINTMENT_REQUEST',
                    payload: {
                        slotId: 'slot_1',
                        name: 'New Patient',
                        phone: '1234567890',
                        reason: 'Fever',
                        date: '2023-01-01',
                        time: '10:00'
                    }
                }])
            })
            // 3. Mock Ack Response
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ success: true })
            });

        // Act
        await service.poll();

        // Assert
        // Verify Sync Call
        expect(global.fetch).toHaveBeenNthCalledWith(1,
            expect.stringContaining('/sync'),
            expect.objectContaining({ headers: expect.objectContaining({ 'x-api-key': 'key' }) })
        );

        // Verify Save Request (Not Patient/Queue)
        expect(mockDb.saveAppointmentRequest).toHaveBeenCalledWith(expect.objectContaining({
            id: 'msg_1',
            patient_name: 'New Patient',
            phone: '1234567890',
            date: '2023-01-01',
            time: '10:00'
        }));

        // Verify Ack Call
        expect(global.fetch).toHaveBeenNthCalledWith(2,
            expect.stringContaining('/ack'),
            expect.objectContaining({
                method: 'POST',
                body: JSON.stringify({ ids: ['msg_1'] })
            })
        );
    });

    it('should handle request save failure but still continue', async () => {
        // Updated mock to include clinic_id so poll proceeds
        mockDb.getSettings.mockReturnValue({ cloud_enabled: 1, cloud_api_key: 'k', cloud_clinic_id: 'clinic_1' });

        (global.fetch as any).mockResolvedValueOnce({
            ok: true,
            json: async () => ([{
                id: 'msg_1',
                type: 'APPOINTMENT_REQUEST',
                payload: { name: 'Bad Data' }
            }])
        });

        // Mock error
        // @ts-ignore
        mockDb.saveAppointmentRequest = vi.fn().mockImplementation(() => {
            throw new Error('Save failed');
        });

        await service.poll();

        // Should NOT Ack if processing failed (logic says: try...catch around save, if catch log error. Does it push to processedIds? No, push is inside try block)
        // So it should NOT Ack.
        expect(global.fetch).toHaveBeenCalledTimes(1); // Sync only
    });

    describe('lifecycle, slots, and self-healing', () => {
        const enabledSettings = () => mockDb.getSettings.mockReturnValue({
            cloud_enabled: 1, cloud_clinic_id: 'cid', cloud_api_key: 'key'
        });

        afterEach(() => {
            service.stopPolling();
        });

        it('starts polling on init only when cloud is enabled', async () => {
            enabledSettings();
            (global.fetch as any).mockResolvedValue({ ok: true, json: async () => [] });
            service.init();
            expect((service as any).pollingInterval).not.toBeNull();
            service.stopPolling();

            mockDb.getSettings.mockReturnValue({ cloud_enabled: 0 });
            service.init();
            expect((service as any).pollingInterval).toBeNull();
        });

        it('reports status with and without settings', async () => {
            mockDb.getSettings.mockReturnValue(null);
            expect(await service.getStatus()).toEqual({ enabled: false, clinicId: null });
            enabledSettings();
            expect(await service.getStatus()).toEqual({ enabled: true, clinicId: 'cid' });
        });

        it('toggles polling with the enabled flag', async () => {
            (global.fetch as any).mockResolvedValue({ ok: true, json: async () => [] });
            await service.setEnabled(true);
            expect(mockDb.saveSettings).toHaveBeenCalledWith({ cloud_enabled: 1 });
            expect((service as any).pollingInterval).not.toBeNull();
            await service.setEnabled(false);
            expect((service as any).pollingInterval).toBeNull();
        });

        it('does not double-start the poller', async () => {
            (global.fetch as any).mockResolvedValue({ ok: true, json: async () => [] });
            enabledSettings();
            service.startPolling();
            const first = (service as any).pollingInterval;
            service.startPolling();
            expect((service as any).pollingInterval).toBe(first);
        });

        it('publishes slots only when enabled', async () => {
            mockDb.getSettings.mockReturnValue({ cloud_enabled: 0 });
            await expect(service.publishSlots([], [])).rejects.toThrow('Cloud sync not enabled');

            enabledSettings();
            (global.fetch as any).mockResolvedValue({ ok: true });
            await service.publishSlots([{ date: 'd', time: 't' }], ['d']);
            expect(global.fetch).toHaveBeenCalledWith(
                expect.stringContaining('/slots'), expect.objectContaining({ method: 'POST' }));

            (global.fetch as any).mockRejectedValueOnce(new Error('net down'));
            await expect(service.publishSlots([], [])).rejects.toThrow('net down');
        });

        it('reads published slots and degrades gracefully', async () => {
            mockDb.getSettings.mockReturnValue({ cloud_enabled: 0 });
            expect(await service.getPublishedSlots('2026-01-01')).toEqual([]);

            enabledSettings();
            (global.fetch as any).mockResolvedValueOnce({
                ok: true, json: async () => [{ time: '10:00' }]
            });
            expect(await service.getPublishedSlots('2026-01-01')).toEqual([{ time: '10:00' }]);

            (global.fetch as any).mockResolvedValueOnce({
                ok: false, status: 500, statusText: 'err', text: async () => 'boom'
            });
            expect(await service.getPublishedSlots('2026-01-01')).toEqual([]);

            (global.fetch as any).mockRejectedValueOnce(new Error('net down'));
            expect(await service.getPublishedSlots('2026-01-01')).toEqual([]);
        });

        it('self-heals on 401 by disabling sync', async () => {
            enabledSettings();
            (global.fetch as any).mockResolvedValueOnce({ ok: false, status: 401, statusText: 'x' });
            await service.poll();
            expect(mockDb.saveSettings).toHaveBeenCalledWith({
                cloud_enabled: 0, cloud_clinic_id: null, cloud_api_key: null
            });
        });

        it('keeps sync on non-auth failures and empty inboxes', async () => {
            enabledSettings();
            (global.fetch as any).mockResolvedValueOnce({ ok: false, status: 500, statusText: 'x' });
            await service.poll();
            expect(mockDb.saveSettings).not.toHaveBeenCalledWith(
                expect.objectContaining({ cloud_enabled: 0 }));

            (global.fetch as any).mockResolvedValueOnce({ ok: true, json: async () => [] });
            await service.poll();
        });

        it('ignores unknown message types without acking', async () => {
            enabledSettings();
            (global.fetch as any).mockResolvedValueOnce({
                ok: true, json: async () => ([{ id: 'm9', type: 'SOMETHING_ELSE', payload: {} }])
            });
            await service.poll();
            expect(mockDb.saveAppointmentRequest).not.toHaveBeenCalled();
            expect(global.fetch).toHaveBeenCalledTimes(1);
        });

        it('skips concurrent polls and recovers from transport errors', async () => {
            enabledSettings();
            (service as any).isPolling = true;
            await service.poll();
            expect(global.fetch).not.toHaveBeenCalled();
            (service as any).isPolling = false;

            (global.fetch as any).mockRejectedValueOnce(new Error('net down'));
            await service.poll();
            expect((service as any).isPolling).toBe(false);
        });

        it('fails onboarding loudly on bad responses', async () => {
            (global.fetch as any).mockResolvedValueOnce({ ok: false });
            await expect(service.onboard('C', 'T')).rejects.toThrow('Onboarding failed');
            (global.fetch as any).mockRejectedValueOnce(new Error('net down'));
            await expect(service.onboard('C', 'T')).rejects.toThrow('net down');
        });
    });
});
