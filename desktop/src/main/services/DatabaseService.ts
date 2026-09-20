import { MIGRATIONS } from '../schema/migrations';
import * as catalog from '../catalog/catalogStore';
import { assertValidVitals, DEFAULT_VITAL_UNITS, evaluateVitalsAbnormalities } from '../../shared/vitals-validator';

export class DatabaseService {
    private db: any;
    private fenced = false;
    private inFlight = 0;
    private drain: Array<() => void> = [];

    setDb(db: any) {
        this.db = db;
    }

    beginWork(): void {
        if (this.fenced) throw new Error('RESTORE_IN_PROGRESS');
        this.inFlight++;
    }

    endWork(): void {
        if (this.inFlight > 0) this.inFlight--;
        if (this.inFlight === 0) {
            const waiters = this.drain.splice(0);
            for (const done of waiters) done();
        }
    }

    async fence(timeoutMs = 10_000): Promise<void> {
        this.fenced = true;
        if (this.inFlight === 0) return;
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                const index = this.drain.indexOf(onIdle);
                if (index >= 0) this.drain.splice(index, 1);
                reject(new Error('RESTORE_DRAIN_TIMEOUT'));
            }, timeoutMs);
            const onIdle = () => {
                clearTimeout(timer);
                resolve();
            };
            this.drain.push(onIdle);
        });
    }

    unfence(): void {
        this.fenced = false;
    }

    async runWork<T>(work: () => T | Promise<T>): Promise<T> {
        this.beginWork();
        try { return await work(); }
        finally { this.endWork(); }
    }

    private async createBackup(dbName: string) {
        if (!dbName || dbName === ':memory:') return;

        const backupName = `${dbName}.bak`;
        // Delete existing backup to prevent "incompatible source and target" errors 
        // if the schema/key changed since the last backup.
        try {
            const fs = require('node:fs');
            if (fs.existsSync(backupName)) {
                fs.unlinkSync(backupName);
                console.log(`[DB] Deleted old backup: ${backupName}`);
            }
        } catch (e) {
            console.warn('[DB] Failed to delete old backup:', e);
        }

        console.log(`[DB] Backing up manual snapshot to ${backupName}...`);
        // Use VACUUM INTO for encrypted DB safety
        try {
            this.db.prepare(`VACUUM INTO ?`).run(backupName);
            console.log('[DB] Backup (VACUUM INTO) complete.');
        } catch (e: any) {
            console.warn('[DB] VACUUM INTO failed during migration backup, trying fallback...', e);
            await this.db.backup(backupName);
        }
    }

    async migrate(options: { skipBackup?: boolean } = {}) {
        if (!this.db) throw new Error('DB not initialized');

        // Safety: Backup before migrating
        if (!options.skipBackup) {
            try {
                await this.createBackup(this.db.name);
            } catch (e) {
                console.error('[DB] Backup failed! Proceeding with caution...', e);
                // Optional: Throw if backup is critical? For now, log and proceed (or user can't login).
            }
        }

        // Check Version
        const currentVersion = this.db.pragma('user_version', { simple: true });
        console.log(`[DB] Current Schema Version: ${currentVersion}`);

        // Transactional Migration
        const runMigrations = this.db.transaction(() => {
            for (const migration of MIGRATIONS) {
                if (migration.version > currentVersion) {
                    console.log(`[DB] Migrating to v${migration.version}...`);
                    migration.up(this.db);
                    this.db.pragma(`user_version = ${migration.version}`);
                }
            }
        });

        try {
            runMigrations();
            console.log(`[DB] Migration check complete. Version: ${this.db.pragma('user_version', { simple: true })}`);
        } catch (err) {
            console.error('[DB] MIGRATION FAILED! Rolling back transaction.', err);
            throw err; // Critical failure
        }
    }

    async backupDatabase(destPath: string) {
        if (!this.db) throw new Error('DB not initialized');
        console.log(`[DB] Starting backup to ${destPath}...`);

        // Remove destination if exists (VACUUM INTO requires non-existent target)
        const fs = require('node:fs');
        if (fs.existsSync(destPath)) {
            try { fs.unlinkSync(destPath); } catch (e) { console.warn('Failed to delete existing backup target', e); }
        }

        try {
            // Use VACUUM INTO for encrypted DB compatibility
            this.db.prepare(`VACUUM INTO ?`).run(destPath);
            console.log(`[DB] Backup to ${destPath} completed.`);
        } catch (e: any) {
            console.error('[DB] VACUUM INTO failed, trying fallback to backup API...', e);
            // Fallback (might fail with same error, but worth a shot if VACUUM fails for other reasons)
            await this.db.backup(destPath);
        }
    }

    async ensureAdminUser(password: string) {
        const admin = this.db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
        if (!admin) {
            const hash = await import('argon2').then(a => a.hash(password));
            this.db.prepare('INSERT INTO users (username, password, role, name) VALUES (?, ?, ?, ?)').run('admin', hash, 'admin', 'Administrator');
            console.log('Default admin user created.');
        } else {
            // Existing login credentials are never changed by provisioning or
            // database-key operations. CredentialRotationService owns changes.
            console.log('Administrator already provisioned; login password preserved.');
        }

        // Migration: Add doctor fields to users if missing
        try { this.db.exec(`ALTER TABLE users ADD COLUMN specialty TEXT`); } catch (e) { }
        try { this.db.exec(`ALTER TABLE users ADD COLUMN license_number TEXT`); } catch (e) { }
    }

    // ... existing Settings methods ...

    // Users
    getUsers() {
        return this.db.prepare('SELECT id, username, role, name, active, created_at, designation, mobile, email, joining_date FROM users ORDER BY created_at DESC').all();
    }

    getUserByUsername(username: string) {
        return this.db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    }

    async validateUser(username: string, passwordTry: string) {
        const user = this.getUserByUsername(username);
        if (!user) { console.log('[DB] User not found:', username); return { success: false, error: 'INVALID_CREDENTIALS' }; }
        if (user.active !== 1) { console.log('[DB] User inactive:', username, user.active); return { success: false, error: 'ACCESS_DENIED' }; }

        const argon2 = await import('argon2');
        try {
            if (await argon2.verify(user.password, passwordTry)) {
                return {
                    success: true,
                    user: {
                        id: user.id,
                        username: user.username,
                        role: user.role,
                        name: user.name,
                        password_reset_required: user.password_reset_required
                    }
                };
            }
        } catch (e) {
            console.error('Password verify failed', e);
        }
        return { success: false, error: 'INVALID_CREDENTIALS' };
    }

    async saveUser(user: any, actingUserId?: number) {
        const argon2 = await import('argon2');

        // Prepare optional fields to ensure they aren't undefined
        const safeUser = {
            specialty: null, license_number: null,
            mobile: null, email: null, designation: null, joining_date: null,
            address: null, emergency_contact_name: null, emergency_contact_phone: null,
            password_reset_required: 0,
            active: 1,
            ...user
        };

        const result = user.id
            ? await this.updateExistingUser(safeUser, user, actingUserId)
            : await this.insertNewUser(safeUser, argon2, actingUserId);

        return result;
    }

    private async updateExistingUser(safeUser: any, user: any, actingUserId?: number) {
        const existing = this.db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
        if (!existing) throw new Error('User not found');
        if (Object.prototype.hasOwnProperty.call(user, 'password')) {
            throw new Error('GENERIC_PASSWORD_CHANGE_FORBIDDEN');
        }

        const query = this.buildUpdateQuery();
        const result = this.db.prepare(query).run(safeUser);

        if (actingUserId) {
            this.logAudit('USER_UPDATE', 'users', user.id, actingUserId, `Updated user ${user.username}`);
        }
        return result;
    }

    private buildUpdateQuery(): string {
        const baseCols = `role = @role, name = @name, active = @active, specialty = @specialty, license_number = @license_number,
            mobile = @mobile, email = @email, designation = @designation, joining_date = @joining_date,
            address = @address, emergency_contact_name = @emergency_contact_name, emergency_contact_phone = @emergency_contact_phone`;

        return `UPDATE users SET ${baseCols} WHERE id = @id`;
    }

    private async insertNewUser(safeUser: any, argon2: any, actingUserId?: number) {
        if (!safeUser.password) throw new Error('Password required for new user');

        console.log(`[DB] Creating user ${safeUser.username}`);
        safeUser.password = await argon2.hash(safeUser.password);
        if (safeUser.role) safeUser.role = safeUser.role.toLowerCase();

        // New users always require password reset if created by Admin
        safeUser.password_reset_required = 1;

        const result = this.db.prepare(`
            INSERT INTO users(
                username, password, role, name, active, specialty, license_number,
                mobile, email, designation, joining_date, address, emergency_contact_name, emergency_contact_phone,
                password_reset_required
            )
            VALUES(
                @username, @password, @role, @name, @active, @specialty, @license_number,
                @mobile, @email, @designation, @joining_date, @address, @emergency_contact_name, @emergency_contact_phone,
                @password_reset_required
            )
        `).run(safeUser);

        if (actingUserId) {
            this.logAudit('USER_CREATE', 'users', result.lastInsertRowid, actingUserId, `Created user ${safeUser.username}`);
        }
        return result;
    }

    deleteUser(id: number, actingUserId?: number) {
        // Prevent deleting the admin user
        const user = this.db.prepare('SELECT username FROM users WHERE id = ?').get(id);
        if (user?.username === 'admin') {
            throw new Error('Cannot delete the admin user.');
        }

        // Soft delete preferred? For now we hard delete as per interface, 
        // but normally we should set active=0. 
        // However, 'active' flag usage in getDoctors/validateUser suggests soft delete support.
        // Let's switch to proper soft delete or keep hard delete but audit it.
        // User request implied "Deactivating".
        // Let's do Soft Delete if possible or stick to hard delete for now but log it.
        // Actually, let's allow 'deactivation' via saveUser (active=0).
        // This deleteUser method is likely the "Permanent Delete" button.
        const result = this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
        if (actingUserId) {
            this.logAudit('USER_DELETE', 'users', id, actingUserId, `Deleted user ${id}`);
        }
        return result;
    }

    // ... existing methods ...
    getSettings() {
        return this.db.prepare('SELECT * FROM settings LIMIT 1').get();
    }

    // ... (existing code)

    getPublicSettings() {
        return this.db.prepare('SELECT clinic_name, doctor_name, logo_path, cloud_enabled FROM settings LIMIT 1').get();
    }

    // RBAC
    getPermissions(role: string): string[] {
        const result = this.db.prepare('SELECT permissions FROM roles WHERE name = ?').get(role);
        if (result && result.permissions) {
            try { return JSON.parse(result.permissions); } catch (e) { return []; }
        }
        return [];
    }

    getAllRoles() {
        return this.db.prepare('SELECT * FROM roles').all().map((r: any) => {
            try {
                return {
                    name: r.name,
                    permissions: JSON.parse(r.permissions)
                };
            } catch (e) {
                console.warn(`[DB] Failed to parse permissions for role ${r.name}`, e);
                return { name: r.name, permissions: [] };
            }
        });
    }

    saveRole(name: string, permissions: string[]) {
        const json = JSON.stringify(permissions);
        return this.db.prepare('INSERT INTO roles (name, permissions) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET permissions = excluded.permissions').run(name, json);
    }

    saveSettings(settings: any) {
        // ... (existing code)
        const existing = this.getSettings();

        // Allowed columns whitelist to prevent SQL injection
        const ALLOWED_COLUMNS = [
            'clinic_name', 'doctor_name', 'logo_path', 'license_key',
            'drive_tokens', 'cloud_clinic_id', 'cloud_api_key', 'cloud_enabled',
            'drive_client_id', 'drive_client_secret', 'local_backup_path',
            'abdm_gateway_env', 'abdm_client_id', 'abdm_mock',
            'abdm_hip_id', 'abdm_counter_id'
        ];

        // Filter incoming settings to only allowed columns
        const validKeys = Object.keys(settings).filter(k => ALLOWED_COLUMNS.includes(k));

        if (validKeys.length === 0) return; // Nothing to update/insert

        if (existing) {
            // Build dynamic update query using whitelisted keys
            const setClause = validKeys.map(k => `${k} = @${k}`).join(', ');
            // We must pass only the valid properties to .run() to match the placeholders
            const params: any = {};
            validKeys.forEach(k => params[k] = settings[k]);

            this.db.prepare(`UPDATE settings SET ${setClause}`).run(params);
        } else {
            // First insert
            const placeholders = validKeys.map(k => `@${k}`).join(', ');
            const cols = validKeys.join(', ');

            const params: any = {};
            validKeys.forEach(k => params[k] = settings[k]);

            this.db.prepare(`INSERT INTO settings(${cols}) VALUES(${placeholders})`).run(params);
        }
    }

    // Dedicated writer for the keychain-protected ABDM client secret. Kept out    // of the generic settings whitelist (and reads) by design: the plaintext
    // secret never crosses the generic settings path in either direction.
    saveAbdmSecretProtected(protectedValue: string) {
        const existing = this.getSettings();
        if (existing) {
            this.db.prepare('UPDATE settings SET abdm_client_secret_protected = ?').run(protectedValue);
        } else {
            this.db.prepare('INSERT INTO settings(abdm_client_secret_protected) VALUES(?)').run(protectedValue);
        }
    }

    getDashboardStats() {        const totalPatients = this.db.prepare('SELECT count(*) as count FROM patients').get().count;
        // Today's visits: date >= start of day
        const today = new Date().toISOString().split('T')[0];
        const todayVisits = this.db.prepare("SELECT count(*) as count FROM visits WHERE date(date) = ? AND status = 'finished'").get(today).count;
        return { totalPatients, todayVisits };
    }

    // Doctors
    getDoctors() {
        return this.db.prepare(`SELECT * FROM users WHERE role = 'doctor' AND active = 1`).all();
    }

    // Patients
    getPatients(query: string = '') {
        if (!query) {
            return this.db.prepare('SELECT * FROM patients ORDER BY created_at DESC LIMIT 50').all();
        }
        const search = `%${query.trim()}%`;
        return this.db.prepare(`
        SELECT * FROM patients 
      WHERE name LIKE ? OR mobile LIKE ?
            ORDER BY created_at DESC
                `).all(search, search);
    }

    getPatientById(id: number) {
        return this.db.prepare('SELECT * FROM patients WHERE id = ?').get(id);
    }

    // Links (or unlinks with nulls) a verified ABHA address to a patient.
    // Address shape is validated here so every writer shares one rule.
    linkAbhaAddress(patientId: number, link: { abhaAddress?: string | null; abhaName?: string | null }, actingUserId?: number) {
        const id = Number(patientId);
        if (!Number.isInteger(id) || id <= 0) throw new Error('Valid patient id is required.');
        const address = link?.abhaAddress == null ? null : String(link.abhaAddress).trim();
        if (address !== null && !/^[\w.-]+@[A-Za-z]{2,}$/.test(address)) {
            throw new Error('Health ID looks invalid. Use the format name@abdm.');
        }
        const name = link?.abhaName == null ? null : String(link.abhaName).trim() || null;
        if (address !== null) {
            const clash = this.db.prepare(
                'SELECT id FROM patients WHERE abha_address IS NOT NULL AND LOWER(abha_address) = LOWER(?) AND id != ? LIMIT 1'
            ).get(address, id) as any;
            if (clash) {
                throw new Error('This health ID is already linked to another patient record.');
            }
        }
        this.db.prepare('UPDATE patients SET abha_address = ?, abha_name = ? WHERE id = ?').run(address, name, id);
        this.logAudit('ABHA_LINK', 'patients', id, actingUserId,
            address ? `Linked health ID ${address}` : 'Removed health ID link');
        return this.getPatientById(id);
    }

    findPatientByAbhaAddress(address: string) {
        const value = String(address || '').trim();
        if (!value) return null;
        return this.db.prepare(
            'SELECT * FROM patients WHERE abha_address IS NOT NULL AND LOWER(abha_address) = LOWER(?) LIMIT 1'
        ).get(value) ?? null;
    }

    // LAN-facing aliases: browser sessions call these names through
    // /api/ipc; they delegate to the canonical operations above.
    abdmGetShareTokens() {
        return this.getPendingShareTokens();
    }

    findPatientByAbha(payload: any) {
        const args = payload || {};
        return this.findPatientByAbhaAddress(args.abhaAddress);
    }

    abdmAcceptShareToken(payload: any, actingUserId?: number) {
        const args = payload || {};
        return this.acceptShareToken(args.tokenId ?? args.id, actingUserId);
    }

    // Scan & Share intake: stores a gateway profile-share callback as a
    // numbered queue token. Numbers restart daily; tokens expire after
    // 15 minutes so a stale scan never blocks the dock.
    receiveAbhaShare(payload: any, actingUserId?: number) {
        const name = String(payload?.name || payload?.patientName || '').trim();
        if (!name) throw new Error('Shared profile must include a patient name.');
        if (name.length > 200) throw new Error('Shared profile name is too long.');
        const abhaAddress = payload?.abhaAddress ? String(payload.abhaAddress).trim() : null;
        if (abhaAddress && (abhaAddress.length > 100 || !/^[\w.-]+@[A-Za-z]{2,}$/.test(abhaAddress))) {
            throw new Error('Shared profile health ID looks invalid.');
        }
        const mobile = payload?.mobile ? String(payload.mobile).trim() : null;
        if (mobile && mobile.length > 20) throw new Error('Shared profile mobile number is too long.');
        const record = this.db.transaction(() => {
            const today = (this.db.prepare(`SELECT date('now', 'localtime') AS today`).get() as any).today;
            const maxNo = (this.db.prepare(
                'SELECT COALESCE(MAX(token_no), 0) AS maxNo FROM abdm_share_tokens WHERE token_date = ?'
            ).get(today) as any).maxNo;
            const result = this.db.prepare(`
                INSERT INTO abdm_share_tokens (
                    token_no, token_date, patient_name, age, gender, mobile,
                    abha_address, abha_name, raw_payload, status, expires_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', datetime('now', '+15 minutes'))
            `).run(
                Number(maxNo) + 1,
                today,
                name,
                payload?.age != null ? Number(payload.age) : null,
                payload?.gender ? String(payload.gender) : null,
                payload?.mobile ? String(payload.mobile) : null,
                payload?.abhaAddress ? String(payload.abhaAddress) : null,
                payload?.abhaName ? String(payload.abhaName) : null,
                JSON.stringify(payload || {})
            );
            const row = this.db.prepare('SELECT * FROM abdm_share_tokens WHERE id = ?')
                .get(Number(result.lastInsertRowid));
            this.logAudit('INSERT', 'abdm_share_tokens', Number(result.lastInsertRowid),
                actingUserId, `Scan & Share token #${Number(maxNo) + 1} for ${name}`);
            return row;
        });
        return record.immediate();
    }

    getPendingShareTokens() {
        this.db.prepare(`UPDATE abdm_share_tokens SET status = 'expired'
            WHERE status = 'pending' AND expires_at <= CURRENT_TIMESTAMP`).run();
        return this.db.prepare(`SELECT * FROM abdm_share_tokens
            WHERE status = 'pending' ORDER BY id ASC`).all();
    }

    acceptShareToken(id: number, actingUserId?: number) {
        const accept = this.db.transaction(() => {
            const token = this.db.prepare('SELECT * FROM abdm_share_tokens WHERE id = ?').get(Number(id)) as any;
            if (!token || token.status !== 'pending') {
                throw new Error('Token was already handled or has expired.');
            }
            // The listing sweep may not have run since expiry: enforce the
            // deadline inside the acceptance transaction itself.
            const expired = this.db.prepare(`SELECT 1 FROM abdm_share_tokens
                WHERE id = ? AND expires_at <= CURRENT_TIMESTAMP`).get(token.id) as any;
            if (expired) {
                this.db.prepare(`UPDATE abdm_share_tokens SET status = 'expired' WHERE id = ?`).run(token.id);
                throw new Error('Token has expired. Ask the patient to scan again.');
            }
            this.db.prepare(`UPDATE abdm_share_tokens SET status = 'accepted' WHERE id = ?`).run(token.id);
            this.logAudit('UPDATE', 'abdm_share_tokens', token.id, actingUserId,
                `Accepted Scan & Share token #${token.token_no} for ${token.patient_name}`);
            return this.db.prepare('SELECT * FROM abdm_share_tokens WHERE id = ?').get(token.id);
        });
        return accept.immediate();
    }

    savePatient(patientData: any) {
        // Ensure all fields exist for named parameters
        const defaults = {
            dob: null, blood_group: null, email: null,
            emergency_contact_name: null, emergency_contact_mobile: null,
            street: null, city: null, state: null, zip_code: null,
            insurance_provider: null, policy_number: null,
            abha_address: null, abha_name: null,
            address: '', age: 0, gender: 'Unknown', mobile: '', name: ''
        };

        const patient = { ...defaults, ...patientData };

        if (patient.id) {
            // Health ID links live outside demographic edits: an edit form
            // that omits them must not silently unlink the patient. Clearing
            // goes only through linkAbhaAddress.
            if (patient.abha_address == null || patient.abha_address === '') {
                const stored = this.db.prepare(
                    'SELECT abha_address, abha_name FROM patients WHERE id = ?').get(patient.id) as any;
                patient.abha_address = stored?.abha_address ?? null;
                if (patient.abha_name == null || patient.abha_name === '') {
                    patient.abha_name = stored?.abha_name ?? null;
                }
            }
            return this.db.prepare(`
        UPDATE patients SET
            name = @name,
            mobile = @mobile,
            age = @age,
            gender = @gender,
            address = @address,
            dob = @dob,
            blood_group = @blood_group,
            email = @email,
            emergency_contact_name = @emergency_contact_name,
            emergency_contact_mobile = @emergency_contact_mobile,
            street = @street,
            city = @city,
            state = @state,
            zip_code = @zip_code,
            insurance_provider = @insurance_provider,
            policy_number = @policy_number,
            abha_address = @abha_address, abha_name = @abha_name
        WHERE id = @id
            `).run(patient);
        } else {
            if (!patient.uuid) {
                patient.uuid = crypto.randomUUID();
            }
            return this.db.prepare(`
        INSERT INTO patients(
            uuid, name, mobile, age, gender, address, 
            dob, blood_group, email, emergency_contact_name, emergency_contact_mobile,
            street, city, state, zip_code, insurance_provider, policy_number,
            abha_address, abha_name
        )
        VALUES(
            @uuid, @name, @mobile, @age, @gender, @address,
            @dob, @blood_group, @email, @emergency_contact_name, @emergency_contact_mobile,
            @street, @city, @state, @zip_code, @insurance_provider, @policy_number,
            @abha_address, @abha_name
        )
            `).run(patient);
        }
    }

    // Delete Patient (and their visits)
    deletePatient(id: number) {
        const remove = this.db.transaction(() => {
            const active = this.db.prepare("SELECT id FROM visits WHERE patient_id = ? AND status = 'in-progress'").get(id);
            if (active) throw new Error('Cannot delete a patient with an active encounter');
            this.db.prepare('DELETE FROM visits WHERE patient_id = ?').run(id);
            return this.db.prepare('DELETE FROM patients WHERE id = ?').run(id);
        });
        return remove();
    }

    // Visits
    getVisits(patientId: number) {
        // Updated to include vitals using a simple strategy: Fetch visits, then for each, try to get vitals?
        // OR better: LEFT JOIN vitals on visit_id.
        // NOTE: if multiple vitals exist for a visit (unlikely in current app flow, but possible), this might duplicate rows.
        // Current flow: 1 Visit = 1 Vital entry (usually).

        const visits = this.db.prepare(`
            SELECT 
                v.*, 
                d.name as doctor_name,
                vit.id as vital_id,
                vit.systolic_bp,
                vit.diastolic_bp,
                vit.pulse,
                vit.temperature,
                vit.weight,
                vit.height,
                vit.bmi,
                vit.spo2,
                vit.respiratory_rate,
                vit.effective_time as vital_effective_time,
                vit.recorded_at as vital_recorded_at,
                vit.status as vital_status,
                vit.units_json as vital_units_json,
                vit.performer_id as vital_performer_id,
                vit.replaces_id as vital_replaces_id,
                vit.amendment_reason as vital_amendment_reason,
                perf.name as vital_performer_name
            FROM visits v 
            LEFT JOIN users d ON v.doctor_id = d.id 
            LEFT JOIN vitals vit ON vit.id = (
                SELECT v2.id FROM vitals v2 
                WHERE (v2.visit_id = v.id OR (v.queue_entry_id IS NOT NULL AND v2.queue_entry_id = v.queue_entry_id))
                  AND v2.status != 'entered-in-error'
                ORDER BY v2.recorded_at DESC, v2.id DESC 
                LIMIT 1
            )
            LEFT JOIN users perf ON perf.id = vit.performer_id
            WHERE v.patient_id = ? AND v.status = 'finished'
            ORDER BY v.date DESC
        `).all(patientId);

        return visits.map((v: any) => ({
            ...v,
            prescription: v.prescription_json ? JSON.parse(v.prescription_json) : [],
            vitals: v.vital_id ? {
                id: v.vital_id,
                visit_id: v.id,
                patient_id: v.patient_id,
                systolic_bp: v.systolic_bp,
                diastolic_bp: v.diastolic_bp,
                pulse: v.pulse,
                temperature: v.temperature,
                weight: v.weight,
                height: v.height,
                bmi: v.bmi,
                spo2: v.spo2,
                respiratory_rate: v.respiratory_rate,
                effective_time: v.vital_effective_time,
                recorded_at: v.vital_recorded_at,
                status: v.vital_status,
                performer_id: v.vital_performer_id,
                performer_name: v.vital_performer_name,
                replaces_id: v.vital_replaces_id,
                amendment_reason: v.vital_amendment_reason,
                units: this.safeParseJson(v.vital_units_json, DEFAULT_VITAL_UNITS)
            } : null
        }));
    }

    getAllVisits(limit: number = 50) {
        const visits = this.db.prepare(`
            SELECT v.*, p.name as patient_name, d.name as doctor_name 
            FROM visits v 
            JOIN patients p ON v.patient_id = p.id
            LEFT JOIN users d ON v.doctor_id = d.id 
            WHERE v.status = 'finished'
            ORDER BY v.date DESC
            LIMIT ?
        `).all(limit);
        return visits.map((v: any) => ({
            ...v,
            prescription: v.prescription_json ? JSON.parse(v.prescription_json) : []
        }));
    }

    deleteVisit(id: number) {
        const existing = this.db.prepare('SELECT status FROM visits WHERE id = ?').get(id);
        if (existing?.status === 'in-progress') throw new Error('Active encounters cannot be deleted');
        return this.db.prepare('DELETE FROM visits WHERE id = ?').run(id);
    }

    saveVisit(visit: any) {
        if (!visit.id) {
            throw new Error('New encounters must be created with beginConsultation');
        }
        if (visit.doctor_id) {
            const doc = this.getPractitioner(Number(visit.doctor_id));
            if (!doc) {
                throw new Error('Clinical authoring requires an active licensed practitioner');
            }
        }
        const data = {
            id: Number(visit.id),
            diagnosis: visit.diagnosis ?? '',
            prescription_json: JSON.stringify(visit.prescription || []),
            amount_paid: Number(visit.amount_paid || 0),
            symptoms: visit.symptoms ?? '',
            examination_notes: visit.examination_notes ?? '',
            diagnosis_type: visit.diagnosis_type ?? '',
            allergy_override_reason: visit.allergy_override_reason ?? null
        };

        const existing = this.db.prepare('SELECT patient_id, status FROM visits WHERE id = ?').get(visit.id);
        if (existing?.status === 'in-progress') throw new Error('Use consultation progress commands for active encounters');
        if (existing && visit.prescription) {
            this.assertPrescriptionAllergySafety(existing.patient_id, visit.prescription, visit.allergy_override_reason);
        }
        return this.db.prepare(`
            UPDATE visits SET
                diagnosis = @diagnosis,
                prescription_json = @prescription_json,
                amount_paid = @amount_paid,
                symptoms = @symptoms,
                examination_notes = @examination_notes,
                diagnosis_type = @diagnosis_type,
                allergy_override_reason = COALESCE(@allergy_override_reason, allergy_override_reason)
            WHERE id = @id
            `).run(data);
    }

    /**
     * Starts (or resumes) exactly one encounter for an exact queue episode.
     * startRequestId makes a lost-response retry return the original encounter.
     */
    beginConsultation(input: any, actingUserId: number) {
        const patientId = Number(input?.patientId);
        const queueEntryId = Number(input?.queueEntryId);
        const startRequestId = String(input?.startRequestId || '').trim();
        if (!Number.isInteger(patientId) || patientId <= 0 || !Number.isInteger(queueEntryId) || queueEntryId <= 0 || !startRequestId) {
            throw new Error('patientId, queueEntryId, and startRequestId are required');
        }

        const begin = this.db.transaction(() => {
            const retried = this.getStartRequest(startRequestId);
            if (retried) {
                return this.validateStartRetry(retried, {
                    operation: 'begin', patientId, queueEntryId, actingUserId
                });
            }

            const queue = this.db.prepare('SELECT * FROM patient_queue WHERE id = ?').get(queueEntryId);

            if (!queue || queue.patient_id !== patientId || !['waiting', 'in-consult'].includes(queue.status)) {
                throw new Error('Patient does not have an active queue entry');
            }

            const active = this.db.prepare("SELECT * FROM visits WHERE patient_id = ? AND status = 'in-progress'").get(patientId);
            if (active) {
                if (active.queue_entry_id !== queue.id) throw new Error('Patient already has an active encounter for another queue entry');
                this.assertResponsiblePractitioner(active, actingUserId);
                if (queue.status === 'waiting') throw new Error('Active encounter must be resumed explicitly');
                this.recordStartRequest(startRequestId, 'begin', active.id, patientId, queue.id, actingUserId);
                return this.hydrateVisit(active);
            }

            const queueUpdate = this.db.prepare(`
                UPDATE patient_queue SET status = 'in-consult'
                WHERE id = ? AND patient_id = ? AND status = 'waiting'
            `).run(queue.id, patientId);
            if (queue.status === 'waiting' && queueUpdate.changes !== 1) throw new Error('Queue entry is no longer available');

            const targetDoctorId = Number(input?.doctorId || actingUserId);
            const practitioner = this.getPractitioner(targetDoctorId);
            if (!practitioner) {
                throw new Error('Clinical authoring requires an active licensed practitioner');
            }
            const licenseSnapshot = JSON.stringify({
                name: practitioner.name,
                license_number: practitioner.license_number || '',
                specialty: practitioner.specialty || ''
            });

            const result = this.db.prepare(`
                INSERT INTO visits (
                    patient_id, doctor_id, author_id, doctor_license_snapshot,
                    diagnosis, prescription_json, amount_paid,
                    symptoms, examination_notes, diagnosis_type, status,
                    started_at, updated_at, queue_entry_id, start_request_id,
                    start_operation, start_actor_id
                ) VALUES (?, ?, ?, ?, '', '[]', 0, '', '', '', 'in-progress', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?, ?, 'begin', ?)
            `).run(patientId, practitioner.id, actingUserId, licenseSnapshot, queue.id, startRequestId, actingUserId);
            this.recordStartRequest(startRequestId, 'begin', Number(result.lastInsertRowid), patientId, queue.id, actingUserId);
            this.linkPreConsultationVitals(queue.id, Number(result.lastInsertRowid));
            this.logAudit('ENCOUNTER_START', 'visits', result.lastInsertRowid, actingUserId, `Started encounter for queue entry ${queue.id}`);
            return this.getEncounterById(Number(result.lastInsertRowid));
        });

        return begin.immediate();
    }

    getActiveConsultation(patientId: number, actingUserId: number) {
        const row = this.db.prepare(`
            SELECT * FROM visits WHERE patient_id = ? AND status = 'in-progress'
            ORDER BY started_at DESC, id DESC LIMIT 1
        `).get(Number(patientId));
        if (row) this.assertResponsiblePractitioner(row, actingUserId);
        return row ? this.hydrateVisit(row) : null;
    }

    resumeConsultation(input: any, actingUserId: number) {
        const encounterId = Number(input?.encounterId);
        if (!Number.isInteger(encounterId) || encounterId <= 0) throw new Error('encounterId is required');

        const resume = this.db.transaction(() => {
            const encounter = this.db.prepare('SELECT * FROM visits WHERE id = ?').get(encounterId);
            if (!encounter || encounter.status !== 'in-progress' || !encounter.queue_entry_id) {
                throw new Error('Active encounter not found');
            }
            this.assertResponsiblePractitioner(encounter, actingUserId);
            const queue = this.getExactEncounterQueue(encounter, ['waiting', 'in-consult'], 'Encounter queue entry cannot be resumed');
            if (queue.status === 'waiting') {
                const claimed = this.db.prepare(`
                    UPDATE patient_queue SET status = 'in-consult'
                    WHERE id = ? AND patient_id = ? AND status = 'waiting'
                `).run(queue.id, encounter.patient_id);
                if (claimed.changes !== 1) throw new Error('Queue entry is no longer available');
                this.logAudit('ENCOUNTER_RESUME', 'visits', encounterId, actingUserId, `Resumed queue entry ${queue.id}`);
            }
            return this.getEncounterById(encounterId);
        });
        return resume.immediate();
    }

    saveConsultationProgress(input: any, actingUserId: number) {
        const encounterId = Number(input?.encounterId);
        if (!Number.isInteger(encounterId) || encounterId <= 0) throw new Error('encounterId is required');

        const save = this.db.transaction(() => {
            const encounter = this.db.prepare('SELECT * FROM visits WHERE id = ?').get(encounterId);
            if (!encounter) throw new Error('Encounter not found');
            if (encounter.status !== 'in-progress') throw new Error('Completed encounters cannot be changed as progress');
            this.assertResponsiblePractitioner(encounter, actingUserId);
            this.getExactEncounterQueue(encounter, ['in-consult'], 'Encounter queue entry is not in consultation');
            this.updateEncounterClinicalData(encounterId, input.visit);
            this.logAudit('ENCOUNTER_PROGRESS', 'visits', encounterId, actingUserId, 'Saved consultation progress');
            return this.getEncounterById(encounterId);
        });
        return save.immediate();
    }

    completeConsultation(input: any, actingUserId: number) {
        const encounterId = Number(input?.encounterId);
        if (!Number.isInteger(encounterId) || encounterId <= 0) throw new Error('encounterId is required');
        if (!input?.visit) throw new Error('visit is required to complete an encounter');

        const complete = this.db.transaction(() => {
            const encounter = this.db.prepare('SELECT * FROM visits WHERE id = ?').get(encounterId);
            if (!encounter) throw new Error('Encounter not found');
            this.assertResponsiblePractitioner(encounter, actingUserId);
            // A repeated Finish after response loss is a successful no-op.
            if (encounter.status === 'finished') {
                this.getExactEncounterQueue(encounter, ['completed'], 'Completed encounter queue entry is inconsistent');
                return this.hydrateVisit(encounter);
            }
            if (encounter.status !== 'in-progress' || !encounter.queue_entry_id) throw new Error('Encounter is not completable');
            this.getExactEncounterQueue(encounter, ['in-consult'], 'Queue entry is not in consultation');

            const queueUpdate = this.db.prepare(`
                UPDATE patient_queue SET status = 'completed'
                WHERE id = ? AND patient_id = ? AND status = 'in-consult'
            `).run(encounter.queue_entry_id, encounter.patient_id);
            if (queueUpdate.changes !== 1) throw new Error('Queue entry is not in consultation');

            this.updateEncounterClinicalData(encounterId, input.visit);
            if (input.visit?.prescription && Array.isArray(input.visit.prescription)) {
                this.syncEncounterMedications(encounter.patient_id, input.visit.prescription, actingUserId);
            }
            this.db.prepare(`
                UPDATE visits SET status = 'finished', completed_at = CURRENT_TIMESTAMP,
                    updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'in-progress'
            `).run(encounterId);
            this.logAudit('ENCOUNTER_COMPLETE', 'visits', encounterId, actingUserId, `Completed queue entry ${encounter.queue_entry_id}`);
            return this.getEncounterById(encounterId);
        });
        return complete.immediate();
    }

    postponeConsultation(input: any, actingUserId: number) {
        const encounterId = Number(input?.encounterId);
        if (!Number.isInteger(encounterId) || encounterId <= 0) throw new Error('encounterId is required');

        const postpone = this.db.transaction(() => {
            const encounter = this.db.prepare('SELECT * FROM visits WHERE id = ?').get(encounterId);
            if (!encounter || encounter.status !== 'in-progress' || !encounter.queue_entry_id) throw new Error('Active encounter not found');
            this.assertResponsiblePractitioner(encounter, actingUserId);
            this.getExactEncounterQueue(encounter, ['in-consult'], 'Queue entry is not in consultation');

            const queueUpdate = this.db.prepare(`
                UPDATE patient_queue SET status = 'waiting'
                WHERE id = ? AND patient_id = ? AND status = 'in-consult'
            `).run(encounter.queue_entry_id, encounter.patient_id);
            if (queueUpdate.changes !== 1) throw new Error('Queue entry is not in consultation');

            this.updateEncounterClinicalData(encounterId, input.visit);
            this.logAudit('ENCOUNTER_POSTPONE', 'visits', encounterId, actingUserId, `Postponed queue entry ${encounter.queue_entry_id}`);
            return this.getEncounterById(encounterId);
        });
        return postpone.immediate();
    }

    beginNextConsultation(input: any, actingUserId: number) {
        const startRequestId = String(input?.startRequestId || '').trim();
        if (!startRequestId) throw new Error('startRequestId is required');

        const beginNext = this.db.transaction(() => {
            const existingRequest = this.getStartRequest(startRequestId);
            if (existingRequest) {
                return this.validateStartRetry(existingRequest, {
                    operation: 'next',
                    actingUserId
                });
            }

            const targetDoctorId = Number(input?.doctorId || actingUserId);
            const practitioner = this.getPractitioner(targetDoctorId);
            if (!practitioner) {
                throw new Error('Clinical authoring requires an active licensed practitioner');
            }
            const licenseSnapshot = JSON.stringify({
                name: practitioner.name,
                license_number: practitioner.license_number || '',
                specialty: practitioner.specialty || ''
            });

            const queue = this.db.prepare(`
                SELECT q.*
                FROM patient_queue q
                WHERE q.status = 'waiting'
                  AND NOT EXISTS (
                    SELECT 1 FROM visits v2
                    WHERE v2.patient_id = q.patient_id AND v2.status = 'in-progress'
                  )
                ORDER BY q.priority DESC, q.check_in_time ASC, q.id ASC
                LIMIT 1
            `).get();
            if (!queue) return null;

            const claimed = this.db.prepare(`
                UPDATE patient_queue
                SET status = 'in-consult'
                WHERE id = ? AND status = 'waiting'
            `).run(queue.id);
            if (claimed.changes !== 1) throw new Error('Next queue entry was already claimed');
            const result = this.db.prepare(`
                INSERT INTO visits (
                    patient_id, doctor_id, author_id, doctor_license_snapshot,
                    diagnosis, prescription_json, amount_paid,
                    symptoms, examination_notes, diagnosis_type, status,
                    started_at, updated_at, queue_entry_id, start_request_id,
                    start_operation, start_actor_id
                ) VALUES (?, ?, ?, ?, '', '[]', 0, '', '', '', 'in-progress', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?, ?, 'next', ?)
            `).run(queue.patient_id, practitioner.id, actingUserId, licenseSnapshot, queue.id, startRequestId, actingUserId);
            this.recordStartRequest(startRequestId, 'next', Number(result.lastInsertRowid), queue.patient_id, queue.id, actingUserId);
            this.linkPreConsultationVitals(queue.id, Number(result.lastInsertRowid));
            this.logAudit('ENCOUNTER_START', 'visits', result.lastInsertRowid, actingUserId, `Started next encounter for queue entry ${queue.id}`);
            return this.getEncounterById(Number(result.lastInsertRowid));
        });
        return beginNext.immediate();
    }

    private updateEncounterClinicalData(encounterId: number, visit: any) {
        if (!visit) return;
        const existing = this.db.prepare('SELECT patient_id FROM visits WHERE id = ?').get(encounterId);
        if (existing && visit.prescription) {
            this.assertPrescriptionAllergySafety(existing.patient_id, visit.prescription, visit.allergy_override_reason);
        }
        const data = {
            id: encounterId,
            diagnosis: visit.diagnosis ?? '',
            prescription_json: JSON.stringify(visit.prescription || []),
            amount_paid: Number(visit.amount_paid || 0),
            symptoms: visit.symptoms ?? '',
            examination_notes: visit.examination_notes ?? '',
            diagnosis_type: visit.diagnosis_type ?? '',
            allergy_override_reason: visit.allergy_override_reason ?? null
        };
        this.db.prepare(`
            UPDATE visits SET diagnosis = @diagnosis, prescription_json = @prescription_json,
                amount_paid = @amount_paid, symptoms = @symptoms,
                examination_notes = @examination_notes, diagnosis_type = @diagnosis_type,
                allergy_override_reason = COALESCE(@allergy_override_reason, allergy_override_reason),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = @id AND status = 'in-progress'
        `).run(data);
    }

    private validateStartRetry(encounter: any, expected: {
        operation: 'begin' | 'next'; actingUserId: number; patientId?: number; queueEntryId?: number;
    }) {
        if (encounter.request_operation !== expected.operation || encounter.request_actor_id !== expected.actingUserId) {
            throw new Error('Start request key was already used by another operation or actor');
        }
        this.assertResponsiblePractitioner(encounter, expected.actingUserId);
        if (expected.patientId != null && encounter.request_patient_id !== expected.patientId) {
            throw new Error('Start request key belongs to another patient');
        }
        if (expected.queueEntryId != null && encounter.request_queue_entry_id !== expected.queueEntryId) {
            throw new Error('Start request key belongs to another queue entry');
        }
        const queue = this.db.prepare('SELECT * FROM patient_queue WHERE id = ?').get(encounter.queue_entry_id);
        if (encounter.status !== 'in-progress' || !queue || queue.patient_id !== encounter.patient_id || queue.status !== 'in-consult') {
            throw new Error('Start request key is stale');
        }
        return this.hydrateVisit(encounter);
    }

    private assertResponsiblePractitioner(encounter: any, actingUserId: number) {
        const docId = Number(encounter.doctor_id);
        const authorId = Number(encounter.author_id);
        const actor = Number(actingUserId);
        if (docId !== actor && authorId !== actor) {
            throw new Error('Only the responsible practitioner can access this encounter');
        }
        const user = this.db.prepare('SELECT active FROM users WHERE id = ?').get(actor);
        if (user && !user.active) {
            throw new Error('User is deactivated');
        }
    }

    private getPractitioner(userId: number) {
        if (!userId) return null;
        const user = this.db.prepare('SELECT id, name, role, active, license_number, specialty FROM users WHERE id = ?').get(Number(userId));
        if (user?.role === 'doctor' && user?.active) {
            return user;
        }
        return null;
    }

    private isAllergyConflict(medName: string, activeAllergies: any[]): any | null {
        for (const allergy of activeAllergies) {
            const substance = String(allergy.substance || '').trim().toLowerCase();
            if (substance && (medName.includes(substance) || substance.includes(medName))) {
                return allergy;
            }
        }
        return null;
    }

    assertPrescriptionAllergySafety(patientId: number, prescription: any[], overrideReason?: string | null) {
        if (!Array.isArray(prescription) || prescription.length === 0) return;
        const activeAllergies = this.db.prepare(
            "SELECT id, substance, reaction, severity FROM patient_allergies WHERE patient_id = ? AND status = 'active'"
        ).all(patientId) as any[];
        if (!activeAllergies?.length) return;

        for (const item of prescription) {
            const medName = String(item.medicine || item.name || '').trim().toLowerCase();
            if (!medName) continue;
            const conflict = this.isAllergyConflict(medName, activeAllergies);
            if (conflict && !overrideReason?.trim()) {
                throw new Error(`Prescription contains medication '${item.medicine || item.name}' conflicting with active allergy '${conflict.substance}'. An explicit override reason is required.`);
            }
        }
    }

    private syncEncounterMedications(patientId: number, prescription: any[], actingUserId: number) {
        for (const med of prescription) {
            const medName = String(med.medicine || med.name || '').trim();
            if (!medName) continue;
            const existing = this.db.prepare(
                "SELECT id, dosage, frequency FROM patient_medications WHERE patient_id = ? AND LOWER(medicine_name) = LOWER(?) AND status = 'active'"
            ).get(patientId, medName);
            if (!existing) {
                this.db.prepare(`
                    INSERT INTO patient_medications (
                        patient_id, medicine_name, dosage, frequency, status, start_date, recorded_at, recorder_id
                    ) VALUES (?, ?, ?, ?, 'active', CURRENT_DATE, CURRENT_TIMESTAMP, ?)
                `).run(patientId, medName, med.dosage || '', med.frequency || '', actingUserId);
            } else if ((existing.dosage || '') !== (med.dosage || '') || (existing.frequency || '') !== (med.frequency || '')) {
                // Same medicine, changed regimen: refresh the active row so the
                // safety context shows the current dose, not a stale one.
                this.db.prepare(`
                    UPDATE patient_medications SET dosage = ?, frequency = ? WHERE id = ?
                `).run(med.dosage || '', med.frequency || '', existing.id);
            }
        }
    }

    private getExactEncounterQueue(encounter: any, allowedStatuses: string[], errorMessage: string) {
        const queue = encounter.queue_entry_id
            ? this.db.prepare('SELECT * FROM patient_queue WHERE id = ?').get(encounter.queue_entry_id)
            : null;
        if (!queue || queue.patient_id !== encounter.patient_id || !allowedStatuses.includes(queue.status)) {
            throw new Error(errorMessage);
        }
        return queue;
    }

    private getStartRequest(requestId: string) {
        return this.db.prepare(`
            SELECT r.operation AS request_operation, r.actor_id AS request_actor_id,
                   r.patient_id AS request_patient_id, r.queue_entry_id AS request_queue_entry_id,
                   v.*
            FROM encounter_requests r
            JOIN visits v ON v.id = r.encounter_id
            WHERE r.request_id = ?
        `).get(requestId);
    }

    private recordStartRequest(requestId: string, operation: 'begin' | 'next', encounterId: number,
        patientId: number, queueEntryId: number, actingUserId: number) {
        this.db.prepare(`
            INSERT INTO encounter_requests (
                request_id, operation, encounter_id, patient_id, queue_entry_id, actor_id
            ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(requestId, operation, encounterId, patientId, queueEntryId, actingUserId);
    }

    private getEncounterById(id: number) {
        const row = this.db.prepare('SELECT * FROM visits WHERE id = ?').get(id);
        if (!row) throw new Error('Encounter not found');
        return this.hydrateVisit(row);
    }

    private hydrateVisit(row: any) {
        return {
            ...row,
            prescription: row.prescription_json ? JSON.parse(row.prescription_json) : [],
            doctor_license: this.safeParseJson(row.doctor_license_snapshot, null)
        };
    }



    private safeParseJson(json: string | null | undefined, fallback: any): any {
        if (!json) return fallback;
        try {
            return JSON.parse(json);
        } catch {
            return fallback;
        }
    }

    private linkPreConsultationVitals(queueEntryId: number, encounterId: number): void {
        this.db.prepare(`
            UPDATE vitals
            SET visit_id = ?
            WHERE queue_entry_id = ? AND visit_id IS NULL
        `).run(encounterId, queueEntryId);
    }

    private hydrateVital(row: any): any {
        if (!row) return null;
        return {
            ...row,
            units: this.safeParseJson(row.units_json, DEFAULT_VITAL_UNITS)
        };
    }

    private resolveVitalsContext(vitals: any, patientId: number): { visitId: number | null; queueEntryId: number | null } {
        let visitId = vitals.visit_id ? Number(vitals.visit_id) : null;
        let queueEntryId = vitals.queue_entry_id ? Number(vitals.queue_entry_id) : null;

        if (visitId) {
            const v = this.db.prepare('SELECT id, patient_id, queue_entry_id FROM visits WHERE id = ?').get(visitId) as any;
            if (v && Number(v.patient_id) !== patientId) {
                throw new Error(`Cross-patient violation: visit #${visitId} belongs to patient ${v.patient_id}, not ${patientId}`);
            }
            if (v && !queueEntryId && v.queue_entry_id) {
                queueEntryId = Number(v.queue_entry_id);
            }
        }

        if (queueEntryId) {
            const q = this.db.prepare('SELECT id, patient_id FROM patient_queue WHERE id = ?').get(queueEntryId) as any;
            if (q && Number(q.patient_id) !== patientId) {
                throw new Error(`Cross-patient violation: queue entry #${queueEntryId} belongs to patient ${q.patient_id}, not ${patientId}`);
            }
        }

        if (!visitId && queueEntryId) {
            const active = this.db.prepare("SELECT id FROM visits WHERE queue_entry_id = ? AND status = 'in-progress'").get(queueEntryId) as any;
            if (active) visitId = Number(active.id);
        } else if (!visitId && !queueEntryId) {
            const active = this.db.prepare("SELECT id, queue_entry_id FROM visits WHERE patient_id = ? AND status = 'in-progress'").get(patientId) as any;
            if (active) {
                visitId = Number(active.id);
                queueEntryId = active.queue_entry_id ? Number(active.queue_entry_id) : null;
            } else {
                const waiting = this.db.prepare("SELECT id FROM patient_queue WHERE patient_id = ? AND status = 'waiting' ORDER BY id DESC LIMIT 1").get(patientId) as any;
                if (waiting) queueEntryId = Number(waiting.id);
            }
        }
        return { visitId, queueEntryId };
    }

    private findExistingDuplicateVital(vitals: any, patientId: number, visitId: number | null, queueEntryId: number | null): any {
        if (vitals.client_request_id) {
            const byReq = this.db.prepare('SELECT * FROM vitals WHERE client_request_id = ?').get(String(vitals.client_request_id).trim());
            if (byReq) return this.hydrateVital(byReq);
        }

        const sys = vitals.systolic_bp != null ? Number(vitals.systolic_bp) : -1;
        const dia = vitals.diastolic_bp != null ? Number(vitals.diastolic_bp) : -1;
        const pulse = vitals.pulse != null ? Number(vitals.pulse) : -1;
        const temp = vitals.temperature != null ? Number(vitals.temperature) : -1;

        const candidate = this.db.prepare(`
            SELECT * FROM vitals
            WHERE patient_id = ?
              AND COALESCE(queue_entry_id, 0) = COALESCE(?, 0)
              AND COALESCE(visit_id, 0) = COALESCE(?, 0)
              AND COALESCE(systolic_bp, -1) = ?
              AND COALESCE(diastolic_bp, -1) = ?
              AND COALESCE(pulse, -1) = ?
              AND COALESCE(temperature, -1) = ?
              AND status = 'final'
              AND datetime(recorded_at) >= datetime('now', '-5 seconds')
            ORDER BY id DESC LIMIT 1
        `).get(patientId, queueEntryId, visitId, sys, dia, pulse, temp);

        return candidate ? this.hydrateVital(candidate) : null;
    }

    private saveAmendedVital(
        vitals: any,
        originalId: number,
        patientId: number,
        visitId: number | null,
        queueEntryId: number | null,
        unitsJson: string,
        actingUserId?: number
    ): any {
        const original = this.db.prepare('SELECT * FROM vitals WHERE id = ?').get(originalId) as any;
        if (!original) {
            throw new Error(`Original vitals observation #${originalId} not found to amend`);
        }
        if (Number(original.patient_id) !== Number(patientId)) {
            throw new Error(`Cross-patient violation: original vitals #${originalId} belongs to patient ${original.patient_id}, not ${patientId}`);
        }

        const effectiveTime = vitals.effective_time || original.effective_time || new Date().toISOString();
        const finalVisitId = visitId || original.visit_id || null;
        const finalQueueEntryId = queueEntryId || original.queue_entry_id || null;
        const performerId = actingUserId || vitals.performer_id || original.performer_id || null;
        const amendmentReason = vitals.amendment_reason || 'Clinical correction';
        const clientRequestId = vitals.client_request_id || null;

        const runTx = this.db.transaction(() => {
            this.db.prepare("UPDATE vitals SET status = 'amended' WHERE id = ?").run(original.id);
            return this.db.prepare(`
                INSERT INTO vitals (
                    visit_id, patient_id, queue_entry_id,
                    height, weight, bmi, temperature, systolic_bp, diastolic_bp, pulse, respiratory_rate, spo2,
                    effective_time, recorded_at, performer_id, status, units_json,
                    replaces_id, amendment_reason, client_request_id
                ) VALUES (
                    ?, ?, ?,
                    ?, ?, ?, ?, ?, ?, ?, ?, ?,
                    ?, CURRENT_TIMESTAMP, ?, 'amended', ?,
                    ?, ?, ?
                )
            `).run(
                finalVisitId, patientId, finalQueueEntryId,
                vitals.height ?? null, vitals.weight ?? null, vitals.bmi ?? null, vitals.temperature ?? null,
                vitals.systolic_bp ?? null, vitals.diastolic_bp ?? null, vitals.pulse ?? null,
                vitals.respiratory_rate ?? null, vitals.spo2 ?? null,
                effectiveTime, performerId, unitsJson,
                original.id,
                amendmentReason,
                clientRequestId
            );
        });

        const result = runTx.immediate();

        this.logAudit('VITALS_AMEND', 'vitals', result.lastInsertRowid, actingUserId, `Amended vitals observation ${original.id}`);
        const inserted = this.db.prepare('SELECT * FROM vitals WHERE id = ?').get(Number(result.lastInsertRowid));
        return this.hydrateVital(inserted);
    }

    private insertNewVital(
        vitals: any,
        patientId: number,
        visitId: number | null,
        queueEntryId: number | null,
        unitsJson: string,
        actingUserId?: number
    ): any {
        const effectiveTime = vitals.effective_time || new Date().toISOString();
        const status = vitals.status || 'final';
        const performerId = actingUserId || vitals.performer_id || null;

        const result = this.db.prepare(`
            INSERT INTO vitals (
                visit_id, patient_id, queue_entry_id,
                height, weight, bmi, temperature, systolic_bp, diastolic_bp, pulse, respiratory_rate, spo2,
                effective_time, recorded_at, performer_id, status, units_json, client_request_id
            ) VALUES (
                ?, ?, ?,
                ?, ?, ?, ?, ?, ?, ?, ?, ?,
                ?, CURRENT_TIMESTAMP, ?, ?, ?, ?
            )
        `).run(
            visitId, patientId, queueEntryId,
            vitals.height ?? null, vitals.weight ?? null, vitals.bmi ?? null, vitals.temperature ?? null,
            vitals.systolic_bp ?? null, vitals.diastolic_bp ?? null, vitals.pulse ?? null,
            vitals.respiratory_rate ?? null, vitals.spo2 ?? null,
            effectiveTime, performerId, status, unitsJson,
            vitals.client_request_id || null
        );

        this.logAudit('VITALS_RECORD', 'vitals', result.lastInsertRowid, actingUserId, 'Recorded new vitals observation');
        const inserted = this.db.prepare('SELECT * FROM vitals WHERE id = ?').get(Number(result.lastInsertRowid));
        return this.hydrateVital(inserted);
    }

    // Vitals
    saveVitals(vitals: any, actingUserId?: number) {
        assertValidVitals(vitals);

        const patientId = Number(vitals.patient_id);
        if (!Number.isInteger(patientId) || patientId <= 0) {
            throw new Error('patient_id is required');
        }

        const { visitId, queueEntryId } = this.resolveVitalsContext(vitals, patientId);

        const duplicate = this.findExistingDuplicateVital(vitals, patientId, visitId, queueEntryId);
        if (duplicate) return duplicate;

        const unitsJson = JSON.stringify(vitals.units || DEFAULT_VITAL_UNITS);
        const originalId = vitals.replaces_id || vitals.id;

        if (originalId) {
            return this.saveAmendedVital(vitals, Number(originalId), patientId, visitId, queueEntryId, unitsJson, actingUserId);
        }
        return this.insertNewVital(vitals, patientId, visitId, queueEntryId, unitsJson, actingUserId);
    }

    getVitals(patientId: number) {
        const row = this.db.prepare(`
            SELECT vit.*, u.name as performer_name
            FROM vitals vit
            LEFT JOIN users u ON u.id = vit.performer_id
            WHERE vit.patient_id = ? AND vit.status != 'entered-in-error'
            ORDER BY vit.effective_time DESC, vit.id DESC LIMIT 1
        `).get(Number(patientId));
        return row ? this.hydrateVital(row) : null;
    }

    getEncounterVitals(encounterId: number) {
        const row = this.db.prepare(`
            SELECT vit.*, u.name as performer_name
            FROM vitals vit
            LEFT JOIN users u ON u.id = vit.performer_id
            WHERE (vit.visit_id = ? OR (vit.queue_entry_id = (SELECT queue_entry_id FROM visits WHERE id = ?) AND vit.queue_entry_id IS NOT NULL))
              AND vit.status != 'entered-in-error'
            ORDER BY vit.recorded_at DESC, vit.id DESC LIMIT 1
        `).get(Number(encounterId), Number(encounterId));
        return row ? this.hydrateVital(row) : null;
    }

    getVitalsHistory(patientId: number, visitId?: number) {
        let sql = `
            SELECT vit.*, u.name as performer_name
            FROM vitals vit
            LEFT JOIN users u ON u.id = vit.performer_id
            WHERE vit.patient_id = ?
        `;
        const params: any[] = [Number(patientId)];
        if (visitId) {
            sql += ' AND (vit.visit_id = ? OR (vit.queue_entry_id = (SELECT queue_entry_id FROM visits WHERE id = ?) AND vit.queue_entry_id IS NOT NULL))';
            params.push(Number(visitId), Number(visitId));
        }
        sql += ' ORDER BY vit.recorded_at DESC, vit.id DESC';
        const rows = this.db.prepare(sql).all(...params);
        return rows.map((r: any) => this.hydrateVital(r));
    }


    // Queue Management
    getQueue() {
        const rows = this.db.prepare(`
            SELECT q.id, q.patient_id, q.status, q.priority, q.urgency, q.triage_notes,
                   q.triage_assessor_id, q.triaged_at, q.check_in_time,
                   p.name as patient_name, p.gender, p.age, p.mobile,
                   u.name as triage_assessor_name,
                   active.id as active_encounter_id
            FROM patient_queue q
            JOIN patients p ON q.patient_id = p.id
            LEFT JOIN users u ON q.triage_assessor_id = u.id
            LEFT JOIN visits active ON active.queue_entry_id = q.id AND active.status = 'in-progress'
            WHERE q.status != 'completed'
            ORDER BY q.priority DESC, q.check_in_time ASC, q.id ASC
        `).all() as any[];

        return rows.map(q => {
            // Prefer the observation linked to this exact queue episode; fall
            // back to today's measurement only when none exists. Invalidated
            // (entered-in-error) observations never drive queue alerts.
            const linked = this.db.prepare(`
                SELECT systolic_bp, diastolic_bp, pulse, temperature, respiratory_rate, spo2, bmi, status, units_json
                FROM vitals
                WHERE queue_entry_id = ? AND status != 'entered-in-error'
                ORDER BY id DESC LIMIT 1
            `).get(q.id) as any;
            const vitals = linked ?? this.db.prepare(`
                SELECT systolic_bp, diastolic_bp, pulse, temperature, respiratory_rate, spo2, bmi, status, units_json
                FROM vitals
                WHERE patient_id = ? AND date(effective_time) = date('now') AND status != 'entered-in-error'
                ORDER BY id DESC LIMIT 1
            `).get(q.patient_id) as any;

            const evaluated = evaluateVitalsAbnormalities(vitals ? {
                ...vitals,
                units: this.safeParseJson(vitals.units_json, DEFAULT_VITAL_UNITS)
            } : undefined);
            return {
                ...q,
                urgency: q.urgency || this.priorityToUrgency(q.priority),
                has_abnormal_vitals: evaluated.hasAbnormal,
                vitals_alerts: evaluated.alerts
            };
        });
    }

    private normalizeUrgency(value: unknown): string {
        const normalized = String(value ?? 'routine').toLowerCase();
        if (!['immediate', 'urgent', 'priority', 'routine'].includes(normalized)) {
            throw new Error(`Unknown urgency tier: ${String(value)}`);
        }
        return normalized;
    }

    urgencyToPriority(urgency: string): number {        switch (urgency?.toLowerCase()) {
            case 'immediate': return 4;
            case 'urgent': return 3;
            case 'priority': return 2;
            case 'routine':
            default:
                return 1;
        }
    }

    priorityToUrgency(priority: number): string {
        switch (Number(priority)) {
            case 4: return 'immediate';
            case 3: return 'urgent';
            case 2: return 'priority';
            case 1:
            default:
                return 'routine';
        }
    }

    addToQueue(patientId: number, priorityOrOptions: any = 1, actingUserId?: number, urgencyInput?: string, triageNotesInput?: string) {
        // Check if already in queue
        const existing = this.db.prepare('SELECT id FROM patient_queue WHERE patient_id = ? AND status != ?').get(patientId, 'completed');
        if (existing) throw new Error('Patient already in queue');

        let priority: number;
        let urgency: string;
        let triageNotes: string;

        if (typeof priorityOrOptions === 'object' && priorityOrOptions !== null) {
            urgency = priorityOrOptions.urgency || (priorityOrOptions.priority ? this.priorityToUrgency(priorityOrOptions.priority) : 'routine');
            priority = Number(priorityOrOptions.priority) || this.urgencyToPriority(urgency);
            triageNotes = priorityOrOptions.triage_notes || '';
        } else {
            priority = Number(priorityOrOptions || 1);
            urgency = urgencyInput || this.priorityToUrgency(priority);
            triageNotes = triageNotesInput || '';
        }
        urgency = this.normalizeUrgency(urgency);

        const assessorId = actingUserId ? Number(actingUserId) : null;
        const result = this.db.prepare('INSERT INTO patient_queue (patient_id, priority) VALUES (?, ?)').run(patientId, priority);
        const queueId = Number(result.lastInsertRowid);

        try {
            this.db.prepare(`
                UPDATE patient_queue
                SET urgency = ?, triage_notes = ?, triage_assessor_id = ?, triaged_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `).run(urgency, triageNotes, assessorId, queueId);

            this.db.prepare(`
                INSERT INTO queue_triage_history (
                    queue_id, previous_priority, new_priority, urgency_label, reason, changed_by
                ) VALUES (?, ?, ?, ?, ?, ?)
            `).run(queueId, priority, priority, urgency, triageNotes || 'Initial triage at check-in', assessorId || 1);
        } catch {
            // Silently ignore if running with partial mocks or pre-v11 tables
        }

        this.logAudit('INSERT', 'patient_queue', queueId, actingUserId, `Added patient ${patientId} to queue with urgency ${urgency}`);
        return result;
    }

    reassessQueueTriage(queueId: number, newUrgency: string, reason: string, actingUserId?: number) {
        if (!queueId) throw new Error('queueId is required');
        if (!newUrgency) throw new Error('newUrgency is required');
        if (!reason?.trim()) throw new Error('A clinical reason is required for triage reassessment');

        const queue = this.db.prepare('SELECT * FROM patient_queue WHERE id = ?').get(queueId) as any;
        if (!queue) throw new Error('Queue entry not found');
        if (queue.status === 'completed') throw new Error('Cannot reassess triage for completed queue entry');

        const normalizedUrgency = this.normalizeUrgency(newUrgency);
        const newPriority = this.urgencyToPriority(normalizedUrgency);
        const assessorId = actingUserId ? Number(actingUserId) : 1;

        const reassess = this.db.transaction(() => {
            this.db.prepare(`
                INSERT INTO queue_triage_history (
                    queue_id, previous_priority, new_priority, urgency_label, reason, changed_by
                ) VALUES (?, ?, ?, ?, ?, ?)
            `).run(queue.id, queue.priority, newPriority, normalizedUrgency, reason.trim(), assessorId);

            this.db.prepare(`
                UPDATE patient_queue
                SET urgency = ?, priority = ?, triage_notes = ?, triage_assessor_id = ?, triaged_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `).run(normalizedUrgency, newPriority, reason.trim(), assessorId, queue.id);

            this.logAudit('TRIAGE_REASSESS', 'patient_queue', queue.id, actingUserId, `Reassessed triage urgency from ${queue.urgency} to ${normalizedUrgency}: ${reason}`);
            return this.db.prepare('SELECT * FROM patient_queue WHERE id = ?').get(queue.id);
        });

        return reassess.immediate();
    }

    getQueueTriageHistory(queueId: number) {
        return this.db.prepare(`
            SELECT h.id, h.queue_id, h.previous_priority, h.new_priority,
                   h.urgency_label as new_urgency,
                   h.urgency_label,
                   h.reason,
                   h.changed_by,
                   h.changed_at as created_at,
                   u.name as assessor_name
            FROM queue_triage_history h
            LEFT JOIN users u ON h.changed_by = u.id
            WHERE h.queue_id = ?
            ORDER BY h.changed_at DESC, h.id DESC
        `).all(queueId);
    }

    // Allergies Management
    getAllergies(patientId: number) {
        return this.db.prepare(`
            SELECT a.*, u.name as recorder_name
            FROM patient_allergies a
            LEFT JOIN users u ON a.recorder_id = u.id
            WHERE a.patient_id = ?
            ORDER BY CASE WHEN a.status = 'active' THEN 0 ELSE 1 END,
                     CASE a.severity
                         WHEN 'life-threatening' THEN 1
                         WHEN 'severe' THEN 2
                         WHEN 'moderate' THEN 3
                         ELSE 4
                     END,
                     a.id DESC
        `).all(Number(patientId));
    }
    private resolveActorId(actingUserId?: number, fallbackId?: number | string | null): number | null {
        if (actingUserId) return Number(actingUserId);
        if (fallbackId) return Number(fallbackId);
        return null;
    }

    saveAllergy(allergy: any, actingUserId?: number) {
        if (!allergy) throw new Error('Allergy data is required');
        const patientId = Number(allergy.patient_id);
        if (!patientId) throw new Error('patient_id is required');
        const substance = String(allergy.substance || '').trim();
        if (!substance) throw new Error('substance is required');

        const verificationStatus = allergy.verification_status || 'confirmed';
        const criticality = allergy.criticality || 'low';
        const severity = allergy.severity || 'moderate';
        const status = allergy.status || 'active';
        const reaction = allergy.reaction || '';
        const notes = allergy.notes || '';
        const userId = this.resolveActorId(actingUserId, allergy.recorder_id);

        if (allergy.id) {
            this.db.prepare(`
                UPDATE patient_allergies
                SET substance = ?, verification_status = ?, criticality = ?, severity = ?, reaction = ?, status = ?, notes = ?
                WHERE id = ? AND patient_id = ?
            `).run(substance, verificationStatus, criticality, severity, reaction, status, notes, allergy.id, patientId);
            this.logAudit('UPDATE', 'patient_allergies', allergy.id, userId, `Updated allergy ${substance}`);
            return this.db.prepare('SELECT * FROM patient_allergies WHERE id = ?').get(allergy.id);
        } else {
            const result = this.db.prepare(`
                INSERT INTO patient_allergies (
                    patient_id, substance, verification_status, criticality, severity, reaction, status, recorder_id, recorded_at, notes
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)
            `).run(patientId, substance, verificationStatus, criticality, severity, reaction, status, userId, notes);
            this.logAudit('INSERT', 'patient_allergies', result.lastInsertRowid, userId, `Recorded allergy ${substance}`);
            return this.db.prepare('SELECT * FROM patient_allergies WHERE id = ?').get(Number(result.lastInsertRowid));
        }
    }

    deleteAllergy(allergyId: number, actingUserId?: number) {
        const result = this.db.prepare('DELETE FROM patient_allergies WHERE id = ?').run(Number(allergyId));
        this.logAudit('DELETE', 'patient_allergies', allergyId, actingUserId, 'Deleted allergy record');
        return result;
    }

    // Conditions (Problem List) Management
    getConditions(patientId: number) {
        return this.db.prepare(`
            SELECT c.*, c.code as icd10_code, c.clinical_status as status, u.name as recorder_name
            FROM patient_conditions c
            LEFT JOIN users u ON c.recorder_id = u.id
            WHERE c.patient_id = ?
            ORDER BY CASE WHEN c.clinical_status = 'active' THEN 0 ELSE 1 END, c.id DESC
        `).all(Number(patientId));
    }

    saveCondition(condition: any, actingUserId?: number) {
        if (!condition) throw new Error('Condition data is required');
        const patientId = Number(condition.patient_id);
        if (!patientId) throw new Error('patient_id is required');
        const conditionName = String(condition.condition_name || condition.name || '').trim();
        if (!conditionName) throw new Error('condition_name is required');

        const code = condition.code || condition.icd10_code || '';
        const category = condition.category || 'chronic-problem';
        const clinicalStatus = condition.clinical_status || condition.status || 'active';
        const onsetDate = condition.onset_date || null;
        const notes = condition.notes || '';
        const userId = this.resolveActorId(actingUserId, condition.recorder_id);

        if (condition.id) {
            this.db.prepare(`
                UPDATE patient_conditions
                SET condition_name = ?, code = ?, category = ?, clinical_status = ?, onset_date = ?, notes = ?
                WHERE id = ? AND patient_id = ?
            `).run(conditionName, code, category, clinicalStatus, onsetDate, notes, condition.id, patientId);
            this.logAudit('UPDATE', 'patient_conditions', condition.id, userId, `Updated condition ${conditionName}`);
            return this.db.prepare('SELECT *, code as icd10_code, clinical_status as status FROM patient_conditions WHERE id = ?').get(condition.id);
        } else {
            const result = this.db.prepare(`
                INSERT INTO patient_conditions (
                    patient_id, condition_name, code, category, clinical_status, onset_date, recorder_id, recorded_at, notes
                ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)
            `).run(patientId, conditionName, code, category, clinicalStatus, onsetDate, userId, notes);
            this.logAudit('INSERT', 'patient_conditions', result.lastInsertRowid, userId, `Recorded condition ${conditionName}`);
            return this.db.prepare('SELECT *, code as icd10_code, clinical_status as status FROM patient_conditions WHERE id = ?').get(Number(result.lastInsertRowid));
        }
    }

    deleteCondition(conditionId: number, actingUserId?: number) {
        const result = this.db.prepare('DELETE FROM patient_conditions WHERE id = ?').run(Number(conditionId));
        this.logAudit('DELETE', 'patient_conditions', conditionId, actingUserId, 'Deleted condition record');
        return result;
    }

    // Medications Management
    getMedications(patientId: number) {
        return this.db.prepare(`
            SELECT m.*, m.medicine_name as medication_name, u.name as recorder_name
            FROM patient_medications m
            LEFT JOIN users u ON m.recorder_id = u.id
            WHERE m.patient_id = ?
            ORDER BY CASE WHEN m.status = 'active' THEN 0 ELSE 1 END, m.id DESC
        `).all(Number(patientId));
    }

    saveMedication(medication: any, actingUserId?: number) {
        if (!medication) throw new Error('Medication data is required');
        const patientId = Number(medication.patient_id);
        if (!patientId) throw new Error('patient_id is required');
        const medicineName = String(medication.medicine_name || medication.medication_name || medication.name || '').trim();
        if (!medicineName) throw new Error('medicine_name is required');

        const dosage = medication.dosage || '';
        const frequency = medication.frequency || '';
        const status = medication.status || 'active';
        const startDate = medication.start_date || null;
        const endDate = medication.end_date || null;
        const notes = medication.notes || '';
        const userId = this.resolveActorId(actingUserId, medication.recorder_id);

        if (medication.id) {
            this.db.prepare(`
                UPDATE patient_medications
                SET medicine_name = ?, dosage = ?, frequency = ?, status = ?, start_date = ?, end_date = ?, notes = ?
                WHERE id = ? AND patient_id = ?
            `).run(medicineName, dosage, frequency, status, startDate, endDate, notes, medication.id, patientId);
            this.logAudit('UPDATE', 'patient_medications', medication.id, userId, `Updated medication ${medicineName}`);
            return this.db.prepare('SELECT *, medicine_name as medication_name FROM patient_medications WHERE id = ?').get(medication.id);
        } else {
            const result = this.db.prepare(`
                INSERT INTO patient_medications (
                    patient_id, medicine_name, dosage, frequency, status, start_date, end_date, recorder_id, recorded_at, notes
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)
            `).run(patientId, medicineName, dosage, frequency, status, startDate, endDate, userId, notes);
            this.logAudit('INSERT', 'patient_medications', result.lastInsertRowid, userId, `Recorded medication ${medicineName}`);
            return this.db.prepare('SELECT *, medicine_name as medication_name FROM patient_medications WHERE id = ?').get(Number(result.lastInsertRowid));
        }
    }

    deleteMedication(medicationId: number, actingUserId?: number) {
        const result = this.db.prepare('DELETE FROM patient_medications WHERE id = ?').run(Number(medicationId));
        this.logAudit('DELETE', 'patient_medications', medicationId, actingUserId, 'Deleted medication record');
        return result;
    }

    // Patient Clinical Safety Context
    getPatientSafetyContext(patientId: number) {
        const pId = Number(patientId);
        const allergies = this.getAllergies(pId);
        const activeAllergies = allergies.filter((a: any) => a.status === 'active');
        const conditions = this.getConditions(pId);
        const activeConditions = conditions.filter((c: any) => c.clinical_status === 'active' || c.status === 'active');
        const medications = this.getMedications(pId);
        const activeMedications = medications.filter((m: any) => m.status === 'active');
        const hasLifeThreatening = activeAllergies.some((a: any) =>
            a.severity === 'life-threatening' || a.severity === 'severe' || a.criticality === 'high');

        return {
            patient_id: pId,
            allergies,
            active_allergies: activeAllergies,
            has_active_allergies: activeAllergies.length > 0,
            has_life_threatening_allergies: hasLifeThreatening,
            conditions,
            active_conditions: activeConditions,
            medications,
            active_medications: activeMedications
        };
    }

    updateQueueStatus(id: number, status: string, actingUserId: number) {
        if (status === 'in-consult' || status === 'completed') {
            throw new Error('Consultation queue transitions require an encounter command');
        }
        const result = this.db.prepare('UPDATE patient_queue SET status = ? WHERE id = ?').run(status, id);
        this.logAudit('UPDATE', 'patient_queue', id, actingUserId, `Updated status to ${status} `);
        return result;
    }

    updateQueueStatusByPatientId(patientId: number, status: string, actingUserId: number) {
        if (status === 'in-consult' || status === 'completed') {
            throw new Error('Consultation queue transitions require an encounter command');
        }
        // Update the most recent non-completed queue entry for this patient
        // Fetch ID first for audit
        const existing = this.db.prepare(`SELECT id FROM patient_queue WHERE patient_id = ? AND status != 'completed' ORDER BY check_in_time DESC LIMIT 1`).get(patientId);

        if (!existing) return { changes: 0 };

        const result = this.db.prepare(`
            UPDATE patient_queue 
            SET status = ? 
            WHERE id = ?
        `).run(status, existing.id);

        if (result.changes > 0) {
            this.logAudit('UPDATE', 'patient_queue', existing.id, actingUserId, `Updated status to ${status} for patient ${patientId}`);
        }
        return result;
    }

    removeFromQueue(id: number, actingUserId: number) {
        const active = this.db.prepare("SELECT id FROM visits WHERE queue_entry_id = ? AND status = 'in-progress'").get(id);
        if (active) throw new Error('Cannot remove a queue entry with an active encounter');
        const result = this.db.prepare('DELETE FROM patient_queue WHERE id = ?').run(id);
        this.logAudit('DELETE', 'patient_queue', id, actingUserId, 'Removed from queue');
        return result;
    }

    // Audit Logging
    logAudit(action: string, tableName: string, recordId: number | bigint, userId: number | null | undefined, details: string) {
        try {
            this.db.prepare(`
                INSERT INTO audit_logs(action, table_name, record_id, user_id, details)
        VALUES(@action, @tableName, @recordId, @userId, @details)
            `).run({ action, tableName, recordId: Number(recordId), userId: userId ?? null, details });
        } catch (e) {
            console.error('Failed to log audit:', e);
        }
    }

    getAuditLogs(limit: number = 100) {
        return this.db.prepare(`
            SELECT al.*, u.name as actor_name 
            FROM audit_logs al 
            LEFT JOIN users u ON al.user_id = u.id 
            ORDER BY al.timestamp DESC LIMIT ?
        `).all(limit);
    }

    // Appointment Requests
    getAppointmentRequests() {
        const reqs = this.db.prepare("SELECT * FROM appointment_requests ORDER BY created_at DESC").all();
        // Removed debug logs to prevent leak
        return reqs;
    }

    saveAppointmentRequest(req: any) {
        return this.db.prepare(`
            INSERT OR IGNORE INTO appointment_requests (id, patient_name, phone, date, time, reason)
            VALUES (@id, @patient_name, @phone, @date, @time, @reason)
        `).run(req);
    }

    updateAppointmentRequestStatus(id: string, status: string) {
        return this.db.prepare('UPDATE appointment_requests SET status = ? WHERE id = ?').run(status, id);
    }

    // Appointments (Bookings)
    getAppointments(date: string) {
        if (!this.db) throw new Error('DB not initialized');
        // Join with patients to get name
        return this.db.prepare(`
            SELECT a.*, p.name as patient_name, p.mobile as patient_mobile, p.age as patient_age, p.gender as patient_gender, p.address
            FROM appointments a
            LEFT JOIN patients p ON a.patient_id = p.id
            WHERE a.date = ?
            ORDER BY a.time ASC
        `).all(date);
    }

    saveAppointment(appt: any) {
        if (!this.db) throw new Error('DB not initialized');
        if (appt.id) {
            return this.db.prepare(`
                UPDATE appointments SET status = ? WHERE id = ?
            `).run(appt.status, appt.id);
        } else {
            return this.db.prepare(`
                INSERT INTO appointments (patient_id, date, time, reason, status)
                VALUES (?, ?, ?, ?, 'CONFIRMED')
            `).run(appt.patient_id, appt.date, appt.time, appt.reason);
        }
    }

    searchConditions(query?: string, limit?: number) {
        return catalog.searchConditions(this.db, query, limit);
    }

    searchMedicines(query?: string, limit?: number) {
        return catalog.searchMedicines(this.db, query, limit);
    }

    createCondition(input: any) {
        return catalog.createCondition(this.db, input);
    }

    createMedicine(input: any) {
        return catalog.createMedicine(this.db, input);
    }

    getConditionMedPresets(conditionId: number) {
        return catalog.getConditionMedPresets(this.db, conditionId);
    }

    listConditions(includeRetired = false) {
        return catalog.listConditions(this.db, includeRetired);
    }

    listMedicines(includeRetired = false) {
        return catalog.listMedicines(this.db, includeRetired);
    }

    updateCondition(input: any) {
        return catalog.updateCondition(this.db, input);
    }

    updateMedicine(input: any) {
        return catalog.updateMedicine(this.db, input);
    }

    retireCondition(id: number) {
        return catalog.retireCondition(this.db, id);
    }

    retireMedicine(id: number) {
        return catalog.retireMedicine(this.db, id);
    }

    replaceConditionMedPresets(input: any) {
        return catalog.replaceConditionMedPresets(this.db, input);
    }

    logStats() {
        if (!this.db) return;
        try {
            const users = this.db.prepare('SELECT count(*) as c FROM users').get().c;
            const patients = this.db.prepare('SELECT count(*) as c FROM patients').get().c;
            const visits = this.db.prepare('SELECT count(*) as c FROM visits').get().c;
            const queue = this.db.prepare('SELECT count(*) as c FROM patient_queue').get().c;
            console.log('--- [DB STATS] ---');
            console.log(`Users: ${users}`);
            console.log(`Patients: ${patients}`);
            console.log(`Visits: ${visits}`);
            console.log(`Queue: ${queue}`);
            console.log('------------------');
        } catch (e) {
            console.error('Failed to log stats:', e);
        }
    }
}
