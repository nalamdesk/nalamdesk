import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { DatabaseService } from '../services/DatabaseService';

const { DatabaseSync } = require('node:sqlite');

class TestDatabase {
    private readonly sqlite = new DatabaseSync(':memory:');
    readonly name = ':memory:';

    exec(sql: string) { return this.sqlite.exec(sql); }
    prepare(sql: string) { return this.sqlite.prepare(sql); }
    close() { return this.sqlite.close(); }
    pragma(sql: string, options?: { simple?: boolean }) {
        const assignment = sql.match(/^user_version\s*=\s*(\d+)$/);
        if (assignment) {
            this.sqlite.exec(`PRAGMA user_version = ${assignment[1]}`);
            return;
        }
        const row = this.sqlite.prepare(`PRAGMA ${sql}`).get() as any;
        return options?.simple ? row?.user_version : row;
    }
    transaction<T extends (...args: any[]) => any>(operation: T): T & { immediate: T } {
        const run = ((...args: any[]) => {
            this.sqlite.exec('BEGIN IMMEDIATE');
            try {
                const value = operation(...args);
                this.sqlite.exec('COMMIT');
                return value;
            } catch (error) {
                this.sqlite.exec('ROLLBACK');
                throw error;
            }
        }) as T & { immediate: T };
        run.immediate = run;
        return run;
    }
}

/**
 * Appointment lifecycle against a real database: proves the transactional
 * paths (check-in, fulfill, transitions) execute without nested-transaction
 * failures and leave the rows linked.
 */
describe('appointment lifecycle integration', () => {
    let db: any;
    let service: DatabaseService;

    beforeEach(async () => {
        db = new TestDatabase();
        db.exec('PRAGMA foreign_keys = ON');
        service = new DatabaseService();
        service.setDb(db);
        await service.migrate({ skipBackup: true });
        db.prepare("INSERT INTO users (id, username, role, name, active) VALUES (10, 'receptionist', 'receptionist', 'Front Desk', 1)").run();
        db.prepare("INSERT INTO users (id, username, role, name, active) VALUES (11, 'doctor', 'doctor', 'Dr Test', 1)").run();
        db.prepare("INSERT INTO patients (id, uuid, name, mobile) VALUES (1, 'p-1', 'Patient One', '9999999999')").run();
    });

    afterEach(() => db.close());

    it('books, confirms, checks in, and fulfills with linked rows', () => {
        const created: any = service.saveAppointment({ patient_id: 1, date: '2026-10-05', time: '10:00', reason: 'Review' });
        const id = Number(created.lastInsertRowid);
        expect(db.prepare('SELECT status FROM appointments WHERE id = ?').get(id).status).toBe('booked');

        service.transitionAppointment(id, 'confirmed', {}, 10);
        const checked = service.checkInAppointment(id, 10);
        expect(checked.reused).toBe(false);
        const arrived = db.prepare('SELECT status, queue_entry_id FROM appointments WHERE id = ?').get(id) as any;
        expect(arrived.status).toBe('arrived');
        expect(arrived.queue_entry_id).toBe(checked.queueEntryId);

        const visit = db.prepare(`INSERT INTO visits (patient_id, status) VALUES (1, 'finished')`).run();
        const fulfilled = service.fulfillAppointment(id, Number(visit.lastInsertRowid), 11);
        expect(fulfilled.to).toBe('fulfilled');
        expect(db.prepare('SELECT visit_id FROM appointments WHERE id = ?').get(id).visit_id)
            .toBe(Number(visit.lastInsertRowid));

        const history = service.getAppointmentHistory(id);
        expect(history.map((h: any) => h.to_status)).toEqual(['confirmed', 'arrived', 'fulfilled']);
    });

    it('rolls the transition back when queueing fails', () => {
        const created: any = service.saveAppointment({ patient_id: 1, date: '2026-10-05', time: '10:00', reason: 'Review' });
        const id = Number(created.lastInsertRowid);
        service.transitionAppointment(id, 'confirmed', {}, 10);
        // Patient already queued elsewhere: check-in must fail atomically.
        db.prepare(`INSERT INTO patient_queue (patient_id, status) VALUES (1, 'waiting')`).run();
        expect(() => service.checkInAppointment(id, 10)).toThrow('already in queue');
        expect(db.prepare('SELECT status FROM appointments WHERE id = ?').get(id).status).toBe('confirmed');
    });

    it('lists a patient bookings newest first', () => {
        db.prepare(`INSERT INTO patients (id, uuid, name, mobile) VALUES (2, 'p-2', 'Patient Two', '9999999998')`).run();
        service.saveAppointment({ patient_id: 1, date: '2026-10-05', time: '10:00', reason: 'First' });
        service.saveAppointment({ patient_id: 1, date: '2026-10-07', time: '09:00', reason: 'Second' });
        service.saveAppointment({ patient_id: 2, date: '2026-10-06', time: '09:00', reason: 'Other' });
        const rows = service.getAppointmentsByPatient(1) as any[];
        expect(rows.map((r) => r.date)).toEqual(['2026-10-07', '2026-10-05']);
        expect(rows[0]).toMatchObject({ reason: 'Second', patient_name: 'Patient One' });
    });

    it('auto-fulfills the arrived booking when its doctor completes the visit', () => {
        const created: any = service.saveAppointment({ patient_id: 1, date: '2026-10-05', time: '10:00', reason: 'Review' });
        const id = Number(created.lastInsertRowid);
        service.transitionAppointment(id, 'confirmed', {}, 10);
        const checked = service.checkInAppointment(id, 10);
        const enc = service.beginConsultation({
            patientId: 1, queueEntryId: checked.queueEntryId, startRequestId: 'auto-fulfill-1'
        }, 11);
        service.completeConsultation({ encounterId: enc.id, visit: { diagnosis: 'Done' } }, 11);
        const booking = db.prepare('SELECT status, visit_id FROM appointments WHERE id = ?').get(id) as any;
        expect(booking.status).toBe('fulfilled');
        expect(booking.visit_id).toBe(enc.id);
    });

    it('leaves the booking arrived when another doctor completes the visit', () => {
        db.prepare("INSERT INTO users (id, username, role, name, active) VALUES (12, 'dr_other', 'doctor', 'Dr Other', 1)").run();
        const created: any = service.saveAppointment({ patient_id: 1, date: '2026-10-05', time: '10:00', reason: 'Review' });
        const id = Number(created.lastInsertRowid);
        db.prepare('UPDATE appointments SET doctor_id = 12 WHERE id = ?').run(id);
        service.transitionAppointment(id, 'confirmed', {}, 10);
        const checked = service.checkInAppointment(id, 10);
        const enc = service.beginConsultation({
            patientId: 1, queueEntryId: checked.queueEntryId, startRequestId: 'auto-fulfill-2'
        }, 11);
        service.completeConsultation({ encounterId: enc.id, visit: { diagnosis: 'Done' } }, 11);
        const booking = db.prepare('SELECT status, visit_id FROM appointments WHERE id = ?').get(id) as any;
        expect(booking.status).toBe('arrived');
        expect(booking.visit_id).toBeNull();
    });

    it('records reason edits in history without moving state', () => {
        const created: any = service.saveAppointment({ patient_id: 1, date: '2026-10-05', time: '10:00', reason: 'Checkup' });
        const id = Number(created.lastInsertRowid);
        service.saveAppointment({ id, reason: 'Checkup and flu shot' });
        const history = service.getAppointmentHistory(id) as any[];
        expect(history.some((h) => String(h.reason || '').includes('Reason updated'))).toBe(true);
        expect(db.prepare('SELECT reason FROM appointments WHERE id = ?').get(id).reason).toBe('Checkup and flu shot');
    });

    it('leaves the booking arrived when its visit is already linked elsewhere', () => {
        const created: any = service.saveAppointment({ patient_id: 1, date: '2026-10-05', time: '10:00', reason: 'Review' });
        const id = Number(created.lastInsertRowid);
        service.transitionAppointment(id, 'confirmed', {}, 10);
        const checked = service.checkInAppointment(id, 10);
        db.prepare("UPDATE patient_queue SET status = 'completed' WHERE id = ?").run(checked.queueEntryId);
        const other: any = service.saveAppointment({ patient_id: 1, date: '2026-10-05', time: '11:00', reason: 'Other' });
        const otherId = Number(other.lastInsertRowid);
        service.transitionAppointment(otherId, 'confirmed', {}, 10);
        service.checkInAppointment(otherId, 10);
        const visit = db.prepare(`INSERT INTO visits (patient_id, status) VALUES (1, 'finished')`).run();
        service.fulfillAppointment(otherId, Number(visit.lastInsertRowid), 11);
        // Best-effort sweep survives the lost race: no throw, still arrived.
        (service as any).autoFulfillAppointment(checked.queueEntryId, Number(visit.lastInsertRowid), 11);
        const booking = db.prepare('SELECT status, visit_id FROM appointments WHERE id = ?').get(id) as any;
        expect(booking.status).toBe('arrived');
        expect(booking.visit_id).toBeNull();
    });
});
