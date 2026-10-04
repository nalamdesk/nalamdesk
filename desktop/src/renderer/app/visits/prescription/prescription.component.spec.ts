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
});
