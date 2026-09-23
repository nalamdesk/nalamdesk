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
});
