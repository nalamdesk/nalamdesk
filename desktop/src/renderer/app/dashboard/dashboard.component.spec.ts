/**
 * @vitest-environment jsdom
 */
import '@angular/compiler';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DashboardComponent, greetingForLocalHour } from './dashboard.component';
import { DataService } from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { Router } from '@angular/router';

// Mock services to prevent real code execution
vi.mock('../services/api.service');
vi.mock('../services/auth.service');
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

describe('DashboardComponent', () => {
    let component: DashboardComponent;
    let mockDataService: any;
    let mockNgZone: any;
    let mockRouter: any;
    let mockAuthService: any;

    beforeEach(() => {
        // Create fresh mocks
        mockDataService = { invoke: vi.fn() };
        mockNgZone = { run: vi.fn((fn) => fn()) };
        mockRouter = { navigate: vi.fn() };
        mockAuthService = { getUser: vi.fn() };

        // Setup mocked return values to avoid undefined errors
        mockDataService.invoke.mockImplementation((method) => {
            if (method === 'getSettings') return Promise.resolve({ clinic_name: 'Test Clinic' });
            if (method === 'getDashboardStats') return Promise.resolve({ totalPatients: 10, todayVisits: 5 });
            if (method === 'getQueue') return Promise.resolve([]);
            return Promise.resolve(null);
        });

        component = new DashboardComponent(
            mockRouter,
            mockNgZone,
            mockDataService,
            mockAuthService
        );
    });

    it('should load dashboard stats on init', async () => {
        await component.loadData();

        expect(component.stats).toEqual({ totalPatients: 10, todayVisits: 5 });
        expect(mockDataService.invoke).toHaveBeenCalledWith('getDashboardStats');
    });

    it('should handle errors when loading stats', async () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => { });
        mockDataService.invoke.mockRejectedValue(new Error('DB Error'));

        await component.loadData();

        expect(spy).toHaveBeenCalled();
    });

    it('greets Morning before noon, Afternoon before 17, Evening otherwise', () => {
        expect(greetingForLocalHour(0)).toBe('Morning');
        expect(greetingForLocalHour(11)).toBe('Morning');
        expect(greetingForLocalHour(12)).toBe('Afternoon');
        expect(greetingForLocalHour(16)).toBe('Afternoon');
        expect(greetingForLocalHour(17)).toBe('Evening');
        expect(greetingForLocalHour(18)).toBe('Evening');
        expect(greetingForLocalHour(23)).toBe('Evening');
    });

    it('does not say Good Morning at 18:39 local time', () => {
        component.currentTime = new Date(2026, 8, 3, 18, 39, 0);
        expect(component.getTimeOfDay()).toBe('Evening');
        expect(component.getTimeOfDay()).not.toBe('Morning');
    });

    it('checks in a confirmed appointment after dialog confirmation', async () => {
        const dialog = { open: vi.fn().mockResolvedValue(true) };
        const cloud = { saveAppointment: vi.fn().mockResolvedValue({}) };
        const patients = { isPatientComplete: vi.fn().mockReturnValue(true) };
        const full = new DashboardComponent(
            mockRouter, mockNgZone, mockDataService, mockAuthService, cloud as any, patients as any, dialog as any
        );
        const appt = { id: 1, patient_id: 6, patient_name: 'Ramesh Gupta' };

        await full.checkIn(appt);

        expect(dialog.open).toHaveBeenCalledWith(expect.objectContaining({ type: 'confirm', title: 'Check in patient?' }));
        expect(mockDataService.invoke).toHaveBeenCalledWith('addToQueue', { patientId: 6, priority: 1 });
        expect(cloud.saveAppointment).toHaveBeenCalledWith({ id: 1, status: 'CHECKED_IN' });
    });

    it('skips check-in when the dialog is cancelled', async () => {
        const dialog = { open: vi.fn().mockResolvedValue(false) };
        const cloud = { saveAppointment: vi.fn() };
        const patients = { isPatientComplete: vi.fn().mockReturnValue(true) };
        const full = new DashboardComponent(
            mockRouter, mockNgZone, mockDataService, mockAuthService, cloud as any, patients as any, dialog as any
        );

        await full.checkIn({ id: 1, patient_id: 6, patient_name: 'Ramesh Gupta' });

        expect(mockDataService.invoke).not.toHaveBeenCalledWith('addToQueue', expect.anything());
        expect(cloud.saveAppointment).not.toHaveBeenCalled();
    });

    describe('onboarding banner and demo seed', () => {
        const tour = { start: vi.fn() };

        beforeEach(() => {
            localStorage.clear();
            component.currentUser = { id: 1, role: 'admin', name: 'Admin' };
        });

        function fullComponent() {
            return new DashboardComponent(
                mockRouter, mockNgZone, mockDataService, mockAuthService,
                { getAppointments: vi.fn().mockResolvedValue([]) } as any,
                {} as any,
                { open: vi.fn().mockResolvedValue(true) } as any,
                { success: vi.fn() } as any,
                undefined, tour as any
            );
        }

        it('shows the welcome banner for an empty clinic', async () => {
            mockDataService.invoke.mockImplementation((method: string) => {
                if (method === 'getDashboardStats') return Promise.resolve({ totalPatients: 0, todayVisits: 0 });
                if (method === 'getDemoSeedState') return Promise.resolve({ seeded: false });
                return Promise.resolve(null);
            });
            await component.loadData();
            expect(component.showWelcomeBanner).toBe(true);
            expect(component.demoSeeded).toBe(false);
        });

        it('hides the banner for a working clinic until demo data lands', async () => {
            mockDataService.invoke.mockImplementation((method: string) => {
                if (method === 'getDashboardStats') return Promise.resolve({ totalPatients: 12, todayVisits: 3 });
                if (method === 'getDemoSeedState') return Promise.resolve({ seeded: false });
                return Promise.resolve(null);
            });
            await component.loadData();
            expect(component.showWelcomeBanner).toBe(false);

            mockDataService.invoke.mockImplementation((method: string) => {
                if (method === 'getDashboardStats') return Promise.resolve({ totalPatients: 17, todayVisits: 3 });
                if (method === 'getDemoSeedState') return Promise.resolve({ seeded: true, patientIds: [1, 2, 3, 4, 5] });
                return Promise.resolve(null);
            });
            await component.loadData();
            expect(component.showWelcomeBanner).toBe(true);
            expect(component.demoSeeded).toBe(true);
        });

        it('respects dismissal and starts the tour with the user role', async () => {
            mockDataService.invoke.mockImplementation((method: string) => {
                if (method === 'getDashboardStats') return Promise.resolve({ totalPatients: 0, todayVisits: 0 });
                if (method === 'getDemoSeedState') return Promise.resolve({ seeded: false });
                return Promise.resolve(null);
            });
            const full = fullComponent();
            full.currentUser = { id: 2, role: 'nurse', name: 'Nancy' };
            await full.loadData();
            expect(full.showWelcomeBanner).toBe(true);
            full.dismissWelcomeBanner();
            expect(full.showWelcomeBanner).toBe(false);
            full.startTour();
            expect(tour.start).toHaveBeenCalledWith('nurse');
        });

        it('loads and removes demo data through admin confirms', async () => {
            const dialog = { open: vi.fn().mockResolvedValue(true) };
            const toast = { success: vi.fn() };
            const full = new DashboardComponent(
                mockRouter, mockNgZone, mockDataService, mockAuthService,
                { getAppointments: vi.fn().mockResolvedValue([]) } as any,
                {} as any, dialog as any, toast as any, undefined, tour as any
            );
            full.currentUser = { id: 1, role: 'admin', name: 'Admin' };
            mockDataService.invoke.mockImplementation((method: string) => {
                if (method === 'getDashboardStats') return Promise.resolve({ totalPatients: 0, todayVisits: 0 });
                if (method === 'getDemoSeedState') return Promise.resolve({ seeded: false });
                return Promise.resolve(null);
            });

            await full.loadDemoData();
            expect(mockDataService.invoke).toHaveBeenCalledWith('seedDemoData');
            expect(toast.success).toHaveBeenCalledWith('Demo clinic loaded.', 'Welcome');

            dialog.open.mockResolvedValue(false);
            mockDataService.invoke.mockClear();
            await full.removeDemoData();
            expect(mockDataService.invoke).not.toHaveBeenCalledWith('clearDemoData', expect.anything());

            dialog.open.mockResolvedValue(true);
            await full.removeDemoData();
            expect(mockDataService.invoke).toHaveBeenCalledWith('clearDemoData');
        });

        it('refuses demo actions for non-admins and handles failures', async () => {
            const dialog = { open: vi.fn().mockResolvedValue(true) };
            const full = new DashboardComponent(
                mockRouter, mockNgZone, mockDataService, mockAuthService,
                { getAppointments: vi.fn().mockResolvedValue([]) } as any,
                {} as any, dialog as any, undefined, undefined, tour as any
            );
            full.currentUser = { id: 2, role: 'nurse', name: 'Nancy' };
            await full.loadDemoData();
            expect(mockDataService.invoke).not.toHaveBeenCalledWith('seedDemoData', expect.anything());

            full.currentUser = { id: 1, role: 'admin', name: 'Admin' };
            mockDataService.invoke.mockRejectedValue(new Error('db down'));
            await full.loadDemoData();
            expect(dialog.open).toHaveBeenCalledWith(expect.objectContaining({ title: 'Load failed' }));
        });
    });

    describe('daily close', () => {
        it('loads collection totals for billing roles and skips nurses', async () => {
            const close = {
                date: '2026-10-02', collected: 500,
                byMethod: [{ method: 'cash', kind: 'payment', count: 1, total: 500 }],
                invoices: [{ status: 'paid', count: 1, total: 500 }],
                review: []
            };
            mockDataService.invoke.mockImplementation((method: string) => {
                if (method === 'getDashboardStats') return Promise.resolve({ totalPatients: 5, todayVisits: 2 });
                if (method === 'getDemoSeedState') return Promise.resolve({ seeded: false });
                if (method === 'getQueue') return Promise.resolve([]);
                if (method === 'getDailyClose') return Promise.resolve(close);
                return Promise.resolve(null);
            });
            component.currentUser = { id: 1, role: 'receptionist', name: 'Desk' };
            (component as any).cloudService = { getAppointments: vi.fn(async () => []) };
            await component.loadData();
            expect(component.dailyClose.collected).toBe(500);
            expect(component.canSeeBilling).toBe(true);

            component.currentUser = { id: 2, role: 'nurse', name: 'Nancy' };
            mockDataService.invoke.mockClear();
            await component.loadData();
            expect(mockDataService.invoke).not.toHaveBeenCalledWith('getDailyClose', expect.anything());
            expect(component.canSeeBilling).toBe(false);
        });
    });
});
