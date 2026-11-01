import { describe, expect, it, vi } from 'vitest';
import { BookingError } from '../../main/booking/BookingInboxService';
import {
    assertMethodAccess, backupScheduleFollower, BACKUP_IPC_CHANNELS, CLOUD_IPC_CHANNELS,
    createBackupMethods, createCloudMethods, MethodAccessError
} from './clinicMethods';

function fakeServices(paired = true) {
    const pairing = {
        isPaired: vi.fn(() => paired),
        status: vi.fn(() => ({ state: paired ? 'paired' : 'unpaired', clinicId: 'clinic-1' })),
        request: vi.fn(async () => undefined),
        cancel: vi.fn(async () => undefined),
        activate: vi.fn(async () => undefined),
        forget: vi.fn()
    };
    const booking = {
        enableListing: vi.fn(async () => undefined),
        disableListing: vi.fn(async () => undefined),
        publishSlots: vi.fn(async () => 3),
        publishedSlots: vi.fn(async () => ['10:00']),
        decide: vi.fn(async () => undefined)
    };
    const cloudLink = { pairing, booking, checkMailbox: vi.fn(async () => 2) };
    const services = { cloudLink, cloudStatus: vi.fn(() => ({ state: 'paired', listingEnabled: true })) };
    const db = {
        saveSettings: vi.fn(),
        acceptAppointmentRequest: vi.fn(),
        updateAppointmentRequestStatus: vi.fn()
    };
    const methods = createCloudMethods(db as any, services as any);
    return { methods, db, pairing, booking, cloudLink };
}

const admin = { id: 1, role: 'admin' };
const nurse = { id: 2, role: 'nurse' };

describe('clinic method access', () => {
    it('allows users, admins and desk roles as declared', () => {
        expect(() => assertMethodAccess('user', nurse)).not.toThrow();
        expect(() => assertMethodAccess('admin', admin)).not.toThrow();
        expect(() => assertMethodAccess('desk', { id: 3, role: 'receptionist' })).not.toThrow();
    });

    it('refuses anonymous callers with 401 and the wrong role with 403', () => {
        expect(() => assertMethodAccess('user', null)).toThrow(MethodAccessError);
        try { assertMethodAccess('user', undefined); } catch (error) { expect((error as MethodAccessError).status).toBe(401); }
        try { assertMethodAccess('admin', nurse); } catch (error) { expect((error as MethodAccessError).status).toBe(403); }
        expect(() => assertMethodAccess('desk', nurse)).toThrow('Forbidden');
    });

    it('maps every desktop channel to a method that exists', () => {
        const { methods } = fakeServices();
        for (const [, name] of CLOUD_IPC_CHANNELS) expect(methods[name]).toBeDefined();
        const backups = createBackupMethods({} as any);
        for (const [, name] of BACKUP_IPC_CHANNELS) expect(backups[name]?.access).toBe('admin');
    });
});

describe('cloud methods', () => {
    it('keeps pairing and listing admin-only, status and refresh open to staff', () => {
        const { methods } = fakeServices();
        expect(methods['cloudRequestPairing']!.access).toBe('admin');
        expect(methods['cloudEnableListing']!.access).toBe('admin');
        expect(methods['cloudGetStatus']!.access).toBe('user');
        expect(methods['cloudSyncNow']!.access).toBe('user');
        expect(methods['cloudSyncNow']!.selfFenced).toBe(true);
        expect(methods['cloudDecide']!.access).toBe('desk');
    });

    it('passes pairing input through as strings and returns the status', async () => {
        const { methods, pairing } = fakeServices();
        const status = await methods['cloudRequestPairing']!.run([{ hfrId: 'IN27', label: 42 }], admin);
        expect(pairing.request).toHaveBeenCalledWith({ hfrId: 'IN27', label: '42' });
        expect(status).toEqual({ state: 'paired', listingEnabled: true });
        await methods['cloudActivatePairing']!.run([{ code: { bad: true } }], admin);
        expect(pairing.activate).toHaveBeenCalledWith({ code: '' });
    });

    it('forgets the pairing and turns the listing off', async () => {
        const { methods, db, pairing } = fakeServices();
        await methods['cloudForgetPairing']!.run([], admin);
        expect(pairing.forget).toHaveBeenCalled();
        expect(db.saveSettings).toHaveBeenCalledWith({ cloud_enabled: 0, cloud_clinic_id: null });
    });

    it('needs a name and city and a pairing to list the clinic', async () => {
        const { methods, db, booking } = fakeServices();
        await expect(methods['cloudEnableListing']!.run([{ name: ' ', city: 'Chennai' }], admin)).rejects.toThrow('Clinic name and city');
        await methods['cloudEnableListing']!.run([{ name: 'Asha', city: 'Chennai', specialty: ' ' }], admin);
        expect(booking.enableListing).toHaveBeenCalledWith({ name: 'Asha', city: 'Chennai', specialty: undefined });
        expect(db.saveSettings).toHaveBeenCalledWith({ cloud_enabled: 1, cloud_clinic_id: 'clinic-1' });

        const unpaired = fakeServices(false);
        await expect(unpaired.methods['cloudEnableListing']!.run([{ name: 'A', city: 'B' }], admin)).rejects.toThrow('not paired');
        await expect(unpaired.methods['cloudPublishSlots']!.run([[], []], admin)).rejects.toThrow('not paired');
    });

    it('disables the listing locally even when unpaired', async () => {
        const unpaired = fakeServices(false);
        await unpaired.methods['cloudDisableListing']!.run([], admin);
        expect(unpaired.booking.disableListing).not.toHaveBeenCalled();
        expect(unpaired.db.saveSettings).toHaveBeenCalledWith({ cloud_enabled: 0 });
    });

    it('publishes slots and reads them back for a day', async () => {
        const { methods, booking } = fakeServices();
        expect(await methods['cloudPublishSlots']!.run([[{ date: '2026-11-02', time: '10:00' }], ['2026-11-02']], admin)).toEqual({ published: 3 });
        expect(booking.publishSlots).toHaveBeenCalledWith(['2026-11-02'], [{ date: '2026-11-02', time: '10:00' }]);
        expect(await methods['cloudPublishSlots']!.run(['x', 'y'], admin)).toEqual({ published: 3 });
        expect(booking.publishSlots).toHaveBeenLastCalledWith([], []);
        expect(await methods['cloudGetPublishedSlots']!.run(['2026-11-02'], nurse)).toEqual(['10:00']);
        expect(await fakeServices(false).methods['cloudGetPublishedSlots']!.run(['2026-11-02'], nurse)).toEqual([]);
    });

    it('refreshes the mailbox only when paired', async () => {
        expect(await fakeServices().methods['cloudSyncNow']!.run([], nurse)).toEqual({ success: true, paired: true, saved: 2 });
        expect(await fakeServices(false).methods['cloudSyncNow']!.run([], nurse)).toEqual({ success: false, paired: false, saved: 0 });
    });

    it('validates booking decisions and needs a slot to accept', async () => {
        const { methods, booking } = fakeServices();
        const decide = methods['cloudDecide']!;
        await expect(decide.run([{ ref: 'R', decision: 'maybe' }], admin)).rejects.toThrow('accepted or declined');
        await expect(decide.run([{ ref: 'R', decision: 'accepted', date: '2026-11-02' }], admin)).rejects.toThrow('date and time');
        expect(await decide.run([{ ref: 'R', decision: 'accepted', date: '2026-11-02', time: '10:30' }], admin)).toEqual({ success: true });
        expect(booking.decide).toHaveBeenCalledWith('R', 'accepted', { date: '2026-11-02', time: '10:30' });
        await decide.run([{ ref: 'R', decision: 'declined' }], admin);
        expect(booking.decide).toHaveBeenLastCalledWith('R', 'declined', undefined);
    });

    it('decides retired-sync requests locally and reports cloud errors with their code', async () => {
        const { methods, booking, db } = fakeServices();
        const decide = methods['cloudDecide']!;
        booking.decide.mockRejectedValueOnce(new BookingError('bad_ref', 'Unknown reference.'));
        expect(await decide.run([{ ref: 'OLD', decision: 'accepted', date: '2026-11-02', time: '10:30' }], admin))
            .toEqual({ success: true, local: true });
        expect(db.acceptAppointmentRequest).toHaveBeenCalledWith('OLD', { date: '2026-11-02', time: '10:30' });

        booking.decide.mockRejectedValueOnce(new BookingError('bad_ref', 'Unknown reference.'));
        await decide.run([{ ref: 'OLD', decision: 'declined' }], admin);
        expect(db.updateAppointmentRequestStatus).toHaveBeenCalledWith('OLD', 'rejected');

        booking.decide.mockRejectedValueOnce(new BookingError('slot_lost', 'Taken.'));
        await expect(decide.run([{ ref: 'R', decision: 'declined' }], admin)).rejects.toThrow('slot_lost: Taken.');
        booking.decide.mockRejectedValueOnce(new Error('offline'));
        await expect(decide.run([{ ref: 'R', decision: 'declined' }], admin)).rejects.toThrow('offline');
    });
});

describe('backup methods', () => {
    function fakeBackups() {
        return {
            performBackup: vi.fn(async () => undefined),
            listSystemBackups: vi.fn(async () => [{ name: 'a.ndbackup' }]),
            getLocalBackupHealth: vi.fn(async () => ({ healthy: true })),
            updateSchedule: vi.fn()
        };
    }

    it('runs, lists and reports health', async () => {
        const backups = fakeBackups();
        const methods = createBackupMethods(backups);
        expect(await methods['backupRunNow']!.run([], admin)).toEqual({ success: true });
        expect(backups.performBackup).toHaveBeenCalled();
        expect(await methods['backupList']!.run([], admin)).toEqual([{ name: 'a.ndbackup' }]);
        expect(await methods['backupGetHealth']!.run([], admin)).toEqual({ healthy: true });
    });

    it('follows valid schedule changes from settings saves only', () => {
        const backups = fakeBackups();
        const follow = backupScheduleFollower(backups);
        follow('getSettings', [{ backup_schedule: '02:00' }]);
        follow('saveSettings', [{ backup_schedule: '25:00', cloud_backup_schedule: 'soon' }]);
        expect(backups.updateSchedule).not.toHaveBeenCalled();
        follow('saveSettings', [{ backup_schedule: '02:30', cloud_backup_schedule: '23:15' }]);
        expect(backups.updateSchedule).toHaveBeenCalledWith('local', '02:30');
        expect(backups.updateSchedule).toHaveBeenCalledWith('cloud', '23:15');
        follow('saveSettings', []);
        expect(backups.updateSchedule).toHaveBeenCalledTimes(2);
    });
});
