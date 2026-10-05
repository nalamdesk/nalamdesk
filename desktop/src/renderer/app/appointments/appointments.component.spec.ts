/**
 * @vitest-environment jsdom
 */
import '@angular/compiler';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AppointmentsComponent } from './appointments.component';

vi.mock('@angular/core', async () => {
    const actual = await vi.importActual('@angular/core');
    return { ...actual as any, inject: vi.fn() };
});
import { inject } from '@angular/core';
import { DataService } from '../services/api.service';

describe('AppointmentsComponent', () => {
    let component: AppointmentsComponent;
    let mockDataService: any;
    let mockDialogService: any;

    beforeEach(() => {
        mockDataService = { invoke: vi.fn().mockResolvedValue([]) };
        mockDialogService = { open: vi.fn().mockResolvedValue(true) };
        vi.mocked(inject).mockImplementation((token: any) => {
            if (token === DataService) return mockDataService;
            return mockDialogService;
        });
        component = new AppointmentsComponent();
    });

    it('loads the day on init', async () => {
        const rows = [{ id: 1, status: 'confirmed', patient_name: 'Dot' }];
        mockDataService.invoke.mockResolvedValue(rows);
        await component.ngOnInit();
        await component.load();
        expect(mockDataService.invoke).toHaveBeenCalledWith('getAppointments', component.day);
        expect(component.rows).toEqual(rows);
    });

    it('confirms a booked row through the transition', async () => {
        await component.transition({ id: 2, status: 'booked' } as any, 'confirmed');
        expect(mockDataService.invoke).toHaveBeenCalledWith(
            'transitionAppointment', { id: 2, to: 'confirmed', reason: undefined });
    });

    it('checks in through the atomic call and surfaces failures', async () => {
        await component.checkIn({ id: 3, status: 'confirmed' } as any);
        expect(mockDataService.invoke).toHaveBeenCalledWith('checkInAppointment', 3);

        mockDataService.invoke.mockRejectedValueOnce(new Error('already arrived'));
        const dialogSpy = vi.fn().mockResolvedValue(true);
        (component as any).dialogService = { open: dialogSpy };
        await component.checkIn({ id: 3, status: 'confirmed' } as any);
        expect(dialogSpy).toHaveBeenCalledWith(expect.objectContaining({ title: 'Check-in failed' }));
    });

    it('asks for a reason on cancel and no-show, then transitions', async () => {
        component.askReason({ id: 4, status: 'booked' } as any, 'cancelled');
        expect(component.showReasonDialog).toBe(true);
        await component.onReasonDecided('patient called');
        expect(mockDataService.invoke).toHaveBeenCalledWith(
            'transitionAppointment', { id: 4, to: 'cancelled', reason: 'patient called' });

        component.askReason({ id: 5, status: 'confirmed' } as any, 'no-show');
        await component.onReasonDecided(null);
        expect(mockDataService.invoke).not.toHaveBeenCalledWith(
            'transitionAppointment', expect.objectContaining({ to: 'no-show' }));
    });

    it('warns on conflicts when booking without blocking', async () => {
        component.openCreate();
        component.form.date = '2026-10-05';
        component.form.time = '10:00';
        mockDataService.invoke.mockImplementation((method: string) => {
            if (method === 'detectConflicts') return Promise.resolve([{ id: 9 }]);
            return Promise.resolve([]);
        });
        await component.checkConflicts();
        expect(component.conflicts).toHaveLength(1);
    });

    it('saves bookings and reschedules through saveAppointment', async () => {
        component.openCreate();
        component.form.patientId = 7;
        component.form.date = '2026-10-05';
        component.form.time = '09:00';
        await component.saveBooking();
        expect(mockDataService.invoke).toHaveBeenCalledWith('saveAppointment', expect.objectContaining({
            patient_id: 7, date: '2026-10-05', time: '09:00'
        }));

        component.openReschedule({ id: 8, patient_id: 7, date: '2026-10-05', time: '09:00', status: 'booked' } as any);
        component.form.date = '2026-10-06';
        await component.saveBooking();
        expect(mockDataService.invoke).toHaveBeenCalledWith('saveAppointment', expect.objectContaining({
            id: 8, date: '2026-10-06'
        }));
        expect(component.day).toBe('2026-10-06');
    });
});
