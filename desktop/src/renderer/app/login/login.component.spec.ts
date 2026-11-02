/**
 * @vitest-environment jsdom
 */
import '@angular/compiler';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LoginComponent } from './login.component';
import { NgZone } from '@angular/core';

describe('LoginComponent', () => {
    let component: LoginComponent;
    let mockRouter: any;
    let mockNgZone: any;
    let mockAuthService: any;
    let mockRuntimeService: any;

    beforeEach(() => {
        // Mock window.electron
        (window as any).electron = {
            utils: {
                getLocalIp: vi.fn().mockResolvedValue('192.168.1.10')
            }
        };

        mockRouter = { navigate: vi.fn() };
        // NgZone mock that simply executes the function immediately
        mockNgZone = { run: vi.fn((fn) => fn()) };
        mockAuthService = {
            login: vi.fn(),
            getUser: vi.fn(),
            acknowledgeRecoveryCode: vi.fn().mockResolvedValue({ success: true }),
            checkSetup: vi.fn().mockResolvedValue({ isSetup: true }) // Default to setup complete
        };
        mockRuntimeService = {
            init: vi.fn().mockResolvedValue(undefined),
            lanAccessUrl: '',
        };

        component = new LoginComponent(mockRouter, mockNgZone, mockAuthService, mockRuntimeService);
    });

    it('should redirect to /setup if application is not setup', async () => {
        mockAuthService.checkSetup.mockResolvedValue({ isSetup: false });
        await component.ngOnInit();
        expect(mockRouter.navigate).toHaveBeenCalledWith(['/setup']);
    });

    it('should stay on login page if application is setup', async () => {
        mockAuthService.checkSetup.mockResolvedValue({ isSetup: true });
        await component.ngOnInit();
        expect(mockRouter.navigate).not.toHaveBeenCalled();
    });

    it('uses a generic notice when additional vault verification is required', async () => {
        mockAuthService.checkSetup.mockResolvedValue({ isSetup: true, vaultState: 'legacy-migration-required' });
        await component.ngOnInit();
        expect(component.vaultNotice).toContain('Additional security verification may be required');
        expect(component.vaultNotice).not.toContain('migration');
    });

    it('does not disclose the specific vault state in the notice', async () => {
        mockAuthService.checkSetup.mockResolvedValue({ isSetup: true, vaultState: 'recovery-required' });
        await component.ngOnInit();
        expect(component.vaultNotice).toContain('Additional security verification may be required');
        expect(component.vaultNotice).not.toContain('protected vault key');
    });

    it('should initialize with default values', () => {
        expect(component.username).toBe('');
        expect(component.password).toBe('');
        expect(component.isLoading).toBe(false);
    });

    it('should not login if fields are empty', async () => {
        await component.onLogin();
        expect(mockAuthService.login).not.toHaveBeenCalled();
    });

    it('should set error message on login failure', async () => {
        component.username = 'admin';
        component.password = 'wrong';
        mockAuthService.login.mockResolvedValue({ success: false, error: 'Invalid config' });

        await component.onLogin();

        expect(component.isLoading).toBe(false);
        expect(component.error).toBe('Sign-in failed. Check your credentials or use Recover Device if access is unavailable.');
        expect(mockRouter.navigate).not.toHaveBeenCalled();
    });

    it('should navigate to dashboard on login success', async () => {
        component.username = 'admin';
        component.password = 'correct';
        mockAuthService.login.mockResolvedValue({ success: true });

        await component.onLogin();

        expect(component.isLoading).toBe(false);
        expect(component.error).toBe('');
        expect(mockRouter.navigate).toHaveBeenCalledWith(['/dashboard']);
    });

    it('keeps the recovery code visible when acknowledgement fails', async () => {
        component.username = 'admin';
        component.password = 'legacy-password';
        mockAuthService.login.mockResolvedValue({ success: true, pendingRecoveryCode: 'AAAA-BBBB-CCCC-DDDD' });
        mockAuthService.acknowledgeRecoveryCode.mockResolvedValue({ success: false });

        await component.onLogin();
        await component.acknowledgeMigration();

        expect(component.pendingRecoveryCode).toBe('AAAA-BBBB-CCCC-DDDD');
        expect(component.error).toContain('Could not confirm');
        expect(mockRouter.navigate).not.toHaveBeenCalled();
    });

    it('requires acknowledgement of the new recovery code after legacy migration', async () => {
        component.username = 'admin';
        component.password = 'legacy-password';
        mockAuthService.login.mockResolvedValue({ success: true, pendingRecoveryCode: 'AAAA-BBBB-CCCC-DDDD' });

        await component.onLogin();

        expect(component.pendingRecoveryCode).toBe('AAAA-BBBB-CCCC-DDDD');
        expect(mockRouter.navigate).not.toHaveBeenCalled();
        await component.acknowledgeMigration();
        expect(mockAuthService.acknowledgeRecoveryCode).toHaveBeenCalledWith('AAAA-BBBB-CCCC-DDDD');
        expect(mockRouter.navigate).toHaveBeenCalledWith(['/dashboard']);
    });

    it('should handle exception during login', async () => {
        component.username = 'admin';
        component.password = 'crash';
        // Ensure the component actually has a try/catch block around the service call
        mockAuthService.login.mockRejectedValue(new Error('Network Fail'));

        try {
            await component.onLogin();
        } catch (e) {
            // Should be caught by component, but if rethrown, catch here
        }

        expect(component.error).toBe('Sign-in failed. Check your credentials or use Recover Device if access is unavailable.');
        expect(mockRouter.navigate).not.toHaveBeenCalled();
    });

    describe('facilities at sign-in (#211)', () => {
        const facilities = [
            { id: 1, code: 'MAIN', name: 'Main', kind: 'clinic', role: 'doctor' },
            { id: 2, code: 'ANN', name: 'Anna Nagar', kind: 'hospital', role: 'admin' }
        ];
        let facilityService: any;

        beforeEach(() => {
            localStorage.clear();
            mockAuthService.getUser.mockReturnValue({ username: 'asha' });
            mockAuthService.applyFacility = vi.fn();
            (window as any).electron.switchFacility = vi.fn().mockResolvedValue({ success: true, facilityId: 2, user: { role: 'admin' } });
            component.username = 'asha';
            component.password = 'pw';
            facilityService = component.facilities;
        });

        it('explains a sign-in refused for having no facility', async () => {
            mockAuthService.login.mockResolvedValue({ success: false, error: 'NO_FACILITY_ACCESS' });
            await component.onLogin();
            expect(component.error).toContain('not set up for any facility');
        });

        it('goes straight in with one facility', async () => {
            mockAuthService.login.mockResolvedValue({ success: true, facilityId: 1, facilities: [facilities[0]] });
            await component.onLogin();
            expect(component.choosingFacility).toBe(false);
            expect(mockRouter.navigate).toHaveBeenCalledWith(['/dashboard']);
        });

        it('asks which facility, preselecting the last one used here, then switches to it', async () => {
            localStorage.setItem('nalamdesk_last_facility:asha', '2');
            mockAuthService.login.mockResolvedValue({ success: true, facilityId: 1, facilities });
            await component.onLogin();
            expect(component.choosingFacility).toBe(true);
            expect(component.selectedFacilityId).toBe(2);
            expect(mockRouter.navigate).not.toHaveBeenCalled();

            await component.confirmFacility();
            expect((window as any).electron.switchFacility).toHaveBeenCalledWith(2);
            expect(mockAuthService.applyFacility).toHaveBeenCalledWith(2, 'admin');
            expect(facilityService.currentId()).toBe(2);
            expect(mockRouter.navigate).toHaveBeenCalledWith(['/dashboard']);
        });

        it('keeps the sign-in facility without a switch, and remembers it', async () => {
            mockAuthService.login.mockResolvedValue({ success: true, facilityId: 1, facilities });
            await component.onLogin();
            expect(component.selectedFacilityId).toBe(1);
            await component.confirmFacility();
            expect((window as any).electron.switchFacility).not.toHaveBeenCalled();
            expect(localStorage.getItem('nalamdesk_last_facility:asha')).toBe('1');
            expect(mockRouter.navigate).toHaveBeenCalledWith(['/dashboard']);
        });

        it('stays on the picker when the switch is refused', async () => {
            (window as any).electron.switchFacility.mockResolvedValue({ success: false, error: 'NO_FACILITY_ACCESS' });
            mockAuthService.login.mockResolvedValue({ success: true, facilityId: 1, facilities });
            await component.onLogin();
            component.selectedFacilityId = 2;
            await component.confirmFacility();
            expect(component.choosingFacility).toBe(true);
            expect(component.selectedFacilityId).toBe(1);
            expect(component.error).toContain('Could not open that facility');
            expect(mockRouter.navigate).not.toHaveBeenCalled();
        });

        it('asks for the facility after the recovery code is acknowledged', async () => {
            mockAuthService.login.mockResolvedValue({ success: true, pendingRecoveryCode: 'AAAA', facilityId: 1, facilities });
            await component.onLogin();
            expect(component.choosingFacility).toBe(false);
            await component.acknowledgeMigration();
            expect(component.choosingFacility).toBe(true);
        });
    });
});
