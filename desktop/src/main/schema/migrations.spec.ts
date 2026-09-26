import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MIGRATIONS } from './migrations';

describe('Database Migrations', () => {
    let mockDb: any;
    let executedSql: string[];

    beforeEach(() => {
        executedSql = [];
        mockDb = {
            exec: vi.fn((sql: string) => {
                executedSql.push(sql);
            }),
            prepare: vi.fn().mockReturnValue({
                run: vi.fn(),
                get: vi.fn(),
                all: vi.fn()
            }),
            pragma: vi.fn()
        };
    });

    describe('MIGRATIONS array', () => {
        it('should have sequential version numbers starting at 1', () => {
            MIGRATIONS.forEach((migration, index) => {
                expect(migration.version).toBe(index + 1);
            });
        });

        it('should have an up function for each migration', () => {
            MIGRATIONS.forEach(migration => {
                expect(typeof migration.up).toBe('function');
            });
        });

        it('should have 29 migrations total', () => {
            expect(MIGRATIONS).toHaveLength(29);
        });
    });

    describe('Migration v8 (Credential Rotation Journal)', () => {
        it('stores only hashes and constrains the recoverable phases', () => {
            MIGRATIONS[7].up(mockDb);
            const sql = executedSql.join('\n');
            expect(sql).toContain('credential_rotation_journal');
            expect(sql).toContain("phase IN ('prepared', 'applied')");
            expect(sql).toContain('previous_hash');
            expect(sql).toContain('replacement_hash');
            expect(sql).not.toContain('current_password');
            expect(sql).not.toContain('new_password');
        });
    });

    describe('Migration v1 (Baseline)', () => {
        beforeEach(() => {
            MIGRATIONS[0].up(mockDb);
        });

        it('should create settings table', () => {
            expect(executedSql.some(sql => sql.includes('CREATE TABLE IF NOT EXISTS settings'))).toBe(true);
        });

        it('should create users table', () => {
            expect(executedSql.some(sql => sql.includes('CREATE TABLE IF NOT EXISTS users'))).toBe(true);
        });

        it('should create patients table', () => {
            expect(executedSql.some(sql => sql.includes('CREATE TABLE IF NOT EXISTS patients'))).toBe(true);
        });

        it('should create visits table', () => {
            expect(executedSql.some(sql => sql.includes('CREATE TABLE IF NOT EXISTS visits'))).toBe(true);
        });

        it('should create patient_queue table', () => {
            expect(executedSql.some(sql => sql.includes('CREATE TABLE IF NOT EXISTS patient_queue'))).toBe(true);
        });

        it('should create audit_logs table', () => {
            expect(executedSql.some(sql => sql.includes('CREATE TABLE IF NOT EXISTS audit_logs'))).toBe(true);
        });

        it('should add settings columns with ALTER TABLE', () => {
            // Ensures ALTER TABLE calls for backward compatibility columns
            expect(executedSql.some(sql => sql.includes('ALTER TABLE settings ADD COLUMN'))).toBe(true);
        });

        it('should define clinic_name in settings', () => {
            expect(executedSql.some(sql => sql.includes('clinic_name'))).toBe(true);
        });

        it('should define uuid in patients table', () => {
            expect(executedSql.some(sql => sql.includes('uuid'))).toBe(true);
        });

        it('should handle ALTER TABLE errors gracefully', () => {
            // When ALTER TABLE throws (column already exists), migration should not crash
            mockDb.exec.mockImplementation((sql: string) => {
                if (sql.includes('ALTER TABLE')) throw new Error('duplicate column');
            });
            expect(() => MIGRATIONS[0].up(mockDb)).not.toThrow();
        });
    });

    describe('Migration v2 (RBAC Roles)', () => {
        beforeEach(() => {
            MIGRATIONS[1].up(mockDb);
        });

        it('should create roles table', () => {
            expect(executedSql.some(sql => sql.includes('CREATE TABLE IF NOT EXISTS roles'))).toBe(true);
        });

        it('should seed roles using prepared statements', () => {
            expect(mockDb.prepare).toHaveBeenCalledWith(
                expect.stringContaining('INSERT OR IGNORE INTO roles')
            );
        });

        it('should insert 3 roles (doctor, receptionist, nurse)', () => {
            const runFn = mockDb.prepare.mock.results[0].value.run;
            expect(runFn).toHaveBeenCalledTimes(3);
        });

        it('should include doctor role with correct permissions', () => {
            const runFn = mockDb.prepare.mock.results[0].value.run;
            const doctorCall = runFn.mock.calls.find((args: any[]) => args[0].name === 'doctor');
            expect(doctorCall).toBeTruthy();
            const permissions = JSON.parse(doctorCall[0].permissions);
            expect(permissions).toContain('getPatients');
            expect(permissions).toContain('saveVisit');
            expect(permissions).toContain('getDashboardStats');
        });

        it('should include receptionist role with limited permissions', () => {
            const runFn = mockDb.prepare.mock.results[0].value.run;
            const receptionistCall = runFn.mock.calls.find((args: any[]) => args[0].name === 'receptionist');
            expect(receptionistCall).toBeTruthy();
            const permissions = JSON.parse(receptionistCall[0].permissions);
            expect(permissions).toContain('addToQueue');
            expect(permissions).not.toContain('saveVisit');
        });

        it('should include nurse role with minimal permissions', () => {
            const runFn = mockDb.prepare.mock.results[0].value.run;
            const nurseCall = runFn.mock.calls.find((args: any[]) => args[0].name === 'nurse');
            expect(nurseCall).toBeTruthy();
            const permissions = JSON.parse(nurseCall[0].permissions);
            expect(permissions).toContain('getQueue');
            expect(permissions).not.toContain('savePatient');
        });
    });

    describe('Migration v3 (Staff Fields)', () => {
        beforeEach(() => {
            MIGRATIONS[2].up(mockDb);
        });

        it('should add mobile column to users', () => {
            expect(executedSql.some(sql => sql.includes('ALTER TABLE users ADD COLUMN mobile'))).toBe(true);
        });

        it('should add email column to users', () => {
            expect(executedSql.some(sql => sql.includes('ALTER TABLE users ADD COLUMN email'))).toBe(true);
        });

        it('should add designation column to users', () => {
            expect(executedSql.some(sql => sql.includes('ALTER TABLE users ADD COLUMN designation'))).toBe(true);
        });

        it('should add password_reset_required column', () => {
            expect(executedSql.some(sql => sql.includes('password_reset_required'))).toBe(true);
        });

        it('should handle duplicate column errors gracefully', () => {
            mockDb.exec.mockImplementation(() => { throw new Error('duplicate column'); });
            expect(() => MIGRATIONS[2].up(mockDb)).not.toThrow();
        });
    });

    describe('Migration v4 (Drive & Backup Settings)', () => {
        beforeEach(() => {
            MIGRATIONS[3].up(mockDb);
        });

        it('should add drive_client_id column', () => {
            expect(executedSql.some(sql => sql.includes('drive_client_id'))).toBe(true);
        });

        it('should add drive_client_secret column', () => {
            expect(executedSql.some(sql => sql.includes('drive_client_secret'))).toBe(true);
        });

        it('should add local_backup_path column', () => {
            expect(executedSql.some(sql => sql.includes('local_backup_path'))).toBe(true);
        });
    });

    describe('Migration v5 (Backup Schedule)', () => {
        beforeEach(() => {
            MIGRATIONS[4].up(mockDb);
        });

        it('should add backup_schedule column with default', () => {
            expect(executedSql.some(sql => sql.includes('backup_schedule') && sql.includes("DEFAULT '13:00'"))).toBe(true);
        });
    });

    describe('Migration v6 (Cloud Backup Schedule)', () => {
        beforeEach(() => {
            MIGRATIONS[5].up(mockDb);
        });

        it('should add cloud_backup_schedule column with default', () => {
            expect(executedSql.some(sql => sql.includes('cloud_backup_schedule') && sql.includes("DEFAULT '13:00'"))).toBe(true);
        });
    });

    describe('Migration v7 (Encounter integrity)', () => {
        beforeEach(() => {
            MIGRATIONS[6].up(mockDb);
        });

        it('adds durable encounter lifecycle and idempotency fields', () => {
            expect(executedSql.some(sql => sql.includes('ALTER TABLE visits ADD COLUMN status'))).toBe(true);
            expect(executedSql.some(sql => sql.includes('queue_entry_id'))).toBe(true);
            expect(executedSql.some(sql => sql.includes('start_request_id'))).toBe(true);
        });

        it('creates unique indexes for queue, request, and active patient identity', () => {
            const sql = executedSql.join('\n');
            expect(sql).toContain('idx_visits_queue_entry');
            expect(sql).toContain('idx_visits_start_request');
            expect(sql).toContain('idx_visits_one_active_patient');
            expect(sql).toContain('CREATE TABLE IF NOT EXISTS encounter_requests');
        });

        it('adds consultation permissions without dropping existing doctor permissions', () => {
            const run = vi.fn();
            mockDb.prepare = vi.fn().mockReturnValue({
                run,
                get: vi.fn().mockReturnValue({ permissions: JSON.stringify(['saveVisit']) }),
                all: vi.fn()
            });

            MIGRATIONS[6].up(mockDb);

            const [serializedPermissions, role] = run.mock.calls[0];
            const permissions = JSON.parse(serializedPermissions);
            expect(role).toBe('doctor');
            expect(permissions).toContain('saveVisit');
            expect(permissions).toContain('beginConsultation');
            expect(permissions).toContain('beginNextConsultation');
        });
    });

    describe('Migration v9 (Condition and medicine catalogs)', () => {
        it('creates catalog tables, active-name uniqueness, and ordered presets', () => {
            MIGRATIONS[8].up(mockDb);
            const sql = executedSql.join('\n');
            expect(sql).toContain('CREATE TABLE IF NOT EXISTS condition_catalog');
            expect(sql).toContain('CREATE TABLE IF NOT EXISTS medicine_catalog');
            expect(sql).toContain('CREATE TABLE IF NOT EXISTS condition_med_presets');
            expect(sql).toContain('idx_condition_catalog_active_name');
            expect(sql).toContain('idx_medicine_catalog_active_name');
            expect(sql).toContain('WHERE active = 1');
            expect(sql).toContain('instruction TEXT');
        });

        it('adds visit catalog permissions for doctors without dropping existing ones', () => {
            const run = vi.fn();
            mockDb.prepare = vi.fn().mockReturnValue({
                run,
                get: vi.fn().mockReturnValue({ permissions: JSON.stringify(['saveVisit']) }),
                all: vi.fn()
            });
            MIGRATIONS[8].up(mockDb);
            const [serializedPermissions, role] = run.mock.calls[0];
            const permissions = JSON.parse(serializedPermissions);
            expect(role).toBe('doctor');
            expect(permissions).toContain('saveVisit');
            expect(permissions).toContain('searchConditions');
            expect(permissions).toContain('createMedicine');
            expect(permissions).toContain('getConditionMedPresets');
        });
    });

    describe('Migration v10 (Encounter-Linked Vitals & Observation Model)', () => {
        it('adds observation columns and indexes for vitals', () => {
            MIGRATIONS[9].up(mockDb);
            const sql = executedSql.join('\n');
            expect(sql).toContain('ALTER TABLE vitals ADD COLUMN effective_time');
            expect(sql).toContain('ALTER TABLE vitals ADD COLUMN recorded_at');
            expect(sql).toContain('ALTER TABLE vitals ADD COLUMN performer_id');
            expect(sql).toContain('ALTER TABLE vitals ADD COLUMN status');
            expect(sql).toContain('ALTER TABLE vitals ADD COLUMN units_json');
            expect(sql).toContain('ALTER TABLE vitals ADD COLUMN queue_entry_id');
            expect(sql).toContain('ALTER TABLE vitals ADD COLUMN replaces_id');
            expect(sql).toContain('ALTER TABLE vitals ADD COLUMN amendment_reason');
            expect(sql).toContain('ALTER TABLE vitals ADD COLUMN client_request_id');
            expect(sql).toContain('idx_vitals_patient_effective');
            expect(sql).toContain('idx_vitals_queue_entry');
            expect(sql).toContain('idx_vitals_replaces');
        });

        it('adds vitals permissions to doctor, nurse, and receptionist roles', () => {
            const run = vi.fn();
            mockDb.prepare = vi.fn().mockReturnValue({
                run,
                get: vi.fn().mockImplementation((roleName: string) => ({
                    permissions: JSON.stringify(['getQueue', 'getPatients'])
                })),
                all: vi.fn()
            });
            MIGRATIONS[9].up(mockDb);
            expect(run).toHaveBeenCalled();
            const calledRoles = run.mock.calls.map(call => call[1]);
            expect(calledRoles).toContain('doctor');
            expect(calledRoles).toContain('nurse');
            expect(calledRoles).toContain('receptionist');

            const doctorCall = run.mock.calls.find(call => call[1] === 'doctor');
            const doctorPerms = JSON.parse(doctorCall[0]);
            expect(doctorPerms).toContain('getVitals');
            expect(doctorPerms).toContain('saveVitals');
            expect(doctorPerms).toContain('getVitalsHistory');
            expect(doctorPerms).toContain('getEncounterVitals');
        });
    });

    describe('Migration v11 (Clinical Safety, Allergies, Problem List & Actionable Triage)', () => {
        beforeEach(() => {
            MIGRATIONS[10].up(mockDb);
        });

        it('creates patient_allergies, conditions, medications, and triage tables', () => {
            const sql = executedSql.join('\n');
            expect(sql).toContain('CREATE TABLE IF NOT EXISTS patient_allergies');
            expect(sql).toContain('CREATE TABLE IF NOT EXISTS patient_conditions');
            expect(sql).toContain('CREATE TABLE IF NOT EXISTS patient_medications');
            expect(sql).toContain('CREATE TABLE IF NOT EXISTS queue_triage_history');
            expect(sql).toContain('idx_patient_allergies_patient');
            expect(sql).toContain('idx_patient_conditions_patient');
            expect(sql).toContain('idx_patient_medications_patient');
            expect(sql).toContain('idx_queue_triage_hist_queue');
        });

        it('adds author_id, doctor_license_snapshot, and allergy_override_reason to visits', () => {
            const sql = executedSql.join('\n');
            expect(sql).toContain('ALTER TABLE visits ADD COLUMN author_id');
            expect(sql).toContain('ALTER TABLE visits ADD COLUMN doctor_license_snapshot');
            expect(sql).toContain('ALTER TABLE visits ADD COLUMN allergy_override_reason');
        });

        it('adds urgency and triage columns to patient_queue and backfills urgency', () => {
            const sql = executedSql.join('\n');
            expect(sql).toContain('ALTER TABLE patient_queue ADD COLUMN urgency');
            expect(sql).toContain('ALTER TABLE patient_queue ADD COLUMN triage_notes');
            expect(sql).toContain('ALTER TABLE patient_queue ADD COLUMN triage_assessor_id');
            expect(sql).toContain('ALTER TABLE patient_queue ADD COLUMN triaged_at');
            expect(sql).toContain("WHEN priority >= 4 THEN 'immediate'");
        });

        it('adds clinical safety permissions to roles', () => {
            const run = vi.fn();
            mockDb.prepare = vi.fn().mockReturnValue({
                run,
                get: vi.fn().mockImplementation((roleName: string) => ({
                    permissions: JSON.stringify(['getQueue', 'getPatients'])
                })),
                all: vi.fn()
            });
            MIGRATIONS[10].up(mockDb);
            expect(run).toHaveBeenCalled();
            const calledRoles = run.mock.calls.map(call => call[1]);
            expect(calledRoles).toContain('doctor');
            expect(calledRoles).toContain('nurse');
            expect(calledRoles).toContain('receptionist');
            expect(calledRoles).toContain('admin');

            const doctorCall = run.mock.calls.find(call => call[1] === 'doctor');
            const doctorPerms = JSON.parse(doctorCall[0]);
            expect(doctorPerms).toContain('getAllergies');
            expect(doctorPerms).toContain('saveAllergy');
            expect(doctorPerms).toContain('getConditions');
            expect(doctorPerms).toContain('saveCondition');
            expect(doctorPerms).toContain('getMedications');
            expect(doctorPerms).toContain('saveMedication');
            expect(doctorPerms).toContain('reassessQueueTriage');
            expect(doctorPerms).toContain('getQueueTriageHistory');
            expect(doctorPerms).toContain('getPatientSafetyContext');
        });
    });

    describe('Full Migration Run', () => {
        it('should run all migrations without error', () => {
            expect(() => {
                MIGRATIONS.forEach(migration => migration.up(mockDb));
            }).not.toThrow();
        });
    });

    describe('Migration v16 (share-token LAN grants)', () => {
        it('grants share methods to desk roles, reads only for nurses', () => {
            const store: Record<string, string> = {
                doctor: JSON.stringify(['getQueue']),
                receptionist: JSON.stringify(['getQueue']),
                admin: JSON.stringify(['getQueue']),
                nurse: JSON.stringify(['getQueue'])
            };
            const writes: Record<string, string> = {};
            mockDb.prepare.mockImplementation((sql: string) => {
                if (sql.startsWith('SELECT permissions FROM roles')) {
                    return { get: (name: string) => ({ permissions: store[name] }) };
                }
                return { run: (perms: string, name: string) => { writes[name] = perms; } };
            });
            MIGRATIONS.find((m) => m.version === 16)!.up(mockDb);

            for (const role of ['doctor', 'receptionist', 'admin']) {
                const perms = JSON.parse(writes[role]);
                expect(perms).toEqual(expect.arrayContaining(
                    ['abdmGetShareTokens', 'findPatientByAbha', 'abdmAcceptShareToken']));
            }
            const nurse = JSON.parse(writes['nurse']);
            expect(nurse).toEqual(expect.arrayContaining(['abdmGetShareTokens', 'findPatientByAbha']));
            expect(nurse).not.toContain('abdmAcceptShareToken');
        });
    });

    describe('Migration v21 (inbox LAN grants)', () => {
        it('grants inbox methods to desk roles, reads only for nurses', () => {
            const store: Record<string, string> = {
                doctor: JSON.stringify(['getQueue']),
                receptionist: JSON.stringify(['getQueue']),
                admin: JSON.stringify(['getQueue']),
                nurse: JSON.stringify(['getQueue'])
            };
            const writes: Record<string, string> = {};
            mockDb.prepare.mockImplementation((sql: string) => {
                if (sql.startsWith('SELECT permissions FROM roles')) {
                    return { get: (name: string) => ({ permissions: store[name] }) };
                }
                return { run: (perms: string, name: string) => { writes[name] = perms; } };
            });
            MIGRATIONS.find((m) => m.version === 21)!.up(mockDb);

            for (const role of ['doctor', 'receptionist', 'admin']) {
                const perms = JSON.parse(writes[role]);
                expect(perms).toEqual(expect.arrayContaining(['abdmGetInbox', 'abdmAckInbox']));
            }
            const nurse = JSON.parse(writes['nurse']);
            expect(nurse).toEqual(expect.arrayContaining(['abdmGetInbox']));
            expect(nurse).not.toContain('abdmAckInbox');
        });
    });

    describe('Migration v25 (record deletes are admin-only)', () => {
        it('strips record deletes from desk roles while leaving the rest intact', () => {
            const store: Record<string, string> = {
                doctor: JSON.stringify(['getQueue', 'deletePatient', 'deleteVisit']),
                receptionist: JSON.stringify(['getQueue', 'deleteUser']),
                nurse: JSON.stringify(['getQueue']),
                admin: JSON.stringify(['deletePatient', 'deleteVisit', 'deleteUser'])
            };
            const writes: Record<string, string> = {};
            mockDb.prepare.mockImplementation((sql: string) => {
                if (sql.startsWith('SELECT permissions FROM roles')) {
                    return { get: (name: string) => ({ permissions: store[name] }) };
                }
                return { run: (perms: string, name: string) => { writes[name] = perms; } };
            });
            MIGRATIONS.find((m) => m.version === 25)!.up(mockDb);

            for (const role of ['doctor', 'nurse', 'receptionist']) {
                const perms = JSON.parse(writes[role]);
                expect(perms).toContain('getQueue');
                expect(perms).not.toContain('deletePatient');
                expect(perms).not.toContain('deleteVisit');
                expect(perms).not.toContain('deleteUser');
            }
            expect(writes['admin']).toBeUndefined();
        });
    });

    describe('Migration v26 (profile-login LAN grants)', () => {
        it('grants the login OTP methods to desk roles, mirroring the intake gate', () => {
            const store: Record<string, string> = {
                doctor: JSON.stringify(['abdmAbhaLookup']),
                receptionist: JSON.stringify(['abdmAbhaLookup']),
                nurse: JSON.stringify(['abdmAbhaLookup']),
                admin: JSON.stringify(['abdmAbhaLookup'])
            };
            const writes: Record<string, string> = {};
            mockDb.prepare.mockImplementation((sql: string) => {
                if (sql.startsWith('SELECT permissions FROM roles')) {
                    return { get: (name: string) => ({ permissions: store[name] }) };
                }
                return { run: (perms: string, name: string) => { writes[name] = perms; } };
            });
            MIGRATIONS.find((m) => m.version === 26)!.up(mockDb);

            for (const role of ['doctor', 'receptionist', 'admin']) {
                const perms = JSON.parse(writes[role]);
                expect(perms).toEqual(expect.arrayContaining(['abdmAbhaRequestLoginOtp', 'abdmAbhaConfirmLoginOtp']));
            }
            expect(writes['nurse']).toBeUndefined();
        });
    });

    describe('Migration v28 (consent notify dedupe and HIU grants)', () => {
        it('adds the request id column and grants HIU methods to clinical roles', () => {
            MIGRATIONS.find((m) => m.version === 28)!.up(mockDb);
            const sql = executedSql.join('\n');
            expect(sql).toContain('ADD COLUMN request_id');
            expect(sql).toContain('idx_abdm_inbox_dedupe');
            const store: Record<string, string> = {
                doctor: JSON.stringify(['getQueue']),
                receptionist: JSON.stringify(['getQueue']),
                nurse: JSON.stringify(['getQueue']),
                admin: JSON.stringify(['getQueue'])
            };
            const writes: Record<string, string> = {};
            mockDb.prepare.mockImplementation((sqlText: string) => {
                if (sqlText.startsWith('SELECT permissions FROM roles')) {
                    return { get: (name: string) => ({ permissions: store[name] }) };
                }
                return { run: (perms: string, name: string) => { writes[name] = perms; } };
            });
            MIGRATIONS.find((m) => m.version === 28)!.up(mockDb);

            for (const role of ['doctor', 'admin']) {
                const perms = JSON.parse(writes[role]);
                expect(perms).toEqual(expect.arrayContaining(
                    ['abdmHiuRequestConsent', 'abdmHiuGetConsents', 'abdmHiuFetchRecords']));
            }
            expect(JSON.parse(writes['receptionist'])).toEqual(
                expect.arrayContaining(['abdmHiuGetConsents']));
            expect(JSON.parse(writes['receptionist'])).not.toContain('abdmHiuRequestConsent');
            expect(JSON.parse(writes['nurse'])).toEqual(
                expect.arrayContaining(['abdmHiuGetConsents']));
            expect(JSON.parse(writes['nurse'])).not.toContain('abdmHiuFetchRecords');
        });
    });

    describe('Migration v29 (external-records read and clear grants)', () => {
        it('grants reads to the desk and clearing to clinical roles', () => {
            const store: Record<string, string> = {
                doctor: JSON.stringify(['getQueue']),
                receptionist: JSON.stringify(['getQueue']),
                nurse: JSON.stringify(['getQueue']),
                admin: JSON.stringify(['getQueue'])
            };
            const writes: Record<string, string> = {};
            mockDb.prepare.mockImplementation((sqlText: string) => {
                if (sqlText.startsWith('SELECT permissions FROM roles')) {
                    return { get: (name: string) => ({ permissions: store[name] }) };
                }
                return { run: (perms: string, name: string) => { writes[name] = perms; } };
            });
            MIGRATIONS.find((m) => m.version === 29)!.up(mockDb);

            for (const role of ['doctor', 'receptionist', 'admin', 'nurse']) {
                expect(JSON.parse(writes[role])).toEqual(
                    expect.arrayContaining(['abdmHiuGetExternalRecords']));
            }
            for (const role of ['doctor', 'admin']) {
                expect(JSON.parse(writes[role])).toEqual(
                    expect.arrayContaining(['abdmHiuClearExternalRecords']));
            }
            expect(JSON.parse(writes['receptionist'])).not.toContain('abdmHiuClearExternalRecords');
            expect(JSON.parse(writes['nurse'])).not.toContain('abdmHiuClearExternalRecords');
        });
    });
});
