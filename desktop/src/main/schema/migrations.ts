/**
 * Adds methods to existing roles without dropping current grants. Shared by
 * the desk-grant migrations (v32, v33) so repair migrations cannot drift
 * from the original grant logic.
 */
import { NLEM_2022_GENERICS } from '../catalog/nlem2022.seeds';

function grantRoleMethods(db: any, grants: Record<string, string[]>) {
    const get = db.prepare('SELECT permissions FROM roles WHERE name = ?');
    const set = db.prepare('UPDATE roles SET permissions = ? WHERE name = ?');
    for (const [name, add] of Object.entries(grants)) {
        try {
            const row = get.get(name) as { permissions?: string };
            set.run(JSON.stringify([...new Set([...JSON.parse(row?.permissions || '[]'), ...add])]), name);
        } catch { /* keep existing grants on malformed rows */ }
    }
}

export const MIGRATIONS = [
    {
        version: 1,
        up: (db: any) => {
            console.log('Running Migration v1 (Baseline)...');

            // 1. Settings Table
            db.exec(`
                CREATE TABLE IF NOT EXISTS settings (
                    clinic_name TEXT,
                    doctor_name TEXT,
                    logo_path TEXT,
                    license_key TEXT,
                    drive_tokens TEXT,
                    cloud_clinic_id TEXT,
                    cloud_api_key TEXT,
                    cloud_enabled INTEGER DEFAULT 0
                );
            `);

            // Ensure columns exist (for existing dev DBs that might be partial)
            const settingsCols = ['drive_tokens TEXT', 'clinic_name TEXT', 'doctor_name TEXT', 'cloud_clinic_id TEXT', 'cloud_api_key TEXT', 'cloud_enabled INTEGER DEFAULT 0'];
            settingsCols.forEach(col => {
                try { db.exec(`ALTER TABLE settings ADD COLUMN ${col}`); } catch (e) { }
            });

            // 2. Users Table
            db.exec(`
                CREATE TABLE IF NOT EXISTS users (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    username TEXT UNIQUE,
                    password TEXT,
                    role TEXT,
                    name TEXT,
                    specialty TEXT,
                    license_number TEXT,
                    active INTEGER DEFAULT 1,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                );
            `);
            // Users columns
            const userCols = ['specialty TEXT', 'license_number TEXT'];
            userCols.forEach(col => {
                try { db.exec(`ALTER TABLE users ADD COLUMN ${col}`); } catch (e) { }
            });


            // 3. Patients Table
            db.exec(`
                CREATE TABLE IF NOT EXISTS patients (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    uuid TEXT UNIQUE,
                    name TEXT,
                    mobile TEXT,
                    age INTEGER,
                    gender TEXT,
                    address TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    dob DATE,
                    blood_group TEXT,
                    email TEXT,
                    emergency_contact_name TEXT,
                    emergency_contact_mobile TEXT,
                    street TEXT,
                    city TEXT,
                    state TEXT,
                    zip_code TEXT,
                    insurance_provider TEXT,
                    policy_number TEXT
                );
            `);
            // Patient Add Columns (Legacy safety)
            const patientCols = [
                'dob DATE', 'blood_group TEXT', 'email TEXT',
                'emergency_contact_name TEXT', 'emergency_contact_mobile TEXT',
                'street TEXT', 'city TEXT', 'state TEXT', 'zip_code TEXT',
                'insurance_provider TEXT', 'policy_number TEXT'
            ];
            patientCols.forEach(col => {
                try { db.exec(`ALTER TABLE patients ADD COLUMN ${col}`); } catch (e) { }
            });


            // 4. Visits Table
            db.exec(`
                CREATE TABLE IF NOT EXISTS visits(
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    patient_id INTEGER,
                    doctor_id INTEGER,
                    date DATETIME DEFAULT CURRENT_TIMESTAMP,
                    diagnosis TEXT,
                    prescription_json TEXT,
                    amount_paid REAL,
                    symptoms TEXT,
                    examination_notes TEXT,
                    diagnosis_type TEXT,
                    FOREIGN KEY(patient_id) REFERENCES patients(id),
                    FOREIGN KEY(doctor_id) REFERENCES users(id)
                );
            `);
            // Visit Add Columns (Legacy safety)
            const visitCols = ['doctor_id INTEGER', 'symptoms TEXT', 'examination_notes TEXT', 'diagnosis_type TEXT'];
            visitCols.forEach(col => {
                try { db.exec(`ALTER TABLE visits ADD COLUMN ${col}`); } catch (e) { }
            });


            // 5. Vitals Table
            db.exec(`
                CREATE TABLE IF NOT EXISTS vitals (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    visit_id INTEGER,
                    patient_id INTEGER,
                    height REAL,
                    weight REAL,
                    bmi REAL,
                    temperature REAL,
                    systolic_bp INTEGER,
                    diastolic_bp INTEGER,
                    pulse INTEGER,
                    respiratory_rate INTEGER,
                    spo2 INTEGER,
                    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY(visit_id) REFERENCES visits(id) ON DELETE CASCADE,
                    FOREIGN KEY(patient_id) REFERENCES patients(id) ON DELETE CASCADE
                );
            `);

            // 6. Audit Logs
            db.exec(`
                CREATE TABLE IF NOT EXISTS audit_logs(
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    action TEXT,
                    table_name TEXT,
                    record_id INTEGER,
                    user_id INTEGER,
                    details TEXT,
                    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
                );
            `);

            // 7. Patient Queue
            db.exec(`
                CREATE TABLE IF NOT EXISTS patient_queue(
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    patient_id INTEGER,
                    status TEXT DEFAULT 'waiting', --waiting, in-consult, completed
                    priority INTEGER DEFAULT 1, --1: Normal, 2: Emergency
                    check_in_time DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY(patient_id) REFERENCES patients(id) on DELETE CASCADE
                );
            `);

            // 8. Appointment Requests
            db.exec(`
                CREATE TABLE IF NOT EXISTS appointment_requests (
                    id TEXT PRIMARY KEY,
                    patient_name TEXT,
                    phone TEXT,
                    date TEXT,
                    time TEXT,
                    reason TEXT,
                    status TEXT DEFAULT 'pending',
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                );
            `);

            // 9. Appointments
            db.exec(`
                CREATE TABLE IF NOT EXISTS appointments (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    patient_id INTEGER,
                    date TEXT,
                    time TEXT,
                    reason TEXT,
                    status TEXT DEFAULT 'CONFIRMED', -- CONFIRMED, CHECKED_IN, CANCELLED, COMPLETED
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY(patient_id) REFERENCES patients(id)
                );
            `);

            // Seed Admin (Legacy check inside migration? No, better to do it in EnsureAdminUser logic outside, or here?)
            // Robust approach: Migrations handle Schema. Seeding relies on App Logic or a separate Seed Migration.
            // We left 'ensureAdminUser' in DatabaseService, which is fine.
        }
    },
    {
        version: 2,
        up: (db: any) => {
            console.log('Running Migration v2 (RBAC Roles)...');
            db.exec(`
                CREATE TABLE IF NOT EXISTS roles (
                    name TEXT PRIMARY KEY,
                    permissions TEXT -- JSON array of strings
                );
            `);

            // Seed Default Roles
            const roles = [
                {
                    name: 'doctor',
                    permissions: JSON.stringify([
                        'getPatients', 'savePatient', 'getVisits', 'getAllVisits', 'saveVisit',
                        'getQueue', 'addToQueue', 'removeFromQueue', 'updateQueueStatus',
                        'getDashboardStats', 'getDoctors', 'getPublicSettings'
                    ])
                },
                {
                    name: 'receptionist',
                    permissions: JSON.stringify([
                        'getPatients', 'savePatient',
                        'getQueue', 'addToQueue', 'removeFromQueue', 'updateQueueStatus', 'updateQueueStatusByPatientId', 'getPublicSettings'
                    ])
                },
                {
                    name: 'nurse',
                    permissions: JSON.stringify([
                        'getPatients', 'getQueue', 'updateQueueStatus', 'getPublicSettings'
                    ])
                }
            ];

            const insert = db.prepare('INSERT OR IGNORE INTO roles (name, permissions) VALUES (@name, @permissions)');
            roles.forEach(role => insert.run(role));
        }
    },
    {
        version: 3,
        up: (db: any) => {
            console.log('Running Migration v3 (Staff Fields)...');
            const cols = [
                'mobile TEXT',
                'email TEXT',
                'designation TEXT',
                'joining_date TEXT',
                'address TEXT',
                'emergency_contact_name TEXT',
                'emergency_contact_phone TEXT',
                'password_reset_required INTEGER DEFAULT 0',
                'dob TEXT'
            ];
            cols.forEach(col => {
                try { db.exec(`ALTER TABLE users ADD COLUMN ${col}`); } catch (e) { }
            });
        }
    },
    {
        version: 4,
        up: (db: any) => {
            console.log('Running Migration v4 (Drive & Backup Settings)...');
            const cols = [
                'drive_client_id TEXT',
                'drive_client_secret TEXT',
                'local_backup_path TEXT'
            ];
            cols.forEach(col => {
                try { db.exec(`ALTER TABLE settings ADD COLUMN ${col}`); } catch (e) { console.debug(`[Migration] Column ${col} might already exist.`); }
            });
        }
    },
    {
        version: 5,
        up: (db: any) => {
            console.log('Running Migration v5 (Backup Schedule)...');
            try { db.exec(`ALTER TABLE settings ADD COLUMN backup_schedule TEXT DEFAULT '13:00'`); } catch (e) { console.debug('[Migration] backup_schedule column might already exist.'); }
        }
    },
    {
        version: 6,
        up: (db: any) => {
            console.log('Running Migration v6 (Cloud Backup Schedule)...');
            try { db.exec(`ALTER TABLE settings ADD COLUMN cloud_backup_schedule TEXT DEFAULT '13:00'`); } catch (e) { console.debug('[Migration] cloud_backup_schedule column might already exist.'); }
        }
    },
    {
        version: 7,
        up: (db: any) => {
            console.log('Running Migration v7 (Encounter integrity)...');

            const visitCols = [
                "status TEXT DEFAULT 'finished'",
                'started_at DATETIME',
                'completed_at DATETIME',
                'updated_at DATETIME',
                'queue_entry_id INTEGER',
                'start_request_id TEXT',
                'start_operation TEXT',
                'start_actor_id INTEGER'
            ];
            visitCols.forEach(col => {
                try { db.exec(`ALTER TABLE visits ADD COLUMN ${col}`); } catch (e) { console.debug(`[Migration] visits.${col.split(' ')[0]} might already exist.`); }
            });

            // All records created by earlier versions were persisted as completed history.
            db.exec(`
                UPDATE visits
                SET status = CASE WHEN status = 'in-progress' THEN status ELSE 'finished' END,
                    started_at = COALESCE(started_at, date),
                    completed_at = CASE WHEN status = 'in-progress' THEN completed_at ELSE COALESCE(completed_at, date) END,
                    updated_at = COALESCE(updated_at, date)
                ;

                CREATE UNIQUE INDEX IF NOT EXISTS idx_visits_queue_entry
                    ON visits(queue_entry_id) WHERE queue_entry_id IS NOT NULL;
                CREATE UNIQUE INDEX IF NOT EXISTS idx_visits_start_request
                    ON visits(start_request_id) WHERE start_request_id IS NOT NULL;
                CREATE UNIQUE INDEX IF NOT EXISTS idx_visits_one_active_patient
                    ON visits(patient_id) WHERE status = 'in-progress';
                CREATE INDEX IF NOT EXISTS idx_visits_status_updated
                    ON visits(status, updated_at);

                CREATE TABLE IF NOT EXISTS encounter_requests (
                    request_id TEXT PRIMARY KEY,
                    operation TEXT NOT NULL,
                    encounter_id INTEGER NOT NULL,
                    patient_id INTEGER NOT NULL,
                    queue_entry_id INTEGER NOT NULL,
                    actor_id INTEGER NOT NULL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY(encounter_id) REFERENCES visits(id) ON DELETE CASCADE,
                    FOREIGN KEY(patient_id) REFERENCES patients(id),
                    FOREIGN KEY(queue_entry_id) REFERENCES patient_queue(id),
                    FOREIGN KEY(actor_id) REFERENCES users(id)
                );
                CREATE INDEX IF NOT EXISTS idx_encounter_requests_encounter
                    ON encounter_requests(encounter_id);

                CREATE TRIGGER IF NOT EXISTS trg_visits_queue_link_insert
                BEFORE INSERT ON visits WHEN NEW.queue_entry_id IS NOT NULL
                BEGIN
                    SELECT CASE WHEN NOT EXISTS (
                        SELECT 1 FROM patient_queue q
                        WHERE q.id = NEW.queue_entry_id AND q.patient_id = NEW.patient_id
                    ) THEN RAISE(ABORT, 'Encounter queue entry does not match patient') END;
                END;

                CREATE TRIGGER IF NOT EXISTS trg_visits_queue_link_update
                BEFORE UPDATE OF queue_entry_id, patient_id ON visits WHEN NEW.queue_entry_id IS NOT NULL
                BEGIN
                    SELECT CASE WHEN NOT EXISTS (
                        SELECT 1 FROM patient_queue q
                        WHERE q.id = NEW.queue_entry_id AND q.patient_id = NEW.patient_id
                    ) THEN RAISE(ABORT, 'Encounter queue entry does not match patient') END;
                END;

                CREATE TRIGGER IF NOT EXISTS trg_visits_status_insert
                BEFORE INSERT ON visits
                WHEN NEW.status IS NULL OR NEW.status NOT IN ('in-progress', 'finished')
                BEGIN SELECT RAISE(ABORT, 'Invalid encounter status'); END;

                CREATE TRIGGER IF NOT EXISTS trg_visits_status_update
                BEFORE UPDATE OF status ON visits
                WHEN NEW.status IS NULL OR NEW.status NOT IN ('in-progress', 'finished')
                BEGIN SELECT RAISE(ABORT, 'Invalid encounter status'); END;
            `);

            // Backfill any encounter created by a pre-release v7 build.
            db.exec(`
                INSERT OR IGNORE INTO encounter_requests (
                    request_id, operation, encounter_id, patient_id, queue_entry_id, actor_id
                )
                SELECT start_request_id, COALESCE(start_operation, 'begin'), id,
                       patient_id, queue_entry_id, COALESCE(start_actor_id, doctor_id)
                FROM visits
                WHERE start_request_id IS NOT NULL AND queue_entry_id IS NOT NULL
                  AND COALESCE(start_actor_id, doctor_id) IS NOT NULL
                  AND EXISTS (
                      SELECT 1 FROM patient_queue q
                      WHERE q.id = visits.queue_entry_id AND q.patient_id = visits.patient_id
                  )
                  AND EXISTS (SELECT 1 FROM patients p WHERE p.id = visits.patient_id)
                  AND EXISTS (
                      SELECT 1 FROM users u
                      WHERE u.id = COALESCE(visits.start_actor_id, visits.doctor_id)
                  );
            `);

            // LAN/offline doctors use the same explicit encounter commands as Electron.
            const doctor = db.prepare('SELECT permissions FROM roles WHERE name = ?').get('doctor');
            if (doctor?.permissions) {
                const permissions = new Set<string>(JSON.parse(doctor.permissions));
                [
                    'beginConsultation', 'getActiveConsultation', 'saveConsultationProgress',
                    'completeConsultation', 'postponeConsultation', 'resumeConsultation',
                    'beginNextConsultation'
                ].forEach(permission => permissions.add(permission));
                db.prepare('UPDATE roles SET permissions = ? WHERE name = ?')
                    .run(JSON.stringify([...permissions]), 'doctor');
            }
        }
    },
    {
        version: 8,
        up: (db: any) => {
            console.log('Running Migration v8 (Credential Rotation Journal)...');
            db.exec(`
                CREATE TABLE IF NOT EXISTS credential_rotation_journal (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    username TEXT NOT NULL,
                    previous_hash TEXT NOT NULL,
                    replacement_hash TEXT NOT NULL,
                    previous_reset_required INTEGER NOT NULL DEFAULT 0,
                    phase TEXT NOT NULL CHECK (phase IN ('prepared', 'applied')),
                    started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
                );
            `);
        }
    },
    {
        version: 9,
        up: (db: any) => {
            console.log('Running Migration v9 (Condition and medicine catalogs)...');
            db.exec(`
                CREATE TABLE IF NOT EXISTS condition_catalog (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    active INTEGER NOT NULL DEFAULT 1,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                );
                CREATE UNIQUE INDEX IF NOT EXISTS idx_condition_catalog_active_name
                    ON condition_catalog(name COLLATE NOCASE) WHERE active = 1;

                CREATE TABLE IF NOT EXISTS medicine_catalog (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    form TEXT,
                    dosage TEXT,
                    route TEXT,
                    frequency TEXT,
                    duration TEXT,
                    instruction TEXT,
                    active INTEGER NOT NULL DEFAULT 1,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                );
                CREATE UNIQUE INDEX IF NOT EXISTS idx_medicine_catalog_active_name
                    ON medicine_catalog(name COLLATE NOCASE) WHERE active = 1;

                CREATE TABLE IF NOT EXISTS condition_med_presets (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    condition_id INTEGER NOT NULL,
                    sort_order INTEGER NOT NULL DEFAULT 0,
                    medicine_id INTEGER,
                    medicine TEXT NOT NULL,
                    form TEXT,
                    dosage TEXT,
                    route TEXT,
                    frequency TEXT,
                    duration TEXT,
                    instruction TEXT,
                    FOREIGN KEY(condition_id) REFERENCES condition_catalog(id) ON DELETE CASCADE,
                    FOREIGN KEY(medicine_id) REFERENCES medicine_catalog(id)
                );
                CREATE INDEX IF NOT EXISTS idx_condition_med_presets_condition
                    ON condition_med_presets(condition_id, sort_order);
            `);

            const doctor = db.prepare('SELECT permissions FROM roles WHERE name = ?').get('doctor');
            if (doctor?.permissions) {
                const permissions = new Set<string>(JSON.parse(doctor.permissions));
                ['searchConditions', 'searchMedicines', 'createCondition', 'createMedicine', 'getConditionMedPresets']
                    .forEach(permission => permissions.add(permission));
                db.prepare('UPDATE roles SET permissions = ? WHERE name = ?')
                    .run(JSON.stringify([...permissions]), 'doctor');
            }
        }
    },
    {
        version: 10,
        up: (db: any) => {
            console.log('Running Migration v10 (Encounter-Linked Vitals & Observation Model)...');

            db.exec(`
                CREATE TABLE IF NOT EXISTS vitals (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    visit_id INTEGER,
                    patient_id INTEGER,
                    height REAL,
                    weight REAL,
                    bmi REAL,
                    temperature REAL,
                    systolic_bp INTEGER,
                    diastolic_bp INTEGER,
                    pulse INTEGER,
                    respiratory_rate INTEGER,
                    spo2 INTEGER,
                    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY(visit_id) REFERENCES visits(id) ON DELETE CASCADE,
                    FOREIGN KEY(patient_id) REFERENCES patients(id) ON DELETE CASCADE
                );
            `);

            const vitalsCols = [
                'effective_time DATETIME DEFAULT CURRENT_TIMESTAMP',
                'recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP',
                'performer_id INTEGER REFERENCES users(id)',
                "status TEXT DEFAULT 'final'",
                'units_json TEXT',
                'queue_entry_id INTEGER REFERENCES patient_queue(id)',
                'replaces_id INTEGER REFERENCES vitals(id)',
                'amendment_reason TEXT',
                'client_request_id TEXT'
            ];
            vitalsCols.forEach(col => {
                try { db.exec(`ALTER TABLE vitals ADD COLUMN ${col}`); } catch (e) { }
            });

            db.exec(`
                UPDATE vitals
                SET effective_time = COALESCE(effective_time, timestamp, CURRENT_TIMESTAMP),
                    recorded_at = COALESCE(recorded_at, timestamp, CURRENT_TIMESTAMP),
                    status = COALESCE(status, 'final'),
                    units_json = COALESCE(units_json, '{"height":"cm","weight":"kg","bmi":"kg/m2","temperature":"°F","systolic_bp":"mmHg","diastolic_bp":"mmHg","pulse":"bpm","respiratory_rate":"bpm","spo2":"%"}')
                WHERE effective_time IS NULL OR recorded_at IS NULL OR status IS NULL OR units_json IS NULL;

                UPDATE vitals
                SET queue_entry_id = (SELECT v.queue_entry_id FROM visits v WHERE v.id = vitals.visit_id)
                WHERE visit_id IS NOT NULL AND queue_entry_id IS NULL;

                CREATE INDEX IF NOT EXISTS idx_vitals_patient_effective
                    ON vitals(patient_id, effective_time);
                CREATE INDEX IF NOT EXISTS idx_vitals_visit
                    ON vitals(visit_id);
                CREATE INDEX IF NOT EXISTS idx_vitals_queue_entry
                    ON vitals(queue_entry_id);
                CREATE INDEX IF NOT EXISTS idx_vitals_replaces
                    ON vitals(replaces_id);
                CREATE INDEX IF NOT EXISTS idx_vitals_request
                    ON vitals(client_request_id) WHERE client_request_id IS NOT NULL;
            `);

            const newPermissions = ['getVitals', 'saveVitals', 'getVitalsHistory', 'getEncounterVitals'];
            ['doctor', 'nurse', 'receptionist'].forEach(roleName => {
                try {
                    const role = db.prepare('SELECT permissions FROM roles WHERE name = ?').get(roleName);
                    if (role?.permissions) {
                        const permissions = new Set<string>(JSON.parse(role.permissions));
                        newPermissions.forEach(p => permissions.add(p));
                        db.prepare('UPDATE roles SET permissions = ? WHERE name = ?')
                            .run(JSON.stringify([...permissions]), roleName);
                    }
                } catch (e) { }
            });
        }
    },
    {
        version: 11,
        up: (db: any) => {
            console.log('Running Migration v11 (Clinical Safety, Allergies, Problem List & Actionable Triage)...');

            // 1. patient_allergies
            db.exec(`
                CREATE TABLE IF NOT EXISTS patient_allergies (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
                    substance TEXT NOT NULL,
                    verification_status TEXT DEFAULT 'confirmed',
                    criticality TEXT DEFAULT 'low',
                    severity TEXT DEFAULT 'moderate',
                    reaction TEXT,
                    status TEXT DEFAULT 'active',
                    recorder_id INTEGER REFERENCES users(id),
                    recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    notes TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_patient_allergies_patient
                    ON patient_allergies(patient_id, status);
            `);

            // 2. patient_conditions (Problem list)
            db.exec(`
                CREATE TABLE IF NOT EXISTS patient_conditions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
                    condition_name TEXT NOT NULL,
                    code TEXT,
                    category TEXT DEFAULT 'chronic-problem',
                    clinical_status TEXT DEFAULT 'active',
                    onset_date TEXT,
                    recorder_id INTEGER REFERENCES users(id),
                    recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    notes TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_patient_conditions_patient
                    ON patient_conditions(patient_id, clinical_status);
            `);

            // 3. patient_medications (Active/Current medications)
            db.exec(`
                CREATE TABLE IF NOT EXISTS patient_medications (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
                    medicine_name TEXT NOT NULL,
                    dosage TEXT,
                    frequency TEXT,
                    status TEXT DEFAULT 'active',
                    start_date TEXT,
                    end_date TEXT,
                    recorder_id INTEGER REFERENCES users(id),
                    recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    notes TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_patient_medications_patient
                    ON patient_medications(patient_id, status);
            `);

            // 4. queue_triage_history
            db.exec(`
                CREATE TABLE IF NOT EXISTS queue_triage_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    queue_id INTEGER NOT NULL,
                    previous_priority INTEGER NOT NULL,
                    new_priority INTEGER NOT NULL,
                    urgency_label TEXT NOT NULL,
                    reason TEXT NOT NULL,
                    changed_by INTEGER NOT NULL REFERENCES users(id),
                    changed_at DATETIME DEFAULT CURRENT_TIMESTAMP
                );
                CREATE INDEX IF NOT EXISTS idx_queue_triage_hist_queue
                    ON queue_triage_history(queue_id);
            `);

            // 5. Enhance visits table for practitioner provenance and allergy overrides
            const visitCols = [
                'author_id INTEGER REFERENCES users(id)',
                'doctor_license_snapshot TEXT',
                'allergy_override_reason TEXT'
            ];
            visitCols.forEach(col => {
                try { db.exec(`ALTER TABLE visits ADD COLUMN ${col}`); } catch (e) { }
            });

            // 6. Enhance patient_queue table for actionable urgency and triage
            const queueCols = [
                'priority INTEGER DEFAULT 4',
                "urgency TEXT DEFAULT 'routine'",
                'triage_notes TEXT',
                'triage_assessor_id INTEGER REFERENCES users(id)',
                'triaged_at DATETIME'
            ];
            queueCols.forEach(col => {
                try { db.exec(`ALTER TABLE patient_queue ADD COLUMN ${col}`); } catch (e) { }
            });

            // Backfill urgency based on existing numeric priority (higher priority number = higher urgency)
            try {
                db.exec(`
                    UPDATE patient_queue
                    SET urgency = CASE
                        WHEN priority >= 4 THEN 'immediate'
                        WHEN priority = 3 THEN 'urgent'
                        WHEN priority = 2 THEN 'priority'
                        ELSE 'routine'
                    END;
                `);
            } catch (e) { }

            // 7. Role permissions update
            const safetyPermissions = [
                'getAllergies', 'saveAllergy', 'deleteAllergy',
                'getConditions', 'saveCondition', 'deleteCondition',
                'getMedications', 'saveMedication', 'deleteMedication',
                'reassessQueueTriage', 'getQueueTriageHistory',
                'getPatientSafetyContext'
            ];
            ['doctor', 'nurse', 'receptionist', 'admin'].forEach(roleName => {
                try {
                    const role = db.prepare('SELECT permissions FROM roles WHERE name = ?').get(roleName);
                    if (role?.permissions) {
                        const permissions = new Set<string>(JSON.parse(role.permissions));
                        safetyPermissions.forEach(p => permissions.add(p));
                        db.prepare('UPDATE roles SET permissions = ? WHERE name = ?')
                            .run(JSON.stringify([...permissions]), roleName);
                    }
                } catch (e) { }
            });
        }
    },
    {
        version: 12,
        up: (db: any) => {
            console.log('Running Migration v12 (urgency backfill correction & clinical mutation permissions)...');

            // 1. Correct legacy emergency mapping. Pre-v11 rows never received an
            // explicit triage stamp (triaged_at IS NULL); those with the old
            // Emergency priority (2) were defaulted to the lower 'priority'
            // tier by v11. A legacy Emergency means "needs prompt assessment",
            // which is the 'urgent' tier in the 4-tier system.
            try {
                db.exec(`
                    UPDATE patient_queue SET urgency = 'urgent'
                    WHERE urgency = 'priority' AND priority = 2 AND triaged_at IS NULL;
                `);
            } catch (e) { }

            // 2. Safety net for any row that never received an urgency value.
            try {
                db.exec(`
                    UPDATE patient_queue SET urgency = CASE
                        WHEN priority >= 4 THEN 'immediate'
                        WHEN priority = 3 THEN 'urgent'
                        WHEN priority = 2 THEN 'urgent'
                        ELSE 'routine'
                    END WHERE urgency IS NULL;
                `);
            } catch (e) { }

            // 3. Safety-record mutation is a doctor/admin action (see PRODUCT
            // RBAC). Reads, triage, and the safety context stay available to
            // all clinical roles; only the six mutation methods are revoked
            // from nurse and receptionist.
            const clinicalMutations = [
                'saveAllergy', 'deleteAllergy',
                'saveCondition', 'deleteCondition',
                'saveMedication', 'deleteMedication'
            ];
            ['nurse', 'receptionist'].forEach(roleName => {
                try {
                    const role = db.prepare('SELECT permissions FROM roles WHERE name = ?').get(roleName);
                    if (role?.permissions) {
                        const permissions = new Set<string>(JSON.parse(role.permissions));
                        clinicalMutations.forEach(p => permissions.delete(p));
                        db.prepare('UPDATE roles SET permissions = ? WHERE name = ?')
                            .run(JSON.stringify([...permissions]), roleName);
                    }
                } catch (e) { }
            });
        }
    },
    {
        version: 13,
        up: (db: any) => {
            console.log('Running Migration v13 (ABDM gateway settings)...');
            const abdmCols = [
                'abdm_gateway_env TEXT',
                'abdm_client_id TEXT',
                'abdm_client_secret_protected TEXT',
                'abdm_mock INTEGER DEFAULT 1'
            ];
            abdmCols.forEach(col => {
                try { db.exec(`ALTER TABLE settings ADD COLUMN ${col}`); } catch (e) { }
            });
        }
    },
    {
        version: 14,
        up: (db: any) => {
            console.log('Running Migration v14 (patient ABHA link)...');
            ['abha_address TEXT', 'abha_name TEXT'].forEach(col => {
                try { db.exec(`ALTER TABLE patients ADD COLUMN ${col}`); } catch (e) { }
            });
        }
    },
    {
        version: 15,
        up: (db: any) => {
            console.log('Running Migration v15 (ABDM share tokens & facility identity)...');
            db.exec(`
                CREATE TABLE IF NOT EXISTS abdm_share_tokens (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    token_no INTEGER NOT NULL,
                    token_date TEXT NOT NULL DEFAULT (date('now', 'localtime')),
                    patient_name TEXT NOT NULL,
                    age INTEGER,
                    gender TEXT,
                    mobile TEXT,
                    abha_address TEXT,
                    abha_name TEXT,
                    raw_payload TEXT,
                    status TEXT DEFAULT 'pending',
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    expires_at DATETIME
                );
            `);
            db.exec(`
                CREATE INDEX IF NOT EXISTS idx_abdm_share_tokens_status
                ON abdm_share_tokens(status, token_date);
            `);
            ['abdm_hip_id TEXT', 'abdm_counter_id TEXT'].forEach(col => {
                try { db.exec(`ALTER TABLE settings ADD COLUMN ${col}`); } catch (e) { }
            });
        }
    },
    {
        version: 16,
        up: (db: any) => {
            console.log('Running Migration v16 (share-token LAN grants)...');
            // Browser (LAN) sessions reach the share dock through /api/ipc,
            // which enforces DB role permissions. Grant the three share
            // methods to desk roles; nurses keep the two read methods.
            const grants: Record<string, string[]> = {
                doctor: ['abdmGetShareTokens', 'findPatientByAbha', 'abdmAcceptShareToken'],
                receptionist: ['abdmGetShareTokens', 'findPatientByAbha', 'abdmAcceptShareToken'],
                admin: ['abdmGetShareTokens', 'findPatientByAbha', 'abdmAcceptShareToken'],
                nurse: ['abdmGetShareTokens', 'findPatientByAbha']
            };
            Object.entries(grants).forEach(([roleName, methods]) => {
                try {
                    const role = db.prepare('SELECT permissions FROM roles WHERE name = ?').get(roleName);
                    if (role?.permissions) {
                        const permissions = new Set<string>(JSON.parse(role.permissions));
                        methods.forEach((m) => permissions.add(m));
                        db.prepare('UPDATE roles SET permissions = ? WHERE name = ?')
                            .run(JSON.stringify([...permissions]), roleName);
                    }
                } catch (e) { }
            });
        }
    },
    {
        version: 17,
        up: (db: any) => {
            console.log('Running Migration v17 (ABHA uniqueness & LAN grants)...');
            // Reconcile pre-existing case-insensitive duplicates before the
            // unique index lands: keep the lowest-id holder, clear the rest.
            // Clearing is safe here because the address stays on the kept row.
            try {
                const dupes = (db.prepare(`
                    SELECT LOWER(abha_address) AS key, COUNT(*) AS n FROM patients
                    WHERE abha_address IS NOT NULL GROUP BY key HAVING n > 1
                `).all() || []);
                if (dupes.length > 0) {
                    console.log(`[Migration v17] Reconciling ${dupes.length} duplicated health ID(s); keeping the earliest record.`);
                }
                db.exec(`
                    UPDATE patients SET abha_address = NULL, abha_name = NULL
                    WHERE abha_address IS NOT NULL AND id NOT IN (
                        SELECT MIN(id) FROM patients
                        WHERE abha_address IS NOT NULL GROUP BY LOWER(abha_address)
                    );
                `);
            } catch (e) {
                console.error('[Migration v17] Duplicate reconciliation failed:', e);
            }
            // One health ID belongs to exactly one patient (case-insensitive);
            // unlinked rows are unaffected by the partial index.
            try {
                db.exec(`
                    CREATE UNIQUE INDEX IF NOT EXISTS idx_patients_abha_unique
                    ON patients(LOWER(abha_address)) WHERE abha_address IS NOT NULL;
                `);
            } catch (e) { }
            // Browser (LAN) sessions reach ABDM flows through /api/ipc, which
            // enforces DB role permissions.
            const grants: Record<string, string[]> = {
                doctor: [
                    'abdmGetConfig', 'abdmAbhaLookup', 'abdmAbhaRequestOtp',
                    'abdmAbhaConfirmOtp', 'abdmAbhaCard', 'abdmLinkAbha'
                ],
                receptionist: [
                    'abdmGetConfig', 'abdmAbhaLookup', 'abdmAbhaRequestOtp',
                    'abdmAbhaConfirmOtp', 'abdmAbhaCard', 'abdmLinkAbha'
                ],
                admin: [
                    'abdmGetConfig', 'abdmSaveConfig', 'abdmSetSecret',
                    'abdmTestConnectivity', 'abdmSimulateShare',
                    'abdmAbhaLookup', 'abdmAbhaRequestOtp', 'abdmAbhaConfirmOtp',
                    'abdmAbhaCard', 'abdmLinkAbha'
                ],
                nurse: ['abdmGetConfig', 'abdmAbhaLookup', 'abdmAbhaCard']
            };
            Object.entries(grants).forEach(([roleName, methods]) => {
                try {
                    const role = db.prepare('SELECT permissions FROM roles WHERE name = ?').get(roleName);
                    if (role?.permissions) {
                        const permissions = new Set<string>(JSON.parse(role.permissions));
                        methods.forEach((m) => permissions.add(m));
                        db.prepare('UPDATE roles SET permissions = ? WHERE name = ?')
                            .run(JSON.stringify([...permissions]), roleName);
                    }
                } catch (e) { }
            });
        }
    },
    {
        version: 18,
        up: (db: any) => {
            console.log('Running Migration v18 (atomic check-in LAN grant)...');
            ['doctor', 'receptionist', 'admin'].forEach(roleName => {
                try {
                    const role = db.prepare('SELECT permissions FROM roles WHERE name = ?').get(roleName);
                    if (role?.permissions) {
                        const permissions = new Set<string>(JSON.parse(role.permissions));
                        permissions.add('abdmAcceptShareTokenAndCheckIn');
                        db.prepare('UPDATE roles SET permissions = ? WHERE name = ?')
                            .run(JSON.stringify([...permissions]), roleName);
                    }
                } catch (e) { }
            });
        }
    },
    {
        version: 19,
        up: (db: any) => {
            console.log('Running Migration v19 (facility and practitioner registry identity)...');
            ['abdm_hfr_id TEXT', 'abdm_hpr_id TEXT'].forEach(col => {
                try { db.exec(`ALTER TABLE settings ADD COLUMN ${col}`); } catch (e) { }
            });
        }
    },
    {
        version: 20,
        up: (db: any) => {
            console.log('Running Migration v20 (care context linking and callback inbox)...');
            try { db.exec(`ALTER TABLE visits ADD COLUMN care_context_ref TEXT`); } catch (e) { }
            db.exec(`
                CREATE TABLE IF NOT EXISTS abdm_inbox (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    kind TEXT NOT NULL,
                    payload TEXT,
                    status TEXT DEFAULT 'pending',
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                );
            `);
            db.exec(`
                CREATE UNIQUE INDEX IF NOT EXISTS idx_visits_care_context_ref
                ON visits(care_context_ref) WHERE care_context_ref IS NOT NULL;
            `);
            db.exec(`
                CREATE INDEX IF NOT EXISTS idx_abdm_inbox_status
                ON abdm_inbox(status, created_at);
            `);
        }
    },
    {
        version: 21,
        up: (db: any) => {
            console.log('Running Migration v21 (inbox LAN grants)...');
            const grants: Record<string, string[]> = {
                doctor: ['abdmGetInbox', 'abdmAckInbox'],
                receptionist: ['abdmGetInbox', 'abdmAckInbox'],
                admin: ['abdmGetInbox', 'abdmAckInbox'],
                nurse: ['abdmGetInbox']
            };
            Object.entries(grants).forEach(([roleName, methods]) => {
                try {
                    const role = db.prepare('SELECT permissions FROM roles WHERE name = ?').get(roleName);
                    if (role?.permissions) {
                        const permissions = new Set<string>(JSON.parse(role.permissions));
                        methods.forEach((m) => permissions.add(m));
                        db.prepare('UPDATE roles SET permissions = ? WHERE name = ?')
                            .run(JSON.stringify([...permissions]), roleName);
                    }
                } catch (e) { }
            });
        }
    },
    {
        version: 22,
        up: (db: any) => {
            console.log('Running Migration v22 (transfer endpoint and recipient key)...');
            ['abdm_hip_endpoint TEXT', 'abdm_recipient_key TEXT'].forEach(col => {
                try { db.exec(`ALTER TABLE settings ADD COLUMN ${col}`); } catch (e) { }
            });
        }
    },
    {
        version: 23,
        up: (db: any) => {
            console.log('Running Migration v23 (transfer grants, callback secret, per-doctor registry)...');
            ['abdm_callback_secret TEXT'].forEach(col => {
                try { db.exec(`ALTER TABLE settings ADD COLUMN ${col}`); } catch (e) { }
            });
            try { db.exec(`ALTER TABLE users ADD COLUMN abdm_hpr_id TEXT`); } catch (e) { }
            const grants: Record<string, string[]> = {
                doctor: ['abdmTransferBundle'],
                admin: ['abdmTransferBundle']
            };
            Object.entries(grants).forEach(([roleName, methods]) => {
                try {
                    const role = db.prepare('SELECT permissions FROM roles WHERE name = ?').get(roleName);
                    if (role?.permissions) {
                        const permissions = new Set<string>(JSON.parse(role.permissions));
                        methods.forEach((m) => permissions.add(m));
                        db.prepare('UPDATE roles SET permissions = ? WHERE name = ?')
                            .run(JSON.stringify([...permissions]), roleName);
                    }
                } catch (e) { }
            });
        }
    },
    {
        version: 24,
        up: (db: any) => {
            console.log('Running Migration v24 (care context sequence)...');
            // Per-year counters independent of deletable visit rows, so a
            // deleted encounter can never cause its reference to be reused.
            db.exec(`
                CREATE TABLE IF NOT EXISTS care_context_seq (
                    year INTEGER PRIMARY KEY,
                    last_no INTEGER NOT NULL DEFAULT 0
                );
            `);
            try {
                db.exec(`
                    INSERT INTO care_context_seq (year, last_no)
                    SELECT CAST(SUBSTR(care_context_ref, 4, 4) AS INTEGER) AS year,
                           MAX(CAST(SUBSTR(care_context_ref, 9) AS INTEGER)) AS last_no
                    FROM visits WHERE care_context_ref LIKE 'OP-%'
                    GROUP BY year
                    ON CONFLICT(year) DO UPDATE SET last_no = MAX(last_no, excluded.last_no);
                `);
            } catch (e) { }
        }
    },
    {
        version: 25,
        up: (db: any) => {
            console.log('Running Migration v25 (record deletes are admin-only)...');
            // Destructive record deletes must never sit on desk-role grants.
            // No shipped seed grants them today; this strips them wherever a
            // dirty roles row carries them, so the server 403s non-admins.
            const recordDeletes = ['deletePatient', 'deleteVisit', 'deleteUser'];
            ['doctor', 'nurse', 'receptionist'].forEach(roleName => {
                try {
                    const role = db.prepare('SELECT permissions FROM roles WHERE name = ?').get(roleName);
                    if (role?.permissions) {
                        const permissions = new Set<string>(JSON.parse(role.permissions));
                        recordDeletes.forEach(p => permissions.delete(p));
                        db.prepare('UPDATE roles SET permissions = ? WHERE name = ?')
                            .run(JSON.stringify([...permissions]), roleName);
                    }
                } catch (e) { }
            });
        }
    },
    {
        version: 26,
        up: (db: any) => {
            console.log('Running Migration v26 (profile-login LAN grants)...');
            // LAN sessions enforce DB role permissions; grant the profile-login
            // OTP methods to the same desk roles the Electron gate allows.
            const grants: Record<string, string[]> = {
                doctor: ['abdmAbhaRequestLoginOtp', 'abdmAbhaConfirmLoginOtp'],
                receptionist: ['abdmAbhaRequestLoginOtp', 'abdmAbhaConfirmLoginOtp'],
                admin: ['abdmAbhaRequestLoginOtp', 'abdmAbhaConfirmLoginOtp']
            };
            Object.entries(grants).forEach(([roleName, methods]) => {
                try {
                    const role = db.prepare('SELECT permissions FROM roles WHERE name = ?').get(roleName);
                    if (role?.permissions) {
                        const permissions = new Set<string>(JSON.parse(role.permissions));
                        methods.forEach((m) => permissions.add(m));
                        db.prepare('UPDATE roles SET permissions = ? WHERE name = ?')
                            .run(JSON.stringify([...permissions]), roleName);
                    }
                } catch (e) { }
            });
        }
    },
    {
        version: 27,
        up: (db: any) => {
            console.log('Running Migration v27 (HIU consent store and keypair)...');
            db.exec(`
                CREATE TABLE IF NOT EXISTS abdm_consents (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    patient_id INTEGER,
                    abha_address TEXT NOT NULL,
                    hi_types TEXT NOT NULL DEFAULT '[]',
                    date_from TEXT,
                    date_to TEXT,
                    status TEXT NOT NULL DEFAULT 'requested',
                    gateway_request_id TEXT UNIQUE,
                    consent_handle TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                );
            `);
            db.exec(`
                CREATE TABLE IF NOT EXISTS abdm_fetched_records (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    consent_id INTEGER REFERENCES abdm_consents(id),
                    patient_id INTEGER,
                    care_context_ref TEXT,
                    bundle_json TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'cached',
                    fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    expires_at DATETIME
                );
            `);
            db.exec(`CREATE INDEX IF NOT EXISTS idx_abdm_consents_patient ON abdm_consents(patient_id, status);`);
            db.exec(`CREATE INDEX IF NOT EXISTS idx_abdm_fetched_patient ON abdm_fetched_records(patient_id, status);`);
            db.exec(`CREATE INDEX IF NOT EXISTS idx_abdm_fetched_expiry ON abdm_fetched_records(expires_at);`);
            ['abdm_hiu_private_protected TEXT', 'abdm_hiu_public_key TEXT'].forEach(col => {
                try { db.exec(`ALTER TABLE settings ADD COLUMN ${col}`); } catch (e) { }
            });
            // LAN sessions enforce DB role permissions; the HIU public key is
            // needed wherever intake runs (desk roles), never secret.
            const grants: Record<string, string[]> = {
                doctor: ['abdmHiuGetPublicKey'],
                receptionist: ['abdmHiuGetPublicKey'],
                admin: ['abdmHiuGetPublicKey']
            };
            Object.entries(grants).forEach(([roleName, methods]) => {
                try {
                    const role = db.prepare('SELECT permissions FROM roles WHERE name = ?').get(roleName);
                    if (role?.permissions) {
                        const permissions = new Set<string>(JSON.parse(role.permissions));
                        methods.forEach((m) => permissions.add(m));
                        db.prepare('UPDATE roles SET permissions = ? WHERE name = ?')
                            .run(JSON.stringify([...permissions]), roleName);
                    }
                } catch (e) { }
            });
        }
    },
    {
        version: 28,
        up: (db: any) => {
            console.log('Running Migration v28 (consent notify dedupe and HIU grants)...');
            try { db.exec(`ALTER TABLE abdm_inbox ADD COLUMN request_id TEXT`); } catch (e) { }
            try {
                db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_abdm_inbox_dedupe
                    ON abdm_inbox(kind, request_id) WHERE request_id IS NOT NULL;`);
            } catch (e) { }
            // Content-hash delivery key: retried pushes land idempotently.
            try { db.exec(`ALTER TABLE abdm_fetched_records ADD COLUMN bundle_sha256 TEXT`); } catch (e) { }
            try {
                db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_abdm_fetched_delivery
                    ON abdm_fetched_records(consent_id, bundle_sha256);`);
            } catch (e) { }
            // Consent requests and record fetches are clinical acts
            // (doctor/admin); reads stay available to the desk incl. nurses.
            const grants: Record<string, string[]> = {
                doctor: ['abdmHiuRequestConsent', 'abdmHiuGetConsents', 'abdmHiuFetchRecords'],
                receptionist: ['abdmHiuGetConsents'],
                admin: ['abdmHiuRequestConsent', 'abdmHiuGetConsents', 'abdmHiuFetchRecords'],
                nurse: ['abdmHiuGetConsents']
            };
            Object.entries(grants).forEach(([roleName, methods]) => {
                try {
                    const role = db.prepare('SELECT permissions FROM roles WHERE name = ?').get(roleName);
                    if (role?.permissions) {
                        const permissions = new Set<string>(JSON.parse(role.permissions));
                        methods.forEach((m) => permissions.add(m));
                        db.prepare('UPDATE roles SET permissions = ? WHERE name = ?')
                            .run(JSON.stringify([...permissions]), roleName);
                    }
                } catch (e) { }
            });
        }
    },
    {
        version: 29,
        up: (db: any) => {
            console.log('Running Migration v29 (external-records read and clear grants)...');
            // Reading outside records follows the inbox read split; clearing
            // the cache is a clinical act (doctor/admin only).
            const grants: Record<string, string[]> = {
                doctor: ['abdmHiuGetExternalRecords', 'abdmHiuClearExternalRecords'],
                receptionist: ['abdmHiuGetExternalRecords'],
                admin: ['abdmHiuGetExternalRecords', 'abdmHiuClearExternalRecords'],
                nurse: ['abdmHiuGetExternalRecords']
            };
            Object.entries(grants).forEach(([roleName, methods]) => {
                try {
                    const role = db.prepare('SELECT permissions FROM roles WHERE name = ?').get(roleName);
                    if (role?.permissions) {
                        const permissions = new Set<string>(JSON.parse(role.permissions));
                        methods.forEach((m) => permissions.add(m));
                        db.prepare('UPDATE roles SET permissions = ? WHERE name = ?')
                            .run(JSON.stringify([...permissions]), roleName);
                    }
                } catch (e) { }
            });
        }
    },
    {
        version: 30,
        up: (db: any) => {
            console.log('Running Migration v30 (external medication import grant)...');
            // Importing outside meds mutates the active list: clinical act.
            const grants: Record<string, string[]> = {
                doctor: ['abdmHiuImportMedication'],
                admin: ['abdmHiuImportMedication']
            };
            Object.entries(grants).forEach(([roleName, methods]) => {
                try {
                    const role = db.prepare('SELECT permissions FROM roles WHERE name = ?').get(roleName);
                    if (role?.permissions) {
                        const permissions = new Set<string>(JSON.parse(role.permissions));
                        methods.forEach((m) => permissions.add(m));
                        db.prepare('UPDATE roles SET permissions = ? WHERE name = ?')
                            .run(JSON.stringify([...permissions]), roleName);
                    }
                } catch (e) { }
            });
        }
    },
    {
        version: 31,
        up: (db: any) => {
            console.log('Running Migration v31 (per-user permission overrides)...');
            // Fine-grained deltas over the role baseline: one row grants or
            // forbids a single action for a single user. Reason is mandatory
            // (ABDM audit needs who allowed what and why). Effective access =
            // role permits, plus user allows, minus user forbids; default deny.
            db.exec(`
                CREATE TABLE IF NOT EXISTS user_permission_overrides (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    action TEXT NOT NULL,
                    effect TEXT NOT NULL DEFAULT 'allow'
                        CHECK(effect IN ('allow', 'forbid')),
                    reason TEXT NOT NULL DEFAULT '',
                    granted_by INTEGER REFERENCES users(id),
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(user_id, action)
                );
            `);
            db.exec(`CREATE INDEX IF NOT EXISTS idx_user_overrides_user
                ON user_permission_overrides(user_id);`);
        }
    },
    {
        version: 32,
        up: (db: any) => {
            console.log('Running Migration v32 (desk read and check-in grants)...');
            // Close the gap between what desk UIs call and what the roles
            // table grants, so central permission enforcement cannot break
            // legitimate flows: dashboard stats, appointment check-in, and
            // visit reads for every desk role. Destructive and secret
            // methods stay admin-only by omission.
            const grants: Record<string, string[]> = {
                doctor: ['getDashboardStats', 'getAppointments', 'saveAppointment', 'getVisits'],
                receptionist: ['getDashboardStats', 'getAppointments', 'saveAppointment', 'getVisits'],
                nurse: ['getDashboardStats', 'getAppointments', 'saveAppointment', 'getVisits']
            };
            grantRoleMethods(db, grants);
        }
    },
    {
        version: 33,
        up: (db: any) => {
            console.log('Running Migration v33 (patient-detail, all-visits, and request reads)...');
            // PR96 review (P1): central enforcement guards getPatientById,
            // getAllVisits, and getAppointmentRequests, but no seed or v32
            // grant covers them. Patient details, the Visits page, and the
            // dashboard call these for every desk role, so denying them
            // breaks legitimate flows. updateAppointmentRequestStatus is
            // included: the online-booking Accept flow creates the
            // appointment before marking the request accepted, so denying
            // the status update leaves the request pending and a retry
            // creates a duplicate appointment. Additive (not a v32 edit)
            // so clinics that already applied v32 are repaired too.
            const grants: Record<string, string[]> = {
                doctor: ['getPatientById', 'getAllVisits', 'getAppointmentRequests', 'updateAppointmentRequestStatus'],
                receptionist: ['getPatientById', 'getAllVisits', 'getAppointmentRequests', 'updateAppointmentRequestStatus'],
                nurse: ['getPatientById', 'getAllVisits', 'getAppointmentRequests', 'updateAppointmentRequestStatus']
            };
            grantRoleMethods(db, grants);
        }
    },
    {
        version: 34,
        up: (db: any) => {
            console.log('Running Migration v34 (app metadata store)...');
            // Generic key-value store for clinic-level state that is not
            // settings (demo-seed snapshot, feature flags). Keeps seed
            // tracking out of the settings whitelist.
            db.exec(`
                CREATE TABLE IF NOT EXISTS app_meta (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL,
                    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                );
            `);
        }
    },
    {
        version: 35,
        up: (db: any) => {
            console.log('Running Migration v35 (patient identity: MRN, DOB estimate, merge link)...');
            try { db.exec('ALTER TABLE patients ADD COLUMN mrn TEXT'); } catch (e) { }
            try { db.exec('ALTER TABLE patients ADD COLUMN dob_estimated INTEGER NOT NULL DEFAULT 0'); } catch (e) { }
            try { db.exec('ALTER TABLE patients ADD COLUMN merged_into INTEGER NULL'); } catch (e) { }
            // Backfill clinic MRNs for existing rows before the unique index.
            // PREFIX-<rowid offset, zero-padded to at least 6>: immutable and
            // collision-free by construction (rowids are unique; the width
            // grows rather than wrapping past 900k rows).
            db.exec(`UPDATE patients SET mrn = 'ND-' || printf('%06d', 100000 + id)
                WHERE mrn IS NULL OR mrn = ''`);
            db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_patients_mrn ON patients(mrn)');
            // Configurable MRN prefix for newly registered patients.
            try { db.exec(`ALTER TABLE settings ADD COLUMN mrn_prefix TEXT DEFAULT 'ND'`); } catch (e) { }
            // Duplicate-warning search rides the registration flow desk roles
            // already hold (getPatients/savePatient).
            grantRoleMethods(db, {
                doctor: ['findDuplicateCandidates'],
                receptionist: ['findDuplicateCandidates']
            });
        }
    },
    {
        version: 36,
        up: (db: any) => {
            console.log('Running Migration v36 (patient merge ledger)...');
            // Reversible merge ledger: every moved row recorded so unmerge
            // replays exactly. Merge itself is doctor/admin-only (grants).
            db.exec(`
                CREATE TABLE IF NOT EXISTS patient_merges (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    survivor_id INTEGER NOT NULL,
                    duplicate_id INTEGER NOT NULL,
                    reason TEXT NOT NULL,
                    merged_by INTEGER NULL,
                    moved_abha_address TEXT NULL,
                    moved_abha_name TEXT NULL,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    undone_at TEXT NULL
                );
            `);
            db.exec(`
                CREATE TABLE IF NOT EXISTS patient_merge_items (
                    merge_id INTEGER NOT NULL,
                    table_name TEXT NOT NULL,
                    id_column TEXT NOT NULL DEFAULT 'id',
                    row_id TEXT NOT NULL
                );
            `);
            db.exec(`CREATE INDEX IF NOT EXISTS idx_merge_items_merge
                ON patient_merge_items(merge_id)`);
            grantRoleMethods(db, {
                doctor: ['previewPatientMerge', 'mergePatients', 'unmergePatients'],
                admin: ['previewPatientMerge', 'mergePatients', 'unmergePatients']
            });
        }
    },
    {
        version: 37,
        up: (db: any) => {            console.log('Running Migration v37 (billing ledger)...');
            // Immutable money trail: invoices with charge lines, payments as
            // append-only rows (refunds/reversals are rows, never edits),
            // receipt identity per payment. Corrections never overwrite.
            db.exec(`
                CREATE TABLE IF NOT EXISTS invoices (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    number TEXT UNIQUE,
                    visit_id INTEGER NOT NULL,
                    patient_id INTEGER NOT NULL,
                    status TEXT NOT NULL DEFAULT 'unpaid',
                    subtotal REAL NOT NULL DEFAULT 0,
                    discount REAL NOT NULL DEFAULT 0,
                    tax REAL NOT NULL DEFAULT 0,
                    total REAL NOT NULL DEFAULT 0,
                    void_reason TEXT NULL,
                    created_by INTEGER NULL,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                );
            `);
            db.exec(`
                CREATE TABLE IF NOT EXISTS invoice_items (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    invoice_id INTEGER NOT NULL,
                    description TEXT NOT NULL,
                    quantity REAL NOT NULL DEFAULT 1,
                    rate REAL NOT NULL DEFAULT 0,
                    amount REAL NOT NULL DEFAULT 0
                );
            `);
            db.exec(`
                CREATE TABLE IF NOT EXISTS payments (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    receipt_no TEXT UNIQUE,
                    invoice_id INTEGER NOT NULL,
                    kind TEXT NOT NULL DEFAULT 'payment',
                    amount REAL NOT NULL DEFAULT 0,
                    method TEXT NOT NULL DEFAULT 'cash',
                    reference TEXT NULL,
                    reason TEXT NULL,
                    reversal_of INTEGER NULL,
                    client_key TEXT UNIQUE NULL,
                    received_by INTEGER NULL,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                );
            `);
            db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_number ON invoices(number)`);
            db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_receipt ON payments(receipt_no)`);
            try { db.exec(`ALTER TABLE settings ADD COLUMN consultation_fee REAL DEFAULT 0`); } catch (e) { }
            const billing = ['getInvoice', 'getVisitInvoices', 'createInvoice',
                'recordPayment', 'refundPayment', 'voidInvoice'];
            grantRoleMethods(db, {
                doctor: billing,
                receptionist: billing,
                admin: billing
            });
        }
    },
    {
        version: 38,
        up: (db: any) => {
            console.log('Running Migration v38 (record lifecycle: archive, correction)...');
            // Soft lifecycle instead of hard deletes: charts deactivate with
            // reason, visits mark entered-in-error with reason. Rows stay
            // for history, audit, and merges; purge is a separate op.
            try { db.exec('ALTER TABLE patients ADD COLUMN active INTEGER NOT NULL DEFAULT 1'); } catch (e) { }
            try { db.exec('ALTER TABLE patients ADD COLUMN archive_reason TEXT'); } catch (e) { }
            try { db.exec('ALTER TABLE visits ADD COLUMN correction_reason TEXT'); } catch (e) { }
            // Encounter-integrity triggers whitelist statuses: admit the
            // entered-in-error lifecycle state alongside in-progress/finished.
            db.exec('DROP TRIGGER IF EXISTS trg_visits_status_insert');
            db.exec('DROP TRIGGER IF EXISTS trg_visits_status_update');
            db.exec(`
                CREATE TRIGGER trg_visits_status_insert
                BEFORE INSERT ON visits
                WHEN NEW.status IS NULL OR NEW.status NOT IN ('in-progress', 'finished', 'entered-in-error')
                BEGIN SELECT RAISE(ABORT, 'Invalid encounter status'); END;
            `);
            db.exec(`
                CREATE TRIGGER trg_visits_status_update
                BEFORE UPDATE OF status ON visits
                WHEN NEW.status IS NULL OR NEW.status NOT IN ('in-progress', 'finished', 'entered-in-error')
                BEGIN SELECT RAISE(ABORT, 'Invalid encounter status'); END;
            `);
            const deskLifecycle = ['archivePatient', 'unarchivePatient', 'getArchivedPatients'];
            const clinicalCorrection = ['markVisitEnteredInError'];
            grantRoleMethods(db, {
                doctor: [...deskLifecycle, ...clinicalCorrection],
                receptionist: [...deskLifecycle],
                admin: [...deskLifecycle, ...clinicalCorrection, 'purgeUser']
            });
        }
    },
    {
        version: 39,
        up: (db: any) => {
            console.log('Running Migration v39 (flexible patient identifiers)...');
            // Multi-system identifiers (issue #55): one chart can carry a
            // clinic MRN, an ABHA number / address, insurance and free-form
            // ids at once. Single-column patients.mrn / abha_address stay
            // as the fast path; this table is the extensible registry.
            db.exec(`
                CREATE TABLE IF NOT EXISTS patient_identifiers (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    patient_id INTEGER NOT NULL REFERENCES patients(id),
                    system TEXT NOT NULL,
                    type_code TEXT,
                    value TEXT NOT NULL,
                    is_primary INTEGER NOT NULL DEFAULT 0,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                );
            `);
            db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_patient_identifiers_system_value
                ON patient_identifiers(system, value);`);
            db.exec(`CREATE INDEX IF NOT EXISTS idx_patient_identifiers_patient
                ON patient_identifiers(patient_id);`);
            // Nationally-unique ABHA number column on the chart itself.
            try { db.exec('ALTER TABLE patients ADD COLUMN abha_number TEXT'); } catch (e) { }
            db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_patients_abha_number
                ON patients(abha_number) WHERE abha_number IS NOT NULL;`);
            // Backfill the registry from the fast-path columns so search
            // and duplicate detection see one source of truth.
            db.exec(`
                INSERT OR IGNORE INTO patient_identifiers (patient_id, system, value, is_primary)
                SELECT id, 'mrn', mrn, 1 FROM patients
                WHERE mrn IS NOT NULL AND mrn != '';
            `);
            db.exec(`
                INSERT OR IGNORE INTO patient_identifiers (patient_id, system, value, is_primary)
                SELECT id, 'abha-address', abha_address, 0 FROM patients
                WHERE abha_address IS NOT NULL AND abha_address != '';
            `);
            const identifierMethods = ['getIdentifiers', 'saveIdentifier', 'deleteIdentifier'];
            grantRoleMethods(db, {
                doctor: identifierMethods,
                receptionist: identifierMethods,
                admin: identifierMethods
            });
        }
    },
    {
        version: 40,
        up: (db: any) => {
            console.log('Running Migration v40 (catalog enrichment: generics, ICD-10)...');
            // NMC generic-first prescribing (issue #56): catalog rows carry
            // the generic composition alongside the brand, and conditions
            // carry ICD-10. SNOMED columns exist for future mapping; seeds
            // leave them NULL rather than guess codes.
            try { db.exec('ALTER TABLE medicine_catalog ADD COLUMN generic_name TEXT'); } catch (e) { }
            try { db.exec('ALTER TABLE medicine_catalog ADD COLUMN brand_name TEXT'); } catch (e) { }
            try { db.exec('ALTER TABLE medicine_catalog ADD COLUMN snomed_form_code TEXT'); } catch (e) { }
            try { db.exec('ALTER TABLE medicine_catalog ADD COLUMN snomed_route_code TEXT'); } catch (e) { }
            try { db.exec('ALTER TABLE condition_catalog ADD COLUMN icd10_code TEXT'); } catch (e) { }
            try { db.exec('ALTER TABLE condition_catalog ADD COLUMN snomed_code TEXT'); } catch (e) { }
            try { db.exec('ALTER TABLE condition_catalog ADD COLUMN icd11_code TEXT'); } catch (e) { }
            const insertCondition = db.prepare(`INSERT OR IGNORE INTO condition_catalog
                (name, icd10_code, active, created_at, updated_at)
                VALUES (?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`);
            const stampCondition = db.prepare(`UPDATE condition_catalog
                SET icd10_code = ? WHERE name = ? AND (icd10_code IS NULL OR icd10_code = '')`);
            for (const [name, icd10] of SEED_CONDITIONS) {
                insertCondition.run(name, icd10);
                stampCondition.run(icd10, name);
            }
            const insertMedicine = db.prepare(`INSERT OR IGNORE INTO medicine_catalog
                (name, generic_name, brand_name, form, dosage, route, frequency, duration, instruction,
                 active, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`);
            const stampMedicine = db.prepare(`UPDATE medicine_catalog
                SET generic_name = ?, brand_name = ? WHERE name = ? AND (generic_name IS NULL OR generic_name = '')`);
            for (const [name, generic, brand, form, dosage] of SEED_MEDICINES) {
                insertMedicine.run(name, generic, brand, form, dosage, 'Oral', '1-0-1', '3 days', 'After Food');
                stampMedicine.run(generic, brand, name);
            }
            // NLEM 2022 generics (384): every essential generic exists as a
            // searchable row even without brand or strength detail. Curated
            // rows above win on detail; this only fills the gaps.
            const ensureNlem = db.prepare(`INSERT OR IGNORE INTO medicine_catalog
                (name, generic_name, active, created_at, updated_at)
                VALUES (?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`);
            for (const generic of NLEM_2022_GENERICS) {
                ensureNlem.run(generic, generic);
            }
        }
    }
];

/**
 * Essential outpatient conditions with ICD-10 (issue #56 seed core).
 * Curated, extensible: append rows, never edit shipped ones.
 */
const SEED_CONDITIONS: Array<[string, string]> = [
    ['Essential hypertension', 'I10'],
    ['Type 2 diabetes mellitus', 'E11.9'],
    ['Type 1 diabetes mellitus', 'E10.9'],
    ['Acute upper respiratory infection', 'J06.9'],
    ['Acute pharyngitis', 'J02.9'],
    ['Acute bronchitis', 'J20.9'],
    ['Asthma', 'J45.909'],
    ['COPD', 'J44.9'],
    ['Pneumonia', 'J18.9'],
    ['Chronic sinusitis', 'J32.9'],
    ['Allergic rhinitis', 'J30.9'],
    ['Chronic rhinitis', 'J31.0'],
    ['Gastritis', 'K29.70'],
    ['Gastro-oesophageal reflux disease', 'K21.9'],
    ['Dyspepsia', 'K30'],
    ['Irritable bowel syndrome', 'K58.9'],
    ['Constipation', 'K59.00'],
    ['Infectious diarrhoea', 'A09'],
    ['Typhoid fever', 'A01.00'],
    ['Malaria', 'B54'],
    ['Dengue fever', 'A90'],
    ['Chickenpox', 'B01.9'],
    ['Measles', 'B05.9'],
    ['Mumps', 'B26.9'],
    ['Anaemia', 'D64.9'],
    ['Iron deficiency anaemia', 'D50.9'],
    ['Hypothyroidism', 'E03.9'],
    ['Hyperthyroidism', 'E05.90'],
    ['Obesity', 'E66.9'],
    ['Hyperlipidaemia', 'E78.5'],
    ['Polycystic ovarian syndrome', 'E28.2'],
    ['Migraine', 'G43.909'],
    ['Tension headache', 'G44.209'],
    ['Headache', 'R51'],
    ['Fever', 'R50.9'],
    ['Cough', 'R05'],
    ['Abdominal pain', 'R10.9'],
    ['Dizziness', 'R42'],
    ['Low back pain', 'M54.50'],
    ['Osteoarthritis', 'M19.90'],
    ['Rheumatoid arthritis', 'M05.9'],
    ['Urinary tract infection', 'N39.0'],
    ['Kidney stone', 'N20.0'],
    ['Dysmenorrhoea', 'N94.6'],
    ['Vaginitis', 'N76.0'],
    ['Eczema', 'L30.9'],
    ['Urticaria', 'L50.9'],
    ['Itching of skin', 'L29.9'],
    ['Scabies', 'B86'],
    ['Conjunctivitis', 'H10.9'],
    ['Otitis media', 'H66.90'],
    ['Dental caries', 'K02.9'],
    ['Anxiety', 'F41.9'],
    ['Depression', 'F32.9'],
    ['Insomnia', 'G47.00'],
    ['Coronary artery disease', 'I25.10'],
    ['Heart failure', 'I50.9'],
    ['Stroke', 'I63.9']
];

/**
 * Essential medicines: brand row name, generic composition, common form
 * and strength (issue #56 seed core). Brands are widespread Indian
 * examples; the generic column is the normative one.
 */
const SEED_MEDICINES: Array<[string, string, string, string, string]> = [
    ['Crocin 500', 'Paracetamol', 'Crocin', 'Tab', '500mg'],
    ['Dolo 650', 'Paracetamol', 'Dolo', 'Tab', '650mg'],
    ['Brufen 400', 'Ibuprofen', 'Brufen', 'Tab', '400mg'],
    ['Voveran 50', 'Diclofenac', 'Voveran', 'Tab', '50mg'],
    ['Azithral 500', 'Azithromycin', 'Azithral', 'Tab', '500mg'],
    ['Moxikind 500', 'Amoxicillin', 'Moxikind', 'Cap', '500mg'],
    ['Augmentin 625', 'Amoxicillin + Clavulanate', 'Augmentin', 'Tab', '625mg'],
    ['Zifi 200', 'Cefixime', 'Zifi', 'Tab', '200mg'],
    ['Metrogyl 400', 'Metronidazole', 'Metrogyl', 'Tab', '400mg'],
    ['Cetzine 10', 'Cetirizine', 'Cetzine', 'Tab', '10mg'],
    ['Lorfast 10', 'Loratadine', 'Lorfast', 'Tab', '10mg'],
    ['Montair 10', 'Montelukast', 'Montair', 'Tab', '10mg'],
    ['Asthalin inhaler', 'Salbutamol', 'Asthalin', 'Inhaler', '100mcg'],
    ['Omez 20', 'Omeprazole', 'Omez', 'Cap', '20mg'],
    ['Pantocid 40', 'Pantoprazole', 'Pantocid', 'Tab', '40mg'],
    ['Domstal 10', 'Domperidone', 'Domstal', 'Tab', '10mg'],
    ['Emeset 4', 'Ondansetron', 'Emeset', 'Tab', '4mg'],
    ['Electral powder', 'Oral rehydration salts', 'Electral', 'Powder', '21.8g'],
    ['Glycomet 500', 'Metformin', 'Glycomet', 'Tab', '500mg'],
    ['Amaryl 1', 'Glimepiride', 'Amaryl', 'Tab', '1mg'],
    ['Atorva 10', 'Atorvastatin', 'Atorva', 'Tab', '10mg'],
    ['Amlopress 5', 'Amlodipine', 'Amlopress', 'Tab', '5mg'],
    ['Losar 50', 'Losartan', 'Losar', 'Tab', '50mg'],
    ['Metolar 50', 'Metoprolol', 'Metolar', 'Tab', '50mg'],
    ['Ecosprin 75', 'Aspirin', 'Ecosprin', 'Tab', '75mg'],
    ['Clopilet 75', 'Clopidogrel', 'Clopilet', 'Tab', '75mg'],
    ['Thyrox 50', 'Levothyroxine', 'Thyrox', 'Tab', '50mcg'],
    ['Wysolone 5', 'Prednisolone', 'Wysolone', 'Tab', '5mg'],
    ['Decadron 0.5', 'Dexamethasone', 'Decadron', 'Tab', '0.5mg'],
    ['Flucos 150', 'Fluconazole', 'Flucos', 'Cap', '150mg'],
    ['Permite 5%', 'Permethrin', 'Permite', 'Cream', '5%'],
    ['Betadine ointment', 'Povidone-iodine', 'Betadine', 'Oint', '10%'],
    ['Calamine lotion', 'Calamine + Zinc oxide', 'Calamine', 'Lotion', '8%+8%'],
    ['Becosules', 'B-complex + Vitamin C', 'Becosules', 'Cap', '1 cap'],
    ['Shelcal', 'Calcium + Vitamin D3', 'Shelcal', 'Tab', '500mg+250IU'],
    ['Uprise-D3', 'Cholecalciferol', 'Uprise-D3', 'Cap', '60k IU'],
    ['Autrin', 'Ferrous sulfate + Folic acid', 'Autrin', 'Cap', '150mg+0.5mg'],
    ['Mecobalamin 500', 'Methylcobalamin', 'Nurokind', 'Tab', '500mcg']
];
