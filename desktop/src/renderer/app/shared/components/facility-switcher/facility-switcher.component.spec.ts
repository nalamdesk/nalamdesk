/**
 * @vitest-environment jsdom
 */
import '@angular/compiler';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { FacilitySwitcherComponent } from './facility-switcher.component';
import { FacilityService } from '../../../services/facility.service';
import { AuthService } from '../../../services/auth.service';
import { DialogService } from '../../services/dialog.service';

const FACILITIES = [
    { id: 1, code: 'MAIN', name: 'Main', kind: 'clinic', role: 'doctor' },
    { id: 2, code: 'ANN', name: 'Anna Nagar', kind: 'hospital', role: 'admin' }
];

describe('FacilitySwitcherComponent', () => {
    let facilities: FacilityService;
    let dialog: { open: ReturnType<typeof vi.fn> };

    beforeEach(() => {
        dialog = { open: vi.fn().mockResolvedValue(true) };
        (window as any).electron = {
            getFacilities: vi.fn().mockResolvedValue({ facilityId: 1, facilities: FACILITIES }),
            switchFacility: vi.fn().mockResolvedValue({ success: true, facilityId: 2, user: { role: 'admin' } })
        };
        TestBed.configureTestingModule({
            imports: [FacilitySwitcherComponent],
            providers: [
                { provide: AuthService, useValue: { getUser: () => ({ username: 'asha' }), applyFacility: vi.fn() } },
                { provide: DialogService, useValue: dialog }
            ]
        });
        facilities = TestBed.inject(FacilityService);
    });

    afterEach(() => {
        delete (window as any).electron;
        TestBed.resetTestingModule();
    });

    async function render() {
        const fixture = TestBed.createComponent(FacilitySwitcherComponent);
        const reload = vi.fn();
        fixture.componentInstance.reload = reload;
        fixture.detectChanges();
        await fixture.whenStable();
        fixture.detectChanges();
        return { fixture, reload, el: fixture.nativeElement as HTMLElement };
    }

    it('is hidden for a user with one facility', async () => {
        (window as any).electron.getFacilities.mockResolvedValue({ facilityId: 1, facilities: [FACILITIES[0]] });
        const { el } = await render();
        expect(el.querySelector('[data-testid="facility-switcher"]')).toBeNull();
    });

    it('lists the facilities and reloads into the dashboard after a switch', async () => {
        const { el, reload } = await render();
        const select = el.querySelector('select') as HTMLSelectElement;
        expect(Array.from(select.options).map(o => o.textContent?.trim())).toEqual(['Main · Doctor', 'Anna Nagar (hospital) · Admin']);
        select.value = '2';
        select.dispatchEvent(new Event('change'));
        await vi.waitFor(() => expect(reload).toHaveBeenCalled());
        expect((window as any).electron.switchFacility).toHaveBeenCalledWith(2);
        expect(facilities.currentId()).toBe(2);
    });

    it('stays put and explains a refused switch', async () => {
        (window as any).electron.switchFacility.mockResolvedValue({ success: false, error: 'NO_FACILITY_ACCESS' });
        const { el, reload } = await render();
        const select = el.querySelector('select') as HTMLSelectElement;
        select.value = '2';
        select.dispatchEvent(new Event('change'));
        await vi.waitFor(() => expect(dialog.open).toHaveBeenCalled());
        expect(reload).not.toHaveBeenCalled();
        expect(select.value).toBe('1');
    });
});
