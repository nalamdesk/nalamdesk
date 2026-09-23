import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { adminGuard } from './admin.guard';
import { AuthService } from '../services/auth.service';

describe('adminGuard', () => {
    let mockAuthService: any;
    let mockRouter: any;

    beforeEach(() => {
        mockAuthService = { isLoggedIn: vi.fn(), getUser: vi.fn() };
        mockRouter = { createUrlTree: vi.fn((commands: any[]) => commands) };
        TestBed.configureTestingModule({
            providers: [
                { provide: AuthService, useValue: mockAuthService },
                { provide: Router, useValue: mockRouter }
            ]
        });
    });

    it('allows admins through', () => {
        mockAuthService.isLoggedIn.mockReturnValue(true);
        mockAuthService.getUser.mockReturnValue({ role: 'admin' });
        expect(TestBed.runInInjectionContext(() => adminGuard({} as any, {} as any))).toBe(true);
    });

    it('redirects doctors, nurses, and receptionists to the dashboard', () => {
        mockAuthService.isLoggedIn.mockReturnValue(true);
        for (const role of ['doctor', 'nurse', 'receptionist']) {
            mockAuthService.getUser.mockReturnValue({ role });
            TestBed.runInInjectionContext(() => adminGuard({} as any, {} as any));
            expect(mockRouter.createUrlTree).toHaveBeenCalledWith(['/dashboard']);
        }
    });

    it('redirects signed-out users to the dashboard (authGuard handles login)', () => {
        mockAuthService.isLoggedIn.mockReturnValue(false);
        TestBed.runInInjectionContext(() => adminGuard({} as any, {} as any));
        expect(mockRouter.createUrlTree).toHaveBeenCalledWith(['/dashboard']);
    });
});
