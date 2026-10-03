/**
 * @vitest-environment jsdom
 */
import '@angular/compiler';
import { describe, xdescribe, it, expect, vi, beforeEach } from 'vitest';
import { VisitComponent } from './visit.component';
import { DataService } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { BehaviorSubject, of } from 'rxjs';

// Mock services
vi.mock('../../services/api.service');
vi.mock('../../services/auth.service');
vi.mock('../../services/pdf.service');
vi.mock('@angular/router');

// Mock inject
vi.mock('@angular/core', async () => {
    const actual = await vi.importActual('@angular/core');
    return {
        ...actual as any,
        inject: vi.fn(),
    };
});
import { inject } from '@angular/core';

describe('VisitComponent', () => {
    let component: VisitComponent;
    let mockRoute: any;
    let mockRouter: any;
    let mockFb: any;
    let mockNgZone: any;
    let mockPdfService: any;
    let mockDataService: any;
    let mockAuthService: any;

    beforeEach(() => {
        mockRoute = { params: of({ id: 1 }), queryParams: of({}), snapshot: { queryParams: {} } };
        mockRouter = {
            navigate: vi.fn(),
            getCurrentNavigation: vi.fn().mockReturnValue({ extras: { state: {} } })
        };
        mockFb = {
            group: vi.fn().mockImplementation((config) => ({
                value: { diagnosis: 'Test', ...config }, // Add default value to allow valid check
                patchValue: vi.fn(),
                reset: vi.fn(),
                disable: vi.fn(),
                enable: vi.fn(),
                valid: true,
                invalid: false,
                markAllAsTouched: vi.fn(),
                get: vi.fn().mockReturnValue({
                    value: '',
                    invalid: false,
                    touched: false,
                    dirty: false
                }) // Mock get() for strict checks
            }))
        };
        mockNgZone = { run: vi.fn((fn) => fn()) };
        mockPdfService = { generatePrescription: vi.fn() };
        mockDataService = { invoke: vi.fn() };
        mockAuthService = { getUser: vi.fn().mockReturnValue({ id: 99, role: 'doctor' }) };

        vi.mocked(inject).mockImplementation((token: any) => {
            if (token === DataService) return mockDataService;
            if (token === AuthService) return mockAuthService;
            return null;
        });

        // Default mock implementation
        mockDataService.invoke.mockImplementation((method: string) => {
            if (method === 'getVisits') return Promise.resolve([]);
            if (method === 'getPatients') return Promise.resolve([{ id: 1, name: 'John' }]);
            if (method === 'getQueue') return Promise.resolve([]);
            if (method === 'getVitals') return Promise.resolve({ systolic_bp: 120 });
            if (method === 'getActiveConsultation') return Promise.resolve(null);
            if (method === 'resumeConsultation') return Promise.resolve(null);
            if (method === 'saveVisit') return Promise.resolve(true);
            if (method === 'saveConsultationProgress') return Promise.resolve({ id: 7 });
            if (method === 'completeConsultation') return Promise.resolve({ id: 7, status: 'finished' });
            return Promise.resolve(null);
        });

        component = new VisitComponent(mockRoute, mockRouter, mockFb, mockNgZone, mockPdfService, mockDataService, mockAuthService);
    });

    it('should initialize and load data', async () => {
        const visits = [{ id: 1, diagnosis: 'Flu' }];
        // Override for this specific test
        mockDataService.invoke.mockImplementation((method: string) => {
            if (method === 'getVisits') return Promise.resolve(visits);
            if (method === 'getPatients') return Promise.resolve([{ id: 1, name: 'John' }]);
            if (method === 'getQueue') return Promise.resolve([]);
            return Promise.resolve(null);
        });

        component.ngOnInit();
        await component.loadData();

        expect(component.patientId).toBe(1);
        expect(component.patient).toEqual({ id: 1, name: 'John' });
        expect(component.history).toEqual(visits);
    });

    it('should set isConsulting to true when patient is in queue', async () => {
        const activeEncounter = { id: 7, patient_id: 1, status: 'in-progress', prescription: [] };
        // Override mock to return a queue item
        mockDataService.invoke.mockImplementation((method: string) => {
            if (method === 'getActiveConsultation') return Promise.resolve(activeEncounter);
            if (method === 'resumeConsultation') return Promise.resolve(activeEncounter);
            if (method === 'getPatients') return Promise.resolve([{ id: 1, name: 'John' }]);
            if (method === 'getVitals') return Promise.resolve({});
            return Promise.resolve([]); // Default return array for lists, or null
        });

        component.ngOnInit();
        await component.loadData();

        expect(component.isConsulting).toBe(true);
        expect(component.visitForm.enable).toHaveBeenCalled();
        expect(mockDataService.invoke).toHaveBeenCalledWith('resumeConsultation', { encounterId: 7 });
    });

    it('keeps the form disabled until a postponed encounter reclaims its exact queue entry', async () => {
        component.patientId = 1;
        const activeEncounter = { id: 7, patient_id: 1, status: 'in-progress', prescription: [] };
        let releaseResume!: (value: any) => void;
        const resumePending = new Promise(resolve => { releaseResume = resolve; });
        mockDataService.invoke.mockImplementation((method: string) => {
            if (method === 'getVisits') return Promise.resolve([]);
            if (method === 'getPatients') return Promise.resolve([{ id: 1, name: 'John' }]);
            if (method === 'getVitals') return Promise.resolve({});
            if (method === 'getActiveConsultation') return Promise.resolve(activeEncounter);
            if (method === 'resumeConsultation') return resumePending;
            return Promise.resolve(null);
        });

        const loading = component.loadData();
        await Promise.resolve();
        await Promise.resolve();
        expect(component.visitForm.disable).toHaveBeenCalled();
        expect(component.visitForm.enable).not.toHaveBeenCalled();

        releaseResume(activeEncounter);
        await loading;
        expect(component.visitForm.enable).toHaveBeenCalled();
        expect(component.encounterId).toBe(7);
    });

    it("keeps another practitioner's active patient chart private and read-only", async () => {
        component.patientId = 1;
        component.isConsulting = true;
        const history = [{ id: 5, patient_id: 1, status: 'finished', diagnosis: 'Prior visit' }];
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        mockDataService.invoke.mockImplementation((method: string) => {
            if (method === 'getVisits') return Promise.resolve(history);
            if (method === 'getPatients') return Promise.resolve([{ id: 1, name: 'John' }]);
            if (method === 'getVitals') return Promise.resolve({ pulse: 80 });
            if (method === 'getActiveConsultation') return Promise.reject(new Error('Only the responsible practitioner can access this encounter'));
            return Promise.resolve(null);
        });

        await component.loadData();

        expect(component.patient).toEqual({ id: 1, name: 'John' });
        expect(component.history).toEqual(history);
        expect(component.patientVitals).toEqual({ pulse: 80 });
        expect(component.isConsulting).toBe(false);
        expect(component.activeEncounterReadOnly).toBe(true);
        expect(component.encounterId).toBeNull();
        expect(component.editingVisitId).toBeNull();
        expect(component.visitForm.disable).toHaveBeenCalled();
        expect(component.visitForm.enable).not.toHaveBeenCalled();
        expect(mockDataService.invoke.mock.calls.some((call: any[]) => call[0] === 'beginConsultation')).toBe(false);
        expect(mockDataService.invoke.mock.calls.some((call: any[]) => call[0] === 'resumeConsultation')).toBe(false);

        component.editVisit(history[0]);
        expect(component.editingVisitId).toBeNull();
        expect(component.visitForm.enable).not.toHaveBeenCalled();
    });

    it('surfaces a retryable error instead of read-only mode for transient resume failures', async () => {
        component.patientId = 1;
        const activeEncounter = { id: 7, patient_id: 1, status: 'in-progress', prescription: [] };
        mockDataService.invoke.mockImplementation((method: string) => {
            if (method === 'getVisits') return Promise.resolve([]);
            if (method === 'getPatients') return Promise.resolve([{ id: 1, name: 'John' }]);
            if (method === 'getVitals') return Promise.resolve({});
            if (method === 'getActiveConsultation') return Promise.resolve(activeEncounter);
            if (method === 'resumeConsultation') return Promise.reject(new Error('database is locked'));
            return Promise.resolve(null);
        });
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        await component.loadData();

        expect(component.activeEncounterReadOnly).toBe(false);
        expect(component.consultationLoadError).toContain('Retry');
        expect(component.encounterId).toBeNull();
        expect(component.visitForm.enable).not.toHaveBeenCalled();
    });

    it('leaves a failed start usable and reuses the request id on retry', async () => {
        component.patientId = 1;
        component.isConsulting = true;
        const requestIds: string[] = [];
        let attempts = 0;
        mockDataService.invoke.mockImplementation((method: string, input: any) => {
            if (method === 'getVisits') return Promise.resolve([]);
            if (method === 'getPatients') return Promise.resolve([{ id: 1, name: 'John' }]);
            if (method === 'getVitals') return Promise.resolve({});
            if (method === 'getActiveConsultation') return Promise.resolve(null);
            if (method === 'getQueue') return Promise.resolve([{ id: 9, patient_id: 1, status: 'waiting' }]);
            if (method === 'beginConsultation') {
                requestIds.push(input.startRequestId);
                attempts += 1;
                return attempts === 1 ? Promise.reject(new Error('response lost')) : Promise.resolve({ id: 7, prescription: [] });
            }
            return Promise.resolve(null);
        });
        vi.spyOn(console, 'error').mockImplementation(() => undefined);

        await component.loadData();
        expect(component.isConsulting).toBe(false);
        expect(component.consultationLoadError).toContain('Could not start');
        expect(component.visitForm.disable).toHaveBeenCalled();

        await component.retryConsultationLoad();
        expect(requestIds).toHaveLength(2);
        expect(requestIds[1]).toBe(requestIds[0]);
        expect(component.encounterId).toBe(7);
        expect(component.visitForm.enable).toHaveBeenCalled();
    });

    it('should save visit', async () => {
        component.patientId = 1;
        component.encounterId = 7;
        // Mock the form value to include SOAP fields
        const formVal = {
            diagnosis: 'Cold',
            symptoms: 'Cough',
            examination_notes: 'Throat Red',
            diagnosis_type: 'Provisional'
        };
        // We can't easily assign to .value of the mock group if it's static, 
        // but our mock implementation returns { ...config, value: ... }
        // Let's assume the component reads this.visitForm.value.
        // We can force the getter if needed, or if we mocked it as a property
        component.visitForm = {
            value: formVal,
            invalid: false,
            reset: vi.fn(),
            patchValue: vi.fn(),
            disable: vi.fn(),
            enable: vi.fn(),
            markAllAsTouched: vi.fn(),
            get: vi.fn().mockReturnValue({ invalid: false })
        } as any;

        await component.saveVisit();

        expect(mockDataService.invoke).toHaveBeenCalledWith('saveConsultationProgress', {
            encounterId: 7,
            visit: expect.objectContaining({ symptoms: 'Cough', examination_notes: 'Throat Red' })
        });
    });

    it('keeps an in-progress draft out of history after saving progress', async () => {
        component.patientId = 1;
        component.encounterId = 7;
        component.visitForm = {
            value: { diagnosis: 'Draft' }, invalid: false, valid: true,
            reset: vi.fn(), patchValue: vi.fn(), disable: vi.fn(), enable: vi.fn(),
            markAllAsTouched: vi.fn(), get: vi.fn().mockReturnValue({ invalid: false })
        } as any;
        mockDataService.invoke.mockImplementation((method: string) => {
            if (method === 'saveConsultationProgress') return Promise.resolve({ id: 7 });
            if (method === 'getVisits') return Promise.resolve([
                { id: 7, status: 'in-progress', diagnosis: 'Draft' },
                { id: 6, status: 'finished', diagnosis: 'Prior' }
            ]);
            return Promise.resolve(null);
        });

        await component.saveVisit();
        await Promise.resolve();

        expect(component.history).toEqual([{ id: 6, status: 'finished', diagnosis: 'Prior' }]);
    });

    it('should not enter historical edit mode during an active consultation', () => {
        component.encounterId = 7;
        component.isConsulting = true;
        const activePatch = vi.spyOn(component.visitForm, 'patchValue');

        component.editVisit({ id: 42, diagnosis: 'Historical diagnosis' });

        expect(component.editingVisitId).toBeNull();
        expect(activePatch).not.toHaveBeenCalled();
        expect(component.encounterId).toBe(7);
    });

    it('should end consult', async () => {
        component.patientId = 1;
        component.encounterId = 7;
        // Ensure form is valid so endConsult proceeds
        component.visitForm = {
            value: {},
            invalid: false,
            valid: true,
            markAllAsTouched: vi.fn()
        } as any;


        await component.endConsult();

        expect(mockDataService.invoke).toHaveBeenCalledWith('completeConsultation', {
            encounterId: 7,
            visit: {}
        });
        expect(mockRouter.navigate).toHaveBeenCalledWith(['/queue']);
    });

    it('should reuse the next-patient request id after a lost response', async () => {
        component.patientId = 1;
        component.encounterId = 7;
        component.isConsulting = true;
        component.visitForm = {
            value: { diagnosis: 'Done' }, invalid: false, valid: true,
            markAllAsTouched: vi.fn(), reset: vi.fn(), patchValue: vi.fn(),
            enable: vi.fn(), disable: vi.fn(), get: vi.fn().mockReturnValue({ value: '' })
        } as any;
        vi.spyOn(window, 'alert').mockImplementation(() => undefined);
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const requestIds: string[] = [];
        let nextAttempt = 0;
        mockDataService.invoke.mockImplementation((method: string, input: any) => {
            if (method === 'completeConsultation') return Promise.resolve({ id: 7, status: 'finished' });
            if (method === 'beginNextConsultation') {
                requestIds.push(input.startRequestId);
                nextAttempt += 1;
                return nextAttempt === 1
                    ? Promise.reject(new Error('response lost'))
                    : Promise.resolve({ id: 8, patient_id: 2 });
            }
            if (method === 'getVisits' || method === 'getPatients') return Promise.resolve([]);
            return Promise.resolve(null);
        });

        await component.finishAndNext();
        await component.finishAndNext();

        expect(requestIds).toHaveLength(2);
        expect(requestIds[1]).toBe(requestIds[0]);
        expect(mockRouter.navigate).toHaveBeenCalledWith(['/visit', 2], {
            state: { isConsulting: true, encounterId: 8 }
        });
    });

    it('should ignore a second Finish & Next click while completion is pending', async () => {
        component.encounterId = 7;
        component.visitForm = {
            value: { diagnosis: 'Done' }, invalid: false, valid: true,
            markAllAsTouched: vi.fn(), reset: vi.fn(), patchValue: vi.fn(),
            enable: vi.fn(), disable: vi.fn(), get: vi.fn().mockReturnValue({ value: '' })
        } as any;
        let releaseCompletion!: (value: any) => void;
        const pendingCompletion = new Promise(resolve => { releaseCompletion = resolve; });
        mockDataService.invoke.mockImplementation((method: string) => {
            if (method === 'completeConsultation') return pendingCompletion;
            if (method === 'beginNextConsultation') return Promise.resolve(null);
            return Promise.resolve(null);
        });
        vi.spyOn(window, 'alert').mockImplementation(() => undefined);

        const first = component.finishAndNext();
        const second = component.finishAndNext();
        releaseCompletion({ id: 7, status: 'finished' });
        await Promise.all([first, second]);

        expect(mockDataService.invoke.mock.calls.filter((call: any[]) => call[0] === 'completeConsultation')).toHaveLength(1);
        expect(mockDataService.invoke.mock.calls.filter((call: any[]) => call[0] === 'beginNextConsultation')).toHaveLength(1);
    });

    it('should ignore a second Finish & Exit click while completion is pending', async () => {
        component.encounterId = 7;
        component.visitForm = {
            value: { diagnosis: 'Done' }, invalid: false, valid: true,
            markAllAsTouched: vi.fn()
        } as any;
        let releaseCompletion!: (value: any) => void;
        mockDataService.invoke.mockImplementation((method: string) => method === 'completeConsultation'
            ? new Promise(resolve => { releaseCompletion = resolve; })
            : Promise.resolve(null));

        const first = component.endConsult();
        const second = component.endConsult();
        releaseCompletion({ id: 7, status: 'finished' });
        await Promise.all([first, second]);

        expect(mockDataService.invoke.mock.calls.filter((call: any[]) => call[0] === 'completeConsultation')).toHaveLength(1);
    });

    it('should ignore a second Postpone click and omit invalid visit data', async () => {
        component.encounterId = 7;
        component.visitForm = { value: {}, invalid: true, valid: false } as any;
        let releasePostpone!: (value: any) => void;
        mockDataService.invoke.mockImplementation((method: string) => method === 'postponeConsultation'
            ? new Promise(resolve => { releasePostpone = resolve; })
            : Promise.resolve(null));

        const first = component.postponeConsult();
        const second = component.postponeConsult();
        releasePostpone({ id: 7 });
        await Promise.all([first, second]);

        const calls = mockDataService.invoke.mock.calls.filter((call: any[]) => call[0] === 'postponeConsultation');
        expect(calls).toHaveLength(1);
        expect(calls[0][1]).toEqual({ encounterId: 7, visit: undefined });
    });

    it('does not present LIVE writable chart when opened without beginConsultation', async () => {
        component.patientId = 1;
        await component.loadData();

        expect(component.isConsulting).toBe(false);
        expect(component.encounterId).toBeNull();
        expect(component.isLiveConsultation).toBe(false);
        expect(component.canEditChart).toBe(false);
        expect(component.visitForm.enable).not.toHaveBeenCalled();
        expect(mockDataService.invoke.mock.calls.some((call: any[]) => call[0] === 'beginConsultation')).toBe(false);
    });

    it('shows a writable LIVE consultation after a started encounter is resumed', async () => {
        component.patientId = 1;
        const activeEncounter = { id: 7, patient_id: 1, status: 'in-progress', prescription: [] };
        mockDataService.invoke.mockImplementation((method: string) => {
            if (method === 'getActiveConsultation') return Promise.resolve(activeEncounter);
            if (method === 'resumeConsultation') return Promise.resolve(activeEncounter);
            if (method === 'getPatients') return Promise.resolve([{ id: 1, name: 'John' }]);
            if (method === 'getVitals') return Promise.resolve({});
            return Promise.resolve([]);
        });

        await component.loadData();

        expect(component.isConsulting).toBe(true);
        expect(component.encounterId).toBe(7);
        expect(component.isLiveConsultation).toBe(true);
        expect(component.canEditChart).toBe(true);
        expect(component.visitForm.enable).toHaveBeenCalled();
    });

    it('keeps SOAP and Rx read-only together when another practitioner owns the encounter', async () => {
        component.patientId = 1;
        component.isConsulting = true;
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        mockDataService.invoke.mockImplementation((method: string) => {
            if (method === 'getVisits') return Promise.resolve([]);
            if (method === 'getPatients') return Promise.resolve([{ id: 1, name: 'John' }]);
            if (method === 'getVitals') return Promise.resolve({});
            if (method === 'getActiveConsultation') return Promise.reject(new Error('Only the responsible practitioner can access this encounter'));
            return Promise.resolve(null);
        });

        await component.loadData();

        expect(component.activeEncounterReadOnly).toBe(true);
        expect(component.isLiveConsultation).toBe(false);
        expect(component.canEditChart).toBe(false);
        expect(component.visitForm.enable).not.toHaveBeenCalled();
    });

    it('unlocks SOAP and Rx together when editing a past visit, then relocks on reset', () => {
        component.editVisit({ id: 42, diagnosis: 'Prior', prescription: [{ medicine: 'Para' }] });
        expect(component.editingVisitId).toBe(42);
        expect(component.canEditChart).toBe(true);
        expect(component.isLiveConsultation).toBe(false);

        component.resetForm();
        expect(component.editingVisitId).toBeNull();
        expect(component.canEditChart).toBe(false);
    });

    it('loads a finished visit in view mode without starting a consult', async () => {
        component.patientId = 1;
        component.viewMode = true;
        component.viewVisitId = 42;
        const finished = {
            id: 42,
            status: 'finished',
            symptoms: 'Headache for 2 days',
            examination_notes: 'BP 120/80',
            diagnosis: 'Tension headache',
            diagnosis_type: 'Final',
            prescription: [{ medicine: 'Paracetamol', frequency: 'SOS' }],
            amount_paid: 300
        };
        mockDataService.invoke.mockImplementation((method: string) => {
            if (method === 'getVisits') return Promise.resolve([finished]);
            if (method === 'getPatients') return Promise.resolve([{ id: 1, name: 'Clinical Tester Sep2' }]);
            if (method === 'getVitals') return Promise.resolve({ pulse: 72 });
            return Promise.resolve(null);
        });

        await component.loadData();

        expect(component.patient).toEqual({ id: 1, name: 'Clinical Tester Sep2' });
        expect(component.viewedVisit).toEqual(finished);
        expect(component.visitForm.patchValue).toHaveBeenCalledWith(expect.objectContaining({
            symptoms: 'Headache for 2 days',
            examination_notes: 'BP 120/80',
            diagnosis: 'Tension headache',
            diagnosis_type: 'Final',
            prescription: [{ medicine: 'Paracetamol', frequency: 'SOS' }],
            amount_paid: 300
        }));
        expect(component.currentPrescription).toEqual([{ medicine: 'Paracetamol', frequency: 'SOS' }]);
        expect(component.isViewMode).toBe(true);
        expect(component.isLiveConsultation).toBe(false);
        expect(component.canEditChart).toBe(false);
        expect(component.isConsulting).toBe(false);
        expect(component.encounterId).toBeNull();
        expect(component.editingVisitId).toBeNull();
        expect(component.visitForm.enable).not.toHaveBeenCalled();
        expect(mockDataService.invoke.mock.calls.some((call: any[]) => call[0] === 'beginConsultation')).toBe(false);
        expect(mockDataService.invoke.mock.calls.some((call: any[]) => call[0] === 'getActiveConsultation')).toBe(false);
        expect(mockDataService.invoke.mock.calls.some((call: any[]) => call[0] === 'resumeConsultation')).toBe(false);
    });

    it('reads view intent from router state and query params', () => {
        mockRouter.getCurrentNavigation.mockReturnValue({
            extras: { state: { visitId: 42, mode: 'view' } }
        });
        const fromState = new VisitComponent(mockRoute, mockRouter, mockFb, mockNgZone, mockPdfService, mockDataService, mockAuthService);
        expect(fromState.viewMode).toBe(true);
        expect(fromState.viewVisitId).toBe(42);

        mockRoute = {
            params: of({ id: 1 }),
            queryParams: of({ visitId: '88', mode: 'view' }),
            snapshot: { queryParams: { visitId: '88', mode: 'view' } }
        };
        const fromQuery = new VisitComponent(mockRoute, mockRouter, mockFb, mockNgZone, mockPdfService, mockDataService, mockAuthService);
        fromQuery.ngOnInit();
        expect(fromQuery.viewMode).toBe(true);
        expect(fromQuery.viewVisitId).toBe(88);

        mockRoute = {
            params: of({ id: 1 }),
            queryParams: of({ mode: 'view' }),
            snapshot: { queryParams: { mode: 'view' } }
        };
        const viewWithoutId = new VisitComponent(mockRoute, mockRouter, mockFb, mockNgZone, mockPdfService, mockDataService, mockAuthService);
        viewWithoutId.ngOnInit();
        expect(viewWithoutId.viewMode).toBe(true);
        expect(viewWithoutId.viewVisitId).toBeNull();
    });

    it('clears view mode when the same visit route is reused without view query params', async () => {
        const params$ = new BehaviorSubject({ id: 1 });
        const query$ = new BehaviorSubject<Record<string, any>>({ visitId: '42', mode: 'view' });
        mockRoute = { params: params$, queryParams: query$, snapshot: { queryParams: query$.value } };
        const reused = new VisitComponent(mockRoute, mockRouter, mockFb, mockNgZone, mockPdfService, mockDataService, mockAuthService);
        reused.ngOnInit();
        await Promise.resolve();
        expect(reused.viewMode).toBe(true);
        expect(reused.viewVisitId).toBe(42);
        reused.viewedVisit = { id: 42, diagnosis: 'Headache' } as any;

        query$.next({});
        await Promise.resolve();
        expect(reused.viewMode).toBe(false);
        expect(reused.viewVisitId).toBeNull();
        expect(reused.viewedVisit).toBeNull();
        expect(reused.isViewMode).toBe(false);
        expect(reused.canEditChart).toBe(false);
        expect(mockDataService.invoke.mock.calls.some((call: any[]) => call[0] === 'getActiveConsultation')).toBe(true);
        expect(mockDataService.invoke.mock.calls.some((call: any[]) => call[0] === 'beginConsultation')).toBe(false);
    });

    it('updates the viewed visit when query visitId changes on the reused route', async () => {
        const params$ = new BehaviorSubject({ id: 1 });
        const query$ = new BehaviorSubject<Record<string, any>>({ visitId: '42', mode: 'view' });
        mockRoute = { params: params$, queryParams: query$, snapshot: { queryParams: query$.value } };
        const visits = [
            { id: 42, status: 'finished', diagnosis: 'Headache', prescription: [], amount_paid: 100 },
            { id: 88, status: 'finished', diagnosis: 'Flu', prescription: [{ medicine: 'Azithro' }], amount_paid: 200 }
        ];
        mockDataService.invoke.mockImplementation((method: string) => {
            if (method === 'getVisits') return Promise.resolve(visits);
            if (method === 'getPatients') return Promise.resolve([{ id: 1, name: 'John' }]);
            if (method === 'getVitals') return Promise.resolve({});
            return Promise.resolve(null);
        });
        const reused = new VisitComponent(mockRoute, mockRouter, mockFb, mockNgZone, mockPdfService, mockDataService, mockAuthService);
        reused.ngOnInit();
        await Promise.resolve();
        await Promise.resolve();
        expect(reused.viewVisitId).toBe(42);
        expect(reused.viewedVisit).toEqual(expect.objectContaining({ diagnosis: 'Headache' }));

        query$.next({ visitId: '88', mode: 'view' });
        await Promise.resolve();
        await Promise.resolve();
        expect(reused.viewMode).toBe(true);
        expect(reused.viewVisitId).toBe(88);
        expect(reused.viewedVisit).toEqual(expect.objectContaining({ diagnosis: 'Flu' }));
        expect(reused.canEditChart).toBe(false);
    });

    it('prints via PdfService and skips download when no visit snapshot is loaded', async () => {
        component.patient = { id: 1, name: 'John', age: 30, gender: 'Male' };
        mockDataService.invoke.mockImplementation((method: string) => {
            if (method === 'getPublicSettings') return Promise.resolve({ doctor_name: 'Dr. Clinic', license_key: 'LIC-9' });
            return Promise.resolve(null);
        });
        mockAuthService.getUser.mockReturnValue({});

        await component.printPrescription();
        expect(mockPdfService.generatePrescription).toHaveBeenCalled();

        mockPdfService.generatePrescription.mockClear();
        component.viewedVisit = null;
        await component.downloadVisitPdf();
        expect(mockPdfService.generatePrescription).not.toHaveBeenCalled();
    });

    it('surfaces an error when the viewed visit id is missing from history', async () => {
        component.patientId = 1;
        component.viewMode = true;
        component.viewVisitId = 99;
        mockDataService.invoke.mockImplementation((method: string) => {
            if (method === 'getVisits') return Promise.resolve([{ id: 42, status: 'finished', diagnosis: 'Other' }]);
            if (method === 'getPatients') return Promise.resolve([{ id: 1, name: 'John' }]);
            if (method === 'getVitals') return Promise.resolve({});
            return Promise.resolve(null);
        });
        await component.loadData();
        expect(component.viewedVisit).toBeNull();
        expect(component.consultationLoadError).toContain('Could not load this visit');
        expect(component.canEditChart).toBe(false);
    });

    it('downloads a PDF from the loaded visit snapshot, not the empty form', async () => {
        component.patient = { id: 1, name: 'Clinical Tester Sep2', age: 40, gender: 'Female' };
        component.viewedVisit = {
            id: 42,
            date: '2026-09-02T10:00:00Z',
            diagnosis: 'Tension headache',
            prescription: [{ medicine: 'Paracetamol', frequency: 'SOS' }],
            amount_paid: 300
        } as any;
        component.visitForm = { value: {}, invalid: false } as any;
        mockDataService.invoke.mockImplementation((method: string) => {
            if (method === 'getPublicSettings') return Promise.resolve({ doctor_name: 'Dr. Clinic' });
            return Promise.resolve(null);
        });
        mockAuthService.getUser.mockReturnValue({ name: 'Dr. Clinic', specialty: 'General', license_number: 'LIC-1' });

        await component.downloadVisitPdf();

        expect(mockPdfService.generatePrescription).toHaveBeenCalledWith(
            expect.objectContaining({
                diagnosis: 'Tension headache',
                prescription: [{ medicine: 'Paracetamol', frequency: 'SOS' }],
                amount_paid: 300
            }),
            component.patient,
            expect.objectContaining({ name: 'Dr. Clinic' })
        );
        expect(mockPdfService.generatePrescription.mock.calls[0][0]).not.toEqual(expect.objectContaining({
            diagnosis: undefined
        }));
    });

    it('keeps sidebar history clicks read-only in view mode', () => {
        component.viewMode = true;
        component.viewVisitId = 42;
        component.editVisit({
            id: 9,
            diagnosis: 'Older flu',
            prescription: [{ medicine: 'Azithro' }],
            amount_paid: 200
        });
        expect(component.viewVisitId).toBe(9);
        expect(component.editingVisitId).toBeNull();
        expect(component.canEditChart).toBe(false);
        expect(component.visitForm.enable).not.toHaveBeenCalled();
        expect(component.visitForm.patchValue).toHaveBeenCalledWith(expect.objectContaining({ diagnosis: 'Older flu' }));
    });

    it('ignores prescription edits and copy-last-visit while the chart is read-only', () => {
        component.history = [{ diagnosis: 'Flu', diagnosis_type: 'Final', prescription: [] }] as any;
        component.updatePrescription([{ medicine: 'x' }]);
        component.copyLastVisit();
        expect(component.visitForm.patchValue).not.toHaveBeenCalledWith({ prescription: [{ medicine: 'x' }] });

        component.chartWritable = true;
        component.isConsulting = true;
        component.encounterId = 7;
        component.copyLastVisit();
        expect(component.visitForm.patchValue).toHaveBeenCalledWith(expect.objectContaining({ diagnosis: 'Flu' }));
    });

    it('applies editable condition presets when a catalog diagnosis is picked', async () => {
        component.chartWritable = true;
        component.isConsulting = true;
        component.encounterId = 7;
        mockDataService.invoke.mockImplementation((method: string) => {
            if (method === 'getConditionMedPresets') {
                return Promise.resolve([{ medicine: 'Paracetamol', dosage: '500mg', duration: '3 days' }]);
            }
            return Promise.resolve([]);
        });
        await component.onConditionPicked({ id: 4, name: 'Influenza' });
        expect(component.visitForm.patchValue).toHaveBeenCalledWith({ diagnosis: 'Influenza' });
        expect(component.currentPrescription[0].medicine).toBe('Paracetamol');
        component.currentPrescription[0].duration = '7 days';
        expect(component.currentPrescription[0].duration).toBe('7 days');
    });

    it('ignores stale condition presets after a later diagnosis pick', async () => {
        component.chartWritable = true;
        component.isConsulting = true;
        component.encounterId = 7;
        let resolveFlu: (lines: any[]) => void = () => undefined;
        let resolveUri: (lines: any[]) => void = () => undefined;
        const fluPresets = new Promise<any[]>((resolve) => {
            resolveFlu = resolve;
        });
        const uriPresets = new Promise<any[]>((resolve) => {
            resolveUri = resolve;
        });
        mockDataService.invoke.mockImplementation((method: string, id?: number) => {
            if (method === 'getConditionMedPresets') {
                return id === 1 ? fluPresets : uriPresets;
            }
            return Promise.resolve([]);
        });

        const fluPick = component.onConditionPicked({ id: 1, name: 'Influenza' });
        const uriPick = component.onConditionPicked({ id: 2, name: 'URI' });
        resolveFlu([{ medicine: 'Oseltamivir' }]);
        await fluPick;
        expect(component.currentPrescription).toEqual([]);

        resolveUri([{ medicine: 'Paracetamol' }]);
        await uriPick;
        expect(component.currentPrescription[0].medicine).toBe('Paracetamol');
    });

    it('adds a new diagnosis without blocking free-text entry', async () => {
        component.chartWritable = true;
        component.isConsulting = true;
        component.encounterId = 7;
        mockDataService.invoke.mockResolvedValue({ id: 8, name: 'Viral fever' });
        const created = await component.createCondition('Viral fever');
        expect(mockDataService.invoke).toHaveBeenCalledWith('createCondition', { name: 'Viral fever' });
        expect(created.name).toBe('Viral fever');
        component.onDiagnosisTyped('Free text diagnosis');
        expect(component.visitForm.patchValue).toHaveBeenCalledWith({ diagnosis: 'Free text diagnosis' });
    });

    it('validates vitals presence and suppresses malformed placeholders', () => {
        expect(component.hasBp(null)).toBe(false);
        expect(component.hasBp({})).toBe(false);
        expect(component.hasBp({ systolic_bp: 120 })).toBe(false);
        expect(component.hasBp({ diastolic_bp: 80 })).toBe(false);
        expect(component.hasBp({ systolic_bp: 120, diastolic_bp: 80 })).toBe(true);

        expect(component.hasVitalsToDisplay(null)).toBe(false);
        expect(component.hasVitalsToDisplay({})).toBe(false);
        expect(component.hasVitalsToDisplay({ pulse: 72 })).toBe(true);

        const partial = { pulse: 72, temperature: 98.6 };
        const text = component.formatVitalsObjective(partial);
        expect(text).not.toContain('BP:');
        expect(text).not.toContain('undefined');
        expect(text).toContain('Pulse: 72 bpm');
        expect(text).toContain('Temp: 98.6 °F');

        const withBp = { systolic_bp: 120, diastolic_bp: 80, pulse: 70 };
        const textWithBp = component.formatVitalsObjective(withBp);
        expect(textWithBp).toContain('BP: 120/80 mmHg');
        expect(textWithBp).toContain('Pulse: 70 bpm');
    });

    it('opens and closes vitals modal during active consultation', () => {
        component.chartWritable = true;
        component.isConsulting = true;
        component.openVitalsModal();
        expect(component.showVitalsModal).toBe(true);
        const newVitals = { systolic_bp: 120, diastolic_bp: 80, pulse: 72 };
        component.onVitalsSaved(newVitals);
        expect(component.patientVitals).toEqual(newVitals);
        expect(component.showVitalsModal).toBe(false);
    });

    it('loads patient safety context in loadData', async () => {
        const mockSafetyContext = {
            patient_id: 1,
            active_allergies: [{ id: 1, substance: 'Amoxicillin', criticality: 'high' }],
            has_active_allergies: true,
            active_conditions: [{ id: 1, condition_name: 'Asthma' }],
            active_medications: [{ id: 1, medicine_name: 'Salbutamol' }]
        };
        mockDataService.invoke.mockImplementation((method: string) => {
            if (method === 'getVisits' || method === 'getPatients') return Promise.resolve([]);
            if (method === 'getPatientSafetyContext') return Promise.resolve(mockSafetyContext);
            return Promise.resolve(null);
        });

        component.patientId = 1;
        await component.loadData();

        expect(component.patientSafetyContext).toEqual(mockSafetyContext);
    });

    it('detects allergy conflict and blocks completion until override reason is acknowledged', async () => {
        component.patientId = 1;
        component.encounterId = 7;
        component.isConsulting = true;
        component.chartWritable = true;
        component.patientSafetyContext = {
            patient_id: 1,
            active_allergies: [{ id: 1, substance: 'Penicillin', criticality: 'high', reaction: 'Anaphylaxis' }],
            has_active_allergies: true
        };

        component.currentPrescription = [{ medicine: 'Amoxicillin / Clavulanate (Penicillin class)' }];
        component.visitForm.value.prescription = component.currentPrescription;
        component.visitForm.value.diagnosis = 'Infection';

        const conflicts = component.checkForAllergyConflicts();
        expect(conflicts).toHaveLength(1);
        expect(conflicts[0].substance).toBe('Penicillin');

        // Attempting to complete consultation should trigger allergy override modal and block
        const completed = await component.completeConsult();
        expect(completed).toBe(false);
        expect(component.showAllergyOverrideModal).toBe(true);
        expect(mockDataService.invoke).not.toHaveBeenCalledWith('completeConsultation', expect.anything());

        // Doctor acknowledges and enters clinical override rationale
        component.overrideReasonInput = 'Patient tolerated cephalosporins and graded dose previously';
        mockDataService.invoke.mockImplementation((method: string) => {
            if (method === 'completeConsultation') return Promise.resolve({ id: 7, status: 'finished' });
            return Promise.resolve(null);
        });

        component.confirmAllergyOverride();

        expect(component.showAllergyOverrideModal).toBe(false);
        expect(component.visitForm.value.allergy_override_reason).toBe('Patient tolerated cephalosporins and graded dose previously');
        expect(mockDataService.invoke).toHaveBeenCalledWith('completeConsultation', expect.objectContaining({
            encounterId: 7,
            visit: expect.objectContaining({
                allergy_override_reason: 'Patient tolerated cephalosporins and graded dose previously'
            })
        }));
    });

    it('resumes Finish & Next after the allergy override is confirmed', async () => {
        component.patientId = 1;
        component.encounterId = 7;
        component.isConsulting = true;
        component.chartWritable = true;
        component.patientSafetyContext = {
            patient_id: 1,
            active_allergies: [{ id: 1, substance: 'Penicillin', criticality: 'high', reaction: 'Anaphylaxis' }],
            has_active_allergies: true
        };
        component.currentPrescription = [{ medicine: 'Amoxicillin (Penicillin class)' }];
        component.visitForm.value.prescription = component.currentPrescription;
        component.visitForm.value.diagnosis = 'Infection';
        mockDataService.invoke.mockImplementation((method: string) => {
            if (method === 'completeConsultation') return Promise.resolve({ id: 7, status: 'finished' });
            if (method === 'beginNextConsultation') return Promise.resolve({ id: 8, patient_id: 2 });
            return Promise.resolve(null);
        });
        vi.spyOn(window, 'alert').mockImplementation(() => undefined);

        await component.finishAndNext();
        expect(component.showAllergyOverrideModal).toBe(true);

        component.overrideReasonInput = 'Desensitized previously';
        component.confirmAllergyOverride();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(mockDataService.invoke).toHaveBeenCalledWith('beginNextConsultation', expect.anything());
        expect(mockRouter.navigate).toHaveBeenCalledWith(['/visit', 2], expect.objectContaining({
            state: expect.objectContaining({ encounterId: 8 })
        }));
    });

    it('navigates back to the queue when Finish & Exit resumes after override', async () => {
        component.patientId = 1;
        component.encounterId = 7;
        component.isConsulting = true;
        component.chartWritable = true;
        component.patientSafetyContext = {
            patient_id: 1,
            active_allergies: [{ id: 1, substance: 'Penicillin', criticality: 'high', reaction: 'Anaphylaxis' }],
            has_active_allergies: true
        };
        component.currentPrescription = [{ medicine: 'Amoxicillin (Penicillin class)' }];
        component.visitForm.value.prescription = component.currentPrescription;
        component.visitForm.value.diagnosis = 'Infection';
        mockDataService.invoke.mockImplementation((method: string) => {
            if (method === 'completeConsultation') return Promise.resolve({ id: 7, status: 'finished' });
            return Promise.resolve(null);
        });

        await component.endConsult();
        expect(component.showAllergyOverrideModal).toBe(true);

        component.overrideReasonInput = 'Desensitized previously';
        component.confirmAllergyOverride();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(mockRouter.navigate).toHaveBeenCalledWith(['/queue']);
    });

    it('reports blocked queue instead of empty when next finds nothing actionable', async () => {
        component.patientId = 1;
        component.encounterId = 7;
        component.isConsulting = true;
        component.chartWritable = true;
        component.patientSafetyContext = null;
        component.currentPrescription = [];
        component.visitForm.value.prescription = [];
        component.visitForm.value.diagnosis = 'Review';
        mockDataService.invoke.mockImplementation((method: string) => {
            if (method === 'completeConsultation') return Promise.resolve({ id: 7, status: 'finished' });
            if (method === 'beginNextConsultation') return Promise.resolve(null);
            if (method === 'getQueue') return Promise.resolve([{ id: 9, patient_id: 3, status: 'waiting', active_encounter_id: 5 }]);
            return Promise.resolve(null);
        });
        const toast = { info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn() };
        (component as any).toastService = toast;

        await component.finishAndNext();

        expect(toast.info).toHaveBeenCalledWith(expect.stringContaining('still in queue'), 'Queue blocked');
        expect(mockRouter.navigate).toHaveBeenCalledWith(['/queue']);
    });

    it('clears a recorded override rationale when the prescription changes afterwards', async () => {
        component.patientId = 1;
        component.encounterId = 7;
        component.isConsulting = true;
        component.chartWritable = true;
        component.patientSafetyContext = {
            patient_id: 1,
            active_allergies: [{ id: 1, substance: 'Penicillin', criticality: 'high', reaction: 'Anaphylaxis' }],
            has_active_allergies: true
        };
        component.currentPrescription = [{ medicine: 'Amoxicillin (Penicillin class)' }];
        component.visitForm.value.prescription = component.currentPrescription;
        component.visitForm.value.diagnosis = 'Infection';
        mockDataService.invoke.mockImplementation((method: string) => {
            if (method === 'completeConsultation') return Promise.resolve({ id: 7, status: 'finished' });
            return Promise.resolve(null);
        });

        await component.completeConsult();
        expect(component.showAllergyOverrideModal).toBe(true);
        component.overrideReasonInput = 'Desensitized previously';
        component.confirmAllergyOverride();
        expect(component.visitForm.value.allergy_override_reason).toBe('Desensitized previously');

        // Unchanged lines keep the rationale.
        component.updatePrescription([{ medicine: 'Amoxicillin (Penicillin class)' }]);
        expect(component.visitForm.value.allergy_override_reason).toBe('Desensitized previously');

        // Changed lines invalidate it so the next save re-checks.
        component.updatePrescription([{ medicine: 'Azithromycin' }]);
        expect(component.visitForm.value.allergy_override_reason).toBe('');
    });

    describe('billing ledger panel', () => {
        beforeEach(() => {
            component.currentUser = { id: 99, role: 'receptionist', name: 'Desk' };
            component.editingVisitId = 7;
        });

        it('loads invoices and clinic name for billing roles', async () => {
            mockDataService.invoke.mockImplementation((method: string) => {
                if (method === 'getVisitInvoices') {
                    return Promise.resolve([{ id: 1, number: 'INV-100001', status: 'unpaid', total: 500 }]);
                }
                if (method === 'getPublicSettings') return Promise.resolve({ clinic_name: 'Fee Clinic' });
                return Promise.resolve(null);
            });
            await component.loadInvoices();
            expect(component.invoices).toHaveLength(1);
            expect(component.clinicName).toBe('Fee Clinic');
        });

        it('hides billing for nurses', async () => {
            component.currentUser = { id: 20, role: 'nurse', name: 'Nancy' };
            await component.loadInvoices();
            expect(component.invoices).toEqual([]);
            expect(mockDataService.invoke).not.toHaveBeenCalledWith('getVisitInvoices', expect.anything());
        });

        it('creates invoices from charge lines', async () => {
            component.newChargeItems = [{ description: 'X-ray', quantity: 1, rate: 350 }];
            await component.createInvoice();
            expect(mockDataService.invoke).toHaveBeenCalledWith('createInvoice', expect.objectContaining({
                visitId: 7,
                items: [{ description: 'X-ray', quantity: 1, rate: 350 }]
            }));
            expect(component.newChargeItems).toEqual([]);
            component.addChargeLine();
            expect(component.newChargeItems).toHaveLength(1);
            component.removeChargeLine(0);
            expect(component.newChargeItems).toHaveLength(0);
        });

        it('records payments with idempotency keys and opens receipts', async () => {
            mockDataService.invoke.mockImplementation((method: string) => {
                if (method === 'recordPayment') {
                    return Promise.resolve({ id: 9, receipt_no: 'RCP-100009', amount: 200 });
                }
                return Promise.resolve(null);
            });
            const invoice = { id: 3, number: 'INV-100003' };
            component.payFormFor(3).amount = 200;
            await component.recordPayment(invoice);
            const payload = mockDataService.invoke.mock.calls
                .find((call: any[]) => call[0] === 'recordPayment')[1];
            expect(payload.amount).toBe(200);
            expect(payload.clientKey).toMatch(/^[0-9a-f-]{36}$/);

            component.openReceipt(invoice, { id: 9, receipt_no: 'RCP-100009' }, true);
            expect(component.showReceipt).toBe(true);
            expect(component.receiptReprint).toBe(true);
            expect(component.isRefunding({ id: 1, payments: [{ id: 9 }] })).toBe(false);
        });

        it('drives refund and void flows with reasons', async () => {
            (component as any).dialogService = { open: vi.fn(async () => true) };
            const payment = { id: 9, amount: 200 };
            await component.refundPayment(payment);
            expect(component.refundForm.paymentId).toBe(9);
            expect(component.refundingPayment({ payments: [{ id: 9 }] }).id).toBe(9);
            expect(component.isRefunding({ payments: [{ id: 9 }] })).toBe(true);
            component.refundForm.reason = 'Duplicate charge';
            await component.refundPayment(payment);
            expect(mockDataService.invoke).toHaveBeenCalledWith('refundPayment', expect.objectContaining({
                paymentId: 9, reason: 'Duplicate charge'
            }));

            component.voidReason[3] = 'Entered by mistake';
            await component.voidInvoice({ id: 3, number: 'INV-100003' });
            expect(mockDataService.invoke).toHaveBeenCalledWith('voidInvoice', expect.objectContaining({
                invoiceId: 3, reason: 'Entered by mistake'
            }));
        });

        it('marks a visit entered-in-error with a reason instead of deleting', async () => {
            (component as any).editingVisitId = 42;
            mockDataService.invoke.mockClear();
            await component.deleteVisit();
            expect(component.showVisitErrorDialog).toBe(true);
            expect(mockDataService.invoke).not.toHaveBeenCalledWith('markVisitEnteredInError', expect.anything());

            await component.onVisitErrorDecided('wrong patient');
            expect(mockDataService.invoke).toHaveBeenCalledWith('markVisitEnteredInError', { id: 42, reason: 'wrong patient' });
        });

        it('keeps the visit untouched when the reason dialog is cancelled', async () => {
            (component as any).editingVisitId = 42;
            mockDataService.invoke.mockClear();
            await component.deleteVisit();
            expect(component.showVisitErrorDialog).toBe(true);
            await component.onVisitErrorDecided(null);
            expect(mockDataService.invoke).not.toHaveBeenCalled();
        });
    });
});

