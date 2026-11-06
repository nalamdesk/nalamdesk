import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseService } from '../services/DatabaseService';
import { FACILITY_SCOPED_TABLES, HIU_FACILITY_TABLES, MIGRATIONS } from './migrations';
import { TestDatabase } from '../testing/TestDatabase';

const FACILITY_MIGRATION = MIGRATIONS.find(m => m.version === 51)!;

/** A vault as it stands before facilities: schema v50 with clinic data. */
function seedPreFacilityVault(db: TestDatabase) {
    for (const migration of MIGRATIONS.filter(m => m.version < FACILITY_MIGRATION.version)) migration.up(db);
    db.pragma(`user_version = ${FACILITY_MIGRATION.version - 1}`);
    db.prepare(`INSERT INTO settings (clinic_name, doctor_name, logo_path, consultation_fee, mrn_prefix,
        abdm_hip_id, abdm_counter_id, abdm_hfr_id, abdm_hpr_id, abdm_hip_endpoint, abdm_recipient_key, backup_schedule)
        VALUES ('Sunrise Clinic', 'Dr. Asha', '/logo.png', 300, 'SR',
        'HIP-1', 'CTR-1', 'IN3310000001', '71-0001', 'https://hip.example', '{"k":1}', '02:00')`).run();
    db.prepare("INSERT INTO users (id, username, role, name, active) VALUES (1, 'admin', 'admin', 'Admin', 1)").run();
    db.prepare("INSERT INTO users (id, username, role, name, active) VALUES (2, 'asha', 'doctor', 'Dr. Asha', 1)").run();
    db.prepare("INSERT INTO users (id, username, role, name, active) VALUES (3, 'ravi', 'receptionist', 'Ravi', 1)").run();
    db.prepare("INSERT INTO patients (id, uuid, name) VALUES (1, 'p-1', 'Meena')").run();
    db.prepare('INSERT INTO patient_queue (patient_id) VALUES (1)').run();
    db.prepare("INSERT INTO appointments (patient_id, date, time) VALUES (1, '2026-11-02', '10:00')").run();
    db.prepare("INSERT INTO visits (id, patient_id, doctor_id, diagnosis) VALUES (1, 1, 2, 'Fever')").run();
    db.prepare("INSERT INTO invoices (number, visit_id, patient_id, total) VALUES ('INV-100001', 1, 1, 300)").run();
    db.prepare("INSERT INTO payments (receipt_no, invoice_id, amount) VALUES ('RCT-1', 1, 300)").run();
    db.prepare("INSERT INTO abdm_consents (id, patient_id, abha_address, hi_types, status) VALUES (1, 1, 'meena@sbx', '[]', 'granted')").run();
    db.prepare("INSERT INTO abdm_hiu_artefacts (id, consent_id, status) VALUES ('art-1', 1, 'granted')").run();
    db.prepare("INSERT INTO abdm_fetched_records (consent_id, patient_id, bundle_json) VALUES (1, 1, '{}')").run();
}

describe('migration v51: organisations and facilities (#195)', () => {
    let db: TestDatabase;
    let service: DatabaseService;

    beforeEach(async () => {
        db = new TestDatabase();
        db.exec('PRAGMA foreign_keys = ON');
        seedPreFacilityVault(db);
        service = new DatabaseService();
        service.setDb(db);
        await service.migrate({ skipBackup: true });
    });

    afterEach(() => db.close());

    it('turns the clinic into facility 1 with a General OPD', () => {
        expect(db.prepare('SELECT * FROM facilities').all()).toEqual([expect.objectContaining({
            id: 1, code: 'MAIN', kind: 'clinic', active: 1, name: 'Sunrise Clinic', doctor_name: 'Dr. Asha',
            logo_path: '/logo.png', consultation_fee: 300, abdm_hip_id: 'HIP-1', abdm_counter_id: 'CTR-1',
            abdm_hfr_id: 'IN3310000001', abdm_hpr_id: '71-0001', abdm_hip_endpoint: 'https://hip.example',
            abdm_recipient_key: '{"k":1}'
        })]);
        expect(db.prepare('SELECT id, facility_id, code, name, kind FROM departments').all())
            .toEqual([{ id: 1, facility_id: 1, code: 'OPD', name: 'General OPD', kind: 'opd' }]);
        expect((db.prepare('SELECT organisation_name FROM settings').get() as any).organisation_name).toBe('Sunrise Clinic');
    });

    it('stamps every operational row with facility 1', () => {
        for (const table of [...FACILITY_SCOPED_TABLES, ...HIU_FACILITY_TABLES]) {
            const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as any[]).map(c => c.name);
            expect(columns, table).toContain('facility_id');
            expect((db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE facility_id IS NOT 1`).get() as any).n, table).toBe(0);
        }
        expect(db.prepare('SELECT facility_id, department_id, encounter_class FROM visits').get())
            .toEqual({ facility_id: 1, department_id: null, encounter_class: 'OPD' });
        expect((db.prepare('SELECT COUNT(*) AS n FROM invoices WHERE facility_id = 1').get() as any).n).toBe(1);
        expect((db.prepare('SELECT COUNT(*) AS n FROM payments WHERE facility_id = 1').get() as any).n).toBe(1);
    });

    it('grants each user their role at facility 1 and makes admins organisation admins', () => {
        expect(db.prepare('SELECT user_id, facility_id, role FROM user_facility_roles ORDER BY user_id').all()).toEqual([
            { user_id: 1, facility_id: 1, role: 'admin' },
            { user_id: 2, facility_id: 1, role: 'doctor' },
            { user_id: 3, facility_id: 1, role: 'receptionist' }
        ]);
        expect(db.prepare('SELECT id, org_admin FROM users ORDER BY id').all())
            .toEqual([{ id: 1, org_admin: 1 }, { id: 2, org_admin: 0 }, { id: 3, org_admin: 0 }]);
    });

    it('keeps the settings view unchanged for existing callers', () => {
        expect(service.getSettings()).toMatchObject({
            clinic_name: 'Sunrise Clinic', doctor_name: 'Dr. Asha', logo_path: '/logo.png', consultation_fee: 300,
            mrn_prefix: 'SR', backup_schedule: '02:00', abdm_hip_id: 'HIP-1', abdm_hfr_id: 'IN3310000001',
            abdm_hip_endpoint: 'https://hip.example', abdm_recipient_key: '{"k":1}', organisation_name: 'Sunrise Clinic'
        });
        expect(service.getPublicSettings()).toEqual({
            clinic_name: 'Sunrise Clinic', doctor_name: 'Dr. Asha', logo_path: '/logo.png', cloud_enabled: 0,
            standards_mode: 'india_abdm'
        });
    });

    it('writes clinic fields to the facility and organisation fields to settings', () => {
        service.saveSettings({ clinic_name: 'Sunrise Hospital', abdm_hip_id: 'HIP-2', mrn_prefix: 'SH' });
        expect(db.prepare('SELECT name, abdm_hip_id FROM facilities WHERE id = 1').get())
            .toEqual({ name: 'Sunrise Hospital', abdm_hip_id: 'HIP-2' });
        expect(db.prepare('SELECT clinic_name, abdm_hip_id, mrn_prefix FROM settings').get())
            .toEqual({ clinic_name: 'Sunrise Clinic', abdm_hip_id: 'HIP-1', mrn_prefix: 'SH' });
        expect(service.getSettings()).toMatchObject({ clinic_name: 'Sunrise Hospital', abdm_hip_id: 'HIP-2', mrn_prefix: 'SH' });
    });

    it('keeps each facility its own letterhead and HIP while sharing organisation settings', () => {
        db.prepare("INSERT INTO facilities (id, code, name, kind, abdm_hip_id) VALUES (2, 'ANN', 'Anna Nagar', 'hospital', 'HIP-ANN')").run();
        service.saveSettings({ doctor_name: 'Dr. Kumar', consultation_fee: 500 }, 2);
        expect(service.getSettings(2)).toMatchObject({
            clinic_name: 'Anna Nagar', doctor_name: 'Dr. Kumar', consultation_fee: 500, abdm_hip_id: 'HIP-ANN', mrn_prefix: 'SR'
        });
        expect(service.getSettings(1)).toMatchObject({ clinic_name: 'Sunrise Clinic', doctor_name: 'Dr. Asha', consultation_fee: 300 });
        expect(() => service.saveSettings({ clinic_name: 'Ghost' }, 99)).toThrow('Unknown facility.');
    });

    it('refuses the same HFR or HIP ID on two facilities', () => {
        expect(() => db.prepare("INSERT INTO facilities (code, name, abdm_hfr_id) VALUES ('B2', 'Branch', 'IN3310000001')").run())
            .toThrow(/UNIQUE/);
        expect(() => db.prepare("INSERT INTO facilities (code, name, abdm_hip_id) VALUES ('B3', 'Branch', 'HIP-1')").run())
            .toThrow(/UNIQUE/);
        db.prepare("INSERT INTO facilities (code, name) VALUES ('B4', 'No IDs yet'), ('B5', 'Also none')").run();
    });

    it('mirrors new and changed roles into facility 1 while the vault has one facility', () => {
        db.prepare("INSERT INTO users (id, username, role, name) VALUES (4, 'nina', 'nurse', 'Nina')").run();
        db.prepare("UPDATE users SET role = 'admin' WHERE id = 3").run();
        expect(db.prepare('SELECT user_id, role FROM user_facility_roles WHERE user_id IN (3, 4) ORDER BY user_id').all())
            .toEqual([{ user_id: 3, role: 'admin' }, { user_id: 4, role: 'nurse' }]);
        expect((db.prepare('SELECT org_admin FROM users WHERE id = 3').get() as any).org_admin).toBe(1);

        // With a second facility, grants are managed explicitly.
        db.prepare("INSERT INTO facilities (id, code, name) VALUES (2, 'ANN', 'Anna Nagar')").run();
        db.prepare("UPDATE users SET role = 'doctor' WHERE id = 4").run();
        expect((db.prepare('SELECT role FROM user_facility_roles WHERE user_id = 4').get() as any).role).toBe('nurse');
    });

    it('migrates a vault that never saved settings', async () => {
        const fresh = new TestDatabase();
        for (const migration of MIGRATIONS) migration.up(fresh);
        expect(fresh.prepare('SELECT id, code, name FROM facilities').all()).toEqual([{ id: 1, code: 'MAIN', name: '' }]);
        const freshService = new DatabaseService();
        freshService.setDb(fresh);
        expect(freshService.getSettings()).toBeUndefined();
        freshService.saveSettings({ clinic_name: 'New Clinic' });
        expect(freshService.getSettings()).toMatchObject({ clinic_name: 'New Clinic' });
        fresh.close();
    });

    it('creates the inpatient structure for hospitals', () => {
        db.prepare("INSERT INTO wards (id, facility_id, department_id, name, kind) VALUES (1, 1, 1, 'Ward A', 'general')").run();
        db.prepare("INSERT INTO beds (ward_id, code) VALUES (1, 'A-01')").run();
        expect(() => db.prepare("INSERT INTO beds (ward_id, code, status) VALUES (1, 'A-02', 'lost')").run()).toThrow(/CHECK/);
        expect(() => db.prepare("UPDATE visits SET encounter_class = 'XYZ'").run()).toThrow(/CHECK/);
    });
});
