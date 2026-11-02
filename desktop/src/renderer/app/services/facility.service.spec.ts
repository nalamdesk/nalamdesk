/**
 * @vitest-environment jsdom
 */
import '@angular/compiler';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FacilityService, roleLabel } from './facility.service';

const FACILITIES = [
    { id: 1, code: 'MAIN', name: 'Main', kind: 'clinic', role: 'doctor' },
    { id: 2, code: 'ANN', name: 'Anna Nagar', kind: 'hospital', role: 'admin' }
];

describe('FacilityService', () => {
    let auth: any;

    beforeEach(() => {
        localStorage.clear();
        auth = { getUser: vi.fn(() => ({ username: 'asha' })), applyFacility: vi.fn() };
    });

    afterEach(() => {
        delete (window as any).electron;
    });

    it('loads from the desktop main process and shows the switcher only with several facilities', async () => {
        (window as any).electron = { getFacilities: vi.fn().mockResolvedValue({ facilityId: 2, facilities: FACILITIES }) };
        const service = new FacilityService(auth);
        expect(service.canSwitch()).toBe(false);
        await service.load();
        expect(service.current()?.code).toBe('ANN');
        expect(service.canSwitch()).toBe(true);
    });

    it('loads from the server for server clients and survives an older server', async () => {
        const server: any = { call: vi.fn().mockResolvedValue({ facilityId: 1, facilities: [FACILITIES[0]] }) };
        const service = new FacilityService(auth, server);
        await service.load();
        expect(server.call).toHaveBeenCalledWith('GET', '/api/auth/facilities');
        expect(service.canSwitch()).toBe(false);
        server.call.mockRejectedValue(new Error('Method not implemented'));
        await expect(service.load()).resolves.toBeUndefined();
    });

    it('switches on the server, applies the new role and remembers the choice', async () => {
        const server: any = { switchFacility: vi.fn().mockResolvedValue({ facilityId: 2, role: 'admin' }) };
        const service = new FacilityService(auth, server);
        service.seed(1, FACILITIES);
        expect(await service.switchTo(2)).toEqual({ ok: true });
        expect(auth.applyFacility).toHaveBeenCalledWith(2, 'admin');
        expect(service.currentId()).toBe(2);
        expect(service.lastUsed()).toBe(2);
    });

    it('reports a refused switch and keeps the current facility', async () => {
        (window as any).electron = { switchFacility: vi.fn().mockResolvedValue({ success: false, error: 'NO_FACILITY_ACCESS' }) };
        const service = new FacilityService(auth);
        service.seed(1, FACILITIES);
        expect(await service.switchTo(2)).toEqual({ ok: false, error: 'NO_FACILITY_ACCESS' });
        expect(service.currentId()).toBe(1);
        expect(auth.applyFacility).not.toHaveBeenCalled();

        const server: any = { switchFacility: vi.fn().mockRejectedValue(new Error('NO_FACILITY_ACCESS')) };
        delete (window as any).electron;
        const remote = new FacilityService(auth, server);
        expect(await remote.switchTo(2)).toEqual({ ok: false, error: 'NO_FACILITY_ACCESS' });
    });

    it('ignores a remembered facility the user no longer has', () => {
        localStorage.setItem('nalamdesk_last_facility:asha', '9');
        const service = new FacilityService(auth);
        service.seed(1, FACILITIES);
        expect(service.lastUsed()).toBeNull();
        auth.getUser.mockReturnValue(null);
        expect(service.lastUsed()).toBeNull();
    });

    it('labels roles', () => {
        expect(roleLabel('receptionist')).toBe('Receptionist');
        expect(roleLabel(undefined)).toBe('');
    });
});
