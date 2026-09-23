/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { VisitListComponent } from './visit-list.component';

vi.mock('../../services/api.service');
vi.mock('@angular/core', async () => {
    const actual = await vi.importActual('@angular/core');
    return { ...actual as any, inject: vi.fn() };
});

describe('VisitListComponent layout', () => {
    it('keeps Amount visible at 1024px clinic-laptop width', () => {
        const component = new VisitListComponent({ run: (fn: () => void) => fn() } as any, { navigate: vi.fn() } as any);
        const amount = component.colDefs.find(c => c.field === 'amount_paid');
        expect(amount?.headerName).toBe('Amount');
        expect(amount?.minWidth).toBeGreaterThanOrEqual(110);
        const minSum = component.colDefs.reduce((sum, col) => sum + (col.minWidth || 0), 0);
        // 1024px − lg sidebar (288) − md:p-6 padding (48) = 688. Visit list sets
        // [multiSelect]="true", which SharedTable maps to object rowSelection
        // { mode: 'multiRow', checkboxes: true, headerCheckbox: true }. AG Grid 32
        // injects the checkbox controls column (library maxWidth 50) for that
        // configuration, so it counts against the width budget.
        const selectionColumnWidth = 50;
        expect(minSum + selectionColumnWidth).toBeLessThanOrEqual(1024 - 288 - 48);
    });

    it('opens a finished visit in view mode with visitId', () => {
        const navigate = vi.fn();
        const component = new VisitListComponent({ run: (fn: () => void) => fn() } as any, { navigate } as any);
        component.goToVisit({ id: 42, patient_id: 7, diagnosis: 'Headache' });
        expect(navigate).toHaveBeenCalledWith(['/visit', 7], {
            queryParams: { visitId: 42, mode: 'view' },
            state: { visitId: 42, mode: 'view' }
        });
    });

    it('defaults to cards and persists the narrow-viewport view override', () => {
        const component = new VisitListComponent({ run: (fn: () => void) => fn() } as any, { navigate: vi.fn() } as any);
        expect(component.mobileView).toBe('cards');
        component.setMobileView('grid');
        expect(component.mobileView).toBe('grid');
        component.ngOnInit();
        expect(component.mobileView).toBe('grid');
        component.setMobileView('cards');
    });

    it('filters visits client-side across patient, diagnosis, and doctor', () => {
        const component = new VisitListComponent({ run: (fn: () => void) => fn() } as any, { navigate: vi.fn() } as any);
        component.visits = [
            { patient_name: 'Ramesh Gupta', diagnosis: 'Hypertension', doctor_name: 'Dr. Meera Krishnan' },
            { patient_name: 'Arjun Karthik', diagnosis: 'Viral fever', doctor_name: 'Dr. Meera Krishnan' }
        ] as any;
        expect(component.visibleVisits()).toHaveLength(2);
        component.searchTerm = 'ramesh';
        expect(component.visibleVisits()).toHaveLength(1);
        component.searchTerm = 'fever';
        expect(component.visibleVisits()).toHaveLength(1);
        component.searchTerm = 'meera';
        expect(component.visibleVisits()).toHaveLength(2);
        component.searchTerm = 'no-match-xyz';
        expect(component.visibleVisits()).toHaveLength(0);
    });
});
