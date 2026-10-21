import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseService } from './DatabaseService';
import { MIGRATIONS } from '../schema/migrations';

const LATEST_SCHEMA_VERSION = Math.max(...MIGRATIONS.map((m: any) => m.version));

const { DatabaseSync } = require('node:sqlite');

/** Minimal better-sqlite3-compatible adapter backed by Node's real SQLite engine. */
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

describe('encounter integrity transactions', () => {
    let db: any;
    let service: DatabaseService;

    beforeEach(async () => {
        db = new TestDatabase();
        db.exec('PRAGMA foreign_keys = ON');
        service = new DatabaseService();
        service.setDb(db);
        await service.migrate();
        db.prepare("INSERT INTO users (id, username, role, name, active) VALUES (10, 'doctor', 'doctor', 'Dr Test', 1)").run();
        db.prepare("INSERT INTO users (id, username, role, name, active) VALUES (11, 'doctor-2', 'doctor', 'Dr Other', 1)").run();
        db.prepare("INSERT INTO users (id, username, role, name, active) VALUES (99, 'admin', 'admin', 'Administrator', 1)").run();
        db.prepare("INSERT INTO patients (id, uuid, name) VALUES (1, 'p-1', 'Patient One'), (2, 'p-2', 'Patient Two'), (3, 'p-3', 'Patient Three')").run();
    });

    afterEach(() => db.close());

    function queue(patientId = 1, priority = 1) {
        return Number(db.prepare('INSERT INTO patient_queue (patient_id, priority) VALUES (?, ?)').run(patientId, priority).lastInsertRowid);
    }

    it('returns one durable encounter when begin is retried', () => {
        const queueEntryId = queue();
        const input = { patientId: 1, queueEntryId, startRequestId: 'start-1' };

        const first = service.beginConsultation(input, 10);
        const retry = service.beginConsultation(input, 10);

        expect(retry.id).toBe(first.id);
        expect(db.prepare('SELECT count(*) count FROM visits').get().count).toBe(1);
        expect(db.prepare('SELECT status FROM patient_queue WHERE id = ?').get(queueEntryId).status).toBe('in-consult');
        expect(first.queue_entry_id).toBe(queueEntryId);
        expect(first.status).toBe('in-progress');
    });

    it('updates progress and completes exactly once across retries', () => {
        const queueEntryId = queue();
        const encounter = service.beginConsultation({ patientId: 1, queueEntryId, startRequestId: 'start-2' }, 10);
        const visit = { diagnosis: 'Influenza', symptoms: 'Fever', prescription: [{ medicine: 'Test', form: 'Tab', route: 'Oral', dosage: '1 tab', frequency: '1-0-1', duration: '3 days' }], amount_paid: 100 };

        service.saveConsultationProgress({ encounterId: encounter.id, visit }, 10);
        service.saveConsultationProgress({ encounterId: encounter.id, visit: { ...visit, symptoms: 'Fever and cough' } }, 10);
        const completed = service.completeConsultation({ encounterId: encounter.id, visit }, 10);
        const retry = service.completeConsultation({ encounterId: encounter.id, visit }, 10);

        expect(retry.id).toBe(completed.id);
        expect(retry.status).toBe('finished');
        expect(db.prepare('SELECT count(*) count FROM visits').get().count).toBe(1);
        expect(db.prepare('SELECT status FROM patient_queue WHERE id = ?').get(queueEntryId).status).toBe('completed');
    });

    it('preserves saved clinical data when progress omits a payload and rejects empty completion', () => {
        const queueEntryId = queue();
        const encounter = service.beginConsultation({ patientId: 1, queueEntryId, startRequestId: 'payload-guard' }, 10);
        service.saveConsultationProgress({ encounterId: encounter.id, visit: { diagnosis: 'Keep me', symptoms: 'Stable' } }, 10);

        service.saveConsultationProgress({ encounterId: encounter.id }, 10);
        expect(() => service.completeConsultation({ encounterId: encounter.id }, 10)).toThrow('visit is required');

        expect(db.prepare('SELECT diagnosis, symptoms, status FROM visits WHERE id = ?').get(encounter.id))
            .toMatchObject({ diagnosis: 'Keep me', symptoms: 'Stable', status: 'in-progress' });
        expect(db.prepare('SELECT status FROM patient_queue WHERE id = ?').get(queueEntryId).status).toBe('in-consult');
    });

    it('rolls back clinical completion when the exact queue entry cannot complete', () => {
        const queueEntryId = queue();
        const encounter = service.beginConsultation({ patientId: 1, queueEntryId, startRequestId: 'start-3' }, 10);
        db.prepare("UPDATE patient_queue SET status = 'waiting' WHERE id = ?").run(queueEntryId);

        expect(() => service.completeConsultation({ encounterId: encounter.id, visit: { diagnosis: 'Must not persist' } }, 10))
            .toThrow('Queue entry is not in consultation');

        const stored = db.prepare('SELECT status, diagnosis FROM visits WHERE id = ?').get(encounter.id);
        expect(stored).toMatchObject({ status: 'in-progress', diagnosis: '' });
    });

    it('postpones and resumes the same encounter without inserting another visit', () => {
        const queueEntryId = queue();
        const encounter = service.beginConsultation({ patientId: 1, queueEntryId, startRequestId: 'start-4' }, 10);
        service.postponeConsultation({ encounterId: encounter.id, visit: { diagnosis: 'Draft' } }, 10);

        expect(() => service.beginConsultation({ patientId: 1, queueEntryId, startRequestId: 'start-4' }, 10))
            .toThrow('stale');

        const resumed = service.resumeConsultation({ encounterId: encounter.id }, 10);

        expect(resumed.id).toBe(encounter.id);
        expect(resumed.diagnosis).toBe('Draft');
        expect(db.prepare('SELECT count(*) count FROM visits').get().count).toBe(1);
        expect(db.prepare('SELECT status FROM patient_queue WHERE id = ?').get(queueEntryId).status).toBe('in-consult');
    });

    it('rolls back the queue claim when encounter insertion fails after the update', () => {
        const queueEntryId = queue();
        db.exec(`
            CREATE TRIGGER fail_encounter_insert BEFORE INSERT ON visits
            WHEN NEW.start_request_id = 'fail-after-claim'
            BEGIN SELECT RAISE(ABORT, 'injected insert failure'); END;
        `);

        expect(() => service.beginConsultation({
            patientId: 1, queueEntryId, startRequestId: 'fail-after-claim'
        }, 10)).toThrow('injected insert failure');

        expect(db.prepare('SELECT status FROM patient_queue WHERE id = ?').get(queueEntryId).status).toBe('waiting');
        expect(db.prepare('SELECT count(*) count FROM visits').get().count).toBe(0);
        expect(db.prepare('SELECT count(*) count FROM encounter_requests').get().count).toBe(0);
    });

    it('atomically chooses the highest-priority oldest waiting patient', () => {
        queue(1, 1);
        const emergencyQueueId = queue(2, 2);

        const encounter = service.beginNextConsultation({ startRequestId: 'next-1' }, 10);
        const retry = service.beginNextConsultation({ startRequestId: 'next-1' }, 10);

        expect(encounter.patient_id).toBe(2);
        expect(encounter.queue_entry_id).toBe(emergencyQueueId);
        expect(retry.id).toBe(encounter.id);
        expect(db.prepare("SELECT count(*) count FROM patient_queue WHERE status = 'in-consult'").get().count).toBe(1);
    });

    it('enforces exact patient/queue linkage and prevents removal during consultation', () => {
        const queueEntryId = queue(1);
        const encounter = service.beginConsultation({ patientId: 1, queueEntryId, startRequestId: 'start-5' }, 10);

        expect(() => db.prepare(`
            INSERT INTO visits (patient_id, doctor_id, status, queue_entry_id, start_request_id)
            VALUES (2, 10, 'in-progress', ?, 'invalid-link')
        `).run(queueEntryId)).toThrow('Encounter queue entry does not match patient');
        expect(() => service.removeFromQueue(queueEntryId, 10))
            .toThrow('Cannot remove a queue entry with an active encounter');
        expect(service.getActiveConsultation(1, 10).id).toBe(encounter.id);
        expect(() => service.getActiveConsultation(1, 11)).toThrow('responsible practitioner');
    });

    it('rejects idempotency keys reused by a different actor, patient, queue, or operation', () => {
        const queueEntryId = queue(1);
        const otherQueueId = queue(2);
        service.beginConsultation({ patientId: 1, queueEntryId, startRequestId: 'bound-key' }, 10);

        expect(() => service.beginConsultation({ patientId: 1, queueEntryId, startRequestId: 'bound-key' }, 11))
            .toThrow('another operation or actor');
        expect(() => service.beginConsultation({ patientId: 2, queueEntryId: otherQueueId, startRequestId: 'bound-key' }, 10))
            .toThrow('another patient');
        expect(() => service.beginConsultation({ patientId: 1, queueEntryId: otherQueueId, startRequestId: 'bound-key' }, 10))
            .toThrow('another queue entry');
        expect(() => service.beginNextConsultation({ startRequestId: 'bound-key' }, 10))
            .toThrow('another operation or actor');
    });

    it('rejects stale begin and begin-next request keys after completion', () => {
        const firstQueueId = queue(1);
        const first = service.beginConsultation({ patientId: 1, queueEntryId: firstQueueId, startRequestId: 'stale-begin' }, 10);
        service.completeConsultation({ encounterId: first.id, visit: { diagnosis: 'Done' } }, 10);
        expect(() => service.beginConsultation({ patientId: 1, queueEntryId: firstQueueId, startRequestId: 'stale-begin' }, 10))
            .toThrow('stale');

        const nextQueueId = queue(2, 2);
        const next = service.beginNextConsultation({ startRequestId: 'stale-next' }, 10);
        service.completeConsultation({ encounterId: next.id, visit: { diagnosis: 'Done' } }, 10);
        expect(() => service.beginNextConsultation({ startRequestId: 'stale-next' }, 10)).toThrow('stale');
        expect(db.prepare('SELECT status FROM patient_queue WHERE id = ?').get(nextQueueId).status).toBe('completed');
    });

    it('excludes in-progress drafts from history, visit lists, and dashboard totals', () => {
        const finishedQueueId = queue(1);
        const finished = service.beginConsultation({ patientId: 1, queueEntryId: finishedQueueId, startRequestId: 'finished-one' }, 10);
        service.completeConsultation({ encounterId: finished.id, visit: { diagnosis: 'Finished' } }, 10);
        const draftQueueId = queue(2);
        service.beginConsultation({ patientId: 2, queueEntryId: draftQueueId, startRequestId: 'draft-one' }, 10);

        expect(service.getVisits(1).map((visit: any) => visit.diagnosis)).toEqual(['Finished']);
        expect(service.getVisits(2)).toEqual([]);
        expect(service.getAllVisits().map((visit: any) => visit.diagnosis)).toEqual(['Finished']);
        expect(service.getDashboardStats().todayVisits).toBe(1);
    });

    it('cascades idempotency bindings when completed history is deleted', () => {
        const queueEntryId = queue(1);
        const encounter = service.beginConsultation({ patientId: 1, queueEntryId, startRequestId: 'delete-finished' }, 10);
        service.completeConsultation({ encounterId: encounter.id, visit: { diagnosis: 'Finished' } }, 10);

        service.deleteVisit(encounter.id);

        expect(db.prepare('SELECT count(*) count FROM visits WHERE id = ?').get(encounter.id).count).toBe(0);
        expect(db.prepare("SELECT count(*) count FROM encounter_requests WHERE request_id = 'delete-finished'").get().count).toBe(0);
    });

    it('edits finished clinical history without changing its responsible practitioner', () => {
        const queueEntryId = queue(1);
        const encounter = service.beginConsultation({ patientId: 1, queueEntryId, startRequestId: 'finished-edit' }, 10);
        service.completeConsultation({ encounterId: encounter.id, visit: { diagnosis: 'Original' } }, 10);

        service.saveVisit({
            id: encounter.id,
            diagnosis: 'Corrected', prescription: [], amount_paid: 0,
            symptoms: '', examination_notes: '', diagnosis_type: 'Final'
        });

        const stored = db.prepare('SELECT doctor_id, diagnosis FROM visits WHERE id = ?').get(encounter.id);
        expect(stored).toMatchObject({ doctor_id: 10, diagnosis: 'Corrected' });
    });

    it('rejects mutation and retry attempts by a different doctor or admin actor', () => {
        const queueEntryId = queue(1);
        const encounter = service.beginConsultation({ patientId: 1, queueEntryId, startRequestId: 'owned-encounter' }, 10);

        for (const actorId of [11, 99]) {
            expect(() => service.resumeConsultation({ encounterId: encounter.id }, actorId)).toThrow('responsible practitioner');
            expect(() => service.saveConsultationProgress({ encounterId: encounter.id, visit: { diagnosis: 'Wrong actor' } }, actorId))
                .toThrow('responsible practitioner');
            expect(() => service.completeConsultation({ encounterId: encounter.id, visit: { diagnosis: 'Wrong actor' } }, actorId))
                .toThrow('responsible practitioner');
            expect(() => service.postponeConsultation({ encounterId: encounter.id }, actorId)).toThrow('responsible practitioner');
            expect(() => service.beginConsultation({ patientId: 1, queueEntryId, startRequestId: 'owned-encounter' }, actorId))
                .toThrow('another operation or actor');
            expect(() => service.beginConsultation({ patientId: 1, queueEntryId, startRequestId: `actor-${actorId}` }, actorId))
                .toThrow('responsible practitioner');
        }

        expect(db.prepare('SELECT diagnosis FROM visits WHERE id = ?').get(encounter.id).diagnosis).toBe('');
    });

    it('blocks stale progress, completion, and repeated postpone after postponement', () => {
        const queueEntryId = queue(1);
        const encounter = service.beginConsultation({ patientId: 1, queueEntryId, startRequestId: 'postpone-stale-client' }, 10);
        service.postponeConsultation({ encounterId: encounter.id, visit: { diagnosis: 'Saved draft' } }, 10);

        expect(() => service.saveConsultationProgress({ encounterId: encounter.id, visit: { diagnosis: 'Stale overwrite' } }, 10))
            .toThrow('not in consultation');
        expect(() => service.completeConsultation({ encounterId: encounter.id, visit: { diagnosis: 'Stale finish' } }, 10))
            .toThrow('not in consultation');
        expect(() => service.postponeConsultation({ encounterId: encounter.id }, 10)).toThrow('not in consultation');
        expect(service.beginNextConsultation({ startRequestId: 'implicit-handoff-doctor' }, 11)).toBeNull();
        expect(() => service.beginNextConsultation({ startRequestId: 'implicit-handoff-admin' }, 99))
            .toThrow('Clinical authoring requires an active licensed practitioner');

        const stored = db.prepare('SELECT diagnosis, status FROM visits WHERE id = ?').get(encounter.id);
        expect(stored).toMatchObject({ diagnosis: 'Saved draft', status: 'in-progress' });
        expect(db.prepare('SELECT status FROM patient_queue WHERE id = ?').get(queueEntryId).status).toBe('waiting');
    });

    it('validates practitioner and exact completed queue state on idempotent finish retries', () => {
        const queueEntryId = queue(1);
        const encounter = service.beginConsultation({ patientId: 1, queueEntryId, startRequestId: 'finished-retry-owner' }, 10);
        service.completeConsultation({ encounterId: encounter.id, visit: { diagnosis: 'Done' } }, 10);

        expect(() => service.completeConsultation({ encounterId: encounter.id, visit: { diagnosis: 'Wrong actor' } }, 11))
            .toThrow('responsible practitioner');
        db.prepare("UPDATE patient_queue SET status = 'waiting' WHERE id = ?").run(queueEntryId);
        expect(() => service.completeConsultation({ encounterId: encounter.id, visit: { diagnosis: 'Retry' } }, 10))
            .toThrow('inconsistent');
        expect(db.prepare('SELECT diagnosis FROM visits WHERE id = ?').get(encounter.id).diagnosis).toBe('Done');
    });

    it("skips another practitioner's postponed patient when beginning next", () => {
        const doctor10Queue = queue(1, 2);
        const doctor10Encounter = service.beginConsultation({
            patientId: 1, queueEntryId: doctor10Queue, startRequestId: 'doctor-10-p1'
        }, 10);
        service.postponeConsultation({ encounterId: doctor10Encounter.id, visit: { diagnosis: 'Doctor 10 draft' } }, 10);

        const doctor11Queue = queue(2, 1);
        const doctor11Encounter = service.beginConsultation({
            patientId: 2, queueEntryId: doctor11Queue, startRequestId: 'doctor-11-p2'
        }, 11);
        service.completeConsultation({ encounterId: doctor11Encounter.id, visit: { diagnosis: 'Doctor 11 done' } }, 11);

        const eligibleQueue = queue(3, 1);
        const next = service.beginNextConsultation({ startRequestId: 'doctor-11-next-p3' }, 11);

        expect(next.patient_id).toBe(3);
        expect(next.queue_entry_id).toBe(eligibleQueue);
        expect(next.doctor_id).toBe(11);
        expect(db.prepare('SELECT status FROM patient_queue WHERE id = ?').get(doctor10Queue).status).toBe('waiting');
        expect(db.prepare('SELECT doctor_id, diagnosis, status FROM visits WHERE id = ?').get(doctor10Encounter.id))
            .toMatchObject({ doctor_id: 10, diagnosis: 'Doctor 10 draft', status: 'in-progress' });
    });

    it('skips own postponed patient when beginning next instead of failing', () => {
        const postponedQueue = queue(1, 2);
        const postponed = service.beginConsultation({
            patientId: 1, queueEntryId: postponedQueue, startRequestId: 'own-postponed'
        }, 10);
        service.postponeConsultation({ encounterId: postponed.id, visit: { diagnosis: 'Deferred' } }, 10);

        const otherQueue = queue(2, 1);
        const other = service.beginConsultation({
            patientId: 2, queueEntryId: otherQueue, startRequestId: 'own-other'
        }, 10);
        service.completeConsultation({ encounterId: other.id, visit: { diagnosis: 'Done' } }, 10);

        const cleanQueue = queue(3, 1);
        const next = service.beginNextConsultation({ startRequestId: 'own-next' }, 10);

        expect(next.patient_id).toBe(3);
        expect(next.queue_entry_id).toBe(cleanQueue);
        expect(db.prepare('SELECT status FROM patient_queue WHERE id = ?').get(postponedQueue).status).toBe('waiting');
        expect(db.prepare('SELECT status FROM visits WHERE id = ?').get(postponed.id).status).toBe('in-progress');
    });
});

describe('migration v7 compatibility', () => {
    it('preserves legacy visit history as finished encounters', async () => {
        const db: any = new TestDatabase();
        try {
            db.exec(`
                CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);
                CREATE TABLE patients (id INTEGER PRIMARY KEY, name TEXT);
                CREATE TABLE patient_queue (id INTEGER PRIMARY KEY, patient_id INTEGER, status TEXT);
                CREATE TABLE visits (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, patient_id INTEGER, doctor_id INTEGER,
                    date DATETIME DEFAULT CURRENT_TIMESTAMP, diagnosis TEXT, prescription_json TEXT,
                    amount_paid REAL, symptoms TEXT, examination_notes TEXT, diagnosis_type TEXT
                );
                CREATE TABLE roles (name TEXT PRIMARY KEY, permissions TEXT);
                INSERT INTO roles VALUES ('doctor', '["saveVisit"]');
                INSERT INTO visits (patient_id, diagnosis, prescription_json) VALUES (1, 'Legacy diagnosis', '[]');
                PRAGMA user_version = 6;
            `);
            const service = new DatabaseService();
            service.setDb(db);
            await service.migrate();

            const migrated = db.prepare('SELECT * FROM visits').get();
            expect(migrated.status).toBe('finished');
            expect(migrated.started_at).toBeTruthy();
            expect(migrated.completed_at).toBeTruthy();
            expect(db.pragma('user_version', { simple: true })).toBe(LATEST_SCHEMA_VERSION);
        } finally {
            db.close();
        }
    });

    it('skips pre-release encounter requests with orphaned foreign-key references', async () => {
        const db: any = new TestDatabase();
        try {
            db.exec(`
                PRAGMA foreign_keys = ON;
                CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);
                CREATE TABLE patients (id INTEGER PRIMARY KEY, name TEXT);
                CREATE TABLE patient_queue (id INTEGER PRIMARY KEY, patient_id INTEGER, status TEXT);
                CREATE TABLE visits (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, patient_id INTEGER, doctor_id INTEGER,
                    date DATETIME DEFAULT CURRENT_TIMESTAMP, diagnosis TEXT, prescription_json TEXT,
                    amount_paid REAL, symptoms TEXT, examination_notes TEXT, diagnosis_type TEXT,
                    status TEXT, started_at DATETIME, completed_at DATETIME, updated_at DATETIME,
                    queue_entry_id INTEGER, start_request_id TEXT, start_operation TEXT, start_actor_id INTEGER
                );
                CREATE TABLE roles (name TEXT PRIMARY KEY, permissions TEXT);
                INSERT INTO roles VALUES ('doctor', '["saveVisit"]');
                INSERT INTO visits (
                    patient_id, doctor_id, status, queue_entry_id, start_request_id, start_operation, start_actor_id
                ) VALUES (404, 405, 'in-progress', 406, 'orphaned-request', 'begin', 405);
                PRAGMA user_version = 6;
            `);
            const service = new DatabaseService();
            service.setDb(db);

            await expect(service.migrate()).resolves.toBeUndefined();
            expect(db.prepare('SELECT count(*) count FROM encounter_requests').get().count).toBe(0);
            expect(db.pragma('user_version', { simple: true })).toBe(LATEST_SCHEMA_VERSION);
        } finally {
            db.close();
        }
    });
});
