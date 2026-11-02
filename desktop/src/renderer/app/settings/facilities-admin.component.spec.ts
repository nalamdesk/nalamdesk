/**
 * @vitest-environment jsdom
 */
import '@angular/compiler';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FacilitiesAdminComponent, adminErrorMessage, type FacilityAdminData } from './facilities-admin.component';

function adminData(): FacilityAdminData {
    return {
        facilities: [
            { id: 1, code: 'MAIN', name: 'Main', kind: 'clinic', active: 1, doctor_name: null, address: null, phone: null, abdm_hfr_id: null, abdm_hip_id: null },
            { id: 2, code: 'ANN', name: 'Anna Nagar', kind: 'hospital', active: 0, doctor_name: null, address: null, phone: null, abdm_hfr_id: null, abdm_hip_id: null }
        ],
        departments: [
            { id: 1, facility_id: 1, code: 'OPD', name: 'General OPD', kind: 'opd', active: 1 },
            { id: 2, facility_id: 2, code: 'OPD', name: 'General OPD', kind: 'opd', active: 1 }
        ],
        users: [
            { id: 10, username: 'asha', name: 'Dr. Asha', role: 'doctor', active: 1, org_admin: 0 },
            { id: 20, username: 'old', name: 'Old', role: 'nurse', active: 0, org_admin: 0 }
        ],
        grants: [{ user_id: 10, facility_id: 1, role: 'doctor' }],
        roles: ['admin', 'doctor', 'nurse']
    };
}

describe('FacilitiesAdminComponent', () => {
    let component: FacilitiesAdminComponent;
    let data: any;
    let dialog: any;
    const zone: any = { run: (fn: () => unknown) => fn() };

    beforeEach(async () => {
        data = { invoke: vi.fn(async (method: string) => method === 'getFacilityAdmin' ? adminData() : { id: 3 }) };
        dialog = { open: vi.fn().mockResolvedValue(true) };
        component = new FacilitiesAdminComponent(data, dialog, zone);
        await component.load();
    });

    it('loads facilities, selects the first, and lists open facilities and active staff', () => {
        expect(component.selectedFacility?.code).toBe('MAIN');
        expect(component.openFacilities.map(f => f.code)).toEqual(['MAIN']);
        expect(component.activeUsers.map(u => u.username)).toEqual(['asha']);
        expect(component.roleAt(10, 1)).toBe('doctor');
        expect(component.roleAt(10, 2)).toBe('');
        expect(component.departmentsOf(2).map(d => d.code)).toEqual(['OPD']);
        expect(component.departmentKind('ipd')).toBe('Inpatient');
    });

    it('creates and edits facilities, then reloads', async () => {
        component.newFacility();
        component.facilityForm = { ...component.facilityForm, code: 'VEL', name: 'Velachery' };
        await component.saveFacility();
        expect(data.invoke).toHaveBeenCalledWith('saveFacility', { kind: 'clinic', code: 'VEL', name: 'Velachery' });
        expect(component.facilityForm).toBeNull();

        component.editFacility(adminData().facilities[1]);
        expect(component.selectedFacilityId).toBe(2);
        expect(component.facilityForm?.code).toBe('ANN');
    });

    it('asks before closing a facility, and reopens without asking', async () => {
        dialog.open.mockResolvedValueOnce(false);
        await component.toggleFacility(adminData().facilities[0]);
        expect(data.invoke).not.toHaveBeenCalledWith('setFacilityActive', expect.anything());
        await component.toggleFacility(adminData().facilities[0]);
        expect(data.invoke).toHaveBeenCalledWith('setFacilityActive', { id: 1, active: false });
        dialog.open.mockClear();
        await component.toggleFacility(adminData().facilities[1]);
        expect(dialog.open).not.toHaveBeenCalled();
        expect(data.invoke).toHaveBeenCalledWith('setFacilityActive', { id: 2, active: true });
    });

    it('saves departments and toggles them', async () => {
        component.newDepartment(2);
        component.departmentForm = { ...component.departmentForm, code: 'ORTHO', name: 'Orthopaedics' };
        await component.saveDepartment();
        expect(data.invoke).toHaveBeenCalledWith('saveDepartment', { id: undefined, facilityId: 2, code: 'ORTHO', name: 'Orthopaedics', kind: 'opd' });
        component.editDepartment(adminData().departments[1]);
        expect(component.departmentForm?.id).toBe(2);
        await component.toggleDepartment(adminData().departments[1]);
        expect(data.invoke).toHaveBeenCalledWith('setDepartmentActive', { id: 2, active: false });
    });

    it('grants, revokes and toggles organisation admin from the staff table', async () => {
        const user = adminData().users[0];
        const facility = adminData().facilities[0];
        await component.setRole(user, facility, { target: { value: 'nurse' } } as any);
        expect(data.invoke).toHaveBeenCalledWith('grantFacilityRole', { userId: 10, facilityId: 1, role: 'nurse' });
        await component.setRole(user, facility, { target: { value: '' } } as any);
        expect(data.invoke).toHaveBeenCalledWith('revokeFacilityRole', { userId: 10, facilityId: 1 });
        await component.setOrgAdmin(user, { target: { checked: true } } as any);
        expect(data.invoke).toHaveBeenCalledWith('setOrgAdmin', { userId: 10, orgAdmin: true });
    });

    it('shows why a change was refused and keeps the form open', async () => {
        data.invoke.mockImplementation(async (method: string) => {
            if (method === 'getFacilityAdmin') return adminData();
            throw new Error("Error invoking remote method 'db:saveFacility': FacilityAdminError: That code is already in use.");
        });
        component.newFacility();
        await component.saveFacility();
        expect(component.error).toBe('That code is already in use.');
        expect(component.facilityForm).not.toBeNull();
        expect(component.busy).toBe(false);
    });

    it('tells non organisation admins the screen is not for them', async () => {
        data.invoke.mockRejectedValue(new Error('Forbidden'));
        const fresh = new FacilitiesAdminComponent(data, dialog, zone);
        await fresh.load();
        expect(fresh.forbidden).toBe(true);
        expect(fresh.error).toBe('');
    });

    it('turns transport errors into plain messages', () => {
        expect(adminErrorMessage(new Error('Internal server error'))).toBe('Could not save. Try again.');
        expect(adminErrorMessage(new Error("Error invoking remote method 'db:x': Error: Forbidden"))).toContain('Only organisation admins');
        expect(adminErrorMessage(new Error('At least one facility must stay open.'))).toBe('At least one facility must stay open.');
    });
});
