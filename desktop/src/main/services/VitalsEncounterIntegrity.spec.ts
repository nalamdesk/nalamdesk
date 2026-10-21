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

describe('Vitals observation and encounter integrity', () => {
    let db: any;
    let service: DatabaseService;

    beforeEach(async () => {
        db = new TestDatabase();
        db.exec('PRAGMA foreign_keys = ON');
        service = new DatabaseService();
        service.setDb(db);
        await service.migrate();
        db.prepare("INSERT INTO users (id, username, role, name, active) VALUES (10, 'doctor', 'doctor', 'Dr House', 1)").run();
        db.prepare("INSERT INTO users (id, username, role, name, active) VALUES (20, 'nurse', 'nurse', 'Nurse Jackie', 1)").run();
        db.prepare("INSERT INTO patients (id, uuid, name) VALUES (1, 'p-1', 'Alice Johnson'), (2, 'p-2', 'Bob Smith')").run();
    });

    afterEach(() => db.close());

    function queuePatient(patientId = 1, priority = 1): number {
        const res = db.prepare('INSERT INTO patient_queue (patient_id, priority, status) VALUES (?, ?, ?)')
            .run(patientId, priority, 'waiting');
        return Number(res.lastInsertRowid);
    }

    describe('Validation', () => {
        it('rejects an all-empty submission', () => {
            expect(() => {
                service.saveVitals({
                    patient_id: 1,
                    systolic_bp: null,
                    diastolic_bp: null,
                    pulse: null,
                    temperature: null
                }, 20);
            }).toThrow('At least one vital sign measurement is required');
        });

        it('rejects incomplete blood pressure pairs', () => {
            expect(() => {
                service.saveVitals({
                    patient_id: 1,
                    systolic_bp: 120,
                    diastolic_bp: null
                }, 20);
            }).toThrow('Both systolic and diastolic blood pressure must be provided together');

            expect(() => {
                service.saveVitals({
                    patient_id: 1,
                    systolic_bp: null,
                    diastolic_bp: 80
                }, 20);
            }).toThrow('Both systolic and diastolic blood pressure must be provided together');
        });

        it('rejects systolic BP less than or equal to diastolic BP', () => {
            expect(() => {
                service.saveVitals({
                    patient_id: 1,
                    systolic_bp: 80,
                    diastolic_bp: 120
                }, 20);
            }).toThrow('Systolic blood pressure must be greater than diastolic blood pressure');

            expect(() => {
                service.saveVitals({
                    patient_id: 1,
                    systolic_bp: 100,
                    diastolic_bp: 100
                }, 20);
            }).toThrow('Systolic blood pressure must be greater than diastolic blood pressure');
        });

        it('rejects physiological values outside realistic bounds', () => {
            expect(() => {
                service.saveVitals({
                    patient_id: 1,
                    pulse: 300 // max 250
                }, 20);
            }).toThrow('Pulse must be between 30 and 250 bpm');

            expect(() => {
                service.saveVitals({
                    patient_id: 1,
                    temperature: 40.0 // min 50.0 °F
                }, 20);
            }).toThrow('Temperature (°F) must be between 50 and 115 °F');

            expect(() => {
                service.saveVitals({
                    patient_id: 1,
                    systolic_bp: 320, // max 300
                    diastolic_bp: 80
                }, 20);
            }).toThrow('Systolic BP must be between 50 and 300 mmHg');

            expect(() => {
                service.saveVitals({
                    patient_id: 1,
                    spo2: 105 // max 100
                }, 20);
            }).toThrow('Oxygen Saturation (SpO2) must be between 50 and 100 %');
        });

        it('accepts partial valid sets', () => {
            // Pulse only
            const pulseOnly = service.saveVitals({
                patient_id: 1,
                pulse: 76
            }, 20);
            expect(pulseOnly.id).toBeTruthy();
            expect(pulseOnly.pulse).toBe(76);
            expect(pulseOnly.systolic_bp).toBeNull();

            // Height and weight only
            const hwOnly = service.saveVitals({
                patient_id: 1,
                height: 175,
                weight: 70
            }, 20);
            expect(hwOnly.id).toBeTruthy();
            expect(hwOnly.height).toBe(175);
            expect(hwOnly.weight).toBe(70);

            // Valid BP pair only
            const bpOnly = service.saveVitals({
                patient_id: 1,
                systolic_bp: 120,
                diastolic_bp: 80
            }, 20);
            expect(bpOnly.id).toBeTruthy();
            expect(bpOnly.systolic_bp).toBe(120);
            expect(bpOnly.diastolic_bp).toBe(80);
        });
    });

    describe('Encounter Linkage', () => {
        it('associates queue-side pre-consultation vitals with encounter on beginConsultation', () => {
            const queueEntryId = queuePatient(1);

            // Nurse records vitals while patient is waiting in queue
            const preVitals = service.saveVitals({
                patient_id: 1,
                queue_entry_id: queueEntryId,
                systolic_bp: 124,
                diastolic_bp: 82,
                pulse: 74,
                temperature: 98.6
            }, 20);

            expect(preVitals.queue_entry_id).toBe(queueEntryId);
            expect(preVitals.visit_id).toBeNull();
            expect(preVitals.status).toBe('final');

            // Doctor starts consultation for this queue entry
            const encounter = service.beginConsultation({
                patientId: 1,
                queueEntryId,
                startRequestId: 'req-vitals-1'
            }, 10);

            // Verify pre-consultation vitals were automatically linked to new encounter
            const updatedVital = db.prepare('SELECT * FROM vitals WHERE id = ?').get(preVitals.id);
            expect(updatedVital.visit_id).toBe(encounter.id);
            expect(updatedVital.queue_entry_id).toBe(queueEntryId);

            // Encounter vitals query returns the linked observation
            const encounterVitals = service.getEncounterVitals(encounter.id);
            expect(encounterVitals.id).toBe(preVitals.id);
            expect(encounterVitals.systolic_bp).toBe(124);
            expect(encounterVitals.diastolic_bp).toBe(82);
        });

        it('links vitals recorded directly during an active consultation', () => {
            const queueEntryId = queuePatient(1);
            const encounter = service.beginConsultation({
                patientId: 1,
                queueEntryId,
                startRequestId: 'req-vitals-2'
            }, 10);

            // Doctor records vitals in the visit chart
            const inVisitVitals = service.saveVitals({
                patient_id: 1,
                visit_id: encounter.id,
                systolic_bp: 118,
                diastolic_bp: 78,
                pulse: 68
            }, 10);

            expect(inVisitVitals.visit_id).toBe(encounter.id);
            expect(inVisitVitals.performer_id).toBe(10);

            const fetched = service.getEncounterVitals(encounter.id);
            expect(fetched.id).toBe(inVisitVitals.id);
            expect(fetched.systolic_bp).toBe(118);
        });
    });

    describe('Non-destructive Amendment & Correction', () => {
        it('preserves the original observation and inserts an amended observation referencing replaces_id', () => {
            const queueEntryId = queuePatient(1);
            const encounter = service.beginConsultation({
                patientId: 1,
                queueEntryId,
                startRequestId: 'req-vitals-3'
            }, 10);

            // Initial vital
            const original = service.saveVitals({
                patient_id: 1,
                visit_id: encounter.id,
                systolic_bp: 130,
                diastolic_bp: 90,
                pulse: 88
            }, 20);

            // Doctor corrects the pulse measurement
            const amended = service.saveVitals({
                id: original.id,
                patient_id: 1,
                visit_id: encounter.id,
                systolic_bp: 130,
                diastolic_bp: 90,
                pulse: 76,
                amendment_reason: 'Re-measured resting pulse after 10 minutes'
            }, 10);

            expect(amended.id).not.toBe(original.id);
            expect(amended.replaces_id).toBe(original.id);
            expect(amended.status).toBe('amended');
            expect(amended.pulse).toBe(76);
            expect(amended.amendment_reason).toBe('Re-measured resting pulse after 10 minutes');
            expect(amended.performer_id).toBe(10);

            // Original record is preserved in DB with status = amended
            const originalInDb = db.prepare('SELECT * FROM vitals WHERE id = ?').get(original.id);
            expect(originalInDb.status).toBe('amended');
            expect(originalInDb.pulse).toBe(88);

            // Encounter vitals query returns the active amended version
            const activeVitals = service.getEncounterVitals(encounter.id);
            expect(activeVitals.id).toBe(amended.id);
            expect(activeVitals.pulse).toBe(76);

            // History returns both versions in chronological sequence
            const history = service.getVitalsHistory(1, encounter.id);
            expect(history).toHaveLength(2);
            expect(history[0].id).toBe(amended.id);
            expect(history[1].id).toBe(original.id);
        });
    });

    describe('Duplicate Submission Prevention', () => {
        it('returns existing observation when submitted with identical client_request_id', () => {
            const queueEntryId = queuePatient(1);
            const clientRequestId = 'req-uuid-abc-123';

            const first = service.saveVitals({
                patient_id: 1,
                queue_entry_id: queueEntryId,
                systolic_bp: 120,
                diastolic_bp: 80,
                pulse: 72,
                client_request_id: clientRequestId
            }, 20);

            const second = service.saveVitals({
                patient_id: 1,
                queue_entry_id: queueEntryId,
                systolic_bp: 120,
                diastolic_bp: 80,
                pulse: 72,
                client_request_id: clientRequestId
            }, 20);

            expect(second.id).toBe(first.id);
            const count = db.prepare('SELECT count(*) count FROM vitals').get().count;
            expect(count).toBe(1);
        });
    });

    describe('Visit Retrieval without Row Duplication', () => {
        it('joins latest vitals on getVisits and does not duplicate visits when vitals are amended', () => {
            const queueEntryId = queuePatient(1);
            const encounter = service.beginConsultation({
                patientId: 1,
                queueEntryId,
                startRequestId: 'req-vitals-retrieve'
            }, 10);

            // Save initial vital
            const v1 = service.saveVitals({
                patient_id: 1,
                visit_id: encounter.id,
                systolic_bp: 125,
                diastolic_bp: 85,
                pulse: 80
            }, 20);

            // Amend vital
            service.saveVitals({
                replaces_id: v1.id,
                patient_id: 1,
                visit_id: encounter.id,
                systolic_bp: 120,
                diastolic_bp: 80,
                pulse: 72,
                amendment_reason: 'Calibrated cuff re-check'
            }, 10);

            // Complete consultation
            service.completeConsultation({
                encounterId: encounter.id,
                visit: {
                    diagnosis: 'Hypertension monitoring',
                    symptoms: 'Asymptomatic',
                    prescription: [{ medicine: 'Amlodipine', form: 'Tab', route: 'Oral', dosage: '5mg', frequency: '1-0-0', duration: 'until review' }],
                    amount_paid: 200
                }
            }, 10);

            const patientVisits = service.getVisits(1);
            expect(patientVisits).toHaveLength(1);
            expect(patientVisits[0].id).toBe(encounter.id);
            expect(patientVisits[0].vitals).toBeTruthy();
            expect(patientVisits[0].vitals.systolic_bp).toBe(120);
            expect(patientVisits[0].vitals.diastolic_bp).toBe(80);
            expect(patientVisits[0].vitals.pulse).toBe(72);
            expect(patientVisits[0].vitals.status).toBe('amended');
        });

        it('prevents cross-patient vital amendments and encounter linkages', () => {
            // Patient 1 has vital
            const v1 = service.saveVitals({
                patient_id: 1,
                systolic_bp: 120,
                diastolic_bp: 80
            }, 20);

            // Attempting to amend Patient 1's vital under Patient 2's context must throw
            expect(() => {
                service.saveVitals({
                    replaces_id: v1.id,
                    patient_id: 2,
                    systolic_bp: 130,
                    diastolic_bp: 85
                }, 20);
            }).toThrow('Cross-patient violation');
        });
    });
});
