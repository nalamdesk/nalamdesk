/**
 * @vitest-environment jsdom
 */
import '@angular/compiler';
import { describe, xdescribe, it, expect, vi, beforeEach } from 'vitest';
import { NavbarComponent } from './navbar.component';
import { DataService } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { RuntimeService } from '../../services/runtime.service';

// Mock inject/core
vi.mock('@angular/core', async () => {
    const actual = await vi.importActual('@angular/core');
    return {
        ...actual as any,
        inject: vi.fn(),
    };
});
import { inject } from '@angular/core';

describe('NavbarComponent', () => {
    let component: NavbarComponent;
    let mockRouter: any;
    let mockNgZone: any;
    let mockDataService: any;
    let mockAuthService: any;
    let mockRuntimeService: any;

    beforeEach(() => {
        mockRouter = { navigate: vi.fn() };
        mockNgZone = { run: vi.fn((fn) => fn()) };
        mockDataService = { invoke: vi.fn().mockReturnValue(Promise.resolve({ clinic_name: 'Test Clinic' })) };
        mockAuthService = { getUser: vi.fn().mockReturnValue({ name: 'Dr. Test', role: 'doctor' }), logout: vi.fn().mockResolvedValue(undefined) };
        mockRuntimeService = {
            init: vi.fn().mockResolvedValue(undefined),
            lanAccessUrl: '',
        };

        // Mock inject implementation
        vi.mocked(inject).mockImplementation((token: any) => {
            if (token === DataService) return mockDataService;
            if (token === AuthService) return mockAuthService;
            if (token === RuntimeService) return mockRuntimeService;
            return null;
        });

        component = new NavbarComponent(mockRouter, mockNgZone);
    });

    it('should create', () => {
        expect(component).toBeTruthy();
    });

    it('should toggle mobile menu', () => {
        expect(component.isMobileMenuOpen).toBe(false);
        component.toggleMobileMenu();
        expect(component.isMobileMenuOpen).toBe(true);
        component.toggleMobileMenu();
        expect(component.isMobileMenuOpen).toBe(false);
    });

    it('should close mobile menu immediately', () => {
        component.isMobileMenuOpen = true;
        component.closeMobileMenu();
        expect(component.isMobileMenuOpen).toBe(false);
    });

    it('should logout through AuthService', async () => {
        await component.logout();
        expect(mockAuthService.logout).toHaveBeenCalled();
        expect(mockRouter.navigate).not.toHaveBeenCalled();
    });

    it('swallows logout rejection without navigating or clearing session', async () => {
        mockAuthService.logout.mockRejectedValue(new Error('IPC Error'));
        localStorage.setItem('nalamdesk_user', JSON.stringify({ id: 1, name: 'Dr. Test' }));
        localStorage.setItem('nalamdesk_token', 'test-token');
        await expect(component.logout()).resolves.toBeUndefined();
        expect(mockAuthService.logout).toHaveBeenCalled();
        expect(mockRouter.navigate).not.toHaveBeenCalled();
        expect(localStorage.getItem('nalamdesk_user')).toBeTruthy();
        expect(localStorage.getItem('nalamdesk_token')).toBe('test-token');
    });

    it('should load clinic name on init', async () => {
        // ngOnInit calls loadSettings (async but not awaited)
        component.ngOnInit();
        // Wait for promise resolution
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(component.clinicName).toBe('Test Clinic');
    });

    it('loads doctors with stored, single, and empty selections', async () => {
        localStorage.setItem('selectedDoctorId', '7');
        mockDataService.invoke.mockResolvedValue([{ id: 3 }]);
        await component.loadDoctors();
        expect(component.doctors).toHaveLength(1);
        expect(component.selectedDoctorId).toBe(7);

        localStorage.removeItem('selectedDoctorId');
        await component.loadDoctors();
        expect(component.selectedDoctorId).toBe(3);

        mockDataService.invoke.mockResolvedValue([]);
        await component.loadDoctors();
        expect(component.doctors).toEqual([]);
    });

    it('tolerates settings and doctor load failures', async () => {
        mockDataService.invoke.mockRejectedValueOnce(new Error('db down'));
        await component.loadSettings();
        mockDataService.invoke.mockRejectedValueOnce(new Error('db down'));
        await component.loadDoctors();
    });

    it('persists or clears the doctor pick', () => {
        component.selectedDoctorId = 9;
        component.onDoctorChange();
        expect(localStorage.getItem('selectedDoctorId')).toBe('9');
        component.selectedDoctorId = null;
        component.onDoctorChange();
        expect(localStorage.getItem('selectedDoctorId')).toBeNull();
    });

    it('initializes runtime on electron sessions', async () => {
        (window as any).electron = {};
        component.isElectron = true;
        mockAuthService.getUser.mockReturnValue({ name: 'A', role: 'doctor' });
        component.ngOnInit();
        await new Promise((r) => setTimeout(r, 0));
        expect(mockRuntimeService.init).toHaveBeenCalled();
        expect(component.currentUser.role).toBe('doctor');
        delete (window as any).electron;
        component.isElectron = false;
    });
});
