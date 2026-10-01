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

        expect(mockDataService.invoke).toHaveBeenCalledWith('deleteVisit', 1);
        expect(mockDataService.invoke).toHaveBeenCalledWith('getVisits', 123);
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
        expect(mockDataService.invoke).toHaveBeenCalledWith('deleteAllergy', 10);
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
        expect(mockDataService.invoke).toHaveBeenCalledWith('deleteCondition', 20);
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
        expect(mockDataService.invoke).toHaveBeenCalledWith('deleteMedication', 30);
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

        // Cancelled delete does not invoke
        mockDialogService.open.mockResolvedValueOnce(false);
        await component.deletePatient();
        expect(mockDataService.invoke).not.toHaveBeenCalledWith('deletePatient', 123);

        // Confirmed delete calls deletePatient and navigates
        mockDialogService.open.mockResolvedValueOnce(true);
        await component.deletePatient();
        expect(mockDataService.invoke).toHaveBeenCalledWith('deletePatient', 123);
        expect(mockRouter.navigate).toHaveBeenCalledWith(['/patients']);
    });

    it('handles delete patient failure with error dialog', async () => {
        component.patientId = 123;
        mockDialogService.open.mockResolvedValueOnce(true);
        mockDataService.invoke.mockImplementation((endpoint: string) => {
            if (endpoint === 'deletePatient') return Promise.reject(new Error('Cannot delete'));
            return Promise.resolve(null);
        });

        await component.deletePatient();
        expect(mockDialogService.open).toHaveBeenCalledWith(expect.objectContaining({
            title: 'Error',
            message: 'Failed to delete patient.'
        }));
    });

    it('handles delete visit cancellation and failure', async () => {
        component.patientId = 123;

        // Cancelled does not delete
        mockDialogService.open.mockResolvedValueOnce(false);
        mockDataService.invoke.mockClear();
        await component.deleteVisit(1);
        expect(mockDataService.invoke).not.toHaveBeenCalledWith('deleteVisit', 1);

        // Error during delete visit
        mockDialogService.open.mockResolvedValueOnce(true);
        mockDataService.invoke.mockImplementation((endpoint: string) => {
            if (endpoint === 'deleteVisit') return Promise.reject(new Error('DB locked'));
            return Promise.resolve(null);
        });
        await component.deleteVisit(1);
        expect(mockDialogService.open).toHaveBeenCalledWith(expect.objectContaining({
            title: 'Error',
            message: 'Failed to delete visit.'
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
});

