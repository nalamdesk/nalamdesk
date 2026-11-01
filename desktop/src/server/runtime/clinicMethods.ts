import type { DatabaseService } from '../../main/services/DatabaseService';
import { BookingError } from '../../main/booking/BookingInboxService';
import { BackupService } from '../../main/services/BackupService';
import type { ClinicServices } from './clinicServices';

/**
 * Cloud pairing, online booking and backup methods (#196), shared by the
 * desktop's IPC handlers and the server API so admin screens behave the
 * same from any client. Each method names who may call it; the caller has
 * already authenticated the user.
 */

export type MethodAccess = 'user' | 'admin' | 'desk';

export interface MethodUser {
    id: number;
    role: string;
}

export interface ClinicMethod {
    access: MethodAccess;
    /**
     * True when the method guards its own database writes, so it runs
     * outside restore-drained work and a restore never waits on its network
     * call (the mailbox reader fences each save itself).
     */
    selfFenced?: boolean;
    run(args: unknown[], user: MethodUser): unknown;
}

const DESK_ROLES = new Set(['doctor', 'receptionist', 'admin']);

export class MethodAccessError extends Error {
    constructor(readonly status: 401 | 403) {
        super(status === 401 ? 'Unauthorized' : 'Forbidden');
    }
}

/** Throws unless `user` may call a method with `access`. */
export function assertMethodAccess(access: MethodAccess, user: MethodUser | null | undefined): asserts user is MethodUser {
    if (!user) throw new MethodAccessError(401);
    if (access === 'admin' && user.role !== 'admin') throw new MethodAccessError(403);
    if (access === 'desk' && !DESK_ROLES.has(user.role)) throw new MethodAccessError(403);
}

function input(args: unknown[]): Record<string, unknown> {
    const first = args[0];
    return first && typeof first === 'object' ? first as Record<string, unknown> : {};
}

function text(value: unknown): string {
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return String(value);
    return '';
}

export interface BackupOperations {
    performBackup(): Promise<void>;
    listSystemBackups(): Promise<unknown[]>;
    getLocalBackupHealth(): Promise<unknown>;
    updateSchedule(type: 'local' | 'cloud', time: string): void;
}

/** After a settings save through the API, moves the backup schedule to match. */
export function backupScheduleFollower(backups: BackupOperations): (method: string, args: unknown[]) => void {
    return (method, args) => {
        if (method !== 'saveSettings') return;
        const settings = input(args);
        const local = settings['backup_schedule'];
        const cloud = settings['cloud_backup_schedule'];
        if (BackupService.isValidScheduleTime(local)) backups.updateSchedule('local', local);
        if (BackupService.isValidScheduleTime(cloud)) backups.updateSchedule('cloud', cloud);
    };
}

export function createCloudMethods(db: DatabaseService, services: ClinicServices): Record<string, ClinicMethod> {
    const { cloudLink } = services;
    const status = () => services.cloudStatus();
    const requirePaired = () => {
        if (!cloudLink.pairing.isPaired()) throw new Error('This clinic is not paired with NalamDesk Cloud.');
    };
    return {
        cloudGetStatus: { access: 'user', run: () => status() },
        cloudRequestPairing: {
            access: 'admin',
            async run(args) {
                const body = input(args);
                await cloudLink.pairing.request({ hfrId: text(body['hfrId']), label: text(body['label']) });
                return status();
            }
        },
        cloudCancelPairing: {
            access: 'admin',
            async run() {
                await cloudLink.pairing.cancel();
                return status();
            }
        },
        cloudActivatePairing: {
            access: 'admin',
            async run(args) {
                await cloudLink.pairing.activate({ code: text(input(args)['code']) });
                return status();
            }
        },
        cloudForgetPairing: {
            access: 'admin',
            run() {
                cloudLink.pairing.forget();
                db.saveSettings({ cloud_enabled: 0, cloud_clinic_id: null });
                return status();
            }
        },
        cloudEnableListing: {
            access: 'admin',
            async run(args) {
                requirePaired();
                const body = input(args);
                const name = text(body['name']).trim();
                const city = text(body['city']).trim();
                if (!name || !city) throw new Error('Clinic name and city are required.');
                await cloudLink.booking.enableListing({ name, city, specialty: text(body['specialty']).trim() || undefined });
                db.saveSettings({ cloud_enabled: 1, cloud_clinic_id: cloudLink.pairing.status().clinicId ?? null });
                return status();
            }
        },
        cloudDisableListing: {
            access: 'admin',
            async run() {
                if (cloudLink.pairing.isPaired()) await cloudLink.booking.disableListing();
                db.saveSettings({ cloud_enabled: 0 });
                return status();
            }
        },
        cloudPublishSlots: {
            access: 'admin',
            async run(args) {
                requirePaired();
                const [slots, dates] = args;
                const published = await cloudLink.booking.publishSlots(
                    Array.isArray(dates) ? dates : [], Array.isArray(slots) ? slots : []);
                return { published };
            }
        },
        cloudSyncNow: {
            access: 'user',
            selfFenced: true,
            async run() {
                if (!cloudLink.pairing.isPaired()) return { success: false, paired: false, saved: 0 };
                const saved = await cloudLink.checkMailbox();
                return { success: true, paired: true, saved };
            }
        },
        cloudGetPublishedSlots: {
            access: 'user',
            run(args) {
                if (!cloudLink.pairing.isPaired()) return [];
                const day = text(args[0]);
                return cloudLink.booking.publishedSlots(day, day);
            }
        },
        // Accept or decline an online booking request: the cloud first (it
        // books or releases the slot and updates the patient's status page),
        // then locally.
        cloudDecide: {
            access: 'desk',
            async run(args) {
                const body = input(args);
                const ref = text(body['ref']);
                const decision = body['decision'] === 'accepted' || body['decision'] === 'declined' ? body['decision'] : null;
                if (!decision) throw new Error('Decision must be accepted or declined.');
                // An acceptance carries the appointment's slot, booked locally
                // in the same transaction that marks the request accepted.
                const date = text(body['date']);
                const time = text(body['time']);
                if (decision === 'accepted' && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time))) {
                    throw new Error('An accepted booking needs a date and time.');
                }
                const slot = decision === 'accepted' ? { date, time } : undefined;
                try {
                    await cloudLink.booking.decide(ref, decision, slot);
                } catch (error) {
                    // Requests left over from the retired cloud sync have no
                    // online reference; they are decided locally only.
                    if (error instanceof BookingError && error.code === 'bad_ref') {
                        if (slot) db.acceptAppointmentRequest(ref, slot);
                        else db.updateAppointmentRequestStatus(ref, 'rejected');
                        return { success: true, local: true };
                    }
                    if (error instanceof BookingError) throw new Error(`${error.code}: ${error.message}`);
                    throw error;
                }
                return { success: true };
            }
        }
    };
}

export function createBackupMethods(backups: BackupOperations): Record<string, ClinicMethod> {
    return {
        backupRunNow: {
            access: 'admin',
            async run() {
                await backups.performBackup();
                return { success: true };
            }
        },
        backupList: { access: 'admin', run: () => backups.listSystemBackups() },
        backupGetHealth: { access: 'admin', run: () => backups.getLocalBackupHealth() }
    };
}

/** Desktop IPC channel for each shared backup method. */
export const BACKUP_IPC_CHANNELS: ReadonlyArray<readonly [channel: string, method: string]> = [
    ['backup:runNow', 'backupRunNow'],
    ['backup:listSystemBackups', 'backupList'],
    ['backup:getLocalBackupHealth', 'backupGetHealth']
];

/** Desktop IPC channel for each shared cloud method. */
export const CLOUD_IPC_CHANNELS: ReadonlyArray<readonly [channel: string, method: string]> = [
    ['cloud:getStatus', 'cloudGetStatus'],
    ['cloud:requestPairing', 'cloudRequestPairing'],
    ['cloud:cancelPairing', 'cloudCancelPairing'],
    ['cloud:activatePairing', 'cloudActivatePairing'],
    ['cloud:forgetPairing', 'cloudForgetPairing'],
    ['cloud:enableListing', 'cloudEnableListing'],
    ['cloud:disableListing', 'cloudDisableListing'],
    ['cloud:publishSlots', 'cloudPublishSlots'],
    ['cloud:syncNow', 'cloudSyncNow'],
    ['cloud:getPublishedSlots', 'cloudGetPublishedSlots'],
    ['cloud:decide', 'cloudDecide']
];
