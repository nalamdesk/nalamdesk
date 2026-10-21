import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseService } from './DatabaseService';

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

const PARACETAMOL = {
    medicine: 'Crocin 500', medicine_id: 1, generic_name: 'Paracetamol', brand_name: 'Crocin',
    form: 'Tab', dosage: '500mg', route: 'Oral', frequency: '1-0-1', duration: '3 days', instruction: 'After Food'
};
const CETIRIZINE = {
    medicine: 'Local cetirizine', form: 'Tab', dosage: '10mg', route: 'Oral', frequency: 'HS', duration: '5 days', instruction: 'After Food'
};

/**
 * Prescription orders (#20) against a real database: finishing a visit
 * issues a numbered order, edits make a reasoned correction trail, and
 * prints come from the stored order.
 */
describe('prescription orders', () => {
    let db: any;
    let service: DatabaseService;

    beforeEach(async () => {
        db = new TestDatabase();
        db.exec('PRAGMA foreign_keys = ON');
        service = new DatabaseService();
        service.setDb(db);
        await service.migrate({ skipBackup: true });
        db.prepare("INSERT INTO users (id, username, role, name, license_number, specialty, active, abdm_hpr_id) VALUES (10, 'dr_rao', 'doctor', 'Dr. Rao', 'TNMC-1234', 'General Medicine', 1, '71-0001')").run();
        db.prepare("INSERT INTO users (id, username, role, name, license_number, specialty, active) VALUES (11, 'dr_iyer', 'doctor', 'Dr. Iyer', 'TNMC-5678', 'Paediatrics', 1)").run();
        db.prepare("INSERT INTO users (id, username, role, name, active) VALUES (99, 'admin', 'admin', 'Admin', 1)").run();
        db.prepare("INSERT INTO patients (id, uuid, name, mobile, age, gender) VALUES (1, 'p-1', 'Meena', '9876543210', 34, 'Female')").run();
        db.prepare("UPDATE settings SET clinic_name = 'Nalam Clinic', abdm_hfr_id = 'IN3310000001'").run();
        if (!db.prepare('SELECT 1 FROM settings').get()) {
            db.prepare("INSERT INTO settings (clinic_name, abdm_hfr_id) VALUES ('Nalam Clinic', 'IN3310000001')").run();
        }
    });

    afterEach(() => db.close());

    let requestSeq = 0;
    function finishVisit(prescription: any[], doctorId = 10) {
        const queueEntryId = Number(service.addToQueue(1, 1, 20).lastInsertRowid);
        const encounter = service.beginConsultation(
            { patientId: 1, queueEntryId, startRequestId: `rx-${++requestSeq}` }, doctorId);
        return service.completeConsultation({ encounterId: encounter.id, visit: { diagnosis: 'Fever', prescription } }, doctorId);
    }

    function activeMedication(name: string) {
        return db.prepare("SELECT * FROM patient_medications WHERE patient_id = 1 AND medicine_name = ? ORDER BY id DESC").get(name);
    }

    it('issues a numbered order with its lines when the visit is finished', () => {
        const visit = finishVisit([PARACETAMOL, { medicine: '', dosage: '' }, CETIRIZINE]);

        const [order] = service.getVisitPrescriptions(visit.id);
        expect(order).toMatchObject({
            rx_number: `RX-${100000 + order.id}`, status: 'active', intent: 'order', version: 1,
            requester_id: 10, patient_id: 1, replaces_id: null, print_count: 0
        });
        expect(order.authored_at).toBeTruthy();
        expect(order.requester).toEqual({ name: 'Dr. Rao', license_number: 'TNMC-1234', specialty: 'General Medicine' });
        // The blank row is dropped; a typed name that never matched the catalog is marked.
        expect(order.items).toHaveLength(2);
        expect(order.items[0]).toMatchObject({
            medicine: 'Crocin 500', medicine_id: 1, free_text: false, quantity: 6, quantity_unit: 'tablet',
            quantity_derived: true, refills: 0
        });
        expect(order.items[1]).toMatchObject({ medicine: 'Local cetirizine', medicine_id: null, free_text: true, frequency: '0-0-1', quantity: 5 });
        // The visit keeps the stored form of the lines.
        expect(visit.prescription).toHaveLength(2);
        expect(visit.prescription[1].frequency).toBe('0-0-1');
    });

    it('refuses to finish with incomplete or contradictory lines and keeps the visit open', () => {
        const queueEntryId = Number(service.addToQueue(1, 1, 20).lastInsertRowid);
        const encounter = service.beginConsultation({ patientId: 1, queueEntryId, startRequestId: 'rx-bad' }, 10);

        expect(() => service.completeConsultation({
            encounterId: encounter.id,
            visit: { diagnosis: 'Fever', prescription: [{ ...PARACETAMOL, dosage: '' }, { ...CETIRIZINE, route: 'IV' }] }
        }, 10)).toThrow(/Line 1 \(Crocin 500\): dose is required\. Line 2 \(Local cetirizine\): Tab cannot be given by the IV route/);

        expect(db.prepare('SELECT status FROM visits WHERE id = ?').get(encounter.id).status).toBe('in-progress');
        expect(db.prepare('SELECT status FROM patient_queue WHERE id = ?').get(queueEntryId).status).toBe('in-consult');
        expect(db.prepare('SELECT COUNT(*) AS n FROM prescriptions').get().n).toBe(0);
    });

    it('issues no order for a visit without medicines', () => {
        const visit = finishVisit([{ medicine: '', dosage: '', form: 'Tab', route: 'Oral', frequency: '1-0-1' }]);
        expect(service.getVisitPrescriptions(visit.id)).toEqual([]);
        expect(visit.prescription).toEqual([]);
    });

    it('leaves the order alone when a finished visit is saved unchanged', () => {
        const visit = finishVisit([PARACETAMOL]);
        service.saveVisit({ id: visit.id, diagnosis: 'Viral fever', prescription: visit.prescription }, 10);

        const orders = service.getVisitPrescriptions(visit.id);
        expect(orders).toHaveLength(1);
        expect(orders[0].status).toBe('active');
        expect(db.prepare('SELECT diagnosis FROM visits WHERE id = ?').get(visit.id).diagnosis).toBe('Viral fever');
    });

    it('keeps the stored prescription when an edit does not send one', () => {
        const visit = finishVisit([PARACETAMOL]);
        service.saveVisit({ id: visit.id, diagnosis: 'Viral fever' }, 10);
        expect(JSON.parse(db.prepare('SELECT prescription_json FROM visits WHERE id = ?').get(visit.id).prescription_json))
            .toHaveLength(1);
    });

    it('needs a reason and a licensed practitioner to change a finished prescription', () => {
        const visit = finishVisit([PARACETAMOL]);
        const changed = [{ ...PARACETAMOL, dosage: '650mg' }];

        expect(() => service.saveVisit({ id: visit.id, diagnosis: 'Fever', prescription: changed }, 10))
            .toThrow('A reason is required to change a prescription on a finished visit.');
        expect(() => service.saveVisit({ id: visit.id, diagnosis: 'Fever', prescription: changed, prescription_change_reason: 'Dose' }, 99))
            .toThrow('Only a licensed practitioner can change a prescription.');
        expect(() => service.saveVisit({ id: visit.id, diagnosis: 'Fever', prescription: [{ ...PARACETAMOL, duration: '3' }], prescription_change_reason: 'Dose' }, 10))
            .toThrow(/duration "3" needs a number and unit/);
        // Nothing moved on any of the refusals.
        expect(service.getVisitPrescriptions(visit.id)).toHaveLength(1);
        expect(db.prepare('SELECT diagnosis FROM visits WHERE id = ?').get(visit.id).diagnosis).toBe('Fever');
    });

    it('corrects a prescription as a new version and cancels the old one', () => {
        const visit = finishVisit([PARACETAMOL, CETIRIZINE]);
        const [first] = service.getVisitPrescriptions(visit.id);

        service.saveVisit({
            id: visit.id, diagnosis: 'Fever',
            prescription: [{ ...PARACETAMOL, dosage: '650mg', quantity: 10, quantity_derived: false }],
            prescription_change_reason: 'Higher dose for weight'
        }, 11);

        const [current, previous] = service.getVisitPrescriptions(visit.id);
        expect(current).toMatchObject({
            status: 'active', version: 2, replaces_id: first.id, replaces_rx_number: first.rx_number, requester_id: 11
        });
        expect(current.requester.name).toBe('Dr. Iyer');
        expect(current.items).toEqual([expect.objectContaining({ dosage: '650mg', quantity: 10, quantity_derived: false })]);
        expect(previous).toMatchObject({
            id: first.id, status: 'cancelled', status_reason: 'Corrected: Higher dose for weight', status_changed_by: 11
        });
        // The old version's lines are kept as they were.
        expect(previous.items.map((i: any) => i.dosage)).toEqual(['500mg', '10mg']);
        // The dropped medicine stops; the kept one carries the new dose.
        expect(activeMedication('Local cetirizine').status).toBe('stopped');
        expect(activeMedication('Crocin 500')).toMatchObject({ status: 'active', dosage: '650mg' });
        expect(JSON.parse(db.prepare('SELECT prescription_json FROM visits WHERE id = ?').get(visit.id).prescription_json)[0].dosage)
            .toBe('650mg');
    });

    it('lets a diagnosis edit through on a visit from before orders, but checks a changed prescription', () => {
        const visit = finishVisit([]);
        db.prepare('UPDATE visits SET prescription_json = ? WHERE id = ?')
            .run(JSON.stringify([{ medicine: 'Old syrup', dosage: '5ml' }]), visit.id);

        service.saveVisit({ id: visit.id, diagnosis: 'Updated', prescription: [{ medicine: 'Old syrup', dosage: '5ml' }] }, 10);
        expect(service.getVisitPrescriptions(visit.id)).toEqual([]);

        expect(() => service.saveVisit({ id: visit.id, diagnosis: 'Updated', prescription: [{ medicine: 'Old syrup', dosage: '10ml' }], prescription_change_reason: 'Fix' }, 10))
            .toThrow(/form is required/);
        service.saveVisit({
            id: visit.id, diagnosis: 'Updated', prescription_change_reason: 'Record the course',
            prescription: [{ medicine: 'Old syrup', form: 'Syr', dosage: '10ml', route: 'Oral', frequency: '1-1-1', duration: '5 days' }]
        }, 10);
        const [order] = service.getVisitPrescriptions(visit.id);
        expect(order).toMatchObject({ version: 1, status: 'active', replaces_id: null });
        // A bottle can't be counted from the schedule, so no quantity is made up.
        expect(order.items[0]).toMatchObject({ quantity: null, quantity_unit: null });
    });

    it('cancels an order with a reason and stops medicines no other order covers', () => {
        const older = finishVisit([CETIRIZINE]);
        const visit = finishVisit([PARACETAMOL, CETIRIZINE]);

        expect(() => service.cancelPrescription({ visitId: visit.id, reason: ' ' }, 10))
            .toThrow('A reason is required to cancel a prescription.');
        const orders = service.cancelPrescription({ visitId: visit.id, reason: 'Patient allergic' }, 10);

        expect(orders[0]).toMatchObject({ status: 'cancelled', status_reason: 'Patient allergic' });
        expect(JSON.parse(db.prepare('SELECT prescription_json FROM visits WHERE id = ?').get(visit.id).prescription_json)).toEqual([]);
        expect(activeMedication('Crocin 500').status).toBe('stopped');
        // Still prescribed by the earlier visit's active order.
        expect(activeMedication('Local cetirizine').status).toBe('active');
        expect(service.getVisitPrescriptions(older.id)[0].status).toBe('active');
        expect(() => service.cancelPrescription({ visitId: visit.id, reason: 'Again' }, 10))
            .toThrow('This visit has no active prescription.');
        expect(() => service.cancelPrescription({ reason: 'x' }, 10)).toThrow('Valid visit id is required.');
    });

    it('prints from the stored order and numbers every copy', () => {
        const visit = finishVisit([PARACETAMOL]);

        const first = service.recordPrescriptionPrint({ visitId: visit.id }, 10);
        expect(first).toMatchObject({
            copy_number: 1, version: 1, status: 'active', intent: 'order', replaces_rx_number: null,
            clinic: { name: 'Nalam Clinic', hfr_id: 'IN3310000001' },
            requester: { name: 'Dr. Rao', license_number: 'TNMC-1234', specialty: 'General Medicine', hpr_id: '71-0001' },
            patient: { name: 'Meena', age: 34, gender: 'Female', mobile: '9876543210' },
            visit: { id: visit.id, diagnosis: 'Fever' }
        });
        expect(first.rx_number).toMatch(/^RX-\d{6}$/);
        expect(first.items[0]).toMatchObject({ medicine: 'Crocin 500', quantity: 6 });
        expect(first.printed_at).toBeTruthy();
        expect(service.recordPrescriptionPrint(visit.id, 20).copy_number).toBe(2);
        expect(service.getVisitPrescriptions(visit.id)[0].print_count).toBe(2);

        // A correction prints as its own order and names the one it replaces;
        // the earlier paper's snapshot is untouched.
        service.saveVisit({ id: visit.id, diagnosis: 'Fever', prescription: [{ ...PARACETAMOL, frequency: '1-1-1' }], prescription_change_reason: 'TID' }, 10);
        const corrected = service.recordPrescriptionPrint({ visitId: visit.id }, 10);
        expect(corrected).toMatchObject({ copy_number: 1, version: 2, replaces_rx_number: first.rx_number });
        expect(corrected.items[0]).toMatchObject({ frequency: '1-1-1', quantity: 9 });
        const firstPaper = JSON.parse(db.prepare('SELECT snapshot_json FROM prescription_prints ORDER BY id LIMIT 1').get().snapshot_json);
        expect(firstPaper.items[0].frequency).toBe('1-0-1');

        service.cancelPrescription({ visitId: visit.id, reason: 'Stopped' }, 10);
        expect(() => service.recordPrescriptionPrint({ visitId: visit.id }, 10))
            .toThrow('This visit has no active prescription to print.');
        expect(() => service.recordPrescriptionPrint({}, 10)).toThrow('Valid visit id is required.');
    });

    it('takes the order along when the visit is entered in error', () => {
        const visit = finishVisit([PARACETAMOL]);
        service.markVisitEnteredInError(visit.id, 'Wrong patient', 10);

        expect(service.getVisitPrescriptions(visit.id)[0]).toMatchObject({ status: 'entered-in-error', status_reason: 'Wrong patient' });
        expect(activeMedication('Crocin 500').status).toBe('stopped');
    });

    it('removes orders and prints when the visit is deleted', () => {
        const visit = finishVisit([PARACETAMOL]);
        service.recordPrescriptionPrint({ visitId: visit.id }, 10);
        service.saveVisit({ id: visit.id, diagnosis: 'Fever', prescription: [{ ...PARACETAMOL, dosage: '650mg' }], prescription_change_reason: 'Dose' }, 10);

        service.deleteVisit(visit.id);

        for (const table of ['prescriptions', 'prescription_items', 'prescription_prints']) {
            expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, table).toBe(0);
        }
    });

    it('removes a patient with orders', () => {
        finishVisit([PARACETAMOL]);
        service.deletePatient(1);
        expect(db.prepare('SELECT COUNT(*) AS n FROM prescriptions').get().n).toBe(0);
    });

    it('allows one active order per visit', () => {
        const visit = finishVisit([PARACETAMOL]);
        expect(() => db.prepare("INSERT INTO prescriptions (visit_id, patient_id, requester_id) VALUES (?, 1, 10)").run(visit.id))
            .toThrow(/UNIQUE/);
    });
});
