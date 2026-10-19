import { ComponentFixture, TestBed } from '@angular/core/testing';
import { OnlineBookingComponent } from './online-booking.component';
import { CloudService } from '../services/cloud.service';
import { PatientService } from '../services/patient.service';
import { DialogService } from '../shared/services/dialog.service';
import { of } from 'rxjs';

describe('OnlineBookingComponent', () => {
    let component: OnlineBookingComponent;
    let fixture: ComponentFixture<OnlineBookingComponent>;
    let mockCloudService: any;
    let mockPatientService: any;

    beforeEach(() => {
        mockCloudService = {
            getPublishedSlots: vi.fn().mockReturnValue(Promise.resolve([])),
            publishSlots: vi.fn().mockReturnValue(Promise.resolve()),
            syncNow: vi.fn().mockReturnValue(Promise.resolve()),
            getAppointmentRequests: vi.fn().mockReturnValue(Promise.resolve([
                { id: 1, patient_name: 'John', status: 'pending', date: '2025-01-01', time: '10:00' }
            ])),
            decide: vi.fn().mockReturnValue(Promise.resolve({ success: true })),
            saveAppointment: vi.fn().mockReturnValue(Promise.resolve())
        };

        mockPatientService = {
            getPatients: vi.fn().mockReturnValue(Promise.resolve([])),
            savePatient: vi.fn().mockReturnValue(Promise.resolve({ lastInsertRowid: 100 }))
        };

        TestBed.configureTestingModule({
            imports: [OnlineBookingComponent],
            providers: [
                { provide: CloudService, useValue: mockCloudService },
                { provide: PatientService, useValue: mockPatientService }
            ]
        });

        fixture = TestBed.createComponent(OnlineBookingComponent);
        component = fixture.componentInstance;
        fixture.detectChanges();
    });

    it('should create and load requests', async () => {
        await fixture.whenStable();
        expect(component).toBeTruthy();
        expect(mockCloudService.getAppointmentRequests).toHaveBeenCalled();
        expect(component.requests.length).toBe(1);
    });

    it('should toggle time slots', () => {
        const time = '10:00';
        component.toggleTime(time);
        expect(component.selectedSlots.has(time)).toBe(true);
        component.toggleTime(time);
        expect(component.selectedSlots.has(time)).toBe(false);
    });

    // ...

    it('should accept request and create appointment', async () => {
        const dialogService = TestBed.inject(DialogService);
        vi.spyOn(dialogService, 'open').mockResolvedValue(true);
        // Ensure request exists
        component.requests = [{ id: 1, patient_name: 'John', status: 'pending', date: '2025-01-01', time: '10:00' }];
        const req = component.requests[0];

        await component.accept(req);

        expect(mockPatientService.savePatient).toHaveBeenCalled(); // New patient created
        expect(mockCloudService.saveAppointment).toHaveBeenCalledWith(expect.objectContaining({
            patient_id: 100,
            date: '2025-01-01'
        }));
        expect(mockCloudService.decide).toHaveBeenCalledWith(1, 'accepted');
        expect(mockCloudService.decide.mock.invocationCallOrder[0])
            .toBeLessThan(mockCloudService.saveAppointment.mock.invocationCallOrder[0]);
    });

    it('does not create an appointment when the cloud refuses the acceptance', async () => {
        const dialogService = TestBed.inject(DialogService);
        const open = vi.spyOn(dialogService, 'open').mockResolvedValue(true);
        mockCloudService.decide.mockRejectedValueOnce(new Error("Error invoking remote method 'cloud:decide': Error: slot_lost: The request expired and the slot was taken by someone else."));
        const req = { id: 'ABCDEFGHJKMN', patient_name: 'John', status: 'pending', date: '2025-01-01', time: '10:00' };

        await component.accept(req);

        expect(mockCloudService.saveAppointment).not.toHaveBeenCalled();
        expect(open).toHaveBeenLastCalledWith(expect.objectContaining({
            title: 'Accept failed', message: 'The request expired and the slot was taken by someone else.'
        }));
    });

    it('declines through the cloud', async () => {
        const dialogService = TestBed.inject(DialogService);
        vi.spyOn(dialogService, 'open').mockResolvedValue(true);
        await component.reject({ id: 'ABCDEFGHJKMN', patient_name: 'John', date: '2025-01-01', time: '10:00' });
        expect(mockCloudService.decide).toHaveBeenCalledWith('ABCDEFGHJKMN', 'declined');
    });

    it('offers zero-padded half-hour slots the booking API accepts', () => {
        expect(component.timeSlots[0]).toBe('09:00');
        expect(component.timeSlots).toContain('19:30');
    });

    it('should skip accept when the dialog is cancelled', async () => {
        const dialogService = TestBed.inject(DialogService);
        vi.spyOn(dialogService, 'open').mockResolvedValue(false);
        component.requests = [{ id: 1, patient_name: 'John', status: 'pending', date: '2025-01-01', time: '10:00' }];

        await component.accept(component.requests[0]);

        expect(mockCloudService.saveAppointment).not.toHaveBeenCalled();
        expect(mockCloudService.decide).not.toHaveBeenCalled();
    });
});
