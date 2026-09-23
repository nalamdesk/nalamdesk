import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProfileComponent } from './profile.component';

describe('ProfileComponent', () => {
    let mockAuthService: any;
    let mockRouter: any;
    let component: ProfileComponent;

    beforeEach(() => {
        mockAuthService = {
            getUser: vi.fn().mockReturnValue({ name: 'Divya Suresh', role: 'nurse' }),
            changeLoginPassword: vi.fn()
        };
        mockRouter = { navigate: vi.fn() };
        component = new ProfileComponent(mockAuthService, mockRouter);
    });

    it('rejects weak and mismatched passwords without calling the service', async () => {
        component.currentPassword = 'old-secret';
        component.newPassword = 'short';
        component.confirmPassword = 'short';
        await component.changePassword();
        expect(component.formError).toContain('at least 6 characters');
        expect(mockAuthService.changeLoginPassword).not.toHaveBeenCalled();

        component.newPassword = 'new-secret-1';
        component.confirmPassword = 'new-secret-2';
        await component.changePassword();
        expect(component.formError).toContain('do not match');
        expect(mockAuthService.changeLoginPassword).not.toHaveBeenCalled();
    });

    it('changes the password and clears the form', async () => {
        mockAuthService.changeLoginPassword.mockResolvedValue({ success: true });
        const toast = { success: vi.fn() };
        (component as any).toastService = toast;
        component.currentPassword = 'old-secret';
        component.newPassword = 'new-secret-1';
        component.confirmPassword = 'new-secret-1';

        await component.changePassword();

        expect(mockAuthService.changeLoginPassword).toHaveBeenCalledWith('old-secret', 'new-secret-1');
        expect(toast.success).toHaveBeenCalledWith(expect.anything(), 'Password changed');
        expect(component.newPassword).toBe('');
        expect(component.saving).toBe(false);
    });

    it('surfaces service failures in a dialog', async () => {
        mockAuthService.changeLoginPassword.mockResolvedValue({ success: false, error: 'Wrong current password' });
        const dialog = { open: vi.fn().mockResolvedValue(undefined) };
        (component as any).dialogService = dialog;
        component.currentPassword = 'wrong';
        component.newPassword = 'new-secret-1';
        component.confirmPassword = 'new-secret-1';

        await component.changePassword();

        expect(dialog.open).toHaveBeenCalledWith(expect.objectContaining({ title: 'Change failed', type: 'error' }));
        expect(component.saving).toBe(false);
    });
});
