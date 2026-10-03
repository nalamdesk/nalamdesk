/**
 * @vitest-environment jsdom
 */
import '@angular/compiler';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PatientListComponent } from './patient-list.component';
import { DataService } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { of } from 'rxjs';
import { FormBuilder, ReactiveFormsModule } from '@angular/forms';

// Mock inject
vi.mock('@angular/core', async () => {
    const actual = await vi.importActual('@angular/core');
    return {
        ...actual as any,
        inject: vi.fn(),
    };
});
import { inject, ChangeDetectorRef } from '@angular/core';

describe('PatientListComponent', () => {
    let component: PatientListComponent;
    let mockPatientService: any;
    let mockNgZone: any;
    let mockRouter: any;
    let mockDataService: any;
    let mockAuthService: any;
    let mockCdr: any;
    let mockRoute: any;
    let realFb: FormBuilder;

    beforeEach(() => {
        mockPatientService = {
            getPatients: vi.fn().mockResolvedValue([]),
            savePatient: vi.fn().mockResolvedValue({ id: 1 }),
            isPatientComplete: vi.fn().mockReturnValue(true) // Added mock
        };
        mockNgZone = { run: vi.fn((fn) => fn()) };
        mockRouter = { navigate: vi.fn() };
        mockDataService = { invoke: vi.fn() };
        mockAuthService = { getUser: vi.fn().mockReturnValue({ role: 'admin' }) };
        mockCdr = { detectChanges: vi.fn() };
        mockRoute = { queryParams: of({}) }; // Added mock Route

        // Use REAL FormBuilder
        realFb = new FormBuilder();

        vi.mocked(inject).mockImplementation((token: any) => {
            if (token === DataService) return mockDataService;
            if (token === AuthService) return mockAuthService;
            if (token === ChangeDetectorRef) return mockCdr;
            return null;
        });

        component = new PatientListComponent(realFb, mockPatientService, mockNgZone, mockRouter, mockCdr, mockRoute);
        // Manually trigger form init since it's typically called in constructor or ngOnInit
        // In this component it is called in constructor.
    });

    it('should load patients on init', async () => {
        const patients = [{ id: 1, name: 'John', mobile: '123' }];
        mockPatientService.getPatients.mockResolvedValue(patients);
        mockDataService.invoke.mockResolvedValue([]); // Queue status

        await component.ngOnInit();
        await component.loadPatients();

        expect(component.patients).toEqual(patients);
        expect(mockPatientService.getPatients).toHaveBeenCalledWith('', false);
    });

    it('should search patients', async () => {
        component.searchQuery = 'Doe';
        await component.onSearch();
        expect(mockPatientService.getPatients).toHaveBeenCalledWith('Doe', false);
    });

    it('should add patient to queue', async () => {
        const patient = { id: 1, name: 'John', mobile: '123' } as any;
        await component.addToQueue(patient);

        expect(mockDataService.invoke).toHaveBeenCalledWith('addToQueue', { patientId: 1, priority: 1 });
        expect(component.isEnqueued(patient)).toBe(true);
    });

    it('should not add to queue if already enqueued', async () => {
        const patient = { id: 1 } as any;
        component.enqueuedPatientIds.add(1);
        await component.addToQueue(patient);
        expect(mockDataService.invoke).not.toHaveBeenCalled();
    });

    it('should open modal for new patient', () => {
        component.openAddModal();
        expect(component.showModal).toBe(true);
        expect(component.patientForm.get('name')?.value).toBeNull();
    });

    it('should edit patient', () => {
        const patient = { id: 1, name: 'John', mobile: '1234567890', age: 30, gender: 'Male' } as any; // valid data
        component.editPatient(patient);
        expect(component.showModal).toBe(true);
        expect(component.patientForm.get('name')?.value).toBe('John');
        // Verify isEditMode relies on ID being set
        expect(component.isEditMode).toBe(true);
    });

    it('should keep the form valid without an address for rapid intake', () => {
        component.openAddModal();
        component.patientForm.patchValue({ name: 'Walk In', mobile: '9876543210', age: 30, gender: 'Male' });
        expect(component.patientForm.valid).toBe(true);
    });

    it('should save and queue a new walk-in in one action', async () => {
        component.openAddModal();
        component.patientForm.patchValue({ name: 'Walk In', mobile: '9876543210', age: 30, gender: 'Male' });

        await component.savePatient(true);

        expect(mockPatientService.savePatient).toHaveBeenCalled();
        expect(mockDataService.invoke).toHaveBeenCalledWith('addToQueue', { patientId: 1, priority: 1 });
        expect(component.showModal).toBe(false);
        expect(component.isEnqueued({ id: 1 } as any)).toBe(true);
    });

    it('should save without queueing when asked', async () => {
        component.openAddModal();
        component.patientForm.patchValue({ name: 'Walk In', mobile: '9876543210', age: 30, gender: 'Male' });

        await component.savePatient(false);

        expect(mockPatientService.savePatient).toHaveBeenCalled();
        expect(mockDataService.invoke).not.toHaveBeenCalledWith('addToQueue', expect.anything());
    });

    it('should calculate minDate as 110 years ago', () => {
        const minDate = component.minDate;
        const currentYear = new Date().getFullYear();
        const minYear = new Date(minDate).getFullYear();
        expect(currentYear - minYear).toBe(110);
    });

    it('should return today date string', () => {
        const today = new Date().toISOString().split('T')[0];
        expect(component.today).toBe(today);
    });

    // We can now test real validation!
    it('should validate max age', () => {
        const ageControl = component.patientForm.get('age');

        // Valid age
        ageControl?.setValue(50);
        expect(ageControl?.valid).toBe(true);

        // Invalid age (> 110)
        ageControl?.setValue(111);
        expect(ageControl?.hasError('max')).toBe(true);
    });

    // Delete Tests (Batch)
    it('defaults to cards and persists the narrow-viewport view override', () => {        expect(component.mobileView).toBe('cards');
        component.setMobileView('grid');
        expect(component.mobileView).toBe('grid');
        component.ngOnInit();
        expect(component.mobileView).toBe('grid');
        component.setMobileView('cards');
    });

    it('should delete selected patients', async () => {
        // DialogService is injected via inject(); stub it for this flow
        (component as any).dialogService = { open: vi.fn().mockResolvedValue(true) };

        // Select a patient
        const patient = { id: 1, name: 'John' };
        component.selectedPatients = [patient];

        await component.deleteSelectedPatients();

        expect(mockDataService.invoke).toHaveBeenCalledWith('deletePatient', 1);
        expect(component.selectedPatients.length).toBe(0);
        expect(mockPatientService.getPatients).toHaveBeenCalled();
    });

    it('should keep patients when deletion is cancelled', async () => {
        (component as any).dialogService = { open: vi.fn().mockResolvedValue(false) };
        component.selectedPatients = [{ id: 1, name: 'John' }];

        await component.deleteSelectedPatients();

        expect(mockDataService.invoke).not.toHaveBeenCalledWith('deletePatient', expect.anything());
        expect(component.selectedPatients.length).toBe(1);
    });

    it('exposes batch delete only to admins', () => {
        mockAuthService.getUser.mockReturnValue({ role: 'admin' });
        component.ngOnInit();
        expect(component.isAdmin).toBe(true);
        mockAuthService.getUser.mockReturnValue({ role: 'doctor' });
        component.ngOnInit();
        expect(component.isAdmin).toBe(false);
    });

    it('selects cards in batch mode and navigates otherwise', () => {
        const p = { id: 7, name: 'Lakshmi' };
        component.onCardTap(p);
        expect(mockRouter.navigate).toHaveBeenCalledWith(['/patients', 7]);

        component.toggleCardSelectMode();
        expect(component.cardSelectMode).toBe(true);
        component.onCardTap(p);
        expect(component.isCardSelected(p)).toBe(true);
        expect(component.selectedPatients).toHaveLength(1);
        component.onCardTap(p);
        expect(component.isCardSelected(p)).toBe(false);

        component.onCardTap(p);
        component.toggleCardSelectMode();
        expect(component.cardSelectMode).toBe(false);
        expect(component.selectedPatients).toHaveLength(0);
    });

    it('drops selections hidden by a data refresh', () => {
        component.selectedPatients = [{ id: 7 }, { id: 9 }] as any;
        component.patients = [{ id: 9, name: 'Kept' }] as any;
        component.enqueuedPatientIds = new Set();
        component.updateGridData();
        expect(component.selectedPatients.map((p: any) => p.id)).toEqual([9]);
    });

    it('requires an explicit gender selection (no silent default)', () => {
        component.openAddModal();
        expect(component.patientForm.get('gender')?.value).toBe('');
        expect(component.patientForm.get('gender')?.valid).toBe(false);
        component.patientForm.patchValue({ gender: 'Unknown' });
        expect(component.patientForm.get('gender')?.valid).toBe(true);
    });

    it('warns on possible duplicates without blocking registration', async () => {
        vi.useFakeTimers();
        try {
            component.openAddModal();
            mockDataService.invoke.mockResolvedValue([
                { patient: { id: 3, name: 'Ravi', mrn: 'ND-100003', mobile: '9888877771' }, signals: ['phone-shared-possible'], score: 60 }
            ]);
            component.patientForm.patchValue({ name: 'Ravi', mobile: '9888877771' });
            await vi.advanceTimersByTimeAsync(500);
            expect(mockDataService.invoke).toHaveBeenCalledWith('findDuplicateCandidates', expect.objectContaining({
                name: 'Ravi', mobile: '9888877771'
            }));
            expect(component.duplicateCandidates).toHaveLength(1);
            expect(component.duplicateSignalLabel('phone-shared-possible')).toContain('shared');
            expect(component.duplicateSignalLabel('mrn')).toContain('MRN');
        } finally {
            vi.useRealTimers();
        }
    });

    it('clears duplicate warnings for a blank form', async () => {
        component.openAddModal();
        component.duplicateCandidates = [{ patient: { id: 1 } }];
        component.patientForm.patchValue({ name: '', mobile: '' });
        await component.checkDuplicates();
        expect(component.duplicateCandidates).toEqual([]);
    });

    it('ignores stale duplicate responses', async () => {
        component.openAddModal();
        component.patientForm.patchValue({ name: 'Ravi', mobile: '9888877771' });
        let resolveFirst!: (rows: any[]) => void;
        const first = new Promise<any[]>((resolve) => { resolveFirst = resolve; });
        let secondCalled = false;
        mockDataService.invoke.mockImplementationOnce(() => first);
        mockDataService.invoke.mockImplementationOnce(() => {
            secondCalled = true;
            return Promise.resolve([]);
        });
        const p1 = component.checkDuplicates();
        component.patientForm.patchValue({ name: 'Ravi Updated', mobile: '9888877771' });
        const p2 = component.checkDuplicates();
        resolveFirst([{ patient: { id: 9 } }]);
        await Promise.all([p1, p2]);
        expect(secondCalled).toBe(true);
        expect(component.duplicateCandidates).toEqual([]);
    });

    it('retires in-flight requests when the form is cleared', async () => {
        component.openAddModal();
        component.patientForm.patchValue({ name: 'Ravi', mobile: '9888877771' });
        let resolveSlow!: (rows: any[]) => void;
        const slow = new Promise<any[]>((resolve) => { resolveSlow = resolve; });
        mockDataService.invoke.mockImplementationOnce(() => slow);
        const pending = component.checkDuplicates();
        component.patientForm.patchValue({ name: '', mobile: '' });
        await component.checkDuplicates();
        expect(component.duplicateCandidates).toEqual([]);
        resolveSlow([{ patient: { id: 9 } }]);
        await pending;
        expect(component.duplicateCandidates).toEqual([]);
    });

    it('toggles the archived view and reloads with the flag', async () => {
        mockPatientService.getPatients.mockClear();
        component.toggleArchived();
        expect(component.showArchived).toBe(true);
        expect(mockPatientService.getPatients).toHaveBeenCalledWith('', true);
    });

    it('archives a chart with a reason through the dialog', async () => {
        component.askArchive({ id: 3, name: 'Dot' });
        expect(component.showArchiveDialog).toBe(true);
        await component.onArchiveDecided('duplicate chart');
        expect(mockDataService.invoke).toHaveBeenCalledWith('archivePatient', { id: 3, reason: 'duplicate chart' });
        expect(component.showArchiveDialog).toBe(false);
    });

    it('surfaces archive failures in an error dialog', async () => {
        mockDataService.invoke.mockRejectedValueOnce(new Error('active encounter'));
        const dialogSpy = vi.fn().mockResolvedValue(true);
        (component as any).dialogService = { open: dialogSpy };
        component.askArchive({ id: 3, name: 'Dot' });
        await component.onArchiveDecided('duplicate chart');
        expect(dialogSpy).toHaveBeenCalledWith(expect.objectContaining({ title: 'Archive failed' }));
    });

    it('drops the archive when the dialog is cancelled', async () => {
        component.askArchive({ id: 3, name: 'Dot' });
        await component.onArchiveDecided(null);
        expect(mockDataService.invoke).not.toHaveBeenCalledWith('archivePatient', expect.anything());
        expect(component.archiveTarget).toBeNull();
    });

    it('restores an archived chart and surfaces failures', async () => {
        mockDataService.invoke.mockResolvedValue(null);
        await component.unarchivePatient({ id: 4 });
        expect(mockDataService.invoke).toHaveBeenCalledWith('unarchivePatient', 4);

        mockDataService.invoke.mockRejectedValueOnce(new Error('db down'));
        const dialogSpy = vi.fn().mockResolvedValue(true);
        (component as any).dialogService = { open: dialogSpy };
        await component.unarchivePatient({ id: 4 });
        expect(dialogSpy).toHaveBeenCalledWith(expect.objectContaining({ title: 'Restore failed' }));
    });

    it('wires archive and restore through the grid action params', () => {
        const params = (component as any).colDefs
            .find((c: any) => c.headerName === 'Actions').cellRendererParams;
        const queueSpy = vi.spyOn(component, 'addToQueue').mockImplementation(() => Promise.resolve());
        const editSpy = vi.spyOn(component, 'editPatient').mockImplementation(() => undefined);
        const askSpy = vi.spyOn(component, 'askArchive').mockImplementation(() => undefined);
        const restoreSpy = vi.spyOn(component, 'unarchivePatient').mockResolvedValue(undefined);
        params.onQueue({ id: 4 });
        params.onEdit({ id: 4 });
        params.onArchive({ id: 5 });
        params.onUnarchive({ id: 6 });
        expect(queueSpy).toHaveBeenCalledWith({ id: 4 });
        expect(editSpy).toHaveBeenCalledWith({ id: 4 });
        expect(askSpy).toHaveBeenCalledWith({ id: 5 });
        expect(restoreSpy).toHaveBeenCalledWith({ id: 6 });
        queueSpy.mockRestore();
        editSpy.mockRestore();
        askSpy.mockRestore();
        restoreSpy.mockRestore();
    });
});
