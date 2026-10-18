import { describe, xdescribe, it, expect, vi, beforeEach } from 'vitest';
import { PatientDetailsComponent } from './patient-details.component';
import { FormBuilder } from '@angular/forms';
import { of } from 'rxjs';

// Mock Services
vi.mock('../../services/api.service');
vi.mock('../../services/auth.service');
vi.mock('../../shared/services/dialog.service');

describe('PatientDetailsComponent', () => {
    let component: PatientDetailsComponent;
    let mockDataService: any;
    let mockAuthService: any;
    let mockRouter: any;
    let mockRoute: any;
    let mockZone: any;
    let mockDialogService: any;
    let formBuilder: FormBuilder;

    beforeEach(() => {
        mockDataService = {
            invoke: vi.fn().mockImplementation((endpoint: string) => {
                if (endpoint === 'getPatientById') return Promise.resolve({ id: 123, name: 'Test Patient' });
                if (endpoint === 'getVisits') return Promise.resolve([{ id: 1, date: '2025-01-01', diagnosis: 'Test Dx' }]);
                if (endpoint === 'getVitals') return Promise.resolve({ pulse: 80 });
                if (endpoint === 'deleteVisit') return Promise.resolve(true);
                if (endpoint === 'getQueue') return Promise.resolve([{ id: 50, patient_id: 123, status: 'waiting' }]);
                if (endpoint === 'beginConsultation') return Promise.resolve({ id: 70, patient_id: 123 });
                if (endpoint === 'getDoctors') return Promise.resolve([{ id: 10, name: 'Dr. Smith' }]);
                return Promise.resolve(null);
            })
        };

        mockAuthService = {
            getUser: vi.fn().mockReturnValue({ role: 'admin' })
        };

        mockRouter = {
            navigate: vi.fn()
        };

        mockRoute = { params: of({ id: '123' }) };

        mockZone = {
            run: vi.fn((fn) => fn())
        };

        mockDialogService = {
            open: vi.fn().mockResolvedValue(true)
        };

        formBuilder = new FormBuilder();

        component = new PatientDetailsComponent(
            mockRoute,
            mockRouter,
            mockZone,
            formBuilder,
            mockDataService,
            mockAuthService,
            mockDialogService
        );
    });

    it('should create and load data', async () => {
        component.ngOnInit();
        // Wait for async loadData
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(component).toBeTruthy();
        expect(mockDataService.invoke).toHaveBeenCalledWith('getPatientById', 123);
        expect(mockDataService.invoke).toHaveBeenCalledWith('getVisits', 123);
        expect(component.patient.name).toBe('Test Patient');
        expect(component.visits.length).toBe(1);
        expect(component.showVisitModal).toBe(false);
    });

    it('should create the encounter before navigating to consult', async () => {
        component.patientId = 123;
        await component.startConsult();
        expect(mockDataService.invoke).toHaveBeenCalledWith('beginConsultation', expect.objectContaining({
            patientId: 123,
            queueEntryId: 50,
            startRequestId: expect.any(String)
        }));
        expect(mockRouter.navigate).toHaveBeenCalledWith(['/visit', 123], {
            state: { isConsulting: true, encounterId: 70 }
        });
    });

    it('adds a missing queue entry then begins consultation', async () => {
        let queued = false;
        mockDataService.invoke.mockImplementation((endpoint: string) => {
            if (endpoint === 'getQueue') {
                return Promise.resolve(queued ? [{ id: 50, patient_id: 123, status: 'waiting' }] : []);
            }
            if (endpoint === 'addToQueue') {
                queued = true;
                return Promise.resolve({ lastInsertRowid: 50 });
            }
            if (endpoint === 'beginConsultation') return Promise.resolve({ id: 70, patient_id: 123 });
            return Promise.resolve(null);
        });
        component.patientId = 123;
        await component.startConsult();
        expect(mockDataService.invoke).toHaveBeenCalledWith('addToQueue', { patientId: 123, priority: 1 });
        expect(mockDataService.invoke).toHaveBeenCalledWith('beginConsultation', expect.objectContaining({
            patientId: 123,
            queueEntryId: 50,
            startRequestId: expect.any(String)
        }));
        expect(mockRouter.navigate).toHaveBeenCalledWith(['/visit', 123], {
            state: { isConsulting: true, encounterId: 70 }
        });
    });

    it('surfaces start consultation failures in the in-app dialog instead of alert', async () => {
        mockDataService.invoke.mockImplementation((endpoint: string) => {
            if (endpoint === 'getQueue') return Promise.resolve([]);
            if (endpoint === 'addToQueue') return Promise.reject(new Error('Internal server error'));
            return Promise.resolve(null);
        });
        const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        component.patientId = 123;
        await component.startConsult();
        expect(alertSpy).not.toHaveBeenCalled();
        expect(mockDialogService.open).toHaveBeenCalledWith(expect.objectContaining({
            type: 'error',
            title: 'Error'
        }));
        expect(mockRouter.navigate).not.toHaveBeenCalled();
    });

    it('should open and close modal', () => {
        const visit = { id: 1, date: '2025-01-01' };
        component.viewVisit(visit);
        expect(component.selectedVisit).toBe(visit);
        expect(component.showVisitModal).toBe(true);

        component.closeModal();
        expect(component.showVisitModal).toBe(false);
        expect(component.selectedVisit).toBeNull();
    });

    it('should navigate to edit from modal', () => {
        component.selectedVisit = { id: 99 };
        component.editVisitFromModal();
        expect(mockRouter.navigate).toHaveBeenCalledWith(['/visit', 99]);
    });


    it('should delete visit and refresh', async () => {
        component.patientId = 123;
        await component.deleteVisit(1);

        expect(component.showReasonDialog).toBe(true);
        await component.onReasonDecided('entered wrong patient');
        expect(mockDataService.invoke).toHaveBeenCalledWith('markVisitEnteredInError', { id: 1, reason: 'entered wrong patient' });
    });
    it('should NOT show start consult for receptionist', async () => {
        mockAuthService.getUser.mockReturnValue({ role: 'receptionist' });
        // Re-init component to pick up new user
        component.ngOnInit();

        // Check currentUser
        expect(component.currentUser?.role).toBe('receptionist');
    });

    it('suppresses malformed vitals and identifies absent observations', () => {
        expect(component.hasBp(null)).toBe(false);
        expect(component.hasBp({})).toBe(false);
        expect(component.hasBp({ systolic_bp: 120 })).toBe(false);
        expect(component.hasBp({ diastolic_bp: 80 })).toBe(false);
        expect(component.hasBp({ systolic_bp: 120, diastolic_bp: 80 })).toBe(true);

        expect(component.hasVitalsToDisplay(null)).toBe(false);
        expect(component.hasVitalsToDisplay({})).toBe(false);
        expect(component.hasVitalsToDisplay({ pulse: 80 })).toBe(true);

        expect(component.isVitalPresent(null)).toBe(false);
        expect(component.isVitalPresent(undefined)).toBe(false);
        expect(component.isVitalPresent('')).toBe(false);
        expect(component.isVitalPresent(NaN)).toBe(false);
        expect(component.isVitalPresent(0)).toBe(true);
        expect(component.isVitalPresent(80)).toBe(true);
    });

    it('loads clinical safety context, allergies, conditions, and medications', async () => {
        const mockSafetyContext = {
            patient_id: 123,
            allergies: [{ id: 1, substance: 'Penicillin', criticality: 'high', status: 'active' }],
            active_allergies: [{ id: 1, substance: 'Penicillin', criticality: 'high', status: 'active' }],
            has_active_allergies: true,
            has_life_threatening_allergies: true,
            conditions: [{ id: 1, condition_name: 'Hypertension', clinical_status: 'active' }],
            active_conditions: [{ id: 1, condition_name: 'Hypertension', clinical_status: 'active' }],
            medications: [{ id: 1, medicine_name: 'Amlodipine', status: 'active' }],
            active_medications: [{ id: 1, medicine_name: 'Amlodipine', status: 'active' }]
        };
        mockDataService.invoke.mockImplementation((endpoint: string) => {
            if (endpoint === 'getPatientById') return Promise.resolve({ id: 123, name: 'Test Patient' });
            if (endpoint === 'getVisits') return Promise.resolve([]);
            if (endpoint === 'getVitals') return Promise.resolve(null);
            if (endpoint === 'getPatientSafetyContext') return Promise.resolve(mockSafetyContext);
            return Promise.resolve(null);
        });

        component.ngOnInit();
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(component.safetyContext).toEqual(mockSafetyContext);
        expect(component.allergies.length).toBe(1);
        expect(component.conditions.length).toBe(1);
        expect(component.medications.length).toBe(1);
        expect(component.safetyContext.has_active_allergies).toBe(true);
    });

    it('manages allergies lifecycle (add and delete)', async () => {
        component.patientId = 123;
        component.openAddAllergyModal();
        expect(component.showAllergyModal).toBe(true);

        component.allergyForm.patchValue({
            substance: 'Amoxicillin',
            criticality: 'high',
            severity: 'severe',
            reaction: 'Anaphylaxis'
        });

        await component.saveAllergy();
        expect(mockDataService.invoke).toHaveBeenCalledWith('saveAllergy', expect.objectContaining({
            substance: 'Amoxicillin',
            patient_id: 123
        }));
        expect(component.showAllergyModal).toBe(false);

        await component.deleteAllergy(10);
        expect(component.showReasonDialog).toBe(true);
        await component.onReasonDecided('charting error');
        expect(mockDataService.invoke).toHaveBeenCalledWith('deleteAllergy', { id: 10, reason: 'charting error' });
    });

    it('manages conditions lifecycle (add and delete)', async () => {
        component.patientId = 123;
        component.openAddConditionModal();
        expect(component.showConditionModal).toBe(true);

        component.conditionForm.patchValue({
            condition_name: 'Type 2 Diabetes',
            code: 'E11.9',
            clinical_status: 'active'
        });

        await component.saveCondition();
        expect(mockDataService.invoke).toHaveBeenCalledWith('saveCondition', expect.objectContaining({
            condition_name: 'Type 2 Diabetes',
            patient_id: 123
        }));
        expect(component.showConditionModal).toBe(false);

        await component.deleteCondition(20);
        expect(component.showReasonDialog).toBe(true);
        await component.onReasonDecided('charting error');
        expect(mockDataService.invoke).toHaveBeenCalledWith('deleteCondition', { id: 20, reason: 'charting error' });
    });

    it('manages medications lifecycle (add and delete)', async () => {
        component.patientId = 123;
        component.openAddMedicationModal();
        expect(component.showMedicationModal).toBe(true);

        component.medicationForm.patchValue({
            medicine_name: 'Metformin',
            dosage: '500mg',
            frequency: '1-0-1'
        });

        await component.saveMedication();
        expect(mockDataService.invoke).toHaveBeenCalledWith('saveMedication', expect.objectContaining({
            medicine_name: 'Metformin',
            patient_id: 123
        }));
        expect(component.showMedicationModal).toBe(false);

        await component.deleteMedication(30);
        expect(component.showReasonDialog).toBe(true);
        await component.onReasonDecided('charting error');
        expect(mockDataService.invoke).toHaveBeenCalledWith('deleteMedication', { id: 30, reason: 'charting error' });
    });

    it('provides date helper getters and field validation helper', () => {
        expect(component.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(component.minDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);

        component.patientForm.get('name')?.setValue('');
        component.patientForm.get('name')?.markAsTouched();
        expect(component.isFieldInvalid('name')).toBe(true);

        component.patientForm.get('name')?.setValue('Valid Name');
        expect(component.isFieldInvalid('name')).toBe(false);
    });

    it('auto-calculates age and dob bidirectionally', () => {
        component.patientForm.get('age')?.setValue(25);
        expect(component.patientForm.get('dob')?.value).toBeTruthy();

        component.patientForm.get('dob')?.setValue('2000-01-01');
        expect(component.patientForm.get('age')?.value).toBeGreaterThan(0);
    });

    it('manages patient edit modal and saving', async () => {
        component.patient = {
            id: 123,
            name: 'John Doe',
            mobile: '9876543210',
            age: 35,
            gender: 'male',
            address: '123 Main St'
        };

        component.openEditModal();
        expect(component.showEditModal).toBe(true);

        // Invalid form should mark touched and not save
        component.patientForm.patchValue({ name: '' });
        await component.savePatient();
        expect(mockDataService.invoke).not.toHaveBeenCalledWith('savePatient', expect.anything());

        // Valid form saves successfully
        component.patientForm.patchValue({
            name: 'John Doe Updated',
            mobile: '9876543210',
            age: 35,
            gender: 'male',
            address: '123 Main St'
        });
        await component.savePatient();
        expect(mockDataService.invoke).toHaveBeenCalledWith('savePatient', expect.objectContaining({ name: 'John Doe Updated' }));
        expect(component.showEditModal).toBe(false);
        expect(mockDialogService.open).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
    });

    it('handles save patient failure with error dialog', async () => {
        mockDataService.invoke.mockImplementation((endpoint: string) => {
            if (endpoint === 'savePatient') return Promise.reject(new Error('Update failed'));
            return Promise.resolve(null);
        });

        component.patientForm.patchValue({
            name: 'John Doe',
            mobile: '9876543210',
            age: 35,
            gender: 'male',
            address: '123 Main St'
        });

        await component.savePatient();
        expect(mockDialogService.open).toHaveBeenCalledWith(expect.objectContaining({
            title: 'Error',
            type: 'error'
        }));
    });

    it('handles delete patient flow', async () => {
        component.patientId = 123;

        // Cancelled archive does not invoke (null reason)
        await component.deletePatient();
        expect(component.showReasonDialog).toBe(true);
        await component.onReasonDecided(null);
        expect(mockDataService.invoke).not.toHaveBeenCalledWith('archivePatient', expect.anything());

        // Confirmed archive calls archivePatient
        await component.deletePatient();
        await component.onReasonDecided('duplicate chart');
        expect(mockDataService.invoke).toHaveBeenCalledWith('archivePatient', { id: 123, reason: 'duplicate chart' });
    });

    it('handles delete patient failure with error dialog', async () => {
        component.patientId = 123;
        mockDataService.invoke.mockImplementation((endpoint: string) => {
            if (endpoint === 'archivePatient') return Promise.reject(new Error('Cannot archive'));
            return Promise.resolve(null);
        });

        await component.deletePatient();
        await component.onReasonDecided('duplicate chart');
        expect(mockDialogService.open).toHaveBeenCalledWith(expect.objectContaining({
            title: 'Error'
        }));
    });

    it('restores an archived chart and surfaces failures', async () => {
        component.patientId = 123;
        mockDataService.invoke.mockImplementation((endpoint: string) => {
            if (endpoint === 'unarchivePatient') return Promise.resolve({ changes: 1 });
            return Promise.resolve(null);
        });
        await component.unarchivePatient();
        expect(mockDataService.invoke).toHaveBeenCalledWith('unarchivePatient', 123);

        mockDataService.invoke.mockImplementation((endpoint: string) => {
            if (endpoint === 'unarchivePatient') return Promise.reject(new Error('db down'));
            return Promise.resolve(null);
        });
        await component.unarchivePatient();
        expect(mockDialogService.open).toHaveBeenCalledWith(expect.objectContaining({
            title: 'Restore failed'
        }));
    });

    it('handles delete visit cancellation and failure', async () => {
        component.patientId = 123;

        // Cancelled does not mark entered-in-error
        mockDataService.invoke.mockClear();
        await component.deleteVisit(1);
        await component.onReasonDecided(null);
        expect(mockDataService.invoke).not.toHaveBeenCalledWith('markVisitEnteredInError', expect.anything());

        // Error during mark entered-in-error
        mockDataService.invoke.mockImplementation((endpoint: string) => {
            if (endpoint === 'markVisitEnteredInError') return Promise.reject(new Error('DB locked'));
            return Promise.resolve(null);
        });
        await component.deleteVisit(1);
        await component.onReasonDecided('wrong entry');
        expect(mockDialogService.open).toHaveBeenCalledWith(expect.objectContaining({
            title: 'Error'
        }));
    });

    it('handles modal navigation, print, and goBack', () => {
        component.selectedVisit = { id: 55 };
        component.showVisitModal = true;
        component.editVisitFromModal();
        expect(mockRouter.navigate).toHaveBeenCalledWith(['/visit', 55]);

        component.closeModal();
        expect(component.showVisitModal).toBe(false);
        expect(component.selectedVisit).toBeNull();

        const printSpy = vi.spyOn(window, 'print').mockImplementation(() => undefined);
        component.printVisit();
        expect(printSpy).toHaveBeenCalled();

        component.goBack();
        expect(mockRouter.navigate).toHaveBeenCalledWith(['/patients']);
    });

    it('handles clinical modals validation and error branches', async () => {
        component.patientId = 123;

        // Allergy invalid form & error handling
        component.openAddAllergyModal();
        component.allergyForm.patchValue({ substance: '' });
        await component.saveAllergy();
        expect(mockDataService.invoke).not.toHaveBeenCalledWith('saveAllergy', expect.anything());

        mockDataService.invoke.mockImplementation((endpoint: string) => {
            if (endpoint === 'saveAllergy') return Promise.reject(new Error('Allergy save failed'));
            if (endpoint === 'saveCondition') return Promise.reject(new Error('Condition save failed'));
            if (endpoint === 'saveMedication') return Promise.reject(new Error('Medication save failed'));
            return Promise.resolve(null);
        });

        component.allergyForm.patchValue({ substance: 'Aspirin' });
        await component.saveAllergy();
        expect(mockDialogService.open).toHaveBeenCalledWith(expect.objectContaining({
            message: 'Failed to save allergy record.'
        }));

        // Condition invalid form & error handling
        component.openAddConditionModal();
        component.conditionForm.patchValue({ condition_name: '' });
        await component.saveCondition();
        expect(mockDataService.invoke).not.toHaveBeenCalledWith('saveCondition', expect.anything());

        component.conditionForm.patchValue({ condition_name: 'Asthma' });
        await component.saveCondition();
        expect(mockDialogService.open).toHaveBeenCalledWith(expect.objectContaining({
            message: 'Failed to save condition record.'
        }));

        // Medication invalid form & error handling
        component.openAddMedicationModal();
        component.medicationForm.patchValue({ medicine_name: '' });
        await component.saveMedication();
        expect(mockDataService.invoke).not.toHaveBeenCalledWith('saveMedication', expect.anything());

        component.medicationForm.patchValue({ medicine_name: 'Salbutamol' });
        await component.saveMedication();
        expect(mockDialogService.open).toHaveBeenCalledWith(expect.objectContaining({
            message: 'Failed to save medication record.'
        }));
    });

    it('builds an exportable health record from the receipt state', () => {
        component.patient = { id: 1, name: 'Asha', mobile: '9876543210', age: 34, gender: 'Female' };
        component.currentUser = { id: 10, name: 'Dr. Smith', license_number: 'MED-1' };
        component.selectedVisit = {
            id: 7,
            doctor_id: 10,
            doctor_name: 'Dr. Smith',
            date: '2026-09-20T10:00:00.000Z',
            diagnosis: 'Pharyngitis',
            prescription: [{ medicine: 'Amoxicillin 500mg', dosage: '500mg', route: 'Oral', frequency: '1-0-1', duration: '3 days' }]
        };
        component.allergies = [];
        component.conditions = [];

        const { json, warnings } = component.buildHealthRecordJson();
        const bundle = JSON.parse(json);
        expect(bundle.resourceType).toBe('Bundle');
        expect(warnings).toHaveLength(0);
        const composition = bundle.entry[0].resource;
        expect(composition.title).toContain('OP Consultation');
        expect(JSON.stringify(bundle)).toContain('MED-1');
    });

    it('attributes historical visits to their frozen snapshot, not the exporter', () => {
        component.patient = { id: 1, name: 'Asha' };
        component.currentUser = { id: 99, name: 'Admin User' };
        component.selectedVisit = {
            id: 8, doctor_id: 10, doctor_name: 'Dr. Original',
            doctor_license_snapshot: JSON.stringify({ name: 'Dr. Original', license_number: 'MED-OLD', specialty: 'Cardiology' }),
            date: '2026-09-18T10:00:00.000Z', diagnosis: 'Review',
            prescription: [{ medicine: 'Cetirizine', dosage: '10mg', route: 'Oral', frequency: '1-0-0', duration: '5 days' }]
        };
        component.allergies = [];
        component.conditions = [];

        const bundle = JSON.parse(component.buildHealthRecordJson().json);
        expect(JSON.stringify(bundle)).toContain('MED-OLD');
        expect(JSON.stringify(bundle)).not.toContain('Admin User');
        const request = bundle.entry.find((e: any) => e.resource?.resourceType === 'MedicationRequest').resource;
        expect(request.requester).toMatchObject({ reference: 'Practitioner/10' });
    });

    it('defaults timestamps to the encounter date, not export time', () => {
        component.patient = { id: 1, name: 'Asha' };
        component.currentUser = { id: 10, name: 'Dr. Smith' };
        component.selectedVisit = {
            id: 9, doctor_id: 10, doctor_name: 'Dr. Smith',
            date: '2026-09-10T09:00:00.000Z', diagnosis: 'Follow-up',
            prescription: [{ medicine: 'Cetirizine', dosage: '10mg', route: 'Oral', frequency: '1-0-0', duration: '5 days' }]
        };
        component.allergies = [];
        component.conditions = [];

        const bundle = JSON.parse(component.buildHealthRecordJson().json);
        const composition = bundle.entry[0].resource;
        expect(composition.date).toBe('2026-09-10T09:00:00.000Z');
        const request = bundle.entry.find((e: any) => e.resource?.resourceType === 'MedicationRequest').resource;
        expect(request.authoredOn).toBe('2026-09-10T09:00:00.000Z');
        const encounter = bundle.entry.find((e: any) => e.resource?.resourceType === 'Encounter').resource;
        expect(encounter.period.start).toBe('2026-09-10T09:00:00.000Z');
    });

    it('uses the configured clinic identity in the export', () => {
        component.patient = { id: 1, name: 'Asha' };
        component.currentUser = { id: 10, name: 'Dr. Smith' };
        component.selectedVisit = {
            id: 9, doctor_id: 10, doctor_name: 'Dr. Smith',
            date: '2026-09-10T09:00:00.000Z', diagnosis: 'Follow-up', prescription: []
        };
        component.allergies = [];
        component.conditions = [];

        const bundle = JSON.parse(component.buildHealthRecordJson('City Care Clinic').json);
        const organization = bundle.entry.find((e: any) => e.resource?.resourceType === 'Organization').resource;
        expect(organization.name).toBe('City Care Clinic');
    });

    it('attaches registry identifiers when configured', () => {
        component.patient = { id: 1, name: 'Asha' };
        component.currentUser = { id: 10, name: 'Dr. Smith' };
        component.selectedVisit = {
            id: 9, doctor_id: 10, doctor_name: 'Dr. Smith',
            doctor_license_snapshot: JSON.stringify({ name: 'Dr. Smith', license_number: 'MED-1' }),
            date: '2026-09-10T09:00:00.000Z', diagnosis: 'Follow-up', prescription: []
        };
        component.allergies = [];
        component.conditions = [];

        const bundle = JSON.parse(
            component.buildHealthRecordJson('City Care Clinic', { hfrId: 'HFR-1', hprId: 'HPR-2' }).json);
        const organization = bundle.entry.find((e: any) => e.resource?.resourceType === 'Organization').resource;
        expect(organization.identifier).toEqual(
            expect.arrayContaining([expect.objectContaining({ value: 'HFR-1' })]));
        const practitioner = bundle.entry.find((e: any) => e.resource?.resourceType === 'Practitioner').resource;
        expect(practitioner.identifier).toEqual(
            expect.arrayContaining([expect.objectContaining({ value: 'HPR-2' })]));
    });

    it('resolves the registry ID from the visit doctor, not the deployment default', () => {
        const visit = { id: 9, doctor_id: 10 };
        const doctors = [
            { id: 10, name: 'Dr. A', abdm_hpr_id: 'HPR-A' },
            { id: 11, name: 'Dr. B', abha_hpr_id: undefined, abdm_hpr_id: 'HPR-B' }
        ];
        expect((component as any).resolveVisitHprId(visit, doctors, 'HPR-DEPLOY')).toBe('HPR-A');
    });

    it('omits the registry ID when the visit doctor cannot be resolved', () => {
        const visit = { id: 9, doctor_id: 99 };
        const doctors = [
            { id: 10, name: 'Dr. A', abdm_hpr_id: 'HPR-A' },
            { id: 11, name: 'Dr. B', abdm_hpr_id: 'HPR-B' }
        ];
        expect((component as any).resolveVisitHprId(visit, doctors, 'HPR-DEPLOY')).toBeUndefined();
    });

    it('falls back to the deployment ID only with a single doctor on file', () => {
        const visit = { id: 9, doctor_id: 10 };
        expect((component as any).resolveVisitHprId(visit, [{ id: 10, name: 'Dr. Solo' }], 'HPR-DEPLOY'))
            .toBe('HPR-DEPLOY');
        expect((component as any).resolveVisitHprId(visit, [], 'HPR-DEPLOY')).toBeUndefined();
    });

    it('never assigns the fallback to a deactivated author', () => {
        // The visit author is gone; the one remaining active doctor is
        // someone else. The deployment ID must not attach to the wrong name.
        const visit = { id: 9, doctor_id: 10 };
        expect((component as any).resolveVisitHprId(
            visit, [{ id: 11, name: 'Dr. Other', abdm_hpr_id: 'HPR-OTHER' }], 'HPR-DEPLOY'))
            .toBeUndefined();
    });

    it('hides Secure Share from roles that cannot invoke it', () => {
        component.currentUser = { id: 5, role: 'receptionist', name: 'Front Desk' };
        expect(component.canTransfer).toBe(false);
        component.currentUser = { id: 7, role: 'nurse', name: 'Nurse' };
        expect(component.canTransfer).toBe(false);
        component.currentUser = { id: 10, role: 'doctor', name: 'Dr. Smith' };
        expect(component.canTransfer).toBe(true);
        component.currentUser = { id: 99, role: 'admin', name: 'Admin' };
        expect(component.canTransfer).toBe(true);
    });

    it('identifies the exported encounter with its care context reference', () => {
        component.patient = { id: 1, name: 'Asha' };
        component.currentUser = { id: 10, name: 'Dr. Smith' };
        component.selectedVisit = {
            id: 9, doctor_id: 10, doctor_name: 'Dr. Smith', care_context_ref: 'OP-2026-0042',
            date: '2026-09-10T09:00:00.000Z', diagnosis: 'Follow-up', prescription: []
        };
        component.allergies = [];
        component.conditions = [];

        const bundle = JSON.parse(component.buildHealthRecordJson().json);
        const encounter = bundle.entry.find((e: any) => e.resource?.resourceType === 'Encounter').resource;
        expect(encounter.identifier).toEqual(
            expect.arrayContaining([expect.objectContaining({ value: 'OP-2026-0042' })]));
    });

    it('asks for a recipient key before transferring', async () => {
        component.patient = { id: 1, name: 'Asha' };
        component.currentUser = { id: 10, name: 'Dr. Smith' };
        component.selectedVisit = {
            id: 9, doctor_id: 10, doctor_name: 'Dr. Smith',
            date: '2026-09-10T09:00:00.000Z', diagnosis: 'Follow-up', prescription: []
        };
        component.allergies = [];
        component.conditions = [];
        mockDataService.invoke.mockImplementation((method: string) => {
            if (method === 'abdmGetConfig') return Promise.resolve({ has_recipient_key: false });
            return Promise.resolve(null);
        });

        await component.transferHealthRecord();

        expect(mockDialogService.open).toHaveBeenCalledWith(expect.objectContaining({
            title: 'No recipient key'
        }));
        expect(mockDataService.invoke).not.toHaveBeenCalledWith('abdmTransferBundle', expect.anything());
        expect(component.transferBusy).toBe(false);
    });

    it('transfers the receipt bundle and reports the receipt honestly', async () => {
        component.patient = { id: 1, name: 'Asha' };
        component.currentUser = { id: 10, name: 'Dr. Smith' };
        component.selectedVisit = {
            id: 9, doctor_id: 10, doctor_name: 'Dr. Smith',
            date: '2026-09-10T09:00:00.000Z', diagnosis: 'Follow-up', prescription: []
        };
        component.allergies = [];
        component.conditions = [];
        mockDataService.invoke.mockImplementation((method: string) => {
            if (method === 'abdmGetConfig') return Promise.resolve({ has_recipient_key: true });
            if (method === 'abdmTransferBundle') {
                return Promise.resolve({ status: 'mock-loopback', bytes: 128 });
            }
            return Promise.resolve(null);
        });

        await component.transferHealthRecord();

        expect(mockDataService.invoke).toHaveBeenCalledWith('abdmTransferBundle',
            expect.objectContaining({ bundle: expect.objectContaining({ resourceType: 'Bundle' }) }));
        expect(mockDialogService.open).toHaveBeenCalledWith(expect.objectContaining({
            title: 'Test transfer complete'
        }));
    });

    it('opens on the visits tab with record grids intact', () => {
        expect(component.activeTab).toBe('visits');
    });

    it('loads external consents and records on tab open', async () => {
        mockDataService.invoke.mockImplementation((method: string) => {
            if (method === 'abdmHiuGetConsents') return Promise.resolve([{ id: 1, status: 'granted' }]);
            if (method === 'abdmHiuGetExternalRecords') return Promise.resolve([{ id: 9, parsed: { title: 'X' } }]);
            return Promise.resolve(null);
        });
        component.patientId = 123;
        await component.openExternalTab();
        expect(component.activeTab).toBe('external');
        expect(component.externalConsents).toHaveLength(1);
        expect(component.externalRecords).toHaveLength(1);
        expect(component.loadingExternal).toBe(false);
    });

    it('requests outside records with validation', async () => {
        component.patientId = 123;
        await component.requestExternalConsent();
        expect(component.consentError).toContain('health ID');

        component.consentForm = { abhaAddress: 'asha@sbx', hiTypes: [], dateFrom: '', dateTo: '' };
        await component.requestExternalConsent();
        expect(component.consentError).toContain('record type');

        component.consentForm = { abhaAddress: 'asha@sbx', hiTypes: ['Prescription'], dateFrom: '', dateTo: '' };
        mockDataService.invoke.mockImplementation((method: string) => {
            if (method === 'abdmHiuRequestConsent') return Promise.resolve({ id: 4, status: 'requested' });
            if (method === 'abdmHiuGetConsents') return Promise.resolve([]);
            if (method === 'abdmHiuGetExternalRecords') return Promise.resolve([]);
            return Promise.resolve(null);
        });
        await component.requestExternalConsent();
        expect(mockDataService.invoke).toHaveBeenCalledWith('abdmHiuRequestConsent', expect.objectContaining({
            patientId: 123, abhaAddress: 'asha@sbx', hiTypes: ['Prescription']
        }));
        expect(component.showConsentForm).toBe(false);
    });

    it('fetches granted consents and clears the cache on confirm', async () => {
        component.patientId = 123;
        mockDataService.invoke.mockResolvedValue([]);
        await component.fetchExternal(2);
        expect(mockDataService.invoke).toHaveBeenCalledWith('abdmHiuFetchRecords', { consentId: 2 });

        await component.clearExternalCache();
        expect(mockDataService.invoke).toHaveBeenCalledWith('abdmHiuClearExternalRecords', { patientId: 123 });
    });

    it('imports outside meds through the allergy gate with override', async () => {
        component.patientId = 123;
        mockDataService.invoke.mockImplementation((method: string, input: any) => {
            if (method === 'abdmHiuImportMedication' && !input.overrideReason) {
                return Promise.reject(new Error(`Cannot import 'Penicillin-V': conflicting with active allergy 'Penicillin'. An explicit override reason is required.`));
            }
            if (method === 'abdmHiuImportMedication') return Promise.resolve({ id: 31 });
            if (method === 'getPatientById') return Promise.resolve({ id: 123 });
            if (method === 'getVisits') return Promise.resolve([]);
            if (method === 'getVitals') return Promise.resolve(null);
            if (method === 'getPatientSafetyContext') return Promise.resolve(null);
            return Promise.resolve(null);
        });
        await component.importExternalMed(9, { name: 'Penicillin-V', dosage: '250mg', frequency: '1-1-1' });
        expect(mockDialogService.open).toHaveBeenCalledWith(expect.objectContaining({ title: 'Allergy conflict' }));
        expect(mockDataService.invoke).toHaveBeenCalledWith('abdmHiuImportMedication', expect.objectContaining({
            patientId: 123, medicine_name: 'Penicillin-V', overrideReason: expect.stringContaining('override')
        }));
    });

    it('derives chart age from DOB and shows the MRN', () => {
        component.patient = { id: 1, name: 'Asha', dob: '1990-05-01', dob_estimated: 0, age: 99, gender: 'Female', mrn: 'ND-100001' } as any;
        expect(component.displayAge).toMatch(/^\d+$/);
        expect(component.displayAge).not.toBe('99');
        component.patient = { id: 1, name: 'Asha', dob: '1990-05-01', dob_estimated: 1, age: 99, gender: 'Female' } as any;
        expect(component.displayAge.startsWith('≈')).toBe(true);
        component.patient = null;
        expect(component.displayAge).toBe('—');
    });

    it('walks the merge flow from search to confirm', async () => {
        component.patient = { id: 1, name: 'Asha', mrn: 'ND-100001' } as any;
        component.openMergeModal();
        expect(component.showMergeModal).toBe(true);
        expect(component.mergeSurvivorId).toBe(1);

        mockDataService.invoke.mockImplementation((endpoint: string) => {
            if (endpoint === 'findDuplicateCandidates') {
                return Promise.resolve([{ patient: { id: 2, name: 'Asha S', mrn: 'ND-100002' }, signals: ['name'], score: 30 }]);
            }
            if (endpoint === 'previewPatientMerge') {
                return Promise.resolve({
                    survivor: { id: 1, name: 'Asha' },
                    duplicate: { id: 2, name: 'Asha S' },
                    counts: { visits: 2, vitals: 1 }, warnings: []
                });
            }
            return Promise.resolve(null);
        });
        component.mergeQuery = 'Asha';
        await component.searchMergeCandidates();
        expect(component.mergeCandidates).toHaveLength(1);

        await component.selectMergeCandidate({ id: 2, name: 'Asha S' });
        expect(component.mergePreview.duplicate.id).toBe(2);
        expect(component.mergeMoveTotal).toBe(3);
        expect(component.mergeMoveSummary).toContain('2 visits');

        component.mergeReason = 'Same person';
        await component.confirmMerge();
        expect(mockDataService.invoke).toHaveBeenCalledWith('mergePatients', expect.objectContaining({
            survivorId: 1, duplicateId: 2, reason: 'Same person'
        }));
        expect(component.showMergeModal).toBe(false);
    });

    it('unmerges an absorbed chart after confirm', async () => {
        component.patient = { id: 2, name: 'Asha S', merged_into: 1 } as any;
        await component.unmergeChart();
        expect(mockDataService.invoke).toHaveBeenCalledWith('unmergePatients', 2);

        mockDialogService.open.mockResolvedValueOnce(false);
        mockDataService.invoke.mockClear();
        await component.unmergeChart();
        expect(mockDataService.invoke).not.toHaveBeenCalledWith('unmergePatients', expect.anything());
    });

    it('covers merge modal branches and failure paths', async () => {
        component.patient = { id: 1, name: 'Asha', mrn: 'ND-100001' } as any;
        component.openMergeModal();
        expect(component.mergeSurvivorId).toBe(1);

        component.mergeQuery = 'x';
        await component.searchMergeCandidates();
        expect(component.mergeCandidates).toEqual([]);

        mockDataService.invoke.mockRejectedValueOnce(new Error('ipc down'));
        component.mergeQuery = 'Asha';
        await component.searchMergeCandidates();
        expect(component.mergeCandidates).toEqual([]);

        await component.selectMergeCandidate(null as any);
        expect(component.mergePreview).toBeNull();
        await component.pickSurvivor(null);
        expect(component.mergeSurvivorId).toBe(1);

        component.goToPatient(2);
        expect(mockRouter.navigate).toHaveBeenCalledWith(['/patients', 2]);

        mockDataService.invoke.mockImplementation((endpoint: string) => {
            if (endpoint === 'previewPatientMerge') return Promise.reject(new Error('refused'));
            return Promise.resolve(null);
        });
        await component.loadMergePreview(2);
        expect(component.mergePreview).toBeNull();
        expect(component.mergePreviewError).toContain('refused');

        expect(component.mergeMoveTotal).toBe(0);
        expect(component.mergeMoveSummary).toBe('no linked records');

        component.mergePreview = { survivor: { id: 1 }, duplicate: { id: 2 }, counts: {}, warnings: [] };
        component.mergeSurvivorId = 1;
        component.mergeReason = '';
        await component.confirmMerge();
        expect(mockDataService.invoke).not.toHaveBeenCalledWith('mergePatients', expect.anything());

        component.mergeReason = 'Dup';
        mockDialogService.open.mockResolvedValueOnce(false);
        await component.confirmMerge();
        expect(mockDataService.invoke).not.toHaveBeenCalledWith('mergePatients', expect.anything());

        mockDataService.invoke.mockImplementation((endpoint: string) => {
            if (endpoint === 'mergePatients') return Promise.reject(new Error('active encounter'));
            return Promise.resolve(null);
        });
        mockDialogService.open.mockResolvedValueOnce(true);
        await component.confirmMerge();
        expect(component.mergePreviewError).toContain('active encounter');

        mockDataService.invoke.mockRejectedValueOnce(new Error('gone'));
        component.patient = { id: 2, merged_into: 1 } as any;
        mockDialogService.open.mockResolvedValueOnce(true);
        await component.unmergeChart();
        expect(mockDialogService.open).toHaveBeenCalledWith(expect.objectContaining({ title: 'Unmerge failed' }));
    });

    it('loads chart identifiers with patient data', async () => {
        const rows = [{ id: 1, system: 'mrn', value: 'ND-100001', is_primary: 1 }];
        mockDataService.invoke.mockImplementation((endpoint: string) => {
            if (endpoint === 'getPatientById') return Promise.resolve({ id: 123, name: 'Test Patient' });
            if (endpoint === 'getIdentifiers') return Promise.resolve(rows);
            return Promise.resolve(null);
        });
        component.patientId = 123;
        await component.loadData();
        expect(component.identifiers).toEqual(rows);
    });

    it('adds an identifier after inline validation and reloads', async () => {
        component.patientId = 123;
        component.identifierForm = { system: 'abha-number', value: '79927398713891', isPrimary: false };
        await component.addIdentifier();
        expect(mockDataService.invoke).toHaveBeenCalledWith('saveIdentifier', {
            patientId: 123, system: 'abha-number', value: '79927398713891', isPrimary: false
        });
        expect(component.identifierForm.value).toBe('');
        expect(component.identifierError).toBe('');
    });

    it('rejects malformed identifiers inline without invoking', async () => {
        component.patientId = 123;
        mockDataService.invoke.mockClear();
        component.identifierForm = { system: 'abha-number', value: '123', isPrimary: false };
        await component.addIdentifier();
        expect(component.identifierError).toContain('14 digits');
        expect(mockDataService.invoke).not.toHaveBeenCalledWith('saveIdentifier', expect.anything());
    });

    it('surfaces backend identifier failures inline', async () => {
        component.patientId = 123;
        mockDataService.invoke.mockImplementation((endpoint: string) => {
            if (endpoint === 'saveIdentifier') return Promise.reject(new Error('another chart'));
            return Promise.resolve(null);
        });
        component.identifierForm = { system: 'mrn', value: 'ND-100008', isPrimary: false };
        await component.addIdentifier();
        expect(component.identifierError).toContain('another chart');
    });

    it('removes identifiers and surfaces failures inline', async () => {
        component.patientId = 123;
        mockDataService.invoke.mockImplementation((endpoint: string) => {
            if (endpoint === 'deleteIdentifier') return Promise.resolve({ deleted: true });
            if (endpoint === 'getIdentifiers') return Promise.resolve([]);
            return Promise.resolve(null);
        });
        await component.removeIdentifier(11);
        expect(mockDataService.invoke).toHaveBeenCalledWith('deleteIdentifier', 11);
        expect(component.identifierError).toBe('');

        mockDataService.invoke.mockImplementation((endpoint: string) => {
            if (endpoint === 'deleteIdentifier') return Promise.reject(new Error('chart identity'));
            return Promise.resolve(null);
        });
        await component.removeIdentifier(12);
        expect(component.identifierError).toContain('chart identity');
    });

    it('gates identifier curation to desk roles', () => {
        mockAuthService.getUser.mockReturnValue({ role: 'nurse' });
        component.ngOnInit();
        expect(component.canCurateIdentifiers).toBe(false);
        mockAuthService.getUser.mockReturnValue({ role: 'receptionist' });
        component.ngOnInit();
        expect(component.canCurateIdentifiers).toBe(true);
    });

    describe('extended chart coverage', () => {
        const seedVisit = () => {
            component.selectedVisit = {
                id: 9,
                date: '2026-02-02',
                diagnosis: 'Flu',
                diagnosis_type: 'Final',
                prescription: [{ medicine: 'Paracetamol', dosage: '500mg' }]
            };
            component.patient = { id: 123, name: 'Test Patient', age: 30, gender: 'Male' } as any;
            component.allergies = [];
            component.conditions = [];
        };

        it('renders visit, allergy, and medication grid cells', () => {
            const visitCols = (component as any).visitColumnDefs as any[];
            const diagnosis = visitCols.find((c: any) => c.headerName === 'Diagnosis');
            expect(diagnosis.cellRenderer({ data: null })).toBe('');
            const html = diagnosis.cellRenderer({ data: { diagnosis: 'Flu <b>', diagnosis_type: 'Final' } });
            expect(html).toContain('Flu &lt;b&gt;');
            expect(html).toContain('Final');
            expect(diagnosis.cellRenderer({ data: { diagnosis: '' } })).toContain('No Diagnosis');
            const rx = visitCols.find((c: any) => c.headerName === 'Rx Items');
            expect(rx.valueGetter({ data: { prescription: [1, 2] } })).toBe(2);
            expect(rx.valueGetter({ data: {} })).toBe(0);
            expect(rx.cellRenderer({ value: 3 })).toContain('3 items');
        });

        it('renders allergy severity and status chips', () => {
            const cols = (component as any).allergyColumnDefs as any[];
            const sev = cols.find((c: any) => c.headerName === 'Severity & Reaction');
            expect(sev.valueGetter({ data: { severity: 'high', reaction: 'rash' } })).toBe('high rash');
            expect(sev.valueGetter({ data: {} })).toBe('-');
            expect(sev.cellRenderer({ data: null })).toBe('');
            expect(sev.cellRenderer({ data: { severity: 'high', reaction: 'rash' } })).toContain('rash');
            const status = cols.find((c: any) => c.headerName === 'Status');
            expect(status.cellRenderer({ value: 'active' })).toContain('ACTIVE');
            expect(status.cellRenderer({ value: 'resolved' })).toContain('RESOLVED');
        });

        it('renders medication cells and the duration column', () => {
            const cols = (component as any).medicationColumnDefs as any[];
            const med = cols.find((c: any) => c.headerName === 'Medication');
            expect(med.cellRenderer({ data: null })).toBe('');
            expect(med.cellRenderer({ data: { medicine_name: 'A <b>', notes: 'night' } })).toContain('A &lt;b&gt;');
            const dose = cols.find((c: any) => c.headerName === 'Dosage & Frequency');
            expect(dose.valueGetter({ data: { dosage: '10mg', frequency: 'OD' } })).toBe('10mg (OD)');
            expect(dose.valueGetter({ data: {} })).toBe('- ');
            expect(dose.cellRenderer({ data: null })).toBe('');
            const duration = cols.find((c: any) => c.headerName === 'Duration');
            expect(duration.valueGetter({ data: { start_date: '2026-01-01', end_date: '2026-01-05' } }))
                .toBe('2026-01-01 to 2026-01-05');
            expect(duration.cellRenderer({ value: 'x' })).toContain('x');
        });

        it('escapes html, formats dates, and gates safety mutations', () => {
            expect((component as any).escHtml('<a>&"\'')).toBe('&lt;a&gt;&amp;&quot;&#39;');
            expect((component as any).escHtml(null)).toBe('');
            expect((component as any).fmtDate(null)).toBe('-');
            expect((component as any).fmtDate('2026-01-02T00:00:00.000Z')).toMatch(/\d{4}|\d+\/\d+/);
            expect((component as any).statusChip('active', true, 'bg-x')).toContain('ACTIVE');

            mockAuthService.getUser.mockReturnValue({ role: 'nurse' });
            component.currentUser = { role: 'nurse' };
            expect((component as any).denySafetyMutation()).toBe(true);
            expect(mockDialogService.open).toHaveBeenCalledWith(expect.objectContaining({ title: 'Not permitted' }));
            component.currentUser = { role: 'admin' };
            expect((component as any).denySafetyMutation()).toBe(false);
            expect((component as any).deleteActionHtml()).toContain('data-action="delete"');
        });

        it('toggles consent types and validates consent requests', async () => {
            component.toggleHiType('XRay');
            expect(component.consentForm.hiTypes).toContain('XRay');
            component.toggleHiType('XRay');
            expect(component.consentForm.hiTypes).not.toContain('XRay');

            component.patient = null;
            component.consentForm = { abhaAddress: '', hiTypes: ['Prescription'], dateFrom: '', dateTo: '' } as any;
            await component.requestExternalConsent();
            expect(component.consentError).toContain('health ID');

            component.patient = { abha_address: 'x@sbx' } as any;
            component.consentForm.hiTypes = [];
            await component.requestExternalConsent();
            expect(component.consentError).toContain('at least one');
        });

        it('sends consent requests and reports failures', async () => {
            component.patient = { id: 123, abha_address: 'x@sbx' } as any;
            component.consentForm = { abhaAddress: '', hiTypes: ['Prescription'], dateFrom: '', dateTo: '' } as any;
            mockDataService.invoke.mockImplementation((endpoint: string) => {
                if (endpoint === 'abdmHiuGetConsents') return Promise.resolve([]);
                if (endpoint === 'abdmHiuGetExternalRecords') return Promise.resolve([]);
                return Promise.resolve(null);
            });
            await component.requestExternalConsent();
            expect(component.showConsentForm).toBe(false);

            mockDataService.invoke.mockRejectedValueOnce(new Error('gateway down'));
            await component.requestExternalConsent();
            expect(component.consentError).toBe('gateway down');
        });

        it('classifies consent chips and parses consent types', () => {
            expect(component.consentChipClass('GRANTED')).toContain('green');
            expect(component.consentChipClass('denied')).toContain('red');
            expect(component.consentChipClass('expired')).toContain('gray');
            expect(component.consentChipClass('pending')).toContain('amber');
            expect(component.consentTypesText({ hi_types: '["A","B"]' })).toBe('A, B');
            expect(component.consentTypesText({ hi_types: ['A'] })).toBe('A');
            expect(component.consentTypesText({ hi_types: '[broken' })).toBe('');
            expect(component.consentTypesText(null)).toBe('');
        });

        it('imports outside meds with override confirm and cancel', async () => {
            const attempt = (reason?: string) => {
                if (reason) return Promise.resolve({ id: 1 });
                return Promise.reject(new Error('conflicting allergy: penicillin'));
            };
            mockDataService.invoke.mockImplementation((endpoint: string, input: any) =>
                endpoint === 'abdmHiuImportMedication'
                    ? attempt(input?.overrideReason)
                    : Promise.resolve(null));
            await component.importExternalMed(11, { name: 'Amoxicillin' });
            expect(mockDialogService.open).toHaveBeenCalledWith(expect.objectContaining({ title: 'Allergy conflict' }));

            mockDialogService.open.mockResolvedValueOnce(false);
            await component.importExternalMed(11, { name: '  ' });
            await component.importExternalMed(12, { name: 'Cetirizine' });
        });

        it('exports with warnings and downloads the bundle', async () => {
            component.selectedVisit = {
                id: 9,
                date: '2026-02-02',
                diagnosis: 'Flu',
                prescription: [{ medicine: 'X', frequency: 'every full moon' }]
            };
            component.patient = { id: 123, name: 'Test Patient' } as any;
            component.allergies = [];
            component.conditions = [];
            const createObjectURL = vi.fn(() => 'blob:mock');
            const revokeObjectURL = vi.fn();
            const originalCreate = (URL as any).createObjectURL;
            const originalRevoke = (URL as any).revokeObjectURL;
            (URL as any).createObjectURL = createObjectURL;
            (URL as any).revokeObjectURL = revokeObjectURL;
            const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
            try {
                await component.exportHealthRecord();
                expect(mockDialogService.open).toHaveBeenCalledWith(expect.objectContaining({ title: 'Exported with notes' }));
                expect(createObjectURL).toHaveBeenCalled();
            } finally {
                click.mockRestore();
                (URL as any).createObjectURL = originalCreate;
                (URL as any).revokeObjectURL = originalRevoke;
            }
            component.selectedVisit = null;
            await component.exportHealthRecord();
        });

        it('transfers with recipient checks, receipts, and failures', async () => {
            component.selectedVisit = { id: 9, date: '2026-02-02', prescription: [] };
            component.patient = { id: 123, name: 'Test Patient' } as any;
            component.allergies = [];
            component.conditions = [];
            mockDataService.invoke.mockImplementation((endpoint: string) => {
                if (endpoint === 'abdmGetConfig') return Promise.resolve({ has_recipient_key: false });
                return Promise.resolve(null);
            });
            await component.transferHealthRecord();
            expect(mockDialogService.open).toHaveBeenCalledWith(expect.objectContaining({ title: 'No recipient key' }));

            component.selectedVisit.prescription = [{ medicine: 'X', frequency: 'every full moon' }];
            mockDataService.invoke.mockImplementation((endpoint: string) => {
                if (endpoint === 'abdmGetConfig') return Promise.resolve({ has_recipient_key: true });
                if (endpoint === 'getDoctors') return Promise.resolve([]);
                if (endpoint === 'abdmTransferBundle') return Promise.resolve({ status: 'delivered', bytes: 10 });
                return Promise.resolve(null);
            });
            await component.transferHealthRecord();
            expect(mockDialogService.open).toHaveBeenCalledWith(expect.objectContaining({ title: 'Record sent' }));
            expect(component.transferBusy).toBe(false);

            mockDataService.invoke.mockImplementation((endpoint: string) => {
                if (endpoint === 'abdmTransferBundle') return Promise.reject(new Error('nope'));
                if (endpoint === 'abdmGetConfig') return Promise.resolve({ has_recipient_key: true });
                if (endpoint === 'getDoctors') return Promise.resolve([]);
                return Promise.resolve(null);
            });
            component.transferBusy = false;
            await component.transferHealthRecord();
            expect(mockDialogService.open).toHaveBeenCalledWith(expect.objectContaining({ title: 'Transfer failed' }));

            component.selectedVisit = null;
            await component.transferHealthRecord();
            component.transferBusy = true;
            component.selectedVisit = { id: 1 };
            await component.transferHealthRecord();
            component.transferBusy = false;
        });

        it('routes reason-dialog decisions to every mutation kind', async () => {
            mockDataService.invoke.mockImplementation(() => Promise.resolve(null));
            for (const kind of ['archive-patient', 'visit', 'allergy', 'condition', 'medication']) {
                (component as any).pendingReasonAction = { kind, id: 5 };
                component.showReasonDialog = true;
                await component.onReasonDecided('duplicate entry');
                expect(component.showReasonDialog).toBe(false);
            }
            expect(mockDataService.invoke).toHaveBeenCalledWith('archivePatient', { id: 5, reason: 'duplicate entry' });
            expect(mockDataService.invoke).toHaveBeenCalledWith('markVisitEnteredInError', { id: 5, reason: 'duplicate entry' });
            expect(mockDataService.invoke).toHaveBeenCalledWith('deleteAllergy', { id: 5, reason: 'duplicate entry' });
            expect(mockDataService.invoke).toHaveBeenCalledWith('deleteCondition', { id: 5, reason: 'duplicate entry' });
            expect(mockDataService.invoke).toHaveBeenCalledWith('deleteMedication', { id: 5, reason: 'duplicate entry' });

            await component.onReasonDecided(null);
            (component as any).pendingReasonAction = { kind: 'visit', id: 6 };
            mockDataService.invoke.mockRejectedValueOnce(new Error('locked'));
            await component.onReasonDecided('x');
            expect(mockDialogService.open).toHaveBeenCalledWith(expect.objectContaining({ title: 'Error' }));
        });

        it('restores archived charts and reports failures', async () => {
            mockDataService.invoke.mockImplementation(() => Promise.resolve(null));
            await component.unarchivePatient();
            expect(mockDataService.invoke).toHaveBeenCalledWith('unarchivePatient', component.patientId);

            mockDataService.invoke.mockRejectedValueOnce(new Error('gone'));
            await component.unarchivePatient();
            expect(mockDialogService.open).toHaveBeenCalledWith(expect.objectContaining({ title: 'Restore failed' }));
        });

        it('navigates to patients and shows derived age', () => {
            component.goBack();
            expect(mockRouter.navigate).toHaveBeenCalledWith(['/patients']);
            component.goToPatient(42);
            expect(mockRouter.navigate).toHaveBeenCalledWith(['/patients', 42]);
            component.patient = null;
            expect(component.displayAge).toBe('—');
            component.patient = { dob: null, dob_estimated: 0, age: 41 } as any;
            expect(component.displayAge).toContain('41');
        });

        it('starts consults as admin with the first doctor on file and a recorded reason', async () => {
            component.currentUser = { role: 'admin' };
            component.patientId = 123;
            await component.startConsult();
            expect(mockDataService.invoke).toHaveBeenCalledWith('beginConsultation', expect.objectContaining({ doctorId: 10, attributionReason: expect.any(String) }));
            expect(mockRouter.navigate).toHaveBeenCalledWith(['/visit', 123], expect.objectContaining({ state: expect.objectContaining({ encounterId: 70 }) }));
        });

        it('loads the patient appointments into upcoming and history', async () => {
            mockDataService.invoke.mockImplementation((endpoint: string) => {
                if (endpoint === 'getAppointmentsByPatient') return Promise.resolve([
                    { id: 1, date: '2026-10-07', time: '09:00', status: 'booked', reason: 'Review' },
                    { id: 2, date: '2026-09-01', time: '09:00', status: 'fulfilled', reason: 'Done' },
                    { id: 3, date: '2026-10-05', time: '10:00', status: 'confirmed', reason: 'Follow-up' },
                    { id: 4, date: '2026-08-01', time: '09:00', status: 'cancelled', reason: 'Moved' }
                ]);
                if (endpoint === 'getVisits') return Promise.resolve([]);
                if (endpoint === 'getPatientById') return Promise.resolve({ id: 123 });
                return Promise.resolve(null);
            });
            component.patientId = 123;
            await component.loadData();
            expect(mockDataService.invoke).toHaveBeenCalledWith('getAppointmentsByPatient', 123);
            expect(component.upcomingAppointments.map((a: any) => a.id)).toEqual([3, 1]);
            expect(component.pastAppointments.map((a: any) => a.id)).toEqual([2, 4]);
        });

        it('hides appointments the viewer may not see', async () => {
            mockDataService.invoke.mockImplementation((endpoint: string) => {
                if (endpoint === 'getAppointmentsByPatient') return Promise.reject(new Error('Forbidden'));
                if (endpoint === 'getPatientSafetyContext') return Promise.reject(new Error('Forbidden'));
                return Promise.resolve(null);
            });
            component.patientId = 123;
            await component.loadData();
            expect(component.appointments).toEqual([]);
            expect(component.safetyContext).toBeNull();
        });

        it('renders substance, criticality, condition, and ICD cells', () => {
            const allergy = (component as any).allergyColumnDefs as any[];
            const substance = allergy.find((c: any) => c.headerName === 'Substance');
            expect(substance.cellRenderer({ data: null })).toBe('');
            expect(substance.cellRenderer({ data: { substance: 'Pen <b>' } })).toContain('Pen &lt;b&gt;');
            const crit = allergy.find((c: any) => c.headerName === 'Criticality');
            expect(crit.cellRenderer({ value: 'high' })).toContain('bg-red-100');
            expect(crit.cellRenderer({ value: 'low' })).toContain('bg-amber-100');
            expect(crit.cellRenderer({ value: 'medium' })).toContain('bg-gray-100');

            const cond = (component as any).conditionColumnDefs as any[];
            const problem = cond.find((c: any) => c.headerName === 'Problem / Condition');
            expect(problem.cellRenderer({ data: null })).toBe('');
            expect(problem.cellRenderer({ data: { condition_name: 'Asthma', notes: 'mild' } })).toContain('mild');
            const icd = cond.find((c: any) => c.headerName === 'ICD-10 Code');
            expect(icd.cellRenderer({ value: 'J45' })).toContain('J45');
            expect(icd.cellRenderer({ value: '' })).toContain('-');
            const onset = cond.find((c: any) => c.headerName === 'Onset Date');
            expect(onset.valueFormatter({ value: null })).toBe('-');
            expect(onset.cellRenderer({ value: null })).toContain('-');
        });

        it('routes grid action clicks with the safety gate', async () => {
            const visitActions = (component as any).visitColumnDefs.find((c: any) => c.headerName === 'Actions');
            expect(visitActions.cellRenderer()).toContain('data-action="view"');
            const view = { id: 5 };
            visitActions.onCellClicked({ event: { target: { closest: () => ({ getAttribute: () => 'view' }) } }, data: view });
            expect(component.selectedVisit).toEqual(view);

            component.currentUser = { role: 'nurse' };
            const del = { event: { target: { closest: () => ({ getAttribute: () => 'delete' }) } }, data: { id: 9 } };
            const medActions = (component as any).medicationColumnDefs.find((c: any) => c.headerName === 'Actions');
            medActions.onCellClicked(del);
            expect(mockDialogService.open).toHaveBeenCalledWith(expect.objectContaining({ title: 'Not permitted' }));

            component.currentUser = { role: 'doctor' };
            mockDataService.invoke.mockImplementation(() => Promise.resolve(null));
            (component as any).pendingReasonAction = null;
            const condActions = (component as any).conditionColumnDefs.find((c: any) => c.headerName === 'Actions');
            condActions.onCellClicked({ event: del.event, data: { id: 8 } });
            expect((component as any).pendingReasonAction).toEqual({ kind: 'condition', id: 8 });
        });

        it('links ABDM identities and guards survivor picks', async () => {
            component.patient = { id: 1 } as any;
            component.onAbhaLinked({ abhaAddress: 'x@sbx', abhaName: 'X' });
            expect(component.patient.abha_address).toBe('x@sbx');
            component.patient = null;
            component.onAbhaLinked({ abhaAddress: 'x@sbx', abhaName: 'X' });

            component.mergePreview = null;
            await component.pickSurvivor(null);
            await component.pickSurvivor(2);
            expect(component.mergeSurvivorId).toBeNull();
        });

        it('clears the external cache with confirm and cancel', async () => {
            mockDataService.invoke.mockImplementation((endpoint: string) => {
                if (endpoint === 'abdmHiuGetConsents') return Promise.resolve([]);
                if (endpoint === 'abdmHiuGetExternalRecords') return Promise.resolve([]);
                return Promise.resolve(null);
            });
            await component.clearExternalCache();
            expect(mockDataService.invoke).toHaveBeenCalledWith('abdmHiuClearExternalRecords', { patientId: component.patientId });

            mockDialogService.open.mockResolvedValueOnce(false);
            await component.clearExternalCache();
        });

        it('fails external loads and fetches loudly', async () => {
            component.patientId = 0 as any;
            await component.loadExternal();
            component.patientId = 123;
            mockDataService.invoke.mockImplementation(() => { throw new Error('gateway down'); });
            await component.loadExternal();
            expect(component.externalError).toBe('gateway down');

            mockDataService.invoke.mockImplementation(() => Promise.reject(new Error('fetch down')));
            await component.fetchExternal(9);
            expect(component.externalError).toBe('fetch down');
        });

        it('reports non-conflicting import failures', async () => {
            mockDataService.invoke.mockImplementation((endpoint: string) =>
                endpoint === 'abdmHiuImportMedication'
                    ? Promise.reject(new Error('store full'))
                    : Promise.resolve(null));
            await component.importExternalMed(11, { name: 'Aspirin' });
            expect(mockDialogService.open).toHaveBeenCalledWith(expect.objectContaining({ title: 'Import failed' }));
        });

        it('skips the download block without object URLs', async () => {
            component.selectedVisit = { id: 9, date: '2026-02-02', prescription: [] };
            component.patient = { id: 123, name: 'Test Patient' } as any;
            component.allergies = [];
            component.conditions = [];
            const original = (URL as any).createObjectURL;
            (URL as any).createObjectURL = undefined;
            try {
                await component.exportHealthRecord();
                expect(mockDialogService.open).not.toHaveBeenCalledWith(
                    expect.objectContaining({ title: 'Exported with notes' }));
            } finally {
                (URL as any).createObjectURL = original;
            }
        });
    });
});

