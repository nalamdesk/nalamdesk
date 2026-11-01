/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AuthService } from './auth.service';

describe('AuthService', () => {
    let service: AuthService;

    beforeEach(() => {
        service = new AuthService();
        localStorage.clear();
        sessionStorage.clear();
        vi.restoreAllMocks();
    });

    afterEach(() => {
        delete (window as any).electron;
    });

    describe('login (Electron Mode)', () => {
        it('should login successfully via electron IPC', async () => {
            // Mock window.electron
            (window as any).electron = {
                login: vi.fn().mockResolvedValue({ success: true, user: { id: 1, role: 'admin' } })
            };

            const result = await service.login('admin', 'pass');
            expect(result.success).toBe(true);
            expect(service.getUser()).toEqual({ id: 1, role: 'admin' });
            expect(window.electron.login).toHaveBeenCalledWith({ username: 'admin', password: 'pass' });
        });

        it('preserves a one-time migration recovery code for acknowledgement', async () => {
            (window as any).electron = {
                login: vi.fn().mockResolvedValue({
                    success: true,
                    user: { id: 1, role: 'admin' },
                    pendingRecoveryCode: 'AAAA-BBBB-CCCC-DDDD'
                })
            };
            await expect(service.login('admin', 'legacy')).resolves.toMatchObject({
                success: true,
                pendingRecoveryCode: 'AAAA-BBBB-CCCC-DDDD'
            });
        });

        it('sends the exact displayed recovery code when acknowledging', async () => {
            (window as any).electron = {
                acknowledgeRecoveryCode: vi.fn().mockResolvedValue({ success: true })
            };
            await expect(service.acknowledgeRecoveryCode('AAAA-BBBB-CCCC-DDDD'))
                .resolves.toEqual({ success: true });
            expect(window.electron.acknowledgeRecoveryCode)
                .toHaveBeenCalledWith('AAAA-BBBB-CCCC-DDDD');
        });

        it('fails closed when recovery acknowledgement IPC is unavailable', async () => {
            await expect(service.acknowledgeRecoveryCode('AAAA-BBBB-CCCC-DDDD'))
                .resolves.toEqual({ success: false });
        });

        it('should handle login failure', async () => {
            (window as any).electron = {
                login: vi.fn().mockResolvedValue({ success: false, error: 'Invalid' })
            };

            const result = await service.login('admin', 'wrong');
            expect(result.success).toBe(false);
            expect(result.error).toBe('Invalid');
            expect(service.getUser()).toBeNull();
        });

        it('should catch ipc errors', async () => {
            (window as any).electron = {
                login: vi.fn().mockRejectedValue(new Error('IPC Error'))
            };
            const result = await service.login('a', 'b');
            expect(result.success).toBe(false);
            expect(result.error).toBe('IPC Error');
        });

        it('never persists a password hash returned by a compromised IPC payload', async () => {
            (window as any).electron = {
                login: vi.fn().mockResolvedValue({
                    success: true,
                    user: { id: 1, username: 'admin', role: 'admin', name: 'Admin', password: '$argon2id$hash' }
                })
            };
            await service.login('admin', 'pass');
            expect((service.getUser() as any).password).toBeUndefined();
            expect(localStorage.getItem('nalamdesk_user')).not.toContain('$argon2id$hash');
        });

        it('uses distinct IPC contracts for login, staff reset, device, and recovery rotation', async () => {
            (window as any).electron = {
                changeLoginPassword: vi.fn().mockResolvedValue({ success: true }),
                resetUserPassword: vi.fn().mockResolvedValue({ success: true }),
                rotateDeviceEnvelope: vi.fn().mockResolvedValue({ success: true }),
                regenerateRecoveryCode: vi.fn().mockResolvedValue({ success: true, recoveryCode: 'CODE' })
            };
            await service.changeLoginPassword('current', 'replacement');
            await service.resetUserPassword(2, 'admin-current', 'temporary');
            await service.rotateDeviceEnvelope('admin-current');
            await service.regenerateRecoveryCode('admin-current');

            expect(window.electron.changeLoginPassword).toHaveBeenCalledWith({
                currentPassword: 'current', newPassword: 'replacement'
            });
            expect(window.electron.resetUserPassword).toHaveBeenCalledWith({
                targetUserId: 2, currentAdminPassword: 'admin-current', temporaryPassword: 'temporary'
            });
            expect(window.electron.rotateDeviceEnvelope).toHaveBeenCalledWith('admin-current');
            expect(window.electron.regenerateRecoveryCode).toHaveBeenCalledWith('admin-current');
        });
    });

    describe('login (server client)', () => {
        it('signs in through the server connection', async () => {
            const server = { login: vi.fn().mockResolvedValue({ ok: true, user: { id: 2, username: 'user', role: 'doctor', password: 'hash' } }) };
            service = new AuthService(server as any);
            const result = await service.login('user', 'pass');
            expect(result.success).toBe(true);
            expect(server.login).toHaveBeenCalledWith('user', 'pass');
            expect(service.getUser()).toEqual({ id: 2, username: 'user', role: 'doctor' });
        });

        it('returns the server error code', async () => {
            const server = { login: vi.fn().mockResolvedValue({ ok: false, error: 'TOO_MANY_ATTEMPTS' }) };
            service = new AuthService(server as any);
            expect(await service.login('u', 'p')).toEqual({ success: false, error: 'TOO_MANY_ATTEMPTS' });
            expect(service.getUser()).toBeNull();
        });

        it('treats a tab without a server session as signed out, leaving other tabs alone', () => {
            localStorage.setItem('nalamdesk_user', JSON.stringify({ id: 9 }));
            sessionStorage.setItem('nalamdesk_user', JSON.stringify({ id: 1 }));
            service = new AuthService({ signedIn: false } as any);
            expect(service.isLoggedIn()).toBe(false);
            expect(sessionStorage.getItem('nalamdesk_user')).toBeNull();
            expect(localStorage.getItem('nalamdesk_user')).toBe(JSON.stringify({ id: 9 }));
            sessionStorage.setItem('nalamdesk_user', JSON.stringify({ id: 1 }));
            service = new AuthService({ signedIn: true } as any);
            expect(service.isLoggedIn()).toBe(true);
            expect(service.getUser()).toEqual({ id: 1 });
            localStorage.clear();
            sessionStorage.clear();
        });

        it('reports an unreachable server as a network error', async () => {
            const server = { login: vi.fn().mockRejectedValue(new Error('SERVER_UNREACHABLE')) };
            service = new AuthService(server as any);
            expect(await service.login('u', 'p')).toEqual({ success: false, error: 'Network Error' });
        });
    });

    describe('Session Management', () => {
        it('should logout by clearing storage', async () => {
            const server = { logout: vi.fn().mockResolvedValue(undefined) };
            service = new AuthService(server as any);
            service['setUser']({ id: 1 });
            localStorage.setItem('nalamdesk_token', 'test-token');
            expect(service.getUser()).toBeTruthy();

            const navigate = vi.fn();
            await service.logout(navigate);
            expect(server.logout).toHaveBeenCalledOnce();
            expect(localStorage.getItem('nalamdesk_user')).toBeNull();
            expect(localStorage.getItem('nalamdesk_token')).toBeNull();
            expect(navigate).toHaveBeenCalled();
            expect(String(navigate.mock.calls[0][0])).toContain('#/login');
        });

        it('calls auth:logout IPC then lands on hash login instead of reloading settings', async () => {
            const logout = vi.fn().mockResolvedValue({ success: true });
            (window as any).electron = { logout };
            service['setUser']({ id: 1, username: 'admin', role: 'admin', name: 'Admin' });
            expect(localStorage.getItem('nalamdesk_user')).not.toBeNull();
            const navigate = vi.fn();
            await service.logout(navigate);
            expect(logout).toHaveBeenCalledOnce();
            expect(localStorage.getItem('nalamdesk_user')).toBeNull();
            expect(navigate).toHaveBeenCalled();
            expect(String(navigate.mock.calls[0][0])).toContain('#/login');
            expect(String(navigate.mock.calls[0][0])).not.toContain('#/settings');
        });

        it('keeps the principal when auth:logout IPC fails', async () => {
            const logout = vi.fn().mockRejectedValue(new Error('IPC Error'));
            (window as any).electron = { logout };
            service['setUser']({ id: 1, username: 'admin', role: 'admin', name: 'Admin' });
            localStorage.setItem('nalamdesk_token', 'test-token');
            const navigate = vi.fn();
            await expect(service.logout(navigate)).rejects.toThrow('IPC Error');
            expect(service.getUser()).toEqual(expect.objectContaining({
                id: 1, username: 'admin', role: 'admin', name: 'Admin'
            }));
            expect(localStorage.getItem('nalamdesk_token')).toBe('test-token');
            expect(navigate).not.toHaveBeenCalled();
        });
    });
});
