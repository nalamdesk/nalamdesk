import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseService } from './DatabaseService';
import { TestDatabase } from '../testing/TestDatabase';
import { invokeDbMethod } from '../../shared/ipc-db-args';
import { currentFacilityId, runWithContext, setFallbackFacility } from '../../shared/request-context';

const MAIN = 1;
const BRANCH = 2;

describe('facility scoping (#195)', () => {
    let db: TestDatabase;
    let service: DatabaseService;
    const at = <T>(facilityId: number, operation: () => T): T => runWithContext({ userId: 10, facilityId }, operation);

    beforeEach(async () => {
        db = new TestDatabase();
        db.exec('PRAGMA foreign_keys = ON');
        service = new DatabaseService();
        service.setDb(db);
        await service.migrate({ skipBackup: true });
        db.prepare("INSERT INTO facilities (id, code, name, kind) VALUES (2, 'ANN', 'Anna Nagar', 'hospital')").run();
        db.prepare("INSERT INTO departments (id, facility_id, code, name) VALUES (2, 2, 'ORTHO', 'Orthopaedics')").run();
        db.prepare("INSERT INTO users (id, username, role, name, license_number, active) VALUES (10, 'asha', 'doctor', 'Dr. Asha', 'TN-1', 1)").run();
        db.prepare("INSERT INTO users (id, username, role, name, active) VALUES (20, 'ravi', 'receptionist', 'Ravi', 1)").run();
        db.prepare("INSERT INTO users (id, username, role, name, active) VALUES (30, 'boss', 'admin', 'Boss', 1)").run();
        // With two facilities, grants are explicit: Asha works at both, Ravi only at the branch.
        db.prepare(`INSERT INTO user_facility_roles (user_id, facility_id, role) VALUES
            (10, 1, 'doctor'), (10, 2, 'doctor'), (20, 2, 'receptionist'), (30, 1, 'admin')`).run();
        db.prepare('UPDATE users SET org_admin = 1 WHERE id = 30').run();
        db.prepare("INSERT INTO patients (id, uuid, name) VALUES (1, 'p-1', 'Meena'), (2, 'p-2', 'Kumar')").run();
    });

    afterEach(() => {
        setFallbackFacility(() => MAIN);
        db.close();
    });

    function finishedVisit(facilityId: number, patientId = 1): number {
        return Number(db.prepare(`INSERT INTO visits (patient_id, doctor_id, author_id, status, facility_id)
            VALUES (?, 10, 10, 'finished', ?)`).run(patientId, facilityId).lastInsertRowid);
    }

    it('keeps one queue per facility and stamps each entry with its facility and department', () => {
        at(MAIN, () => service.addToQueue(1, 1, 10));
        at(BRANCH, () => service.addToQueue(1, { urgency: 'routine', department_id: 2 }, 10));
        at(BRANCH, () => service.addToQueue(2, 1, 10));

        expect(at(MAIN, () => service.getQueue()).map((q: any) => q.patient_id)).toEqual([1]);
        expect(at(BRANCH, () => service.getQueue()).map((q: any) => q.patient_id)).toEqual([1, 2]);
        expect(db.prepare('SELECT facility_id, department_id FROM patient_queue WHERE patient_id = 1 ORDER BY id').all())
            .toEqual([{ facility_id: 1, department_id: null }, { facility_id: 2, department_id: 2 }]);
        expect(() => at(MAIN, () => service.addToQueue(2, { department_id: 2 }, 10))).toThrow('Unknown department');
    });

    it('refuses queue changes from another facility, even with a valid id', () => {
        const entry = Number(at(MAIN, () => service.addToQueue(1, 1, 10)).lastInsertRowid);
        expect(() => at(BRANCH, () => service.updateQueueStatus(entry, 'waiting', 10))).toThrow('belongs to another facility');
        expect(() => at(BRANCH, () => service.removeFromQueue(entry, 10))).toThrow('belongs to another facility');
        expect(() => at(BRANCH, () => service.reassessQueueTriage(entry, 'urgent', 'Worse', 10))).toThrow('belongs to another facility');
        expect(() => at(BRANCH, () => service.beginConsultation({ patientId: 1, queueEntryId: entry, startRequestId: 's-1' }, 10)))
            .toThrow('belongs to another facility');
        expect(at(BRANCH, () => service.beginNextConsultation({ startRequestId: 's-2' }, 10))).toBeNull();
    });

    it('opens encounters in the queue entry facility and lists them there only', () => {
        const entry = Number(at(BRANCH, () => service.addToQueue(1, { department_id: 2 }, 10)).lastInsertRowid);
        const encounter = at(BRANCH, () => service.beginConsultation({ patientId: 1, queueEntryId: entry, startRequestId: 's-3' }, 10));
        expect(db.prepare('SELECT facility_id, department_id FROM visits WHERE id = ?').get(encounter.id))
            .toEqual({ facility_id: 2, department_id: 2 });
        expect(() => at(MAIN, () => service.saveConsultationProgress({ encounterId: encounter.id, visit: { diagnosis: 'x' } }, 10)))
            .toThrow('belongs to another facility');
        finishedVisit(MAIN);
        finishedVisit(BRANCH);
        expect(at(MAIN, () => service.getAllVisits()).map((v: any) => v.facility_id)).toEqual([1]);
        expect(at(BRANCH, () => service.getAllVisits()).map((v: any) => v.facility_id)).toEqual([2]);
        // The clinical record stays shared: patient history spans facilities.
        expect((service.getVisits(1) as any[]).length).toBe(2);
    });

    it('bills in the visit facility and closes each day per facility', () => {
        const mainVisit = finishedVisit(MAIN);
        const branchVisit = finishedVisit(BRANCH);
        at(BRANCH, () => service.saveSettings({ consultation_fee: 500 }));
        expect(() => at(MAIN, () => service.createInvoice({ visitId: branchVisit }, 10))).toThrow('belongs to another facility');
        const mainInvoice = at(MAIN, () => service.createInvoice({ visitId: mainVisit, items: [{ description: 'X-ray', rate: 300 }] }, 10));
        const branchInvoice = at(BRANCH, () => service.createInvoice({ visitId: branchVisit }, 10));
        expect([mainInvoice.facility_id, branchInvoice.facility_id, branchInvoice.total]).toEqual([1, 2, 500]);

        expect(() => at(MAIN, () => service.recordPayment({ invoiceId: branchInvoice.id, amount: 100 }, 10)))
            .toThrow('belongs to another facility');
        const payment = at(BRANCH, () => service.recordPayment({ invoiceId: branchInvoice.id, amount: 500, method: 'cash' }, 10));
        at(MAIN, () => service.recordPayment({ invoiceId: mainInvoice.id, amount: 300, method: 'cash' }, 10));
        expect(payment.facility_id).toBe(2);
        expect(() => at(MAIN, () => service.refundPayment({ paymentId: payment.id, reason: 'x' }, 10))).toThrow('belongs to another facility');
        expect(() => at(MAIN, () => service.voidInvoice(branchInvoice.id, 'x', 10))).toThrow('belongs to another facility');

        const today = (db.prepare("SELECT date('now', 'localtime') AS d").get() as any).d;
        expect(at(MAIN, () => service.getDailyClose(today)).collected).toBe(300);
        expect(at(BRANCH, () => service.getDailyClose(today)).collected).toBe(500);
    });

    it('books appointments and booking requests per facility', () => {
        at(MAIN, () => service.saveAppointment({ patient_id: 1, date: '2026-11-02', time: '10:00', reason: '' }));
        const branchAppt = Number(at(BRANCH, () => service.saveAppointment({
            patient_id: 2, date: '2026-11-02', time: '10:00', reason: '', department_id: 2
        })).lastInsertRowid);
        expect(at(MAIN, () => service.getAppointments('2026-11-02')).map((a: any) => a.patient_id)).toEqual([1]);
        expect(at(BRANCH, () => service.getAppointments('2026-11-02')).map((a: any) => a.patient_id)).toEqual([2]);
        expect(() => at(MAIN, () => service.transitionAppointment(branchAppt, 'cancelled', { reason: 'x' }, 10)))
            .toThrow('belongs to another facility');
        // Check-in queues the patient in the booked department.
        at(BRANCH, () => service.transitionAppointment(branchAppt, 'confirmed', {}, 10));
        at(BRANCH, () => service.checkInAppointment(branchAppt, 10));
        expect(db.prepare('SELECT facility_id, department_id FROM patient_queue WHERE patient_id = 2').get())
            .toEqual({ facility_id: 2, department_id: 2 });

        at(BRANCH, () => service.saveAppointmentRequest({ id: 'req-1', patient_name: 'A', phone: '1', date: '2026-11-03', time: '09:00', reason: '' }));
        expect(at(MAIN, () => service.getAppointmentRequests())).toEqual([]);
        expect(at(BRANCH, () => service.getAppointmentRequests()).map((r: any) => r.id)).toEqual(['req-1']);
        expect(() => at(MAIN, () => service.updateAppointmentRequestStatus('req-1', 'declined'))).toThrow('belongs to another facility');
    });

    it('lists only the doctors granted at the facility', () => {
        db.prepare("INSERT INTO users (id, username, role, name, active) VALUES (11, 'kumar', 'doctor', 'Dr. Kumar', 1)").run();
        db.prepare("INSERT INTO user_facility_roles (user_id, facility_id, role) VALUES (11, 1, 'doctor')").run();
        expect(at(MAIN, () => service.getDoctors()).map((d: any) => d.id).sort()).toEqual([10, 11]);
        expect(at(BRANCH, () => service.getDoctors()).map((d: any) => d.id)).toEqual([10]);
    });

    it('resolves the role a user holds at each facility', () => {
        expect(service.getFacilityRole(20, BRANCH)).toBe('receptionist');
        expect(service.getFacilityRole(20, MAIN)).toBeNull();
        expect(service.getFacilityRole(30, BRANCH)).toBe('admin');
        db.prepare('UPDATE facilities SET active = 0 WHERE id = 2').run();
        expect(service.getFacilityRole(10, BRANCH)).toBeNull();
        expect(service.getUserFacilities(10).map(f => f.id)).toEqual([1]);
        db.prepare('UPDATE users SET active = 0 WHERE id = 10').run();
        expect(service.getFacilityRole(10, MAIN)).toBeNull();
        expect(service.getUserFacilities(30)).toEqual([{ id: 1, code: 'MAIN', name: '', kind: 'clinic', role: 'admin' }]);
    });

    it('runs IPC calls in the given context, or the desktop session facility', () => {
        at(BRANCH, () => service.addToQueue(2, 1, 10));
        expect((invokeDbMethod(service, 'getQueue', [], { userId: 10, facilityId: BRANCH }) as any[]).length).toBe(1);
        expect((invokeDbMethod(service, 'getQueue', [], 10) as any[]).length).toBe(0);
        setFallbackFacility(() => BRANCH);
        expect(currentFacilityId()).toBe(BRANCH);
        expect((invokeDbMethod(service, 'getQueue', [], 10) as any[]).length).toBe(1);
        expect(at(MAIN, () => currentFacilityId())).toBe(MAIN);
    });

    it('tags the audit trail with the facility', () => {
        at(BRANCH, () => service.addToQueue(1, 1, 10));
        expect((db.prepare("SELECT facility_id FROM audit_logs WHERE table_name = 'patient_queue'").get() as any).facility_id).toBe(2);
    });
});
