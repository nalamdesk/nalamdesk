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

describe('Clinical Safety, Practitioner Provenance & Actionable Triage', () => {
    let db: any;
    let service: DatabaseService;

    beforeEach(async () => {
        db = new TestDatabase();
        db.exec('PRAGMA foreign_keys = ON');
        service = new DatabaseService();
        service.setDb(db);
        await service.migrate();

        // Doctors, nurse, admin
        db.prepare("INSERT INTO users (id, username, role, name, license_number, specialty, active) VALUES (10, 'dr_smith', 'doctor', 'Dr. Smith', 'MED-12345', 'Internal Medicine', 1)").run();
        db.prepare("INSERT INTO users (id, username, role, name, license_number, specialty, active) VALUES (11, 'dr_jones', 'doctor', 'Dr. Jones', 'MED-67890', 'Cardiology', 1)").run();
        db.prepare("INSERT INTO users (id, username, role, name, active) VALUES (20, 'nurse_nancy', 'nurse', 'Nurse Nancy', 1)").run();
        db.prepare("INSERT INTO users (id, username, role, name, active) VALUES (99, 'admin', 'admin', 'System Admin', 1)").run();

        // Patients
        db.prepare("INSERT INTO patients (id, uuid, name, mobile, age, gender) VALUES (1, 'p-1', 'Alice Green', '9876543210', 30, 'female')").run();
        db.prepare("INSERT INTO patients (id, uuid, name, mobile, age, gender) VALUES (2, 'p-2', 'Bob Brown', '9876543211', 45, 'male')").run();
    });

    afterEach(() => db.close());

    function queuePatient(patientId: number, options?: any) {
        return service.addToQueue(patientId, options, 20);
    }

    describe('Track A: Practitioner Provenance (Issue #11)', () => {
        it('requires an active licensed doctor to begin consultation', () => {
            const q = queuePatient(1);
            const qId = Number(q.lastInsertRowid);

            // Admin cannot begin encounter without doctorId
            expect(() => service.beginConsultation({ patientId: 1, queueEntryId: qId, startRequestId: 'req-admin' }, 99))
                .toThrow('Clinical authoring requires an active licensed practitioner');

            // Doctor can begin encounter
            const enc = service.beginConsultation({ patientId: 1, queueEntryId: qId, startRequestId: 'req-doc' }, 10);
            expect(enc.doctor_id).toBe(10);
            expect(enc.author_id).toBe(10);
            expect(enc.doctor_license).toMatchObject({
                name: 'Dr. Smith',
                license_number: 'MED-12345',
                specialty: 'Internal Medicine'
            });
        });

        it('supports delegated authoring by nurse with responsible doctorId', () => {
            const q = queuePatient(1);
            const qId = Number(q.lastInsertRowid);

            // Nurse starting encounter on behalf of Dr. Jones (11)
            const enc = service.beginConsultation({ patientId: 1, queueEntryId: qId, doctorId: 11, startRequestId: 'req-nurse' }, 20);
            expect(enc.doctor_id).toBe(11);
            expect(enc.author_id).toBe(20);
            expect(enc.doctor_license).toMatchObject({
                name: 'Dr. Jones',
                license_number: 'MED-67890'
            });

            // Author (nurse) and responsible doctor can save consultation progress
            const saved = service.saveConsultationProgress({
                encounterId: enc.id,
                visit: { symptoms: 'Sore throat and cough' }
            }, 20);
            expect(saved.symptoms).toBe('Sore throat and cough');

            // Unrelated doctor cannot access
            expect(() => service.saveConsultationProgress({ encounterId: enc.id, visit: {} }, 10))
                .toThrow('Only the responsible practitioner can access this encounter');
        });

        it('rejects access if practitioner is deactivated', () => {
            const q = queuePatient(1);
            const qId = Number(q.lastInsertRowid);
            const enc = service.beginConsultation({ patientId: 1, queueEntryId: qId, startRequestId: 'req-active' }, 10);

            // Deactivate Dr. Smith
            db.prepare('UPDATE users SET active = 0 WHERE id = 10').run();
            expect(() => service.saveConsultationProgress({ encounterId: enc.id, visit: { symptoms: 'fever' } }, 10))
                .toThrow('User is deactivated');
        });
    });

    describe('Track B: Longitudinal Allergies, Conditions & Prescribing Conflicts (Issue #15)', () => {
        it('performs CRUD on allergies and returns active sorted by severity', () => {
            service.saveAllergy({
                patient_id: 1,
                substance: 'Penicillin',
                severity: 'life-threatening',
                reaction: 'Anaphylaxis',
                status: 'active'
            }, 10);

            service.saveAllergy({
                patient_id: 1,
                substance: 'Aspirin',
                severity: 'mild',
                reaction: 'Upset stomach',
                status: 'active'
            }, 10);

            const allergies = service.getAllergies(1);
            expect(allergies).toHaveLength(2);
            // Penicillin (life-threatening) appears before Aspirin (mild)
            expect(allergies[0].substance).toBe('Penicillin');
            expect(allergies[0].severity).toBe('life-threatening');
            expect(allergies[1].substance).toBe('Aspirin');

            // Delete allergy
            service.deleteAllergy(allergies[1].id, 10);
            expect(service.getAllergies(1)).toHaveLength(1);
        });

        it('detects prescription conflict with active allergy and blocks unless override reason provided', () => {
            service.saveAllergy({
                patient_id: 1,
                substance: 'Amoxicillin',
                severity: 'severe',
                status: 'active'
            }, 10);

            const q = queuePatient(1);
            const enc = service.beginConsultation({ patientId: 1, queueEntryId: Number(q.lastInsertRowid), startRequestId: 'req-allergy' }, 10);

            // Saving prescription containing Amoxicillin without override reason should throw
            expect(() => service.saveConsultationProgress({
                encounterId: enc.id,
                visit: {
                    prescription: [{ medicine: 'Amoxicillin 500mg', dosage: '1 tab', frequency: 'TID' }]
                }
            }, 10)).toThrow(/conflicting with active allergy 'Amoxicillin'/);

            // Providing override reason allows it to succeed
            const saved = service.saveConsultationProgress({
                encounterId: enc.id,
                visit: {
                    prescription: [{ medicine: 'Amoxicillin 500mg', dosage: '1 tab', frequency: 'TID' }],
                    allergy_override_reason: 'Patient confirmed prior desensitization therapy'
                }
            }, 10);
            expect(saved.allergy_override_reason).toBe('Patient confirmed prior desensitization therapy');
        });

        it('auto-syncs prescribed medications into patient_medications upon completion', () => {
            const q = queuePatient(1);
            const enc = service.beginConsultation({ patientId: 1, queueEntryId: Number(q.lastInsertRowid), startRequestId: 'req-finish' }, 10);

            service.completeConsultation({
                encounterId: enc.id,
                visit: {
                    diagnosis: 'Acute Bronchitis',
                    prescription: [
                        { medicine: 'Azithromycin 250mg', dosage: '1 tab', frequency: 'OD' },
                        { medicine: 'Paracetamol 650mg', dosage: '1 tab', frequency: 'SOS' }
                    ]
                }
            }, 10);

            const meds = service.getMedications(1);
            expect(meds).toHaveLength(2);
            expect(meds.some((m: any) => m.medicine_name === 'Azithromycin 250mg')).toBe(true);
            expect(meds.some((m: any) => m.medicine_name === 'Paracetamol 650mg')).toBe(true);
        });

        it('consolidates patient safety context into a single profile', () => {
            service.saveAllergy({
                patient_id: 1,
                substance: 'Sulfa Drugs',
                severity: 'severe',
                status: 'active'
            }, 10);
            service.saveCondition({
                patient_id: 1,
                condition_name: 'Hypertension',
                code: 'I10',
                clinical_status: 'active'
            }, 10);

            const safety = service.getPatientSafetyContext(1);
            expect(safety.has_active_allergies).toBe(true);
            expect(safety.has_life_threatening_allergies).toBe(true);
            expect(safety.active_conditions).toHaveLength(1);
            expect(safety.active_conditions[0].condition_name).toBe('Hypertension');
        });

        it('updates existing allergies, conditions, and medications', () => {
            // Allergy update
            const allergy = service.saveAllergy({
                patient_id: 1,
                substance: 'Peanuts',
                criticality: 'low',
                status: 'active'
            }, 10);
            expect(allergy.criticality).toBe('low');

            const updatedAllergy = service.saveAllergy({
                id: allergy.id,
                patient_id: 1,
                substance: 'Peanuts',
                criticality: 'high',
                severity: 'severe',
                status: 'active'
            }, 10);
            expect(updatedAllergy.criticality).toBe('high');
            expect(updatedAllergy.severity).toBe('severe');

            // Condition update and delete
            const condition = service.saveCondition({
                patient_id: 1,
                condition_name: 'Asthma',
                clinical_status: 'active'
            }, 10);
            expect(condition.condition_name).toBe('Asthma');

            const updatedCondition = service.saveCondition({
                id: condition.id,
                patient_id: 1,
                condition_name: 'Severe Asthma',
                clinical_status: 'resolved'
            }, 10);
            expect(updatedCondition.condition_name).toBe('Severe Asthma');
            expect(updatedCondition.clinical_status).toBe('resolved');

            service.deleteCondition(condition.id, 10);
            expect(service.getConditions(1)).toHaveLength(0);

            // Medication update and delete
            const med = service.saveMedication({
                patient_id: 1,
                medicine_name: 'Metformin 500mg',
                dosage: '1 tab',
                frequency: 'BD'
            }, 10);
            expect(med.medicine_name).toBe('Metformin 500mg');

            const updatedMed = service.saveMedication({
                id: med.id,
                patient_id: 1,
                medicine_name: 'Metformin 1000mg',
                dosage: '1 tab',
                frequency: 'BD',
                status: 'active'
            }, 10);
            expect(updatedMed.medicine_name).toBe('Metformin 1000mg');

            service.deleteMedication(med.id, 10);
            expect(service.getMedications(1)).toHaveLength(0);
        });

        it('enforces input validation rules on allergy, condition, and medication mutations', () => {
            expect(() => service.saveAllergy(null)).toThrow('Allergy data is required');
            expect(() => service.saveAllergy({})).toThrow('patient_id is required');
            expect(() => service.saveAllergy({ patient_id: 1 })).toThrow('substance is required');

            expect(() => service.saveCondition(null)).toThrow('Condition data is required');
            expect(() => service.saveCondition({})).toThrow('patient_id is required');
            expect(() => service.saveCondition({ patient_id: 1 })).toThrow('condition_name is required');

            expect(() => service.saveMedication(null)).toThrow('Medication data is required');
            expect(() => service.saveMedication({})).toThrow('patient_id is required');
            expect(() => service.saveMedication({ patient_id: 1 })).toThrow('medicine_name is required');
        });

        it('does not duplicate active medications when auto-syncing duplicate prescribed drugs', () => {
            service.saveMedication({
                patient_id: 1,
                medicine_name: 'Cetirizine 10mg',
                status: 'active'
            }, 10);

            const q = queuePatient(1);
            const enc = service.beginConsultation({ patientId: 1, queueEntryId: Number(q.lastInsertRowid), startRequestId: 'req-dup-med' }, 10);

            service.completeConsultation({
                encounterId: enc.id,
                visit: {
                    prescription: [
                        { medicine: 'Cetirizine 10mg', dosage: '1 tab', frequency: 'HS' }
                    ]
                }
            }, 10);

            const meds = service.getMedications(1);
            expect(meds.filter((m: any) => m.medicine_name === 'Cetirizine 10mg')).toHaveLength(1);
        });
    });

    describe('Track C: Actionable Urgency, Triage History & Abnormal Vitals (Issue #17 & #53)', () => {
        it('sorts queue by urgency priority (immediate > urgent > priority > routine)', () => {
            service.addToQueue(1, { urgency: 'routine', priority: 1, triage_notes: 'Regular checkup' }, 20);
            service.addToQueue(2, { urgency: 'immediate', priority: 4, triage_notes: 'Severe chest pain' }, 20);

            const queue = service.getQueue();
            expect(queue[0].patient_id).toBe(2);
            expect(queue[0].urgency).toBe('immediate');
            expect(queue[1].patient_id).toBe(1);
            expect(queue[1].urgency).toBe('routine');
        });

        it('records initial triage and logs reassessment in queue_triage_history', () => {
            const added = service.addToQueue(1, { urgency: 'routine', priority: 1, triage_notes: 'Normal walk-in' }, 20);
            const queueId = Number(added.lastInsertRowid);

            // Verify initial triage history
            let history = service.getQueueTriageHistory(queueId);
            expect(history).toHaveLength(1);
            expect(history[0].new_urgency).toBe('routine');

            // Reassess triage to Urgent
            service.reassessQueueTriage(queueId, 'urgent', 'Patient developed acute shortness of breath', 10);

            history = service.getQueueTriageHistory(queueId);
            expect(history).toHaveLength(2);
            expect(history[0].previous_priority).toBe(1);
            expect(history[0].new_urgency).toBe('urgent');
            expect(history[0].reason).toBe('Patient developed acute shortness of breath');
            expect(history[0].assessor_name).toBe('Dr. Smith');

            const queue = service.getQueue();
            expect(queue[0].urgency).toBe('urgent');
            expect(queue[0].priority).toBe(3);
        });

        it('flags queue card with abnormal vitals alerts', () => {
            const added = service.addToQueue(1, { urgency: 'routine', priority: 1 }, 20);
            const queueId = Number(added.lastInsertRowid);

            // Record abnormal vitals linked to this queue entry
            service.saveVitals({
                patient_id: 1,
                queue_entry_id: queueId,
                systolic_bp: 175,
                diastolic_bp: 105,
                pulse: 125,
                temperature: 103.5
            }, 20);

            const queue = service.getQueue();
            expect(queue[0].has_abnormal_vitals).toBe(true);
            expect(queue[0].vitals_alerts.length).toBeGreaterThanOrEqual(3);
            expect(queue[0].vitals_alerts.some((a: string) => a.includes('Critical Systolic BP'))).toBe(true);
            expect(queue[0].vitals_alerts.some((a: string) => a.includes('Fever'))).toBe(true);
        });

        it('disallows reassessing completed queue entries', () => {
            const added = service.addToQueue(1, { urgency: 'routine', priority: 1 }, 20);
            const queueId = Number(added.lastInsertRowid);

            const enc = service.beginConsultation({ patientId: 1, queueEntryId: queueId, startRequestId: 'req-comp' }, 10);
            service.completeConsultation({ encounterId: enc.id, visit: { diagnosis: 'Done' } }, 10);

            expect(() => service.reassessQueueTriage(queueId, 'immediate', 'Too late', 10))
                .toThrow('Cannot reassess triage for completed queue entry');
        });

        it('correctly evaluates Celsius vitals in the queue without false hypothermia', () => {
            const added = service.addToQueue(1, { urgency: 'routine', priority: 1 }, 20);
            const queueId = Number(added.lastInsertRowid);

            service.saveVitals({
                patient_id: 1,
                queue_entry_id: queueId,
                temperature: 37,
                pulse: 72,
                systolic_bp: 120,
                diastolic_bp: 80,
                units: { temperature: '°C' }
            }, 20);

            const queue = service.getQueue();
            expect(queue[0].has_abnormal_vitals).toBe(false);
            expect(queue[0].vitals_alerts).toHaveLength(0);
        });

        it('preserves triage history audit records when queue entries are removed', () => {
            const added = service.addToQueue(1, { urgency: 'routine', priority: 1 }, 20);
            const queueId = Number(added.lastInsertRowid);

            service.reassessQueueTriage(queueId, 'urgent', 'Patient feels dizzy', 20);
            const historyBefore = service.getQueueTriageHistory(queueId);
            expect(historyBefore).toHaveLength(2);

            service.removeFromQueue(queueId, 99);

            const historyAfter = service.getQueueTriageHistory(queueId);
            expect(historyAfter).toHaveLength(2);
            expect(historyAfter[0].urgency_label).toBe('urgent');
            expect(historyAfter[0].reason).toBe('Patient feels dizzy');
        });

        it('allows admin or non-doctor staff to start consultation when providing doctorId', () => {
            const added = service.addToQueue(1, { urgency: 'routine', priority: 1 }, 20);
            const queueId = Number(added.lastInsertRowid);

            // Admin starts consultation providing doctorId
            const enc = service.beginConsultation({
                patientId: 1,
                queueEntryId: queueId,
                startRequestId: 'req-admin-delegated',
                doctorId: 10
            }, 99);

            expect(enc).toBeTruthy();
            expect(enc.doctor_id).toBe(10); // Active doctor Dr. Smith
            expect(enc.author_id).toBe(99); // Admin actor
            expect(enc.doctor_license?.license_number).toBe('MED-12345');

            // Admin who authored it can also save consultation progress
            service.saveConsultationProgress({
                encounterId: enc.id,
                visit: { diagnosis: 'Admin initial intake', amount_paid: 50 }
            }, 99);

            const updated = service.getEncounterById(enc.id);
            expect(updated.diagnosis).toBe('Admin initial intake');
        });

        it('enforces validation rules for triage reassessment', () => {
            const added = service.addToQueue(1, { urgency: 'routine', priority: 1 }, 20);
            const queueId = Number(added.lastInsertRowid);

            expect(() => service.reassessQueueTriage(0, 'urgent', 'Patient worsening')).toThrow('queueId is required');
            expect(() => service.reassessQueueTriage(queueId, '', 'Patient worsening')).toThrow('newUrgency is required');
            expect(() => service.reassessQueueTriage(queueId, 'urgent', '')).toThrow('A clinical reason is required for triage reassessment');
            expect(() => service.reassessQueueTriage(queueId, 'urgent', '   ')).toThrow('A clinical reason is required for triage reassessment');
            expect(() => service.reassessQueueTriage(999999, 'urgent', 'Patient worsening')).toThrow('Queue entry not found');
        });

        it('delegates condition and medicine catalog search and creation', () => {
            const cond = service.createCondition({
                name: 'Asthma, unspecified'
            });
            expect(cond).toBeTruthy();

            const condResults = service.searchConditions('Asthma');
            expect(condResults.length).toBeGreaterThan(0);

            const med = service.createMedicine({
                name: 'Amoxicillin 500mg Capsule',
                dosage_form: 'capsule',
                strength: '500mg'
            });
            expect(med).toBeTruthy();

            const medResults = service.searchMedicines('Amoxicillin');
            expect(medResults.length).toBeGreaterThan(0);
        });
    });

    describe('Track D: review follow-ups', () => {
        it('prefers queue-linked vitals over newer same-day readings for alerts', () => {
            const added = service.addToQueue(1, { urgency: 'routine', priority: 1 }, 20);
            const queueId = Number(added.lastInsertRowid);

            service.saveVitals({
                patient_id: 1,
                queue_entry_id: queueId,
                systolic_bp: 120,
                diastolic_bp: 80,
                pulse: 72,
                temperature: 98.6
            }, 20);
            // Unrelated same-day measurement (no queue link, higher id) must not win.
            db.prepare(`INSERT INTO vitals (patient_id, queue_entry_id, systolic_bp, diastolic_bp, pulse, temperature, status, effective_time)
                VALUES (1, NULL, 190, 120, 130, 104, 'final', datetime('now'))`).run();

            const queue = service.getQueue();
            expect(queue[0].has_abnormal_vitals).toBe(false);
            expect(queue[0].vitals_alerts).toHaveLength(0);
        });

        it('excludes entered-in-error vitals from queue alerts', () => {
            const added = service.addToQueue(1, { urgency: 'routine', priority: 1 }, 20);
            const queueId = Number(added.lastInsertRowid);

            db.prepare(`INSERT INTO vitals (patient_id, queue_entry_id, systolic_bp, diastolic_bp, status)
                VALUES (1, ?, 200, 130, 'entered-in-error')`).run(queueId);

            const queue = service.getQueue();
            expect(queue[0].has_abnormal_vitals).toBe(false);
            expect(queue[0].vitals_alerts).toHaveLength(0);
        });

        it('flags high criticality as life-threatening even with moderate severity', () => {
            service.saveAllergy({
                patient_id: 1,
                substance: 'Peanuts',
                criticality: 'high',
                severity: 'moderate',
                status: 'active'
            }, 10);

            const safety = service.getPatientSafetyContext(1);
            expect(safety.has_life_threatening_allergies).toBe(true);
        });

        it('refreshes the active regimen when a later prescription changes the dose', () => {
            const q1 = service.addToQueue(1, 1, 20);
            const enc1 = service.beginConsultation(
                { patientId: 1, queueEntryId: Number(q1.lastInsertRowid), startRequestId: 'rx-1' }, 10);
            service.completeConsultation({
                encounterId: enc1.id,
                visit: { diagnosis: 'DM', prescription: [{ medicine: 'Metformin', dosage: '500mg', frequency: '1-0-1' }] }
            }, 10);

            const q2 = service.addToQueue(1, 1, 20);
            const enc2 = service.beginConsultation(
                { patientId: 1, queueEntryId: Number(q2.lastInsertRowid), startRequestId: 'rx-2' }, 10);
            service.completeConsultation({
                encounterId: enc2.id,
                visit: { diagnosis: 'DM review', prescription: [{ medicine: 'Metformin', dosage: '1000mg', frequency: '1-0-1' }] }
            }, 10);

            const meds = service.getMedications(1).filter((m: any) => m.status === 'active');
            expect(meds).toHaveLength(1);
            expect(meds[0].dosage).toBe('1000mg');
        });

        it('rejects unknown urgency tiers at check-in and reassessment', () => {
            expect(() => service.addToQueue(1, { urgency: 'critical' } as any, 20))
                .toThrow('Unknown urgency tier');
            const added = service.addToQueue(1, { urgency: 'routine', priority: 1 }, 20);
            const queueId = Number(added.lastInsertRowid);
            expect(() => service.reassessQueueTriage(queueId, 'emergent', 'Typo tier', 10))
                .toThrow('Unknown urgency tier');
        });

        it('migration v12 repairs legacy emergency mapping and trims clinical mutation grants', async () => {
            const { MIGRATIONS } = await import('../schema/migrations');
            const v12 = MIGRATIONS.find((m: any) => m.version === 12);
            expect(v12).toBeTruthy();

            db.prepare(`INSERT INTO patient_queue (patient_id, priority, urgency, triaged_at)
                VALUES (1, 2, 'priority', NULL)`).run();
            db.prepare(`INSERT OR REPLACE INTO roles (name, permissions) VALUES ('nurse', ?)`)
                .run(JSON.stringify(['getAllergies', 'saveAllergy', 'deleteAllergy', 'getQueue']));
            db.prepare(`INSERT OR REPLACE INTO roles (name, permissions) VALUES ('doctor', ?)`)
                .run(JSON.stringify(['getAllergies', 'saveAllergy', 'deleteAllergy']));

            v12.up(db);

            const row = db.prepare(`SELECT urgency FROM patient_queue WHERE triaged_at IS NULL`).get() as any;
            expect(row.urgency).toBe('urgent');
            const nurse = JSON.parse((db.prepare(`SELECT permissions FROM roles WHERE name = 'nurse'`).get() as any).permissions);
            expect(nurse).not.toContain('saveAllergy');
            expect(nurse).not.toContain('deleteAllergy');
            expect(nurse).toContain('getAllergies');
            expect(nurse).toContain('getQueue');
            const doctor = JSON.parse((db.prepare(`SELECT permissions FROM roles WHERE name = 'doctor'`).get() as any).permissions);
            expect(doctor).toContain('saveAllergy');
        });

        it('numbers Scan & Share tokens daily and expires them', () => {
            const first: any = service.receiveAbhaShare({ name: 'Ramesh', abhaAddress: 'ramesh@sbx' }, 20);
            const second: any = service.receiveAbhaShare({ name: 'Sita', abhaAddress: 'sita@sbx' }, 20);
            expect(second.token_no).toBe(first.token_no + 1);
            expect(first.status).toBe('pending');

            expect(() => service.receiveAbhaShare({ abhaAddress: 'nobody@sbx' }, 20))
                .toThrow('patient name');

            // Backdate the first token past expiry: it sweeps to expired.
            db.prepare(`UPDATE abdm_share_tokens SET expires_at = datetime('now', '-1 minute') WHERE id = ?`)
                .run(first.id);
            const pending = service.getPendingShareTokens() as any[];
            expect(pending.map((t) => t.id)).not.toContain(first.id);
            expect(pending.map((t) => t.id)).toContain(second.id);
            expect(db.prepare(`SELECT status FROM abdm_share_tokens WHERE id = ?`).get(first.id).status)
                .toBe('expired');
        });

        it('accepts a token once and links patients by health ID', () => {
            const token: any = service.receiveAbhaShare({ name: 'Ramesh', abhaAddress: 'ramesh@sbx' }, 20);
            db.prepare(`INSERT INTO patients (uuid, name, mobile, age, gender, abha_address)
                VALUES ('p-abha', 'Ramesh Kumar', '9876543210', 42, 'Male', 'RAMESH@sbx')`).run();

            const found = service.findPatientByAbhaAddress('ramesh@sbx');
            expect(found?.name).toBe('Ramesh Kumar');

            const accepted: any = service.acceptShareToken(token.id, 20);
            expect(accepted.status).toBe('accepted');
            expect(() => service.acceptShareToken(token.id, 20)).toThrow('already handled');
            expect(service.findPatientByAbhaAddress('  ')).toBeNull();
        });

        it('persists health ID links through patient save', () => {
            const created: any = service.savePatient({
                name: 'Sita', mobile: '9876500001', age: 30, gender: 'Female',
                abha_address: 'sita@sbx', abha_name: 'Sita Devi'
            });
            const id = Number(created.lastInsertRowid);
            expect(service.findPatientByAbhaAddress('SITA@sbx')?.id).toBe(id);

            service.savePatient({ id, name: 'Sita Rao' });
            expect(service.findPatientByAbhaAddress('SITA@sbx')?.id).toBe(id);

            service.linkAbhaAddress(id, { abhaAddress: null, abhaName: null }, 10);
            expect(service.findPatientByAbhaAddress('sita@sbx')).toBeNull();
        });

        it('rejects oversized or malformed share payloads', () => {
            expect(() => service.receiveAbhaShare({ name: 'x'.repeat(201) }, 20))
                .toThrow('too long');
            expect(() => service.receiveAbhaShare({ name: 'Ramesh', abhaAddress: 'not-an-id' }, 20))
                .toThrow('looks invalid');
        });
    });
});
