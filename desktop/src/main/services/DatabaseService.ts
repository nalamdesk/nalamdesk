import { MIGRATIONS } from '../schema/migrations';
import * as catalog from '../catalog/catalogStore';
import { createHash } from 'node:crypto';
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
        this.repairMissingMrns();
    }

    /**
     * Crash-window repair: a registration interrupted between INSERT and
     * MRN assignment leaves a NULL-mrn chart. Re-mint on every launch
     * (idempotent: only NULL/empty rows match, rowid-derived so unique).
     */
    private repairMissingMrns(): void {
        try {
            const prefix = String((this.getSettings() as any)?.mrn_prefix || 'ND').trim() || 'ND';
            // Prefix is data, not SQL: quote it as a bound parameter.
            this.db.prepare(`UPDATE patients SET mrn = ? || printf('%06d', 100000 + id)
                WHERE mrn IS NULL OR mrn = ''`).run(prefix + '-');
        } catch (e) {
            console.error('[DB] MRN repair failed:', e);
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
        return this.db.prepare('SELECT id, username, role, name, active, created_at, designation, mobile, email, joining_date, abdm_hpr_id FROM users ORDER BY created_at DESC').all();
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
            specialty: null, license_number: null, abdm_hpr_id: null,
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
        // Password-reset flags move only through dedicated reset workflows,
        // never through generic profile edits.
        delete safeUser.password_reset_required;
        // Registry IDs live outside most edit forms: an absent value must not
        // wipe the stored one. Clearing goes through an explicit empty string.
        if (user.abdm_hpr_id == null && existing.abdm_hpr_id) {
            safeUser.abdm_hpr_id = existing.abdm_hpr_id;
        }

        const query = this.buildUpdateQuery();
        // Bind exactly the columns the query names: extra keys (username,
        // uuid, reset flags) must never reach the statement.
        const params = {
            id: safeUser.id,
            role: safeUser.role,
            name: safeUser.name,
            active: safeUser.active,
            specialty: safeUser.specialty,
            license_number: safeUser.license_number,
            abdm_hpr_id: safeUser.abdm_hpr_id,
            mobile: safeUser.mobile,
            email: safeUser.email,
            designation: safeUser.designation,
            joining_date: safeUser.joining_date,
            address: safeUser.address,
            emergency_contact_name: safeUser.emergency_contact_name,
            emergency_contact_phone: safeUser.emergency_contact_phone
        };
        const result = this.db.prepare(query).run(params);

        if (actingUserId) {
            this.logAudit('USER_UPDATE', 'users', user.id, actingUserId, `Updated user ${user.username}`);
        }
        return result;
    }

    private buildUpdateQuery(): string {
        const baseCols = `role = @role, name = @name, active = @active, specialty = @specialty, license_number = @license_number,
            abdm_hpr_id = @abdm_hpr_id,
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
                username, password, role, name, active, specialty, license_number, abdm_hpr_id,
                mobile, email, designation, joining_date, address, emergency_contact_name, emergency_contact_phone,
                password_reset_required
            )
            VALUES(
                @username, @password, @role, @name, @active, @specialty, @license_number, @abdm_hpr_id,
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
        // Explicit column list: the keychain-protected ABDM secret blob must
        // never ride along on generic settings reads. Use the dedicated
        // getAbdmSecretProtected accessor from the main process only.
        return this.db.prepare(`SELECT clinic_name, doctor_name, logo_path, license_key,
            drive_tokens, cloud_clinic_id, cloud_api_key, cloud_enabled,
            drive_client_id, drive_client_secret, local_backup_path,
            backup_schedule, cloud_backup_schedule, mrn_prefix, consultation_fee,
            abdm_gateway_env, abdm_client_id, abdm_mock, abdm_hip_id, abdm_counter_id,
            abdm_hfr_id, abdm_hpr_id, abdm_hip_endpoint, abdm_recipient_key,
            abdm_hiu_public_key
            FROM settings LIMIT 1`).get();
    }

    /**
     * Desk-safe settings view: identity and feature flags only. Tokens,
     * secrets, file paths, and keys never leave this allowlist, so it is
     * safe to serve to any authenticated role.
     */
    getSanitizedSettings() {
        return this.db.prepare(`SELECT clinic_name, doctor_name, logo_path, cloud_enabled,
            abdm_gateway_env, abdm_mock, abdm_hip_id, abdm_counter_id,
            abdm_hfr_id, abdm_hip_endpoint, abdm_hiu_public_key
            FROM settings LIMIT 1`).get();
    }

    // The callback shared secret is write-only through settings: readers
    // learn only whether one is set, never its value.
    hasCallbackSecret(): boolean {
        try {
            const row = this.db.prepare(
                'SELECT abdm_callback_secret AS value FROM settings LIMIT 1').get() as any;
            return !!row?.value;
        } catch {
            return false;
        }
    }

    callbackSecretMatches(presented: unknown, strict = false): boolean {
        try {
            const row = this.db.prepare(
                'SELECT abdm_callback_secret AS value FROM settings LIMIT 1').get() as any;
            const expected = String(row?.value || '');
            // Without a configured secret, callbacks stay open only for
            // sandbox testing. Live mode requires the password.
            if (!expected) return !strict;
            return this.secretsEqual(String(presented || ''), expected);
        } catch {
            return false;
        }
    }

    // Constant-time comparison over the longer length, so neither value nor
    // length leaks through timing.
    private secretsEqual(a: string, b: string): boolean {
        const max = Math.max(a.length, b.length);
        let diff = a.length ^ b.length;
        for (let i = 0; i < max; i++) {
            diff |= ((i < a.length ? a.charCodeAt(i) : 0) ^ (i < b.length ? b.charCodeAt(i) : 0));
        }
        return diff === 0;
    }
    // Main-process-only accessor for the keychain-protected ABDM secret blob.
    // Never exposed through generic settings responses, IPC getters, or LAN.
    getAbdmSecretProtected(): string | null {
        try {
            const row = this.db.prepare(
                'SELECT abdm_client_secret_protected AS value FROM settings LIMIT 1').get() as any;
            return row?.value ?? null;
        } catch {
            return null;
        }
    }

    // Main-process-only accessor for the keychain-protected HIU private key.
    // Same contract as the client secret: never in generic reads or LAN.
    getHiuPrivateProtected(): string | null {
        try {
            const row = this.db.prepare(
                'SELECT abdm_hiu_private_protected AS value FROM settings LIMIT 1').get() as any;
            return row?.value ?? null;
        } catch {
            return null;
        }
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

    saveRole(name: string, permissions: string[], actingUserId?: number) {
        const clean = String(name || '').trim().toLowerCase();
        if (!clean) throw new Error('Role name is required.');
        if (!/^[a-z0-9][a-z0-9-_]{1,39}$/.test(clean)) {
            throw new Error('Role name must be 2-40 chars: letters, numbers, hyphen, underscore.');
        }
        const list = Array.isArray(permissions) ? permissions : [];
        const json = JSON.stringify([...new Set(list.map((m) => String(m)))]);
        const result = this.db.prepare('INSERT INTO roles (name, permissions) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET permissions = excluded.permissions').run(clean, json);
        this.logAudit('SAVE', 'roles', 0, actingUserId, `Saved custom role ${clean} (${list.length} permissions)`);
        return result;
    }

    /**
     * Deletes a custom role. Built-in roles and roles still assigned to
     * users are protected: removing either would silently revoke access.
     */
    deleteRole(name: string, actingUserId?: number) {
        const clean = String(name || '').trim().toLowerCase();
        if (['admin', 'doctor', 'nurse', 'receptionist'].includes(clean)) {
            throw new Error('Built-in roles cannot be deleted.');
        }
        const assigned = this.db.prepare(
            'SELECT COUNT(*) as count FROM users WHERE LOWER(role) = ?').get(clean) as any;
        if (assigned && Number(assigned.count) > 0) {
            throw new Error(`Role is still assigned to ${assigned.count} user(s). Reassign them first.`);
        }
        const result = this.db.prepare('DELETE FROM roles WHERE name = ?').run(clean);
        this.logAudit('DELETE', 'roles', 0, actingUserId, `Deleted custom role ${clean}`);
        return result;
    }

    // ------------------------------------------------------------------
    // Demo seed data (first-run onboarding). Admin-only surface.
    // ------------------------------------------------------------------
    private static readonly DEMO_SEED_META_KEY = 'demo_seed_snapshot';

    /** Demo clinic patients: realistic Indian primary-care case mix. */
    private static readonly DEMO_PATIENTS = [
        { name: 'Meenakshi Sundaram', age: 54, gender: 'Female', mobile: '9840010001', address: '12 Mela Masi Street, Madurai', blood_group: 'B+' },
        { name: 'Rajesh Kumar', age: 41, gender: 'Male', mobile: '9840010002', address: '45 Anna Nagar, Chennai', blood_group: 'O+' },
        { name: 'Fatima Begum', age: 63, gender: 'Female', mobile: '9840010003', address: '8 Mosque Street, Trichy', blood_group: 'A+' },
        { name: 'Arun Prakash', age: 29, gender: 'Male', mobile: '9840010004', address: '3 Gandhi Nagar, Coimbatore', blood_group: 'AB+' },
        { name: 'Lakshmi Ammal', age: 71, gender: 'Female', mobile: '9840010005', address: '21 Temple Street, Tanjore', blood_group: 'O-' }
    ];

    getDemoSeedState() {
        try {
            const row = this.db.prepare('SELECT value FROM app_meta WHERE key = ?')
                .get(DatabaseService.DEMO_SEED_META_KEY) as any;
            if (!row?.value) return { seeded: false as boolean, seededAt: null as string | null, patientIds: [] as number[] };
            const snapshot = JSON.parse(row.value);
            return {
                seeded: true as boolean,
                seededAt: (snapshot.seededAt as string | null) ?? null,
                patientIds: (snapshot.patientIds as number[]) ?? []
            };
        } catch {
            return { seeded: false as boolean, seededAt: null as string | null, patientIds: [] as number[] };
        }
    }

    /**
     * Loads a small demo clinic so first-run users see live pages instead
     * of empty tables. Refuses when already seeded or when real patients
     * exist, so demo rows can never mingle silently with clinic data.
     */
    seedDemoData(actingUserId?: number) {
        if (this.getDemoSeedState().seeded) throw new Error('Demo data is already loaded.');
        const existing = this.db.prepare('SELECT COUNT(*) as count FROM patients').get() as any;
        if (existing && Number(existing.count) > 0) {
            throw new Error('Clinic already has patients. Remove demo data first or start from an empty clinic.');
        }
        const today = new Date().toISOString().slice(0, 10);
        const snapshot: { seededAt: string; patientIds: number[]; queueIds: number[]; vitalIds: number[]; appointmentIds: number[] } = {
            seededAt: new Date().toISOString(), patientIds: [], queueIds: [], vitalIds: [], appointmentIds: []
        };
        const seed = this.db.transaction(() => {
            DatabaseService.DEMO_PATIENTS.forEach((demo, index) => {
                const saved: any = this.savePatient({ ...demo });
                const patientId = Number(saved?.lastInsertRowid ?? saved?.id);
                if (!Number.isInteger(patientId) || patientId <= 0) {
                    throw new Error('Demo seed could not create the patient record.');
                }
                snapshot.patientIds.push(patientId);
                // First three patients are waiting; the fourth has vitals
                // recorded; the fifth holds today's appointment.
                if (index < 3) {
                    const queued: any = this.addToQueue(
                        patientId, { priority: index + 1, triage_notes: 'Demo walk-in' }, actingUserId);
                    snapshot.queueIds.push(Number(queued.lastInsertRowid ?? queued.id));
                }
                if (index === 3) {
                    const vital: any = this.saveVitals({
                        patient_id: patientId,
                        systolic_bp: 120, diastolic_bp: 80, pulse: 72, spo2: 98, temperature: 98.6
                    }, actingUserId);
                    snapshot.vitalIds.push(Number(vital.lastInsertRowid ?? vital.id));
                }
                if (index === 4) {
                    const appt: any = this.saveAppointment({
                        patient_id: patientId, date: today, time: '10:30', reason: 'Diabetes review'
                    });
                    snapshot.appointmentIds.push(Number(appt.lastInsertRowid));
                }
            });
            this.db.prepare(`INSERT INTO app_meta (key, value, updated_at)
                VALUES (?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`)
                .run(DatabaseService.DEMO_SEED_META_KEY, JSON.stringify(snapshot));
        });
        seed();
        this.logAudit('SEED', 'patients', 0, actingUserId,
            `Loaded demo clinic (${snapshot.patientIds.length} patients)`);
        return this.getDemoSeedState();
    }

    /**
     * Removes exactly the rows recorded in the seed snapshot. Tolerates
     * rows the user already deleted by hand; refuses when never seeded.
     */
    clearDemoData(actingUserId?: number) {
        const state = this.getDemoSeedState();
        if (!state.seeded) throw new Error('No demo data to remove.');
        let snapshot: { patientIds?: number[]; queueIds?: number[]; vitalIds?: number[]; appointmentIds?: number[] };
        try {
            snapshot = JSON.parse((this.db.prepare('SELECT value FROM app_meta WHERE key = ?')
                .get(DatabaseService.DEMO_SEED_META_KEY) as any)?.value || '{}');
        } catch {
            snapshot = {};
        }
        const clear = this.db.transaction(() => {
            for (const id of snapshot.appointmentIds || []) {
                this.db.prepare('DELETE FROM appointments WHERE id = ?').run(Number(id));
            }
            for (const id of snapshot.queueIds || []) {
                this.db.prepare('DELETE FROM patient_queue WHERE id = ?').run(Number(id));
            }
            for (const id of snapshot.vitalIds || []) {
                this.db.prepare('DELETE FROM vitals WHERE id = ?').run(Number(id));
            }
            for (const id of snapshot.patientIds || []) {
                this.db.prepare('DELETE FROM patients WHERE id = ?').run(Number(id));
            }
            this.db.prepare('DELETE FROM app_meta WHERE key = ?').run(DatabaseService.DEMO_SEED_META_KEY);
        });
        clear();
        this.logAudit('UNSEED', 'patients', 0, actingUserId, 'Removed demo clinic data');
        return this.getDemoSeedState();
    }

    /**
     * Per-user permission deltas over the role baseline (M3-RBAC). One row
     * allows or forbids a single action for a single user; reason is
     * mandatory so the audit trail records why access changed hands.
     */
    getUserOverrides(userId: number) {
        return this.db.prepare(`SELECT * FROM user_permission_overrides
            WHERE user_id = ? ORDER BY action ASC`).all(Number(userId));
    }

    /** All override rows, for compiling the policy set. */
    getAllOverrides() {
        return this.db.prepare(`SELECT user_id, action, effect FROM user_permission_overrides
            ORDER BY user_id ASC, action ASC`).all();
    }

    setUserOverride(input: {
        userId: number; action: string; effect: string; reason: string;
    }, actingUserId?: number) {
        const userId = Number(input?.userId);
        if (!Number.isInteger(userId) || userId <= 0) throw new Error('user_id is required.');
        const action = String(input?.action || '').trim();
        if (!action) throw new Error('action is required.');
        const effect = String(input?.effect || '').trim().toLowerCase();
        if (effect !== 'allow' && effect !== 'forbid') {
            throw new Error(`Unknown override effect: ${input?.effect}`);
        }
        const reason = String(input?.reason || '').trim();
        if (!reason) throw new Error('A reason is required for permission overrides.');
        const user = this.db.prepare('SELECT id FROM users WHERE id = ?').get(userId) as any;
        if (!user) throw new Error('User not found.');
        this.db.prepare(`
            INSERT INTO user_permission_overrides (user_id, action, effect, reason, granted_by)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(user_id, action) DO UPDATE SET
                effect = excluded.effect, reason = excluded.reason,
                granted_by = excluded.granted_by, created_at = CURRENT_TIMESTAMP
        `).run(userId, action, effect, reason, actingUserId ?? null);
        // lastInsertRowid is stale on the CONFLICT/DO UPDATE path, so resolve
        // the row first and audit its actual id.
        const row = this.db.prepare(`SELECT * FROM user_permission_overrides
            WHERE user_id = ? AND action = ?`).get(userId, action) as any;
        this.logAudit('UPSERT', 'user_permission_overrides', Number(row?.id),
            actingUserId, `${effect} ${action} for user ${userId}: ${reason}`);
        return row;
    }

    /**
     * IPC-name alias for the LAN generic dispatcher, which resolves handlers
     * by command name. Electron's explicit handler calls setUserOverride
     * directly; the alias keeps both transports on one implementation.
     */
    saveUserOverride(input: {
        userId: number; action: string; effect: string; reason: string;
    }, actingUserId?: number) {
        return this.setUserOverride(input, actingUserId);
    }

    deleteUserOverride(userId: number, action: string, actingUserId?: number) {
        const cleanAction = String(action || '').trim();
        // Resolve the row id first: auditing users.id would point at the
        // wrong record (same class of bug as the upsert path above).
        const existing = this.db.prepare(`SELECT id FROM user_permission_overrides
            WHERE user_id = ? AND action = ?`).get(Number(userId), cleanAction) as any;
        const result = this.db.prepare(`DELETE FROM user_permission_overrides
            WHERE user_id = ? AND action = ?`).run(Number(userId), cleanAction);
        if (existing?.id) {
            this.logAudit('DELETE', 'user_permission_overrides', Number(existing.id),
                actingUserId, `Removed ${cleanAction} override for user ${userId}`);
        }
        return result;
    }

    saveSettings(settings: any) {
        // ... (existing code)
        const existing = this.getSettings();

        // Allowed columns whitelist to prevent SQL injection
        const ALLOWED_COLUMNS = [
            'clinic_name', 'doctor_name', 'logo_path', 'license_key',
            'drive_tokens', 'cloud_clinic_id', 'cloud_api_key', 'cloud_enabled',
            'drive_client_id', 'drive_client_secret', 'local_backup_path',
            'backup_schedule', 'cloud_backup_schedule', 'mrn_prefix', 'consultation_fee',
            'abdm_gateway_env', 'abdm_client_id', 'abdm_mock', 'abdm_hip_id', 'abdm_counter_id',
            'abdm_hfr_id', 'abdm_hpr_id', 'abdm_hip_endpoint', 'abdm_recipient_key',
            'abdm_hiu_public_key',
            'abdm_callback_secret'
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

    // Dedicated writer for the keychain-protected HIU private key. Same
    // contract: plaintext key material never crosses generic settings paths.
    saveHiuPrivateProtected(protectedValue: string) {
        const existing = this.getSettings();
        if (existing) {
            this.db.prepare('UPDATE settings SET abdm_hiu_private_protected = ?').run(protectedValue);
        } else {
            this.db.prepare('INSERT INTO settings(abdm_hiu_private_protected) VALUES(?)').run(protectedValue);
        }
    }

    /**
     * Writes both HIU keypair halves atomically: a crash between the two
     * writes must never leave a public key paired with another key's
     * private half (records encrypted to it would be undecryptable).
     */
    saveHiuKeypair(publicKey: string, protectedPrivate: string) {
        const save = this.db.transaction(() => {
            const existing = this.getSettings();
            if (existing) {
                this.db.prepare(`UPDATE settings
                    SET abdm_hiu_private_protected = ?, abdm_hiu_public_key = ?`).run(protectedPrivate, publicKey);
            } else {
                this.db.prepare(`INSERT INTO settings(abdm_hiu_private_protected, abdm_hiu_public_key)
                    VALUES(?, ?)`).run(protectedPrivate, publicKey);
            }
        });
        return (save as any).immediate ? (save as any).immediate() : (save as any)();
    }

    getDashboardStats() {        const totalPatients = this.db.prepare('SELECT count(*) as count FROM patients WHERE merged_into IS NULL').get().count;
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
            return this.db.prepare('SELECT * FROM patients WHERE merged_into IS NULL ORDER BY created_at DESC LIMIT 50').all();
        }
        const search = `%${query.trim()}%`;
        return this.db.prepare(`
        SELECT * FROM patients
      WHERE (name LIKE ? OR mobile LIKE ? OR mrn LIKE ?) AND merged_into IS NULL
            ORDER BY created_at DESC
                `).all(search, search, search);
    }

    /**
     * Patient INSERT with the UNIQUE index as the final arbiter: the
     * read-then-insert MRN check above narrows accidental reuse, but only
     * the constraint closes the concurrent-registration race. Surfaces a
     * friendly error instead of raw SQLite constraint text.
     */
    private insertPatientRow(patient: any) {
        try {
            return this.db.prepare(`
        INSERT INTO patients(
            uuid, name, mobile, age, gender, address,
            dob, dob_estimated, blood_group, email, emergency_contact_name, emergency_contact_mobile,
            street, city, state, zip_code, insurance_provider, policy_number,
            abha_address, abha_name, mrn
        )
        VALUES(
            @uuid, @name, @mobile, @age, @gender, @address,
            @dob, @dob_estimated, @blood_group, @email, @emergency_contact_name, @emergency_contact_mobile,
            @street, @city, @state, @zip_code, @insurance_provider, @policy_number,
            @abha_address, @abha_name, @mrn
        )
            `).run({ ...patient, mrn: patient.mrn ?? null });
        } catch (e: any) {
            // Narrow to the MRN index: any other constraint failure (uuid,
            // future unique columns) must surface unmasked.
            if (/UNIQUE constraint failed: patients\.mrn/.test(String(e?.message || ''))) {
                throw new Error('MRN is already registered.');
            }
            throw e;
        }
    }

    /**
     * Duplicate-warning candidates for registration: exact MRN, exact
     * mobile, and name+DOB matches. Shared phone numbers score lower and
     * are labeled as possible (never identical) — twins and families share
     * numbers. Merged-away charts are excluded from results.
     */
    findDuplicateCandidates(input: {
        name?: string; dob?: string | null; mobile?: string; mrn?: string; excludeId?: number;
    }) {
        const name = String(input?.name || '').trim();
        const dob = input?.dob ? String(input.dob).slice(0, 10) : '';
        const mobile = String(input?.mobile || '').trim();
        const mrn = String(input?.mrn || '').trim();
        const excludeId = Number(input?.excludeId) || 0;
        if (!name && !mobile && !mrn) return [];
        // SQL prefilter first: JS scoring runs over the matching subset,
        // never the whole chart table on every keystroke.
        const filters: string[] = [];
        const params: unknown[] = [];
        if (mrn) {
            filters.push('LOWER(mrn) = LOWER(?)');
            params.push(mrn);
        }
        if (mobile) {
            filters.push('mobile = ?');
            params.push(mobile);
        }
        if (name) {
            filters.push('LOWER(name) = LOWER(?)');
            params.push(name);
        }
        params.push(excludeId);
        const rows = this.db.prepare(`SELECT id, uuid, mrn, name, mobile, age, gender, dob, dob_estimated
            FROM patients WHERE (${filters.join(' OR ')}) AND (merged_into IS NULL) AND id != ?`)
            .all(...params) as any[];
        const scored: { patient: any; signals: string[]; score: number }[] = [];
        for (const row of rows) {
            const signals: string[] = [];
            let score = 0;
            if (mrn && row.mrn && String(row.mrn).toLowerCase() === mrn.toLowerCase()) {
                signals.push('mrn');
                score = Math.max(score, 100);
            }
            const rowDob = row.dob ? String(row.dob).slice(0, 10) : '';
            if (name && row.name && String(row.name).trim().toLowerCase() === name.toLowerCase()) {
                if (dob && rowDob && rowDob === dob) {
                    signals.push('name-dob');
                    score = Math.max(score, 85);
                } else {
                    signals.push('name');
                    score = Math.max(score, 30);
                }
            }
            if (mobile && row.mobile && String(row.mobile).trim() === mobile) {
                signals.push('phone-shared-possible');
                score = Math.max(score, 60);
            }
            if (signals.length > 0) scored.push({ patient: row, signals, score });
        }
        return scored.sort((a, b) => b.score - a.score).slice(0, 10);
    }

    /** Tables whose patient_id rows move on merge (queue history follows queue rows). */
    // patient_queue moves first: visit triggers validate queue-entry
    // ownership, so queue rows must already point at the survivor.
    private static readonly MERGE_TABLES: { table: string; idColumn: string }[] = [
        { table: 'patient_queue', idColumn: 'id' },
        { table: 'visits', idColumn: 'id' },
        { table: 'vitals', idColumn: 'id' },
        { table: 'appointments', idColumn: 'id' },
        { table: 'encounter_requests', idColumn: 'request_id' },
        { table: 'patient_allergies', idColumn: 'id' },
        { table: 'patient_conditions', idColumn: 'id' },
        { table: 'patient_medications', idColumn: 'id' },
        { table: 'abdm_consents', idColumn: 'id' },
        { table: 'abdm_fetched_records', idColumn: 'id' }
    ];

    private mergeableChart(id: number) {
        const row = this.db.prepare(`SELECT id, name, mrn, mobile, gender, dob, abha_address, abha_name, merged_into
            FROM patients WHERE id = ?`).get(Number(id)) as any;
        if (!row) throw new Error(`Patient #${id} not found.`);
        if (row.merged_into != null) throw new Error(`${row.name || `Patient #${id}`} is already merged and cannot be merged again.`);
        return row;
    }

    /**
     * Merge preview: both charts, per-table move counts, and hard stops.
     * Refuses nothing itself — mergePatients enforces the same rules.
     */
    previewPatientMerge(input: { survivorId: number; duplicateId: number }) {
        const survivorId = Number(input?.survivorId);
        const duplicateId = Number(input?.duplicateId);
        const survivor = this.mergeableChart(survivorId);
        const duplicate = this.mergeableChart(duplicateId);
        if (Number(survivorId) === Number(duplicateId)) throw new Error('Survivor and duplicate must differ.');
        const counts: Record<string, number> = {};
        for (const { table } of DatabaseService.MERGE_TABLES) {
            try {
                counts[table] = Number((this.db.prepare(
                    `SELECT COUNT(*) as count FROM ${table} WHERE patient_id = ?`).get(duplicate.id) as any)?.count || 0);
            } catch { counts[table] = 0; }
        }
        const warnings: string[] = [];
        for (const pid of [survivor.id, duplicate.id]) {
            const active = this.db.prepare(
                `SELECT id FROM visits WHERE patient_id = ? AND status = 'in-progress' LIMIT 1`).get(pid) as any;
            if (active) warnings.push(`Patient #${pid} has an active encounter: resolve it before merging.`);
        }
        if (duplicate.abha_address && survivor.abha_address
            && String(duplicate.abha_address) !== String(survivor.abha_address)) {
            warnings.push('Both charts hold different health IDs: unlink one before merging.');
        }
        return { survivor, duplicate, counts, warnings };
    }

    /**
     * Merges duplicateId into survivorId: reassigns related rows, moves an
     * uncontested health-ID link, links the absorbed chart, and records
     * every moved row for rollback. Doctor/admin-only at the IPC layer.
     */
    mergePatients(input: { survivorId: number; duplicateId: number; reason: string }, actingUserId?: number) {
        const reason = String(input?.reason || '').trim();
        if (!reason) throw new Error('A reason is required for merging charts.');
        const survivorId = Number(input?.survivorId);
        const duplicateId = Number(input?.duplicateId);
        if (!Number.isInteger(survivorId) || !Number.isInteger(duplicateId)) {
            throw new Error('Survivor and duplicate ids are required.');
        }
        if (survivorId === duplicateId) throw new Error('Survivor and duplicate must differ.');
        const merge = this.db.transaction(() => {
            const survivor = this.mergeableChart(survivorId);
            const duplicate = this.mergeableChart(duplicateId);
            for (const pid of [survivor.id, duplicate.id]) {
                const active = this.db.prepare(
                    `SELECT id FROM visits WHERE patient_id = ? AND status = 'in-progress' LIMIT 1`).get(pid) as any;
                if (active) throw new Error(`Patient #${pid} has an active encounter: resolve it before merging.`);
            }
            if (duplicate.abha_address && survivor.abha_address
                && String(duplicate.abha_address) !== String(survivor.abha_address)) {
                throw new Error('Both charts hold different health IDs: unlink one before merging.');
            }
            const moved: { table: string; idColumn: string; rowId: number | string }[] = [];
            // Table/column identifiers come from the static allowlist above,
            // never from caller input; only values are bound parameters.
            for (const { table, idColumn } of DatabaseService.MERGE_TABLES) {
                const rows = this.db.prepare(
                    `SELECT ${idColumn} as rid FROM ${table} WHERE patient_id = ?`).all(duplicate.id) as any[];
                for (const row of rows) {
                    this.db.prepare(`UPDATE ${table} SET patient_id = ? WHERE ${idColumn} = ?`).run(survivor.id, row.rid);
                    moved.push({ table, idColumn, rowId: row.rid });
                }
            }
            let movedAbhaAddress: string | null = null;
            let movedAbhaName: string | null = null;
            if (duplicate.abha_address && !survivor.abha_address) {
                // Clear first, then set: the unique index forbids two rows
                // holding the same health ID even mid-move.
                this.db.prepare('UPDATE patients SET abha_address = NULL, abha_name = NULL WHERE id = ?')
                    .run(duplicate.id);
                this.db.prepare('UPDATE patients SET abha_address = ?, abha_name = ? WHERE id = ?')
                    .run(duplicate.abha_address, duplicate.abha_name, survivor.id);
                movedAbhaAddress = duplicate.abha_address;
                movedAbhaName = duplicate.abha_name;
                moved.push({ table: 'patients_abha', idColumn: '', rowId: duplicate.id });
            }
            this.db.prepare('UPDATE patients SET merged_into = ? WHERE id = ?').run(survivor.id, duplicate.id);
            const record = this.db.prepare(`INSERT INTO patient_merges
                (survivor_id, duplicate_id, reason, merged_by, moved_abha_address, moved_abha_name)
                VALUES (?, ?, ?, ?, ?, ?)`)
                .run(survivor.id, duplicate.id, reason, actingUserId ?? null, movedAbhaAddress, movedAbhaName) as any;
            const mergeId = Number(record.lastInsertRowid);
            const addItem = this.db.prepare(`INSERT INTO patient_merge_items
                (merge_id, table_name, id_column, row_id) VALUES (?, ?, ?, ?)`);
            for (const item of moved) addItem.run(mergeId, item.table, item.idColumn, String(item.rowId));
            return { mergeId, moved: moved.length };
        });
        const result = merge();
        this.logAudit('MERGE', 'patients', duplicateId, actingUserId,
            `Merged patient #${duplicateId} into #${survivorId} (${result.moved} rows): ${reason}`);
        return { ...result, survivorId, duplicateId };
    }

    /**
     * Reverses a merge via its ledger: rows move back, the link clears, the
     * merge is stamped undone (ledger itself is append-only history).
     */
    unmergePatients(duplicateId: number, actingUserId?: number) {
        const dup = Number(duplicateId);
        const undo = this.db.transaction(() => {
            const open = this.db.prepare(`SELECT * FROM patient_merges
                WHERE duplicate_id = ? AND undone_at IS NULL ORDER BY id DESC LIMIT 1`).get(dup) as any;
            if (!open) throw new Error('No open merge found for this chart.');
            const items = this.db.prepare(`SELECT table_name, id_column, row_id FROM patient_merge_items
                WHERE merge_id = ?`).all(open.id) as any[];
            // Table names below come from our own ledger (written from the
            // static MERGE_TABLES allowlist), never from caller input.
            const allowed = new Map(
                DatabaseService.MERGE_TABLES.map((t) => [t.table, t.idColumn] as [string, string]));
            for (const item of items) {
                if (item.table_name === 'patients_abha') {
                    // Restore exactly what moved (ledger values, not the
                    // survivor's current link, which may have changed since).
                    // A survivor link acquired after the merge is theirs now:
                    // only clear what this merge placed.
                    const current = this.db.prepare(
                        'SELECT abha_address FROM patients WHERE id = ?').get(open.survivor_id) as any;
                    if (!current?.abha_address || current.abha_address === open.moved_abha_address) {
                        this.db.prepare('UPDATE patients SET abha_address = NULL, abha_name = NULL WHERE id = ?')
                            .run(open.survivor_id);
                    }
                    this.db.prepare('UPDATE patients SET abha_address = ?, abha_name = ? WHERE id = ?')
                        .run(open.moved_abha_address, open.moved_abha_name, open.duplicate_id);
                    continue;
                }
                const idColumn = allowed.get(item.table_name);
                if (!idColumn || item.id_column !== idColumn) continue;
                this.db.prepare(`UPDATE ${item.table_name} SET patient_id = ? WHERE ${idColumn} = ?`)
                    .run(open.duplicate_id, item.row_id);
            }
            this.db.prepare('UPDATE patients SET merged_into = NULL WHERE id = ?').run(open.duplicate_id);
            this.db.prepare(`UPDATE patient_merges SET undone_at = CURRENT_TIMESTAMP WHERE id = ?`).run(open.id);
            return { open, movedBack: items.length };
        });
        const { open, movedBack } = undo();
        this.logAudit('UNMERGE', 'patients', open.duplicate_id, actingUserId,
            `Unmerged patient #${open.duplicate_id} from #${open.survivor_id} (${movedBack} rows restored)`);
        return { mergeId: open.id, movedBack };
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

    // Care context references (`OP-YYYY-NNNN`) durably link an encounter to
    // its ABDM care context. Numbers come from a per-year sequence table —
    // never from MAX() over visits — so deleting an encounter can never
    // cause its externally visible reference to be reused. Called inside the
    // encounter transactions, so concurrent begins cannot share a number.
    private nextCareContextRef(): string {
        const year = new Date().getFullYear();
        this.db.prepare(
            `INSERT INTO care_context_seq (year, last_no) VALUES (?, 0)
             ON CONFLICT(year) DO NOTHING`
        ).run(year);
        const row = this.db.prepare(
            `UPDATE care_context_seq SET last_no = last_no + 1 WHERE year = ? RETURNING last_no`
        ).get(year) as any;
        return `OP-${year}-${String(Number(row?.last_no || 0)).padStart(4, '0')}`;
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

    // ABDM callback inbox: gateway notifications (consent events, data-share
    // notices, link confirmations) land here for explicit human handling.
    // M3 enumerates consent kinds; requestId makes gateway retries idempotent.
    receiveInboxCallback(kind: string, payload: any, actingUserId?: number, requestId?: string) {
        const cleanKind = String(kind || '').trim().slice(0, 64);
        if (!cleanKind) throw new Error('Callback kind is required.');
        const cleanRequestId = String(requestId || (payload as any)?.requestId || '').trim().slice(0, 128) || null;
        if (cleanRequestId) {
            const existing = this.db.prepare(
                `SELECT * FROM abdm_inbox WHERE kind = ? AND request_id = ?`
            ).get(cleanKind, cleanRequestId) as any;
            if (existing) return existing;
        }
        const body = JSON.stringify(payload ?? null);
        if (body.length > 8192) throw new Error('Callback payload is too large.');
        let rowId: number;
        try {
            const result = this.db.prepare(
                `INSERT INTO abdm_inbox (kind, payload, request_id) VALUES (?, ?, ?)`
            ).run(cleanKind, body, cleanRequestId);
            rowId = Number(result.lastInsertRowid);
        } catch (e) {
            // Lost race with a duplicate delivery: return the winner.
            if (!cleanRequestId) throw e;
            const winner = this.db.prepare(
                `SELECT * FROM abdm_inbox WHERE kind = ? AND request_id = ?`
            ).get(cleanKind, cleanRequestId) as any;
            if (!winner) throw e;
            return winner;
        }
        const row = this.db.prepare('SELECT * FROM abdm_inbox WHERE id = ?').get(rowId);
        this.logAudit('INSERT', 'abdm_inbox', rowId,
            actingUserId, `ABDM callback (${cleanKind}) queued`);
        return row;
    }

    getPendingInbox() {
        return this.db.prepare(`SELECT * FROM abdm_inbox
            WHERE status = 'pending' ORDER BY id ASC`).all();
    }

    ackInbox(id: number, actingUserId?: number) {
        const ack = this.db.transaction(() => {
            const row = this.db.prepare('SELECT * FROM abdm_inbox WHERE id = ?').get(Number(id)) as any;
            if (!row || row.status !== 'pending') {
                throw new Error('Callback was already handled.');
            }
            this.db.prepare(`UPDATE abdm_inbox SET status = 'handled' WHERE id = ?`).run(row.id);
            this.logAudit('UPDATE', 'abdm_inbox', row.id, actingUserId,
                `Acknowledged ABDM callback (${row.kind})`);
            return this.db.prepare('SELECT * FROM abdm_inbox WHERE id = ?').get(row.id);
        });
        return ack.immediate();
    }

    /** Enumerated M3 consent-notification kinds carried on the inbox channel. */
    static readonly inboxConsentKinds = [
        'consent-requested',
        'consent-granted',
        'consent-denied',
        'consent-expired',
        'data-ready'
    ] as const;

    static readonly consentStatuses = ['requested', 'granted', 'denied', 'expired'] as const;

    /** Records an HIU consent request; returns the stored row. */
    createConsentRequest(input: {
        patientId?: number | null;
        abhaAddress: string;
        hiTypes: string[];
        dateFrom?: string | null;
        dateTo?: string | null;
        gatewayRequestId?: string | null;
    }, actingUserId?: number) {
        const abhaAddress = String(input?.abhaAddress || '').trim();
        if (!abhaAddress) throw new Error('Health ID is required for a consent request.');
        const hiTypes = Array.isArray(input?.hiTypes)
            ? input.hiTypes.map((t) => String(t || '').trim()).filter(Boolean)
            : [];
        if (hiTypes.length === 0) throw new Error('At least one health information type is required.');
        const patientId = input?.patientId ?? null;
        if (patientId != null) {
            // The address must belong to the patient: never cache outside
            // records against the wrong chart.
            const patient = this.db.prepare(
                'SELECT abha_address FROM patients WHERE id = ?').get(Number(patientId)) as any;
            if (!patient) throw new Error('Patient not found for this consent request.');
            const linked = String(patient.abha_address || '').trim().toLowerCase();
            if (linked && linked !== abhaAddress.toLowerCase()) {
                throw new Error('Health ID does not belong to this patient.');
            }
        }
        const gatewayRequestId = String(input?.gatewayRequestId || '').trim().slice(0, 128) || null;
        const result = this.db.prepare(`
            INSERT INTO abdm_consents (
                patient_id, abha_address, hi_types, date_from, date_to,
                status, gateway_request_id
            ) VALUES (?, ?, ?, ?, ?, 'requested', ?)
        `).run(
            patientId, abhaAddress, JSON.stringify(hiTypes),
            input?.dateFrom || null, input?.dateTo || null, gatewayRequestId
        );
        const row = this.db.prepare('SELECT * FROM abdm_consents WHERE id = ?')
            .get(Number(result.lastInsertRowid));
        this.logAudit('INSERT', 'abdm_consents', Number(result.lastInsertRowid),
            actingUserId, `HIU consent requested for ${abhaAddress}`);
        return row;
    }

    getConsents(patientId?: number | null) {
        if (patientId != null) {
            return this.db.prepare(`SELECT * FROM abdm_consents
                WHERE patient_id = ? ORDER BY id DESC`).all(Number(patientId));
        }
        return this.db.prepare(`SELECT * FROM abdm_consents ORDER BY id DESC`).all();
    }

    getConsentByRequestId(gatewayRequestId: string) {
        const id = String(gatewayRequestId || '').trim();
        if (!id) return null;
        return this.db.prepare(`SELECT * FROM abdm_consents
            WHERE gateway_request_id = ?`).get(id) as any;
    }

    getConsentById(id: number) {
        return this.db.prepare('SELECT * FROM abdm_consents WHERE id = ?').get(Number(id)) as any;
    }

    /** Moves a consent to granted/denied/expired; records the gateway handle. */
    updateConsentStatus(id: number, status: string, consentHandle?: string | null, actingUserId?: number) {
        const next = String(status || '').trim().toLowerCase();
        if (!(DatabaseService.consentStatuses as readonly string[]).includes(next)) {
            throw new Error(`Unknown consent status: ${status}`);
        }
        const existing = this.db.prepare('SELECT * FROM abdm_consents WHERE id = ?').get(Number(id)) as any;
        if (!existing) throw new Error('Consent request not found.');
        // Terminal states never reopen: a replayed grant after deny/expire
        // must not restore fetching. A fresh grant needs a fresh request.
        if ((existing.status === 'denied' || existing.status === 'expired') && next !== existing.status) {
            throw new Error(`Consent is ${existing.status}; a new request is required.`);
        }
        this.db.prepare(`UPDATE abdm_consents
            SET status = ?, consent_handle = COALESCE(?, consent_handle), updated_at = CURRENT_TIMESTAMP
            WHERE id = ?`).run(next, consentHandle ?? null, Number(id));
        const row = this.db.prepare('SELECT * FROM abdm_consents WHERE id = ?').get(Number(id));
        this.logAudit('UPDATE', 'abdm_consents', Number(id), actingUserId, `HIU consent ${next}`);
        return row;
    }

    /** Stores a decrypted inbound bundle against a consent (retention set by caller). */
    storeFetchedRecord(input: {
        consentId?: number | null;
        patientId?: number | null;
        careContextRef?: string | null;
        bundleJson: string;
        expiresAt?: string | null;
    }, actingUserId?: number) {
        const [row] = this.storeFetchedRecordBatch([input], actingUserId);
        return row;
    }

    /**
     * Stores a push batch atomically: every record commits or none does, and
     * retried pushes land idempotently on the (consent, content-hash) key.
     * Returns one row per input, in order.
     */
    storeFetchedRecordBatch(inputs: Array<{
        consentId?: number | null;
        patientId?: number | null;
        careContextRef?: string | null;
        bundleJson: string;
        expiresAt?: string | null;
    }>, actingUserId?: number) {
        const prepared = (inputs || []).map((input) => {
            const bundleJson = String(input?.bundleJson || '');
            if (!bundleJson) throw new Error('A record bundle is required.');
            JSON.parse(bundleJson);
            return {
                consentId: input?.consentId ?? null,
                patientId: input?.patientId ?? null,
                careContextRef: input?.careContextRef || null,
                bundleJson,
                sha: createHash('sha256').update(bundleJson, 'utf8').digest('hex'),
                expiresAt: input?.expiresAt || null
            };
        });
        const storeAll = this.db.transaction(() => {
            const rows: any[] = [];
            for (const record of prepared) {
                this.db.prepare(`
                    INSERT INTO abdm_fetched_records (
                        consent_id, patient_id, care_context_ref, bundle_json,
                        bundle_sha256, status, expires_at
                    ) VALUES (?, ?, ?, ?, ?, 'cached', ?)
                    ON CONFLICT(consent_id, bundle_sha256) DO NOTHING
                `).run(
                    record.consentId, record.patientId, record.careContextRef,
                    record.bundleJson, record.sha, record.expiresAt
                );
                rows.push(this.db.prepare(`SELECT * FROM abdm_fetched_records
                    WHERE consent_id IS ? AND bundle_sha256 = ?`).get(record.consentId, record.sha));
            }
            return rows;
        });
        const rows = (storeAll as any).immediate ? (storeAll as any).immediate() : (storeAll as any)();
        this.logAudit('INSERT', 'abdm_fetched_records', rows.length > 0 ? Number(rows[0].id) : 0,
            actingUserId, `HIU push cached (${rows.length} record(s))`);
        return rows;
    }

    getFetchedRecords(patientId: number, includeExpired = false) {
        return this.db.prepare(`SELECT * FROM abdm_fetched_records
            WHERE patient_id = ? ${includeExpired ? '' : `AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)`}
            ORDER BY id DESC`).all(Number(patientId));
    }

    /** Sweeps expired cache rows: status flips and the decrypted bundle is
     * replaced by a tombstone, so retention actually removes clinical data
     * (metadata stays for accountability). PR3 retention job calls this. */
    expireFetchedRecords() {
        return this.db.prepare(`UPDATE abdm_fetched_records
            SET status = 'expired', bundle_json = '{"expired":true}'
            WHERE status = 'cached' AND expires_at IS NOT NULL
            AND expires_at <= CURRENT_TIMESTAMP`).run();
    }

    /** Explicit patient-initiated wipe of the external-records cache. */
    clearFetchedRecords(patientId: number, actingUserId?: number) {
        const result = this.db.prepare(`DELETE FROM abdm_fetched_records
            WHERE patient_id = ?`).run(Number(patientId));
        this.logAudit('DELETE', 'abdm_fetched_records', Number(patientId),
            actingUserId, 'HIU external-records cache cleared');
        return result;
    }

    // Atomic Scan & Share check-in: claim the token, match or create the
    // patient, and insert the queue entry in one transaction. Anything that
    // fails rolls everything back, so reception never sees "failed" for a
    // patient that was actually queued, and concurrent accepts cannot create
    // duplicate patients. Incomplete demographics leave the token pending and
    // report the patient id for explicit handling in the chart.
    acceptShareTokenAndCheckIn(tokenId: number, actingUserId?: number) {
        const accept = this.db.transaction(() => {
            const token = this.db.prepare('SELECT * FROM abdm_share_tokens WHERE id = ?').get(Number(tokenId)) as any;
            if (!token || token.status !== 'pending') {
                throw new Error('Token was already handled or has expired.');
            }
            const expired = this.db.prepare(`SELECT 1 FROM abdm_share_tokens
                WHERE id = ? AND expires_at <= CURRENT_TIMESTAMP`).get(token.id) as any;
            if (expired) {
                this.db.prepare(`UPDATE abdm_share_tokens SET status = 'expired' WHERE id = ?`).run(token.id);
                throw new Error('Token has expired. Ask the patient to scan again.');
            }
            let patient = token.abha_address ? this.findPatientByAbhaAddress(token.abha_address) : null;
            if (!patient) {
                const created = this.savePatient({
                    name: token.patient_name,
                    mobile: token.mobile || '',
                    age: token.age ?? null,
                    // Token payloads often lack gender: record an explicit
                    // 'Unknown' (a stated value, never a UI default).
                    gender: token.gender || 'Unknown',
                    abha_address: token.abha_address || null,
                    abha_name: token.abha_name || null
                });
                patient = { id: Number((created as any)?.lastInsertRowid ?? (created as any)?.id) };
                if (!patient.id) throw new Error('Could not create the patient record.');
                patient = this.getPatientById(patient.id);
            }
            const complete = !!String(patient.name || '').trim()
                && !!String(patient.mobile || '').trim()
                && !!String(patient.gender || '').trim()
                && ((patient.age != null && Number(patient.age) !== 0) || !!patient.dob);
            if (!complete) {
                return { outcome: 'incomplete', patientId: patient.id, tokenId: token.id };
            }
            const alreadyQueued = this.db.prepare(
                `SELECT id FROM patient_queue WHERE patient_id = ? AND status != 'completed'`
            ).get(patient.id) as any;
            if (!alreadyQueued) {
                this.addToQueue(patient.id, 1, actingUserId);
            }
            this.db.prepare(`UPDATE abdm_share_tokens SET status = 'accepted' WHERE id = ?`).run(token.id);
            this.logAudit('UPDATE', 'abdm_share_tokens', token.id, actingUserId,
                `Accepted Scan & Share token #${token.token_no} for ${token.patient_name}`);
            const entry = this.db.prepare(
                `SELECT id FROM patient_queue WHERE patient_id = ? AND status != 'completed' ORDER BY id DESC LIMIT 1`
            ).get(patient.id) as any;
            return { outcome: 'checked-in', patientId: patient.id, queueEntryId: entry?.id ?? null, tokenId: token.id };
        });
        return accept.immediate();
    }

    static readonly PATIENT_GENDERS = ['Male', 'Female', 'Other', 'Unknown'];

    savePatient(patientData: any) {
        // Ensure all fields exist for named parameters
        const defaults = {
            dob: null, dob_estimated: 0, blood_group: null, email: null,
            emergency_contact_name: null, emergency_contact_mobile: null,
            street: null, city: null, state: null, zip_code: null,
            insurance_provider: null, policy_number: null,
            abha_address: null, abha_name: null,
            address: '', age: 0, gender: '', mobile: '', name: ''
        };

        const patient = { ...defaults, ...patientData };
        patient.dob_estimated = patient.dob_estimated ? 1 : 0;

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
            // Gender is never blanked by an edit: omitted keeps the stored
            // value, an explicit blank is rejected like on registration.
            if (patientData?.gender == null) {
                const stored = this.db.prepare(
                    'SELECT gender FROM patients WHERE id = ?').get(patient.id) as any;
                patient.gender = stored?.gender ?? '';
            }
            if (!DatabaseService.PATIENT_GENDERS.includes(patient.gender)) {
                throw new Error('Gender must be Male, Female, Other, or Unknown.');
            }
            // MRN is immutable: assigned once at registration, never rewritten.
            delete (patient as any).mrn;
            return this.db.prepare(`
        UPDATE patients SET
            name = @name,
            mobile = @mobile,
            age = @age,
            gender = @gender,
            address = @address,
            dob = @dob, dob_estimated = @dob_estimated,
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
            if (!DatabaseService.PATIENT_GENDERS.includes(patient.gender)) {
                throw new Error('Gender must be Male, Female, Other, or Unknown.');
            }
            if (patient.mrn != null && String(patient.mrn).trim() !== '') {
                // Custom MRNs must look like MRNs (clinic prefix + digits);
                // anything else is a typo the uniqueness check would bless.
                if (!/^[A-Za-z0-9]+-\d{4,}$/.test(String(patient.mrn).trim())) {
                    throw new Error('MRN must look like ND-100001 (prefix, hyphen, digits).');
                }
                const taken = this.db.prepare('SELECT id FROM patients WHERE mrn = ?')
                    .get(String(patient.mrn).trim()) as any;
                if (taken) throw new Error('MRN is already registered.');
                patient.mrn = String(patient.mrn).trim();
            }
            // Insert and MRN assignment stay nesting-safe on purpose (no
            // transaction wrapper: savePatient also runs inside the
            // share-token check-in and demo-seed transactions, and
            // better-sqlite3 refuses nested transactions). A colliding
            // hand-picked MRN removes the just-inserted row, and the
            // launch-time repairMissingMrns covers the crash window — so a
            // failed assignment never leaves a chart without an MRN.
            const created = this.insertPatientRow(patient);
            if (!patient.mrn) {
                // Immutable clinic MRN from the rowid: collision-free by
                // construction, never rewritten afterwards. Width grows
                // past six digits instead of wrapping (no slice truncation).
                const prefix = String(this.getSettings()?.mrn_prefix || 'ND').trim() || 'ND';
                const mrn = `${prefix}-${String(100000 + Number(created.lastInsertRowid)).padStart(6, '0')}`;
                try {
                    this.db.prepare('UPDATE patients SET mrn = ? WHERE id = ?')
                        .run(mrn, created.lastInsertRowid);
                } catch (e: any) {
                    try {
                        this.db.prepare('DELETE FROM patients WHERE id = ?')
                            .run(created.lastInsertRowid);
                    } catch { /* best-effort cleanup */ }
                    if (/UNIQUE constraint failed: patients\.mrn/.test(String(e?.message || ''))) {
                        throw new Error('MRN is already registered.');
                    }
                    throw e;
                }
            }
            return created;
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

    // ------------------------------------------------------------------
    // Billing ledger: immutable invoices, append-only payments.
    // ------------------------------------------------------------------
    static readonly PAYMENT_METHODS = ['cash', 'upi', 'card'];
    static readonly INVOICE_STATUSES = ['unpaid', 'partial', 'paid', 'voided', 'refunded'];

    private invoiceNumber(rowId: number): string {
        return `INV-${String(100000 + Number(rowId)).padStart(6, '0')}`;
    }

    private receiptNumber(rowId: number): string {
        return `RCP-${String(100000 + Number(rowId)).padStart(6, '0')}`;
    }

    invoiceBalance(invoiceId: number): { total: number; paid: number; due: number } {
        const invoice = this.db.prepare('SELECT total FROM invoices WHERE id = ?').get(Number(invoiceId)) as any;
        if (!invoice) throw new Error(`Invoice #${invoiceId} not found.`);
        const paid = Number((this.db.prepare(`SELECT COALESCE(SUM(
            CASE WHEN kind = 'payment' THEN amount WHEN kind = 'reversal' THEN -amount ELSE 0 END), 0) as paid
            FROM payments WHERE invoice_id = ?`).get(Number(invoiceId)) as any)?.paid || 0);
        return {
            total: Number(invoice.total || 0),
            paid: Math.round(paid * 100) / 100,
            due: Math.round((Number(invoice.total || 0) - paid) * 100) / 100
        };
    }

    private invoiceStatusFor(balance: { total: number; paid: number; due: number }): string {
        if (balance.paid <= 0) return 'unpaid';
        if (balance.due <= 0) return 'paid';
        return 'partial';
    }

    getInvoice(invoiceId: number) {
        const invoice = this.db.prepare('SELECT * FROM invoices WHERE id = ?').get(Number(invoiceId)) as any;
        if (!invoice) throw new Error(`Invoice #${invoiceId} not found.`);
        const items = this.db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY id ASC')
            .all(Number(invoiceId));
        const payments = this.db.prepare('SELECT * FROM payments WHERE invoice_id = ? ORDER BY id ASC')
            .all(Number(invoiceId));
        return { ...invoice, items, payments, balance: this.invoiceBalance(Number(invoiceId)) };
    }

    getVisitInvoices(visitId: number) {
        const invoices = this.db.prepare('SELECT * FROM invoices WHERE visit_id = ? ORDER BY id ASC')
            .all(Number(visitId)) as any[];
        return invoices.map((invoice: any) => ({
            ...invoice,
            balance: this.invoiceBalance(Number(invoice.id))
        }));
    }

    /**
     * Creates an invoice for a visit: auto consultation-fee line (configurable
     * settings.consultation_fee, may be zero) plus caller-supplied lines.
     * Totals derive from lines; they are never accepted from the caller.
     */
    createInvoice(input: {
        visitId: number; items?: { description: string; quantity?: number; rate?: number }[];
        discount?: number; tax?: number;
    }, actingUserId?: number) {
        const visitId = Number(input?.visitId);
        if (!Number.isInteger(visitId) || visitId <= 0) throw new Error('visitId is required.');
        const visit = this.db.prepare('SELECT id, patient_id, status FROM visits WHERE id = ?')
            .get(visitId) as any;
        if (!visit) throw new Error(`Visit #${visitId} not found.`);
        if (visit.status === 'in-progress') throw new Error('Finish the encounter before billing it.');
        const lines = [...(input?.items || [])];
        const fee = Number((this.getSettings() as any)?.consultation_fee || 0);
        if (fee > 0) lines.unshift({ description: 'Consultation fee', quantity: 1, rate: fee });
        if (lines.length === 0) throw new Error('At least one charge line is required.');
        const normalized = lines.map((line, index) => {
            const description = String(line?.description || '').trim();
            if (!description) throw new Error(`Charge line ${index + 1} needs a description.`);
            const quantity = Number(line?.quantity ?? 1);
            const rate = Number(line?.rate ?? 0);
            if (!Number.isFinite(quantity) || quantity <= 0) throw new Error(`Charge line ${index + 1} needs a positive quantity.`);
            if (!Number.isFinite(rate) || rate < 0) throw new Error(`Charge line ${index + 1} needs a non-negative rate.`);
            return { description, quantity, rate, amount: Math.round(quantity * rate * 100) / 100 };
        });
        const discount = Math.max(0, Number(input?.discount || 0));
        const tax = Math.max(0, Number(input?.tax || 0));
        const subtotal = Math.round(normalized.reduce((sum, line) => sum + line.amount, 0) * 100) / 100;
        const total = Math.round((subtotal - discount + tax) * 100) / 100;
        if (total < 0) throw new Error('Invoice total cannot be negative.');
        const create = this.db.transaction(() => {
            const header = this.db.prepare(`INSERT INTO invoices
                (visit_id, patient_id, status, subtotal, discount, tax, total, created_by)
                VALUES (?, ?, 'unpaid', ?, ?, ?, ?, ?)`)
                .run(visitId, visit.patient_id, subtotal, discount, tax, total, actingUserId ?? null) as any;
            const invoiceId = Number(header.lastInsertRowid);
            const addItem = this.db.prepare(`INSERT INTO invoice_items
                (invoice_id, description, quantity, rate, amount) VALUES (?, ?, ?, ?, ?)`);
            for (const line of normalized) addItem.run(invoiceId, line.description, line.quantity, line.rate, line.amount);
            this.db.prepare('UPDATE invoices SET number = ? WHERE id = ?')
                .run(this.invoiceNumber(invoiceId), invoiceId);
            return invoiceId;
        });
        const invoiceId = create();
        this.logAudit('CREATE', 'invoices', invoiceId, actingUserId,
            `Created invoice ${this.invoiceNumber(invoiceId)} for visit #${visitId} (total ${total})`);
        return this.getInvoice(invoiceId);
    }

    /**
     * Records a payment as an append-only row; the duplicate-submit key
     * (client_key) makes renderer retries safe. Status recomputes from the
     * ledger, and overpayment is refused.
     */
    recordPayment(input: {
        invoiceId: number; amount: number; method?: string; reference?: string; clientKey?: string;
    }, actingUserId?: number) {
        const invoiceId = Number(input?.invoiceId);
        const invoice = this.db.prepare('SELECT id, status, number FROM invoices WHERE id = ?')
            .get(invoiceId) as any;
        if (!invoice) throw new Error(`Invoice #${invoiceId} not found.`);
        if (invoice.status === 'voided') throw new Error('Voided invoices cannot take payments.');
        const amount = Math.round(Number(input?.amount || 0) * 100) / 100;
        if (!Number.isFinite(amount) || amount <= 0) throw new Error('Payment amount must be positive.');
        const method = String(input?.method || 'cash').toLowerCase();
        if (!DatabaseService.PAYMENT_METHODS.includes(method)) {
            throw new Error(`Method must be one of: ${DatabaseService.PAYMENT_METHODS.join(', ')}.`);
        }
        const clientKey = input?.clientKey != null ? String(input.clientKey).trim() : '';
        const record = this.db.transaction(() => {
            if (clientKey) {
                const existing = this.db.prepare('SELECT id, invoice_id FROM payments WHERE client_key = ?')
                    .get(clientKey) as any;
                if (existing && Number(existing.invoice_id) === invoiceId) {
                    return { id: Number(existing.id), duplicate: true };
                }
                if (existing) {
                    throw new Error('Duplicate submit key was already used on another invoice.');
                }
            }
            const live = this.db.prepare('SELECT id, status FROM invoices WHERE id = ?')
                .get(invoiceId) as any;
            if (!live) throw new Error(`Invoice #${invoiceId} not found.`);
            if (live.status === 'voided') throw new Error('Voided invoices cannot take payments.');
            const balance = this.invoiceBalance(invoiceId);
            if (amount > balance.due + 0.009) {
                throw new Error(`Payment exceeds the amount due (${balance.due}).`);
            }
            const row = this.db.prepare(`INSERT INTO payments
                (invoice_id, kind, amount, method, reference, client_key, received_by)
                VALUES (?, 'payment', ?, ?, ?, ?, ?)`)
                .run(invoiceId, amount, method,
                    input?.reference != null ? String(input.reference).trim() || null : null,
                    clientKey || null, actingUserId ?? null) as any;
            const paymentId = Number(row.lastInsertRowid);
            this.db.prepare('UPDATE payments SET receipt_no = ? WHERE id = ?')
                .run(this.receiptNumber(paymentId), paymentId);
            const next = this.invoiceBalance(invoiceId);
            this.db.prepare('UPDATE invoices SET status = ? WHERE id = ?')
                .run(this.invoiceStatusFor(next), invoiceId);
            return { id: paymentId, duplicate: false };
        });
        const saved = record();
        const payment = this.db.prepare('SELECT * FROM payments WHERE id = ?').get(saved.id) as any;
        if (!saved.duplicate) {
            this.logAudit('PAY', 'payments', saved.id, actingUserId,
                `Received ${amount} (${method}) on ${invoice.number} as ${payment.receipt_no}`);
        }
        return { ...payment, duplicate: saved.duplicate };
    }

    /**
     * Refunds as a reversal row linked to the original payment: the original
     * is untouched, the ledger nets out, and status recomputes. Partial and
     * full refunds both supported; over-refund refused.
     */
    refundPayment(input: { paymentId: number; amount?: number; reason: string }, actingUserId?: number) {
        const paymentId = Number(input?.paymentId);
        const reason = String(input?.reason || '').trim();
        if (!reason) throw new Error('A reason is required for refunds.');
        // Read and write inside one transaction: the refundable check cannot
        // go stale between concurrent refunds.
        const record = this.db.transaction(() => {
            const original = this.db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId) as any;
            if (!original) throw new Error(`Payment #${paymentId} not found.`);
            if (original.kind !== 'payment') throw new Error('Only payments can be refunded, not reversals.');
            const invoice = this.db.prepare('SELECT id, status FROM invoices WHERE id = ?')
                .get(original.invoice_id) as any;
            if (!invoice) throw new Error(`Invoice #${original.invoice_id} not found.`);
            if (invoice.status === 'voided') throw new Error('Voided invoices cannot be refunded.');
            const already = Number((this.db.prepare(`SELECT COALESCE(SUM(amount), 0) as refunded
                FROM payments WHERE reversal_of = ?`).get(paymentId) as any)?.refunded || 0);
            const maxRefundable = Math.round((Number(original.amount) - already) * 100) / 100;
            const amount = input?.amount == null
                ? maxRefundable
                : Math.round(Number(input.amount) * 100) / 100;
            if (!Number.isFinite(amount) || amount <= 0) throw new Error('Refund amount must be positive.');
            if (amount > maxRefundable + 0.009) {
                throw new Error(`Refund exceeds the refundable amount (${maxRefundable}).`);
            }
            const row = this.db.prepare(`INSERT INTO payments
                (invoice_id, kind, amount, method, reference, reason, reversal_of, received_by)
                VALUES (?, 'reversal', ?, ?, ?, ?, ?, ?)`)
                .run(original.invoice_id, amount, original.method, original.reference,
                    reason, paymentId, actingUserId ?? null) as any;
            const reversalId = Number(row.lastInsertRowid);
            this.db.prepare('UPDATE payments SET receipt_no = ? WHERE id = ?')
                .run(this.receiptNumber(reversalId), reversalId);
            const next = this.invoiceBalance(original.invoice_id);
            const prior = this.db.prepare('SELECT status FROM invoices WHERE id = ?')
                .get(original.invoice_id) as any;
            const status = next.paid <= 0 && prior?.status !== 'voided' ? 'refunded' : this.invoiceStatusFor(next);
            this.db.prepare('UPDATE invoices SET status = ? WHERE id = ?')
                .run(status, original.invoice_id);
            return { reversalId, amount };
        });
        const { reversalId, amount: refunded } = record();
        this.logAudit('REFUND', 'payments', reversalId, actingUserId,
            `Refunded ${refunded} of payment #${paymentId}: ${reason}`);
        return this.db.prepare('SELECT * FROM payments WHERE id = ?').get(reversalId);
    }

    /**
     * Voids an invoice with a mandatory reason. Blocked while unreversed
     * payments exist — reverse or refund them first.
     */
    voidInvoice(invoiceId: number, reason: string, actingUserId?: number) {
        const id = Number(invoiceId);
        const clean = String(reason || '').trim();
        if (!clean) throw new Error('A reason is required for voiding.');
        // Check and state change atomically: a payment racing the void is
        // either inside (blocked) or outside (guarded by the ledger math).
        const apply = this.db.transaction(() => {
            const invoice = this.db.prepare('SELECT id, status, number FROM invoices WHERE id = ?')
                .get(id) as any;
            if (!invoice) throw new Error(`Invoice #${id} not found.`);
            if (invoice.status === 'voided') throw new Error('Invoice is already voided.');
            const outstanding = Number((this.db.prepare(`SELECT COALESCE(SUM(
                CASE WHEN kind = 'payment' THEN amount WHEN kind = 'reversal' THEN -amount ELSE 0 END), 0) as paid
                FROM payments WHERE invoice_id = ?`).get(id) as any)?.paid || 0);
            if (Math.abs(outstanding) > 0.009) {
                throw new Error('Reverse or refund all payments before voiding.');
            }
            this.db.prepare(`UPDATE invoices SET status = 'voided', void_reason = ? WHERE id = ?`)
                .run(clean, id);
            return invoice.number;
        });
        const number = apply();
        this.logAudit('VOID', 'invoices', id, actingUserId, `Voided ${number}: ${clean}`);
        return this.getInvoice(id);
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
                    start_operation, start_actor_id, care_context_ref
                ) VALUES (?, ?, ?, ?, '', '[]', 0, '', '', '', 'in-progress', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?, ?, 'begin', ?, ?)
            `).run(patientId, practitioner.id, actingUserId, licenseSnapshot, queue.id, startRequestId, actingUserId,
                this.nextCareContextRef());
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
                    start_operation, start_actor_id, care_context_ref
                ) VALUES (?, ?, ?, ?, '', '[]', 0, '', '', '', 'in-progress', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?, ?, 'next', ?, ?)
            `).run(queue.patient_id, practitioner.id, actingUserId, licenseSnapshot, queue.id, startRequestId, actingUserId,
                this.nextCareContextRef());
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

    /**
     * Imports one outside medication into the active list (M3). Runs the
     * same allergy-conflict gate as prescribing: a conflicting import needs
     * an explicit override reason, which is recorded in the audit trail.
     * Already-active duplicates are returned, never duplicated.
     */
    importExternalMedication(patientId: number, med: {
        medicine_name?: string; name?: string; dosage?: string; frequency?: string; source?: string | null;
    }, overrideReason?: string | null, actingUserId?: number) {
        const pId = Number(patientId);
        if (!Number.isInteger(pId) || pId <= 0) throw new Error('patient_id is required.');
        const medName = String(med?.medicine_name || med?.name || '').trim();
        if (!medName) throw new Error('medicine_name is required.');
        const activeAllergies = this.db.prepare(
            "SELECT id, substance, reaction, severity FROM patient_allergies WHERE patient_id = ? AND status = 'active'"
        ).all(pId) as any[];
        const conflict = this.isAllergyConflict(medName.toLowerCase(), activeAllergies || []);
        if (conflict && !String(overrideReason || '').trim()) {
            throw new Error(`Cannot import '${medName}': conflicting with active allergy ` +
                `'${conflict.substance}'${conflict.reaction ? ` (${conflict.reaction})` : ''}. ` +
                `An explicit override reason is required.`);
        }
        const existing = this.db.prepare(
            `SELECT *, medicine_name as medication_name FROM patient_medications
             WHERE patient_id = ? AND LOWER(medicine_name) = LOWER(?) AND status = 'active'`
        ).get(pId, medName) as any;
        if (existing) return existing;
        const notes = String(med?.source || 'Imported from outside record').slice(0, 500);
        const result = this.db.prepare(`
            INSERT INTO patient_medications (
                patient_id, medicine_name, dosage, frequency, status, start_date, recorder_id, recorded_at, notes
            ) VALUES (?, ?, ?, ?, 'active', CURRENT_DATE, ?, CURRENT_TIMESTAMP, ?)
        `).run(pId, medName, String(med?.dosage || ''), String(med?.frequency || ''),
            actingUserId ?? null, overrideReason?.trim() ? `${notes} [override: ${overrideReason.trim().slice(0, 200)}]` : notes);
        this.logAudit('INSERT', 'patient_medications', Number(result.lastInsertRowid), actingUserId,
            `Imported outside medication ${medName}`);
        return this.db.prepare('SELECT *, medicine_name as medication_name FROM patient_medications WHERE id = ?')
            .get(Number(result.lastInsertRowid));
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
