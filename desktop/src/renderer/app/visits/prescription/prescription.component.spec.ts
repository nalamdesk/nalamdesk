/**
 * @vitest-environment jsdom
 */
import '@angular/compiler';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PrescriptionComponent } from './prescription.component';
import { PracticeProfileService } from '../../services/practice-profile.service';

// Mock inject for standalone components
vi.mock('@angular/core', async () => {
    const actual = await vi.importActual('@angular/core');
    return {
        ...actual as any,
        inject: vi.fn(),
    };
});

describe('PrescriptionComponent', () => {
    let component: PrescriptionComponent;

    beforeEach(() => {
        component = new PrescriptionComponent();
    });

    it('should create', () => {
        expect(component).toBeTruthy();
    });

    it('should initialize with default item', () => {
        const items = component.items();
        expect(items.length).toBe(1);
        expect(items[0].medicine).toBe('');
    });

    it('should add medicine item', () => {
        vi.spyOn(component.changed, 'emit');
        component.add();
        expect(component.items().length).toBe(2);
        expect(component.changed.emit).toHaveBeenCalled();
    });

    it('should remove medicine item', () => {
        vi.spyOn(component.changed, 'emit');
        component.add(); // Now 2
        component.remove(0); // Remove first
        expect(component.items().length).toBe(1);
        expect(component.changed.emit).toHaveBeenCalledTimes(2); // Add + Remove
    });

    it('should emit changes when updated manually', () => {
        vi.spyOn(component.changed, 'emit');
        // Simulate ngModel change calling emitChange
        component.emitChange();
        expect(component.changed.emit).toHaveBeenCalledWith(component.items());
    });

    it('should set initial data', () => {
        const data = [{ medicine: 'Paracetamol', form: 'Tab' }];
        component.initialData = data;
        expect(component.items()).toEqual(data);
    });

    it('disables add, remove, and change emission in read-only mode', () => {
        vi.spyOn(component.changed, 'emit');
        component.disabled = true;
        component.add();
        component.remove(0);
        component.emitChange();
        expect(component.items()).toHaveLength(1);
        expect(component.changed.emit).not.toHaveBeenCalled();
    });

    it('copies catalog defaults when a medicine is picked and keeps the line editable', () => {
        vi.spyOn(component.changed, 'emit');
        component.onMedicinePicked(0, { id: 3, name: 'Paracetamol', dosage: '500mg', form: 'Tab' });
        expect(component.items()[0].medicine).toBe('Paracetamol');
        expect(component.items()[0].dosage).toBe('500mg');
        component.onMedicineTyped(0, 'Paracetamol extra');
        expect(component.items()[0].medicine).toBe('Paracetamol extra');
        expect(component.changed.emit).toHaveBeenCalled();
    });

    it('carries generic and brand from the catalog pick onto the Rx line', () => {
        component.onMedicinePicked(0, {
            id: 4, name: 'Crocin 500', generic_name: 'Paracetamol', brand_name: 'Crocin', dosage: '500mg'
        });
        expect(component.items()[0].generic_name).toBe('Paracetamol');
        expect(component.items()[0].brand_name).toBe('Crocin');
    });

    it('searches and creates medicines through catalog IPC when available', async () => {
        // Bypass inject entirely: catalog-off behavior must not depend on
        // whichever inject double the runner provides.
        (component as any).dataService = null;
        await expect(component.searchMedicines('para')).resolves.toEqual([]);
        await expect(component.createMedicine('ORS')).resolves.toEqual({ id: 0, name: 'ORS' });
        component.disabled = true;
        component.onMedicineTyped(0, 'x');
        expect(component.items()[0].medicine).toBe('');
    });

    it('labels frequencies per the profile lens without changing values', () => {
        expect(component.frequencyLabel('1-0-1')).toBe('1-0-1 (BID)');
        expect(component.frequencyLabel('STAT')).toBe('STAT');
        (component as any).profileService = { mode: () => 'international' };
        expect(component.frequencyLabel('1-0-1')).toBe('BID (1-0-1)');
        expect(component.frequencyLabel('SOS')).toBe('PRN (SOS)');
    });

    it('folds typed Latin schedules to canonical on emit', () => {
        const seen: any[][] = [];
        component.changed.subscribe((lines) => seen.push(lines));
        component.items.set([
            { medicine: 'A', form: 'Tab', dosage: '500mg', route: 'Oral', frequency: 'BID', duration: '3 days', instruction: 'After Food' },
            { medicine: 'B', form: 'Tab', dosage: '', route: 'Oral', frequency: 'every 6 hours', duration: '', instruction: '' }
        ]);
        component.emitChange();
        expect(seen[0][0].frequency).toBe('1-0-1');
        expect(seen[0][1].frequency).toBe('every 6 hours');
    });

    it('normalizes typed frequencies through the input handler', () => {
        component.items.set([
            { medicine: 'A', form: 'Tab', dosage: '', route: 'Oral', frequency: '', duration: '', instruction: '' }
        ]);
        component.onFrequencyTyped(0, 'tid');
        expect(component.items()[0].frequency).toBe('1-1-1');
        component.onFrequencyTyped(0, '');
        expect(component.items()[0].frequency).toBe('');
    });

    describe('order fields (#20)', () => {
        it('links a picked medicine to its catalog row and unlinks it when the name is typed over', () => {
            component.onMedicinePicked(0, { id: 4, name: 'Crocin 500', generic_name: 'Paracetamol', brand_name: 'Crocin', form: 'Tab', dosage: '500mg' });
            expect(component.items()[0]).toMatchObject({ medicine: 'Crocin 500', medicine_id: 4 });
            expect(component.isFreeText(component.items()[0])).toBe(false);

            component.onMedicineTyped(0, 'Crocin 500');
            expect(component.items()[0].medicine_id).toBe(4);

            component.onMedicineTyped(0, 'Crocin 650');
            expect(component.items()[0]).toMatchObject({ medicine: 'Crocin 650', medicine_id: null, generic_name: null, brand_name: null });
            expect(component.isFreeText(component.items()[0])).toBe(true);
            expect(component.isFreeText({ medicine: ' ' })).toBe(false);
        });

        it('takes a typed quantity over the worked-out one, and clears back to it', () => {
            component.items.set([{ medicine: 'Crocin', form: 'Tab', dosage: '500mg', route: 'Oral', frequency: '1-0-1', duration: '3 days', quantity: 6, quantity_derived: true }]);
            expect(component.quantityHint(component.items()[0])).toBe('6 (auto)');

            component.onQuantityTyped(0, '10');
            expect(component.items()[0]).toMatchObject({ quantity: 10, quantity_derived: false });
            component.onQuantityTyped(0, '');
            expect(component.items()[0]).toMatchObject({ quantity: null, quantity_derived: false });
            expect(component.quantityHint({ form: 'Syr', frequency: '1-0-1', duration: '3 days' })).toBe('—');
        });

        it('hints what stops a line from being issued, and nothing for a blank row', () => {
            expect(component.issuesFor(0)).toEqual([]);
            expect(component.issuesFor(5)).toEqual([]);
            component.items.set([{ medicine: 'Crocin', form: 'Tab', dosage: '', route: 'IV', frequency: '1-0-1', duration: '3 days' }]);
            expect(component.issuesFor(0)).toEqual(['dose is required', 'Tab cannot be given by the IV route']);
            expect(component.maxRefills).toBe(11);
        });
    });
});
