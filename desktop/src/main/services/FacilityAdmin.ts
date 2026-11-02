import { DEFAULT_FACILITY_ID } from '../../shared/request-context';

/**
 * Organisation administration (#214): facilities, their departments, and
 * who holds which role at each facility. Every call is for organisation
 * admins only, checked here so the desktop and server paths agree.
 */

export const FACILITY_KINDS = ['clinic', 'hospital'] as const;
export const DEPARTMENT_KINDS = ['opd', 'ipd', 'emergency', 'diagnostics', 'pharmacy', 'other'] as const;

const CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{0,15}$/;
const MAX_TEXT = 200;

/** Facility fields an admin edits: identity, letterhead, ABDM registry IDs. */
const FACILITY_TEXT_FIELDS = ['name', 'doctor_name', 'address', 'phone', 'abdm_hfr_id', 'abdm_hip_id'] as const;

export interface FacilityRow {
    id: number;
    code: string;
    name: string;
    kind: string;
    active: number;
    doctor_name: string | null;
    address: string | null;
    phone: string | null;
    abdm_hfr_id: string | null;
    abdm_hip_id: string | null;
}

export interface DepartmentRow {
    id: number;
    facility_id: number;
    code: string;
    name: string;
    kind: string;
    active: number;
}

export interface FacilityAdminView {
    facilities: FacilityRow[];
    departments: DepartmentRow[];
    users: Array<{ id: number; username: string; name: string; role: string; active: number; org_admin: number }>;
    grants: Array<{ user_id: number; facility_id: number; role: string }>;
    roles: string[];
}

type Audit = (action: string, table: string, recordId: number | bigint | null, userId: number, details: string) => void;

export class FacilityAdminError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'FacilityAdminError';
    }
}

function fail(message: string): never {
    throw new FacilityAdminError(message);
}

function payload(input: unknown): Record<string, unknown> {
    return input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
}

function positiveId(value: unknown, what: string): number {
    const id = Number(value);
    if (!Number.isInteger(id) || id < 1) fail(`${what} is required.`);
    return id;
}

function cleanText(value: unknown): string | null {
    if (value === undefined || value === null) return null;
    const text = String(value).trim();
    if (text.length > MAX_TEXT) fail('A value is too long.');
    return text === '' ? null : text;
}

function cleanCode(value: unknown): string {
    const code = String(value ?? '').trim().toUpperCase();
    if (!CODE_PATTERN.test(code)) fail('Code must be 1 to 16 letters, digits, - or _.');
    return code;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T, what: string): T {
    if (value === undefined || value === null || value === '') return fallback;
    const text = String(value).toLowerCase() as T;
    if (!allowed.includes(text)) fail(`Unknown ${what}.`);
    return text;
}

function flag(value: unknown): 0 | 1 {
    return value === true || value === 1 || value === '1' ? 1 : 0;
}

/** Turns a unique-index clash into a message an admin can act on. */
function uniqueClash(error: unknown): never {
    const message = String((error as Error)?.message ?? '');
    if (message.includes('UNIQUE')) {
        if (message.includes('abdm_hfr_id')) fail('Another facility already uses that HFR ID.');
        if (message.includes('abdm_hip_id')) fail('Another facility already uses that HIP ID.');
        fail('That code is already in use.');
    }
    throw error;
}

export class FacilityAdmin {
    constructor(private readonly db: () => any, private readonly audit: Audit) { }

    /** Throws unless the acting user is an active organisation admin. */
    private requireOrgAdmin(actingUserId: unknown): number {
        const id = Number(actingUserId);
        const row = Number.isInteger(id) && id > 0
            ? this.db().prepare('SELECT org_admin, active FROM users WHERE id = ?').get(id) as any
            : null;
        if (!row || Number(row.active) !== 1 || Number(row.org_admin) !== 1) throw new Error('Forbidden');
        return id;
    }

    /** Roles a facility grant can hold: admin (built in) and every role in the roles table. */
    private roleNames(): string[] {
        const stored = (this.db().prepare('SELECT name FROM roles ORDER BY name').all() as Array<{ name: string }>).map(r => r.name);
        return ['admin', ...stored.filter(name => name !== 'admin')];
    }

    /** Everything the admin screens show, in one read. */
    getFacilityAdmin(actingUserId: unknown): FacilityAdminView {
        this.requireOrgAdmin(actingUserId);
        const db = this.db();
        const roles = this.roleNames();
        return {
            facilities: db.prepare(`SELECT id, code, name, kind, active, doctor_name, address, phone, abdm_hfr_id, abdm_hip_id
                FROM facilities ORDER BY id`).all(),
            departments: db.prepare(`SELECT id, facility_id, code, name, kind, active FROM departments
                ORDER BY facility_id, id`).all(),
            users: db.prepare(`SELECT id, username, name, role, active, org_admin FROM users
                ORDER BY active DESC, name COLLATE NOCASE`).all(),
            grants: db.prepare('SELECT user_id, facility_id, role FROM user_facility_roles ORDER BY user_id, facility_id').all(),
            roles
        };
    }

    /** Creates a facility (with a General OPD department) or edits one. */
    saveFacility(input: unknown, actingUserId: unknown): { id: number } {
        const actor = this.requireOrgAdmin(actingUserId);
        const data = payload(input);
        const fields: Record<string, string | null> = {};
        for (const key of FACILITY_TEXT_FIELDS) fields[key] = cleanText(data[key]);
        if (!fields['name']) fail('Facility name is required.');
        const kind = oneOf(data['kind'], FACILITY_KINDS, 'clinic', 'facility kind');
        const code = cleanCode(data['code']);
        const db = this.db();
        try {
            if (data['id'] !== undefined && data['id'] !== null && data['id'] !== '') {
                const id = positiveId(data['id'], 'Facility');
                const result = db.prepare(`UPDATE facilities SET code = @code, kind = @kind,
                    ${FACILITY_TEXT_FIELDS.map(k => `${k} = @${k}`).join(', ')} WHERE id = @id`)
                    .run({ ...fields, code, kind, id });
                if (Number(result.changes) === 0) fail('Unknown facility.');
                this.audit('FACILITY_UPDATE', 'facilities', id, actor, `Updated facility ${code}`);
                return { id };
            }
            const id = db.transaction(() => {
                const created = Number(db.prepare(`INSERT INTO facilities (code, kind, ${FACILITY_TEXT_FIELDS.join(', ')})
                    VALUES (@code, @kind, ${FACILITY_TEXT_FIELDS.map(k => `@${k}`).join(', ')})`)
                    .run({ ...fields, code, kind }).lastInsertRowid);
                db.prepare(`INSERT INTO departments (facility_id, code, name, kind) VALUES (?, 'OPD', 'General OPD', 'opd')`)
                    .run(created);
                return created;
            })();
            this.audit('FACILITY_CREATE', 'facilities', id, actor, `Created facility ${code} (${kind})`);
            return { id };
        } catch (error) {
            return uniqueClash(error);
        }
    }

    /**
     * Opens or closes a facility. Closing ends access there at the next token
     * refresh. The last open facility cannot be closed.
     */
    setFacilityActive(input: unknown, actingUserId: unknown): { id: number; active: number } {
        const actor = this.requireOrgAdmin(actingUserId);
        const data = payload(input);
        const id = positiveId(data['id'], 'Facility');
        const active = flag(data['active']);
        const db = this.db();
        const facility = db.prepare('SELECT code, active FROM facilities WHERE id = ?').get(id) as any;
        if (!facility) fail('Unknown facility.');
        if (!active && Number(facility.active) === 1) {
            const open = Number((db.prepare('SELECT COUNT(*) AS n FROM facilities WHERE active = 1').get() as any).n);
            if (open <= 1) fail('At least one facility must stay open.');
        }
        db.prepare('UPDATE facilities SET active = ? WHERE id = ?').run(active, id);
        this.audit(active ? 'FACILITY_REACTIVATE' : 'FACILITY_DEACTIVATE', 'facilities', id, actor,
            `${active ? 'Reopened' : 'Closed'} facility ${facility.code}`);
        return { id, active };
    }

    /** Creates a department at a facility, or edits one. */
    saveDepartment(input: unknown, actingUserId: unknown): { id: number } {
        const actor = this.requireOrgAdmin(actingUserId);
        const data = payload(input);
        const name = cleanText(data['name']);
        if (!name) fail('Department name is required.');
        const code = cleanCode(data['code']);
        const kind = oneOf(data['kind'], DEPARTMENT_KINDS, 'opd', 'department kind');
        const db = this.db();
        try {
            if (data['id'] !== undefined && data['id'] !== null && data['id'] !== '') {
                const id = positiveId(data['id'], 'Department');
                const result = db.prepare('UPDATE departments SET code = ?, name = ?, kind = ? WHERE id = ?').run(code, name, kind, id);
                if (Number(result.changes) === 0) fail('Unknown department.');
                this.audit('DEPARTMENT_UPDATE', 'departments', id, actor, `Updated department ${code}`);
                return { id };
            }
            const facilityId = positiveId(data['facilityId'], 'Facility');
            if (!db.prepare('SELECT 1 AS ok FROM facilities WHERE id = ?').get(facilityId)) fail('Unknown facility.');
            const id = Number(db.prepare('INSERT INTO departments (facility_id, code, name, kind) VALUES (?, ?, ?, ?)')
                .run(facilityId, code, name, kind).lastInsertRowid);
            this.audit('DEPARTMENT_CREATE', 'departments', id, actor, `Created department ${code} at facility ${facilityId}`);
            return { id };
        } catch (error) {
            return uniqueClash(error);
        }
    }

    /** Opens or closes a department. A facility keeps at least one open department. */
    setDepartmentActive(input: unknown, actingUserId: unknown): { id: number; active: number } {
        const actor = this.requireOrgAdmin(actingUserId);
        const data = payload(input);
        const id = positiveId(data['id'], 'Department');
        const active = flag(data['active']);
        const db = this.db();
        const department = db.prepare('SELECT facility_id, code, active FROM departments WHERE id = ?').get(id) as any;
        if (!department) fail('Unknown department.');
        if (!active && Number(department.active) === 1) {
            const open = Number((db.prepare('SELECT COUNT(*) AS n FROM departments WHERE facility_id = ? AND active = 1')
                .get(department.facility_id) as any).n);
            if (open <= 1) fail('A facility needs at least one open department.');
        }
        db.prepare('UPDATE departments SET active = ? WHERE id = ?').run(active, id);
        this.audit(active ? 'DEPARTMENT_REACTIVATE' : 'DEPARTMENT_DEACTIVATE', 'departments', id, actor,
            `${active ? 'Reopened' : 'Closed'} department ${department.code}`);
        return { id, active };
    }

    /** Gives a staff member a role at a facility, replacing any role they held there. */
    grantFacilityRole(input: unknown, actingUserId: unknown): { userId: number; facilityId: number; role: string } {
        const actor = this.requireOrgAdmin(actingUserId);
        const data = payload(input);
        const userId = positiveId(data['userId'], 'Staff member');
        const facilityId = positiveId(data['facilityId'], 'Facility');
        const role = String(data['role'] ?? '').trim().toLowerCase();
        const db = this.db();
        if (!this.roleNames().includes(role)) fail('Unknown role.');
        const user = db.prepare('SELECT username FROM users WHERE id = ?').get(userId) as any;
        if (!user) fail('Unknown staff member.');
        const facility = db.prepare('SELECT code FROM facilities WHERE id = ?').get(facilityId) as any;
        if (!facility) fail('Unknown facility.');
        db.prepare(`INSERT INTO user_facility_roles (user_id, facility_id, role, granted_by) VALUES (?, ?, ?, ?)
            ON CONFLICT(user_id, facility_id) DO UPDATE SET role = excluded.role, granted_by = excluded.granted_by`)
            .run(userId, facilityId, role, actor);
        this.audit('FACILITY_ROLE_GRANT', 'user_facility_roles', userId, actor,
            `Granted ${user.username} the ${role} role at ${facility.code}`);
        return { userId, facilityId, role };
    }

    /** Takes a staff member's role at a facility away. Their sessions there end at the next refresh. */
    revokeFacilityRole(input: unknown, actingUserId: unknown): { userId: number; facilityId: number } {
        const actor = this.requireOrgAdmin(actingUserId);
        const data = payload(input);
        const userId = positiveId(data['userId'], 'Staff member');
        const facilityId = positiveId(data['facilityId'], 'Facility');
        const db = this.db();
        const result = db.prepare('DELETE FROM user_facility_roles WHERE user_id = ? AND facility_id = ?').run(userId, facilityId);
        if (Number(result.changes) > 0) {
            this.audit('FACILITY_ROLE_REVOKE', 'user_facility_roles', userId, actor,
                `Revoked user ${userId}'s role at facility ${facilityId}`);
        }
        return { userId, facilityId };
    }

    /**
     * Makes a staff member an organisation admin (admin at every facility)
     * or not. Admins cannot demote themselves, and one admin always remains.
     */
    setOrgAdmin(input: unknown, actingUserId: unknown): { userId: number; orgAdmin: number } {
        const actor = this.requireOrgAdmin(actingUserId);
        const data = payload(input);
        const userId = positiveId(data['userId'], 'Staff member');
        const orgAdmin = flag(data['orgAdmin']);
        const db = this.db();
        const user = db.prepare('SELECT username, active, org_admin FROM users WHERE id = ?').get(userId) as any;
        if (!user) fail('Unknown staff member.');
        if (orgAdmin && Number(user.active) !== 1) fail('Reactivate the staff member first.');
        if (!orgAdmin && Number(user.org_admin) === 1) {
            if (userId === actor) fail('You cannot remove your own organisation admin access.');
            const admins = Number((db.prepare('SELECT COUNT(*) AS n FROM users WHERE org_admin = 1 AND active = 1').get() as any).n);
            if (admins <= 1) fail('At least one organisation admin must remain.');
        }
        db.prepare('UPDATE users SET org_admin = ? WHERE id = ?').run(orgAdmin, userId);
        this.audit(orgAdmin ? 'ORG_ADMIN_GRANT' : 'ORG_ADMIN_REVOKE', 'users', userId, actor,
            `${orgAdmin ? 'Made' : 'Removed'} ${user.username} ${orgAdmin ? 'an' : 'as'} organisation admin`);
        return { userId, orgAdmin };
    }
}

/**
 * When a vault has more than one facility, a new staff member starts with
 * their role at the facility they were created in. (With one facility, the
 * users.role mirror trigger already does this.)
 */
export function grantNewUserRole(db: any, userId: number, role: unknown, facilityId: number, actingUserId?: number): void {
    const name = String(role ?? '').trim().toLowerCase();
    if (!name) return;
    db.prepare(`INSERT OR IGNORE INTO user_facility_roles (user_id, facility_id, role, granted_by)
        SELECT ?, f.id, ?, ? FROM facilities f WHERE f.id = ?`)
        .run(Number(userId), name, actingUserId ?? null, Number(facilityId) || DEFAULT_FACILITY_ID);
}
