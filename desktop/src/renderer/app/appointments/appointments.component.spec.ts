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

        component.openReschedule({ id: 8, patient_id: 7, date: '2026-10-05', time: '09:00', reason: 'Follow-up', status: 'booked' } as any);
        expect(component.form.reason).toBe('Follow-up');
        component.form.date = '2026-10-06';
        await component.saveBooking();
        expect(mockDataService.invoke).toHaveBeenCalledWith('saveAppointment', expect.objectContaining({
            id: 8, date: '2026-10-06', reason: 'Follow-up'
        }));
        expect(component.day).toBe('2026-10-06');
    });

    it('clears the picked patient when the search text changes', async () => {
        component.form.patientQuery = 'Ash';
        component.form.patientId = 7;
        component.form.patientQuery = 'Asha X';
        await component.searchPatients();
        expect(component.form.patientId).toBeNull();
    });

    it('ignores double saves while a booking is in flight', async () => {
        let resolveFirst: (v: any) => void = () => undefined;
        mockDataService.invoke.mockImplementation((method: string) => {
            if (method === 'saveAppointment') return new Promise((res) => { resolveFirst = res; });
            return Promise.resolve([]);
        });
        component.openCreate();
        component.form.patientId = 7;
        component.form.date = '2026-10-05';
        component.form.time = '09:00';
        const first = component.saveBooking();
        await component.saveBooking();
        resolveFirst({ id: 1 });
        await first;
        expect(mockDataService.invoke.mock.calls.filter((c: any[]) => c[0] === 'saveAppointment')).toHaveLength(1);
    });

    it('refreshes history after a transition instead of showing stale entries', async () => {
        mockDataService.invoke.mockImplementation((method: string) => {
            if (method === 'getAppointmentHistory') return Promise.resolve([{ to_status: 'confirmed' }]);
            return Promise.resolve([]);
        });
        const row = { id: 2, status: 'booked' } as any;
        component.expandedId = 2;
        await component.transition(row, 'confirmed');
        expect(component.history[2]).toHaveLength(1);
    });

    it('opens and closes the history view', async () => {
        mockDataService.invoke.mockResolvedValue([{ to_status: 'booked' }]);
        const row = { id: 2, status: 'booked' } as any;
        await component.toggleHistory(row);
        expect(component.expandedId).toBe(2);
        expect(component.history[2]).toHaveLength(1);
        await component.toggleHistory(row);
        expect(component.expandedId).toBeNull();
    });

    it('clears history when the lookup fails', async () => {
        mockDataService.invoke.mockRejectedValue(new Error('gone'));
        const row = { id: 2, status: 'booked' } as any;
        await component.toggleHistory(row);
        expect(component.expandedId).toBe(2);
        expect(component.history[2]).toEqual([]);
    });

    it('closes an open link picker on second click', async () => {
        const row = { id: 9, status: 'arrived', patient_id: 7 } as any;
        mockDataService.invoke.mockResolvedValue([]);
        await component.toggleLink(row);
        expect(component.linkingId).toBe(9);
        await component.toggleLink(row);
        expect(component.linkingId).toBeNull();
    });

    it('keeps visits whose link lookup fails', async () => {
        mockDataService.invoke.mockImplementation((method: string) => {
            if (method === 'getVisits') return Promise.resolve([
                { id: 21, status: 'finished' },
                { id: 22, status: 'finished' }
            ]);
            if (method === 'getAppointmentByVisit') return Promise.reject(new Error('down'));
            return Promise.resolve([]);
        });
        await component.toggleLink({ id: 9, status: 'arrived', patient_id: 7 } as any);
        expect(component.linkCandidates[9].map((v: any) => v.id)).toEqual([21, 22]);
    });

    it('reports linkable-visit load failures without stale rows', async () => {
        mockDataService.invoke.mockRejectedValue(new Error('db down'));
        await component.toggleLink({ id: 9, status: 'arrived', patient_id: 7 } as any);
        expect(component.linkCandidates[9]).toEqual([]);
    });

    it('reports link failures in the dialog', async () => {
        mockDataService.invoke.mockRejectedValueOnce(new Error('taken'));
        const dialogSpy = vi.fn().mockResolvedValue(true);
        (component as any).dialogService = { open: dialogSpy };
        await component.fulfill({ id: 9 } as any, { id: 21 });
        expect(dialogSpy).toHaveBeenCalledWith(expect.objectContaining({ title: 'Link failed' }));
    });

    it('ignores stale search responses that finish after a newer search', async () => {
        const resolvers: Array<(v: any) => void> = [];
        mockDataService.invoke.mockImplementation(() => new Promise((res) => { resolvers.push(res); }));
        component.form.patientQuery = 'ash';
        const first = component.searchPatients();
        component.form.patientQuery = 'asha';
        const second = component.searchPatients();
        resolvers[0]([{ id: 1 }]);
        resolvers[1]([{ id: 2 }]);
        await first;
        await second;
        expect(component.patientHits).toEqual([{ id: 2 }]);
    });

    it('ignores stale search errors after a newer search', async () => {
        const resolvers: Array<(v: any, e?: any) => void> = [];
        mockDataService.invoke.mockImplementation(() => new Promise((res, rej) => { resolvers.push(((v: any) => v ? res(v) : rej(new Error('gone'))) as any); }));
        component.form.patientQuery = 'ash';
        const first = component.searchPatients();
        component.form.patientQuery = 'asha';
        const second = component.searchPatients();
        resolvers[0](null);
        resolvers[1]([{ id: 2 }]);
        await first;
        await second;
        expect(component.patientHits).toEqual([{ id: 2 }]);
    });

    it('ignores stale conflict errors after a newer check', async () => {
        const resolvers: Array<(v: any, e?: any) => void> = [];
        mockDataService.invoke.mockImplementation(() => new Promise((res, rej) => { resolvers.push(((v: any) => v ? res(v) : rej(new Error('gone'))) as any); }));
        component.form.date = '2026-10-05';
        component.form.time = '10:00';
        const first = component.checkConflicts();
        const second = component.checkConflicts();
        resolvers[0](null);
        resolvers[1]([]);
        await first;
        await second;
        expect(component.conflicts).toEqual([]);
    });

    it('ignores stale day loads that finish after a day change', async () => {
        const resolvers: Array<(v: any) => void> = [];
        mockDataService.invoke.mockImplementation(() => new Promise((res) => { resolvers.push(res); }));
        const firstDay = component.day;
        const first = component.load();
        component.day = '2026-10-06';
        const second = component.load();
        resolvers[0]([{ id: 1 }]);
        resolvers[1]([]);
        await first;
        await second;
        expect(firstDay).not.toBe('2026-10-06');
        expect(component.rows).toEqual([]);
    });

    it('uses the clinic-local day, not UTC', () => {
        expect(component.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        const d = new Date();
        const pad = (n: number) => String(n).padStart(2, '0');
        expect(component.day).toBe(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
    });

    it('links arrived bookings to finished unlinked visits for doctors', async () => {
        (component as any).authService = { getUser: () => ({ role: 'doctor' }) };
        const row = { id: 9, status: 'arrived', patient_id: 7 } as any;
        expect(component.canFulfill(row)).toBe(true);
        mockDataService.invoke.mockImplementation((method: string) => {
            if (method === 'getVisits') return Promise.resolve([
                { id: 21, status: 'finished', diagnosis: 'Flu' },
                { id: 22, status: 'in-progress', diagnosis: 'Draft' },
                { id: 23, status: 'finished', diagnosis: 'Old' }
            ]);
            if (method === 'getAppointmentByVisit') return Promise.resolve(null);
            return Promise.resolve([]);
        });
        await component.toggleLink(row);
        expect(component.linkCandidates[9].map((v: any) => v.id)).toEqual([21, 23]);
        await component.fulfill(row, { id: 21 });
        expect(mockDataService.invoke).toHaveBeenCalledWith('fulfillAppointment', { id: 9, visitId: 21 });
    });

    it('hides link-visit from non-treating roles', async () => {
        (component as any).authService = { getUser: () => ({ role: 'receptionist' }) };
        expect(component.canFulfill({ id: 9, status: 'arrived' } as any)).toBe(false);
        expect(component.canFulfill({ id: 9, status: 'booked' } as any)).toBe(false);
    });
});
