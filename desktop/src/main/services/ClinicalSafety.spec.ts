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

        it('migration v17 reconciles duplicate links keeping the earliest record', async () => {
            const { MIGRATIONS } = await import('../schema/migrations');
            const v17 = MIGRATIONS.find((m: any) => m.version === 17);
            expect(v17).toBeTruthy();

            db.prepare(`DROP INDEX IF EXISTS idx_patients_abha_unique`).run();
            db.prepare(`INSERT INTO patients (uuid, name, abha_address) VALUES ('p-d1', 'Old', 'dup@sbx')`).run();
            db.prepare(`INSERT INTO patients (uuid, name, abha_address) VALUES ('p-d2', 'New', 'DUP@sbx')`).run();
            v17.up(db);

            const rows = db.prepare(`SELECT id, abha_address FROM patients WHERE name IN ('Old', 'New') ORDER BY id`).all() as any[];
            expect(rows[0].abha_address).toBe('dup@sbx');
            expect(rows[1].abha_address).toBeNull();
            expect(() => service.linkAbhaAddress(rows[1].id, { abhaAddress: 'dup@sbx' }, 10))
                .toThrow('already linked');
        });

        it('matches callback secrets in constant time and stays open without one', () => {
            expect(service.callbackSecretMatches(undefined)).toBe(true);

            service.saveSettings({ abdm_callback_secret: 's3cret-shared-token' });
            expect(service.hasCallbackSecret()).toBe(true);
            expect(service.callbackSecretMatches('s3cret-shared-token')).toBe(true);
            expect(service.callbackSecretMatches('wrong')).toBe(false);
            expect(service.callbackSecretMatches(undefined)).toBe(false);
        });

        it('requires the callback password in strict live mode', () => {
            expect(service.callbackSecretMatches(undefined, true)).toBe(false);

            service.saveSettings({ abdm_callback_secret: 's3cret-shared-token' });
            expect(service.callbackSecretMatches('s3cret-shared-token', true)).toBe(true);
            expect(service.callbackSecretMatches('wrong', true)).toBe(false);
        });

        it('preserves per-doctor registry IDs across unrelated edits', async () => {
            await service.saveUser({
                username: 'drhpr', password: 'Password1!', role: 'doctor',
                name: 'Dr. HPR', abdm_hpr_id: 'HPR-DOC-1'
            }, 99);
            const doctors = service.getDoctors() as any[];
            const match = doctors.find((d) => d.username === 'drhpr');
            expect(match?.abdm_hpr_id).toBe('HPR-DOC-1');

            // An edit payload without the field must not wipe the stored ID.
            await service.saveUser({ id: match.id, username: 'drhpr', role: 'doctor', name: 'Dr. HPR Updated' }, 99);
            const reloaded = (service.getDoctors() as any[]).find((d) => d.username === 'drhpr');
            expect(reloaded?.abdm_hpr_id).toBe('HPR-DOC-1');
            expect(reloaded?.name).toBe('Dr. HPR Updated');
        });

        it('checks in a token atomically: claim, match-or-create, and queue together', () => {
            db.prepare(`INSERT INTO patients (uuid, name, mobile, age, gender, abha_address)
                VALUES ('p-atomic', 'Ramesh Kumar', '9876543210', 42, 'Male', 'ramesh@sbx')`).run();
            const token: any = service.receiveAbhaShare({ name: 'Ramesh', abhaAddress: 'ramesh@sbx' }, 20);

            const result: any = service.acceptShareTokenAndCheckIn(token.id, 20);

            expect(result.outcome).toBe('checked-in');
            expect(db.prepare(`SELECT status FROM abdm_share_tokens WHERE id = ?`).get(token.id).status)
                .toBe('accepted');
            expect(db.prepare(`SELECT status FROM patient_queue WHERE patient_id =
                (SELECT id FROM patients WHERE abha_address = 'ramesh@sbx')`).get().status)
                .toBe('waiting');
        });

        it('leaves the token pending when demographics are incomplete', () => {
            const token: any = service.receiveAbhaShare({ name: 'NoMobile' }, 20);

            const result: any = service.acceptShareTokenAndCheckIn(token.id, 20);

            expect(result.outcome).toBe('incomplete');
            expect(result.patientId).toBeGreaterThan(0);
            expect(db.prepare(`SELECT status FROM abdm_share_tokens WHERE id = ?`).get(token.id).status)
                .toBe('pending');
            expect(db.prepare(`SELECT count(*) AS n FROM patient_queue WHERE patient_id = ?`)
                .get(result.patientId).n).toBe(0);
        });

        it('rejects a second accept without duplicating patients or queue rows', () => {
            const token: any = service.receiveAbhaShare(
                { name: 'Sita', mobile: '9876500001', age: 30, gender: 'Female' }, 20);
            const first: any = service.acceptShareTokenAndCheckIn(token.id, 20);
            expect(first.outcome).toBe('checked-in');

            expect(() => service.acceptShareTokenAndCheckIn(token.id, 20)).toThrow('already handled');
            expect(db.prepare(`SELECT count(*) AS n FROM patients WHERE name = 'Sita'`).get().n).toBe(1);
            expect(db.prepare(`SELECT count(*) AS n FROM patient_queue WHERE patient_id = ?`)
                .get(first.patientId).n).toBe(1);
        });

        it('assigns yearly care context references to encounters', () => {
            const year = new Date().getFullYear();
            const q1 = queuePatient(1);
            const enc1 = service.beginConsultation(
                { patientId: 1, queueEntryId: Number(q1.lastInsertRowid), startRequestId: 'cc-1' }, 10);
            expect(enc1.care_context_ref).toBe(`OP-${year}-0001`);

            service.completeConsultation({ encounterId: enc1.id, visit: { diagnosis: 'Done' } }, 10);
            const q2 = queuePatient(2);
            const enc2 = service.beginConsultation(
                { patientId: 2, queueEntryId: Number(q2.lastInsertRowid), startRequestId: 'cc-2' }, 10);
            expect(enc2.care_context_ref).toBe(`OP-${year}-0002`);
        });

        it('never reuses a care context reference after encounter deletion', () => {
            const year = new Date().getFullYear();
            const q1 = queuePatient(1);
            const enc1 = service.beginConsultation(
                { patientId: 1, queueEntryId: Number(q1.lastInsertRowid), startRequestId: 'cc-del-1' }, 10);
            expect(enc1.care_context_ref).toBe(`OP-${year}-0001`);

            service.completeConsultation({ encounterId: enc1.id, visit: { diagnosis: 'Done' } }, 10);
            service.deleteVisit(enc1.id);

            const q2 = queuePatient(2);
            const enc2 = service.beginConsultation(
                { patientId: 2, queueEntryId: Number(q2.lastInsertRowid), startRequestId: 'cc-del-2' }, 10);
            expect(enc2.care_context_ref).toBe(`OP-${year}-0002`);
        });

        it('queues gateway callbacks and acknowledges them once', async () => {
            const row: any = service.receiveInboxCallback('consent-request', { requestId: 'r-1' }, 20);
            expect(row.status).toBe('pending');

            expect(() => service.receiveInboxCallback('  ', {}, 20)).toThrow('kind is required');
            expect(() => service.receiveInboxCallback('x', 'y'.repeat(9000), 20)).toThrow('too large');

            const pending = service.getPendingInbox() as any[];
            expect(pending.map((r) => r.id)).toContain(row.id);

            const acked: any = service.ackInbox(row.id, 20);
            expect(acked.status).toBe('handled');
            expect(() => service.ackInbox(row.id, 20)).toThrow('already handled');
            expect((service.getPendingInbox() as any[]).map((r) => r.id)).not.toContain(row.id);
        });

        it('dedupes retried callbacks by request id', () => {
            const first: any = service.receiveInboxCallback('consent-granted', { requestId: 'dup-1' }, 20);
            const second: any = service.receiveInboxCallback('consent-granted', { requestId: 'dup-1' }, 20);
            expect(second.id).toBe(first.id);
            // Different kinds are independent deliveries.
            const other: any = service.receiveInboxCallback('data-ready', { requestId: 'dup-1' }, 20);
            expect(other.id).not.toBe(first.id);
        });

        it('tracks HIU consent requests through grant to cached records', async () => {
            expect(() => service.createConsentRequest({
                abhaAddress: '', hiTypes: ['Prescription']
            }, 10)).toThrow('Health ID is required');
            expect(() => service.createConsentRequest({
                abhaAddress: 'asha@sbx', hiTypes: []
            }, 10)).toThrow('health information type');

            const row: any = service.createConsentRequest({
                patientId: 1, abhaAddress: 'asha@sbx',
                hiTypes: ['DiagnosticReport', 'Prescription'],
                dateFrom: '2026-01-01', gatewayRequestId: 'gw-1'
            }, 10);
            expect(row.status).toBe('requested');
            expect(JSON.parse(row.hi_types)).toEqual(['DiagnosticReport', 'Prescription']);

            expect(() => service.updateConsentStatus(row.id, 'maybe', null, 10)).toThrow('Unknown consent status');
            const granted: any = service.updateConsentStatus(row.id, 'granted', 'handle-9', 10);
            expect(granted.status).toBe('granted');
            expect(granted.consent_handle).toBe('handle-9');
            expect(service.getConsentByRequestId('gw-1').id).toBe(row.id);
            expect(service.getConsents(1).map((r: any) => r.id)).toContain(row.id);

            expect(() => service.storeFetchedRecord({ bundleJson: '' }, 10)).toThrow('bundle is required');
            expect(() => service.storeFetchedRecord({ bundleJson: 'not-json' }, 10)).toThrow();
            const cached: any = service.storeFetchedRecord({
                consentId: row.id, patientId: 1,
                bundleJson: JSON.stringify({ resourceType: 'Bundle' }),
                expiresAt: '2099-01-01 00:00:00'
            }, 10);
            expect(cached.status).toBe('cached');
            expect(service.getFetchedRecords(1).map((r: any) => r.id)).toContain(cached.id);

            const stale: any = service.storeFetchedRecord({
                consentId: row.id, patientId: 1,
                bundleJson: JSON.stringify({ resourceType: 'Bundle', marker: 'stale' }),
                expiresAt: '2000-01-01 00:00:00'
            }, 10);
            expect(service.getFetchedRecords(1).map((r: any) => r.id)).not.toContain(stale.id);
            expect(service.getFetchedRecords(1, true).map((r: any) => r.id)).toContain(stale.id);
            service.expireFetchedRecords();
            expect(db.prepare('SELECT status, bundle_json FROM abdm_fetched_records WHERE id = ?')
                .get(stale.id)).toMatchObject({ status: 'expired', bundle_json: '{"expired":true}' });
        });

        it('wipes the external-records cache on explicit request', () => {
            const cached: any = service.storeFetchedRecord({
                consentId: null, patientId: 2,
                bundleJson: JSON.stringify({ resourceType: 'Bundle' }),
                expiresAt: '2099-01-01 00:00:00'
            }, 10);
            expect(service.getFetchedRecords(2, true)).toHaveLength(1);
            service.clearFetchedRecords(2, 10);
            expect(service.getFetchedRecords(2, true)).toHaveLength(0);
        });

        it('imports outside medications through the allergy gate', () => {
            service.saveAllergy({
                patient_id: 2, substance: 'Penicillin',
                criticality: 'high', severity: 'severe', reaction: 'Anaphylaxis'
            }, 10);
            expect(() => service.importExternalMedication(2, {
                medicine_name: 'Penicillin-V', dosage: '250mg', frequency: '1-1-1'
            }, null, 10)).toThrow('conflicting with active allergy');
            expect(() => service.importExternalMedication(0, {
                medicine_name: 'Amlodipine'
            }, null, 10)).toThrow('patient_id is required');
            expect(() => service.importExternalMedication(2, {
                medicine_name: ''
            }, null, 10)).toThrow('medicine_name is required');

            const imported: any = service.importExternalMedication(2, {
                medicine_name: 'Penicillin-V', dosage: '250mg', frequency: '1-1-1'
            }, 'Clinician override after review', 10);
            expect(imported.medicine_name).toBe('Penicillin-V');
            expect(imported.notes).toContain('override');
            expect(service.getMedications(2).filter((m: any) => m.status === 'active')).toHaveLength(1);

            // Re-importing the same active medicine returns it without duplicating.
            const again: any = service.importExternalMedication(2, {
                medicine_name: 'penicillin-v'
            }, 'override', 10);
            expect(again.id).toBe(imported.id);
            expect(service.getMedications(2).filter((m: any) => m.status === 'active')).toHaveLength(1);

            const clean: any = service.importExternalMedication(2, {
                medicine_name: 'Amlodipine', dosage: '5mg', frequency: '1-0-0'
            }, null, 10);
            expect(clean.medicine_name).toBe('Amlodipine');
        });

        it('writes both HIU keypair halves atomically', () => {
            service.saveHiuKeypair('PUBKEY', 'WRAPPED');
            const settings: any = service.getSettings();
            expect(settings.abdm_hiu_public_key).toBe('PUBKEY');
            expect(service.getHiuPrivateProtected()).toBe('WRAPPED');
        });

        it('keeps consent transitions monotonic', () => {
            const row: any = service.createConsentRequest({
                abhaAddress: 'mono@sbx', hiTypes: ['Prescription'], gatewayRequestId: 'mono-1'
            }, 10);
            service.updateConsentStatus(row.id, 'denied', null, 10);
            expect(() => service.updateConsentStatus(row.id, 'granted', null, 10))
                .toThrow('a new request is required');
            // Same-state re-application (gateway retries) stays idempotent.
            expect(service.updateConsentStatus(row.id, 'denied', null, 10).status).toBe('denied');

            const row2: any = service.createConsentRequest({
                abhaAddress: 'mono2@sbx', hiTypes: ['Prescription'], gatewayRequestId: 'mono-2'
            }, 10);
            service.updateConsentStatus(row2.id, 'granted', null, 10);
            service.updateConsentStatus(row2.id, 'expired', null, 10);
            expect(() => service.updateConsentStatus(row2.id, 'granted', null, 10))
                .toThrow('a new request is required');
        });

        it('rejects consent requests mismatched to the patient link', () => {
            db.prepare("UPDATE patients SET abha_address = 'linked@sbx' WHERE id = 1").run();
            expect(() => service.createConsentRequest({
                patientId: 1, abhaAddress: 'other@sbx', hiTypes: ['Prescription']
            }, 10)).toThrow('does not belong to this patient');
            expect(() => service.createConsentRequest({
                patientId: 999, abhaAddress: 'other@sbx', hiTypes: ['Prescription']
            }, 10)).toThrow('Patient not found');
            const ok: any = service.createConsentRequest({
                patientId: 1, abhaAddress: 'linked@sbx', hiTypes: ['Prescription']
            }, 10);
            expect(ok.patient_id).toBe(1);
            const unlinked: any = service.createConsentRequest({
                patientId: 2, abhaAddress: 'fresh@sbx', hiTypes: ['Prescription']
            }, 10);
            expect(unlinked.patient_id).toBe(2);
        });

        it('stores push batches atomically and idempotently', () => {
            const consent: any = service.createConsentRequest({
                patientId: 1, abhaAddress: 'batch@sbx', hiTypes: ['Prescription']
            }, 10);
            const batch = [
                { consentId: consent.id, patientId: 1, bundleJson: JSON.stringify({ n: 1 }), expiresAt: null },
                { consentId: consent.id, patientId: 1, bundleJson: JSON.stringify({ n: 2 }), expiresAt: null }
            ];
            const first = service.storeFetchedRecordBatch(batch, 10);
            expect(first).toHaveLength(2);
            // Retry lands idempotently: same rows, no duplicates.
            const retry = service.storeFetchedRecordBatch(batch, 10);
            expect(retry.map((r: any) => r.id).sort()).toEqual(first.map((r: any) => r.id).sort());
            expect(service.getFetchedRecords(1, true)).toHaveLength(2);
            // A bad bundle aborts the whole batch: nothing is stored.
            expect(() => service.storeFetchedRecordBatch([
                { consentId: consent.id, patientId: 1, bundleJson: JSON.stringify({ n: 3 }), expiresAt: null },
                { consentId: consent.id, patientId: 1, bundleJson: 'not-json', expiresAt: null }
            ], 10)).toThrow();
            expect(service.getFetchedRecords(1, true)).toHaveLength(2);
        });
    });
});
