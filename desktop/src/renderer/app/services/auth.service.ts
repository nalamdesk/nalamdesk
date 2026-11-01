import { Injectable, Optional } from '@angular/core';
import { ServerConnectionService } from './server-connection.service';
import { logoutLandingHref } from '../../../shared/hash-app-path';

@Injectable({
    providedIn: 'root'
})
export class AuthService {
    private tokenKey = 'nalamdesk_token';
    private userKey = 'nalamdesk_user';

    /**
     * The single-PC app keeps the signed-in user across reloads. Server
     * clients keep it per tab, next to that tab's session tokens, so one
     * tab signing in or out never changes another.
     */
    private get userStore(): Storage {
        return window.electron ? localStorage : sessionStorage;
    }

    constructor(@Optional() private server?: ServerConnectionService) { }

    async login(username: string, password: string): Promise<{ success: boolean; error?: string; pendingRecoveryCode?: string }> {
        if (window.electron) {
            try {
                const result = await window.electron.login({ username, password });
                if (result.success) {
                    this.setUser(result.user);
                    return { success: true, pendingRecoveryCode: result.pendingRecoveryCode };
                } else {
                    return { success: false, error: result.error };
                }
            } catch (e: any) {
                return { success: false, error: e.message };
            }
        }
        if (!this.server) return { success: false, error: 'Network Error' };
        try {
            const result = await this.server.login(username, password);
            if (!result.ok) return { success: false, error: result.error };
            this.setUser(result.user);
            return { success: true };
        } catch (e: any) {
            return { success: false, error: e?.message === 'SERVER_UNREACHABLE' ? 'Network Error' : e?.message };
        }
    }

    async checkSetup(): Promise<{ isSetup: boolean, hasRecovery: boolean, vaultState?: string, configVersion?: number }> {
        if (window.electron) {
            return await window.electron.checkSetup();
        } else {
            // Web: Check API
            // For now assume true or implement API endpoint
            return { isSetup: true, hasRecovery: false };
        }
    }

    async setup(data: any): Promise<{ success: boolean, recoveryCode?: string, error?: string }> {
        if (window.electron) {
            return await window.electron.setup(data);
        }
        return { success: false, error: 'Web setup not supported yet' };
    }

    async recover(data: { recoveryCode: string }): Promise<{ success: boolean, pendingRecoveryCode?: string, error?: string }> {
        if (window.electron) {
            return await window.electron.recover(data);
        }
        return { success: false, error: 'Web recovery not supported yet' };
    }

    async acknowledgeRecoveryCode(recoveryCode: string): Promise<{ success: boolean }> {
        if (!window.electron) return { success: false };
        return await window.electron.acknowledgeRecoveryCode(recoveryCode);
    }

    async regenerateRecoveryCode(password: string): Promise<{ success: boolean, recoveryCode?: string, error?: string }> {
        if (window.electron) {
            return await window.electron.regenerateRecoveryCode(password);
        }
        return { success: false, error: 'Not supported' };
    }

    async changeLoginPassword(currentPassword: string, newPassword: string): Promise<{ success: boolean; error?: string }> {
        if (!window.electron) return { success: false, error: 'Not supported' };
        return window.electron.changeLoginPassword({ currentPassword, newPassword });
    }

    async resetUserPassword(
        targetUserId: number,
        currentAdminPassword: string,
        temporaryPassword: string
    ): Promise<{ success: boolean; error?: string }> {
        if (!window.electron) return { success: false, error: 'Not supported' };
        return window.electron.resetUserPassword({ targetUserId, currentAdminPassword, temporaryPassword });
    }

    async rotateDeviceEnvelope(currentPassword: string): Promise<{ success: boolean; error?: string }> {
        if (!window.electron) return { success: false, error: 'Not supported' };
        return window.electron.rotateDeviceEnvelope(currentPassword);
    }

    async logout(navigate: (url: string) => void = (url) => { window.location.replace(url); }): Promise<void> {
        if (window.electron?.logout) {
            await window.electron.logout();
        } else {
            await this.server?.logout();
        }
        localStorage.removeItem(this.tokenKey);
        this.userStore.removeItem(this.userKey);
        navigate(logoutLandingHref(window.location.href));
    }

    /** The server ended this session: forget the signed-in user here too. */
    forgetSession(): void {
        localStorage.removeItem(this.tokenKey);
        this.userStore.removeItem(this.userKey);
    }

    getUser() {
        const u = this.userStore.getItem(this.userKey);
        return u ? JSON.parse(u) : null;
    }

    private setUser(user: any) {
        const safeUser = {
            id: user?.id,
            username: user?.username,
            role: user?.role,
            name: user?.name,
            ...(user?.specialty ? { specialty: user.specialty } : {}),
            ...(user?.license_number ? { license_number: user.license_number } : {}),
            ...(user?.password_reset_required !== undefined
                ? { password_reset_required: user.password_reset_required }
                : {})
        };
        this.userStore.setItem(this.userKey, JSON.stringify(safeUser));
    }

    isLoggedIn() {
        // A server client is signed in only while this tab holds a session.
        if (!window.electron && this.server && !this.server.signedIn) {
            this.forgetSession();
            return false;
        }
        return !!this.getUser();
    }
}
