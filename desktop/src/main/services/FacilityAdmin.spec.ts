import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseService } from './DatabaseService';
import { TestDatabase } from '../testing/TestDatabase';
import { invokeDbMethod } from '../../shared/ipc-db-args';
import { runWithContext } from '../../shared/request-context';

const BOSS = 30;
const ASHA = 10;
const RAVI = 20;

describe('organisation admin (#214)', () => {
    let db: TestDatabase;
    let service: DatabaseService;

    beforeEach(async () => {
        db = new TestDatabase();
        db.exec('PRAGMA foreign_keys = ON');
        service = new DatabaseService();
        service.setDb(db);
        await service.migrate({ skipBackup: true });
        db.prepare("INSERT INTO users (id, username, role, name, license_number, active) VALUES (10, 'asha', 'doctor', 'Dr. Asha', 'TN-1', 1)").run();
        db.prepare("INSERT INTO users (id, username, role, name, active) VALUES (20, 'ravi', 'receptionist', 'Ravi', 1)").run();
        db.prepare("INSERT INTO users (id, username, role, name, active) VALUES (30, 'boss', 'admin', 'Boss', 1)").run();
    });

    afterEach(() => db.close());

    const call = (method: string, input: unknown, actor = BOSS, facilityId = 1) =>
        invokeDbMethod(service, method, method === 'getFacilityAdmin' ? [] : [input], { userId: actor, facilityId }) as any;

    it('refuses everyone but active organisation admins', () => {
        expect(() => call('getFacilityAdmin', null, ASHA)).toThrow('Forbidden');
        expect(() => call('saveFacility', { code: 'X', name: 'X' }, RAVI)).toThrow('Forbidden');
        db.prepare('UPDATE users SET active = 0 WHERE id = 30').run();
        expect(() => call('getFacilityAdmin', null)).toThrow('Forbidden');
    });

    it('creates a facility with a General OPD, edits it, and lists it', () => {
        const { id } = call('saveFacility', { code: 'ann', name: ' Anna Nagar ', kind: 'hospital', abdm_hfr_id: 'IN33' });
        const view = call('getFacilityAdmin', null);
        expect(view.facilities.find((f: any) => f.id === id)).toMatchObject({ code: 'ANN', name: 'Anna Nagar', kind: 'hospital', active: 1, abdm_hfr_id: 'IN33' });
        expect(view.departments.filter((d: any) => d.facility_id === id)).toMatchObject([{ code: 'OPD', name: 'General OPD', kind: 'opd' }]);
        expect(view.roles).toEqual(expect.arrayContaining(['admin', 'doctor']));

        call('saveFacility', { id, code: 'ANN', name: 'Anna Nagar Hospital', kind: 'hospital', address: '2nd Ave' });
        expect(db.prepare('SELECT name, address, abdm_hfr_id FROM facilities WHERE id = ?').get(id))
            .toEqual({ name: 'Anna Nagar Hospital', address: '2nd Ave', abdm_hfr_id: null });
        expect((db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action LIKE 'FACILITY_%'").get() as any).n).toBe(2);
    });

    it('explains invalid and clashing facility input', () => {
        expect(() => call('saveFacility', { code: 'A B', name: 'X' })).toThrow('Code must be');
        expect(() => call('saveFacility', { code: 'AB', name: '' })).toThrow('name is required');
        expect(() => call('saveFacility', { code: 'AB', name: 'X', kind: 'ward' })).toThrow('Unknown facility kind');
        expect(() => call('saveFacility', { code: 'main', name: 'Copy' })).toThrow('already in use');
        call('saveFacility', { code: 'B1', name: 'One', abdm_hfr_id: 'HFR-1' });
        expect(() => call('saveFacility', { code: 'B2', name: 'Two', abdm_hfr_id: 'HFR-1' })).toThrow('HFR ID');
        expect(() => call('saveFacility', { id: 99, code: 'B3', name: 'Ghost' })).toThrow('Unknown facility');
    });

    it('closes and reopens facilities, keeping one open', () => {
        expect(() => call('setFacilityActive', { id: 1, active: false })).toThrow('At least one facility');
        const { id } = call('saveFacility', { code: 'ANN', name: 'Anna Nagar' });
        call('setFacilityActive', { id, active: false });
        expect(service.getUserFacilities(BOSS).map(f => f.id)).toEqual([1]);
        call('setFacilityActive', { id, active: true });
        expect(service.getUserFacilities(BOSS).map(f => f.id)).toEqual([1, id]);
    });

    it('manages departments and keeps one open per facility', () => {
        const { id } = call('saveDepartment', { facilityId: 1, code: 'ortho', name: 'Orthopaedics', kind: 'ipd' });
        expect(db.prepare('SELECT facility_id, code, kind FROM departments WHERE id = ?').get(id)).toEqual({ facility_id: 1, code: 'ORTHO', kind: 'ipd' });
        expect(() => call('saveDepartment', { facilityId: 1, code: 'ORTHO', name: 'Again' })).toThrow('already in use');
        expect(() => call('saveDepartment', { facilityId: 9, code: 'X', name: 'X' })).toThrow('Unknown facility');
        call('saveDepartment', { id, code: 'ORTHO', name: 'Bones', kind: 'opd' });
        call('setDepartmentActive', { id: 1, active: false });
        expect(() => call('setDepartmentActive', { id, active: false })).toThrow('at least one open department');
    });

    it('grants, changes and revokes roles per facility', () => {
        const { id } = call('saveFacility', { code: 'ANN', name: 'Anna Nagar' });
        call('grantFacilityRole', { userId: RAVI, facilityId: id, role: 'Receptionist' });
        expect(service.getFacilityRole(RAVI, id)).toBe('receptionist');
        call('grantFacilityRole', { userId: RAVI, facilityId: id, role: 'nurse' });
        expect(service.getFacilityRole(RAVI, id)).toBe('nurse');
        expect(db.prepare('SELECT granted_by FROM user_facility_roles WHERE user_id = ? AND facility_id = ?').get(RAVI, id))
            .toEqual({ granted_by: BOSS });
        expect(() => call('grantFacilityRole', { userId: RAVI, facilityId: id, role: 'janitor' })).toThrow('Unknown role');
        expect(() => call('grantFacilityRole', { userId: 99, facilityId: id, role: 'nurse' })).toThrow('Unknown staff member');
        call('revokeFacilityRole', { userId: RAVI, facilityId: id });
        expect(service.getFacilityRole(RAVI, id)).toBeNull();
    });

    it('toggles organisation admin, never removing the last one or yourself', () => {
        expect(() => call('setOrgAdmin', { userId: BOSS, orgAdmin: false })).toThrow('your own');
        call('setOrgAdmin', { userId: ASHA, orgAdmin: true });
        expect(service.getUserFacilities(ASHA).every(f => f.role === 'admin')).toBe(true);
        call('setOrgAdmin', { userId: BOSS, orgAdmin: false }, ASHA);
        expect(() => call('setOrgAdmin', { userId: ASHA, orgAdmin: false }, ASHA)).toThrow('your own');
        db.prepare('UPDATE users SET active = 0 WHERE id = 20').run();
        expect(() => call('setOrgAdmin', { userId: RAVI, orgAdmin: true }, ASHA)).toThrow('Reactivate');
    });

    it('keeps organisation admin through unrelated edits, and demotes with the role (#214)', async () => {
        // A doctor made organisation admin stays one when their profile is edited.
        call('setOrgAdmin', { userId: ASHA, orgAdmin: true });
        await service.saveUser({ id: ASHA, username: 'asha', role: 'doctor', name: 'Dr. Asha', license_number: 'TN-1', mobile: '9', active: 1 }, BOSS);
        expect((db.prepare('SELECT org_admin FROM users WHERE id = ?').get(ASHA) as any).org_admin).toBe(1);
        call('setOrgAdmin', { userId: ASHA, orgAdmin: false });

        // The last organisation admin cannot be demoted by a role edit, nor can you demote yourself.
        await expect(service.saveUser({ id: BOSS, username: 'boss', role: 'doctor', name: 'Boss', active: 1 }, BOSS))
            .rejects.toThrow('your own admin access');
        await expect(service.saveUser({ id: BOSS, username: 'boss', role: 'doctor', name: 'Boss', active: 1 }, ASHA))
            .rejects.toThrow('At least one organisation admin');
        expect(service.getFacilityRole(BOSS, 1)).toBe('admin');

        // Promoting someone to admin in Users makes them an organisation admin;
        // changing their role back ends it, so Users shows what they can do.
        await service.saveUser({ id: RAVI, username: 'ravi', role: 'admin', name: 'Ravi', active: 1 }, BOSS);
        expect((db.prepare('SELECT org_admin FROM users WHERE id = ?').get(RAVI) as any).org_admin).toBe(1);
        await service.saveUser({ id: RAVI, username: 'ravi', role: 'receptionist', name: 'Ravi', active: 1 }, BOSS);
        expect((db.prepare('SELECT org_admin FROM users WHERE id = ?').get(RAVI) as any).org_admin).toBe(0);
        expect(service.getFacilityRole(RAVI, 1)).toBe('receptionist');
    });

    it('gives a new staff member their role at the facility they were created in', async () => {
        const { id } = call('saveFacility', { code: 'ANN', name: 'Anna Nagar' });
        const created = await runWithContext({ userId: BOSS, facilityId: id }, () =>
            service.saveUser({ username: 'meena', password: 'Temp-pass-123', role: 'Nurse', name: 'Meena' }, BOSS));
        const userId = Number(created.lastInsertRowid);
        expect(service.getUserFacilities(userId).map(f => [f.id, f.role])).toEqual([[id, 'nurse']]);

        await runWithContext({ userId: BOSS, facilityId: id }, () =>
            service.saveUser({ id: userId, username: 'meena', role: 'receptionist', name: 'Meena', active: 1 }, BOSS));
        expect(service.getFacilityRole(userId, id)).toBe('receptionist');
        expect(service.getFacilityRole(userId, 1)).toBeNull();
    });
});
