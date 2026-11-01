import * as crypto from 'crypto';

export interface UserSession {
    id: number;
    username: string;
    role: string;
    name: string;
    specialty?: string;
    license_number?: string;
    password_reset_required?: number;
    sessionId?: string;
    /** The facility this desktop session works in (#195); facility 1 when unset. */
    facilityId?: number;
}

export class SessionService {
    private currentUser: UserSession | null = null;

    setUser(user: UserSession) {
        if (user == null || user.id == null || typeof user.id !== 'number' || !user.username || !user.role || !user.name) {
            throw new Error('Invalid user session data');
        }
        this.currentUser = {
            id: user.id,
            username: user.username,
            role: user.role,
            name: user.name,
            ...(user.specialty ? { specialty: user.specialty } : {}),
            ...(user.license_number ? { license_number: user.license_number } : {}),
            ...(user.password_reset_required !== undefined ? { password_reset_required: user.password_reset_required } : {}),
            ...(user.facilityId ? { facilityId: user.facilityId } : {}),
            sessionId: crypto.randomUUID()
        };
    }

    getUser(): UserSession | null {
        return this.currentUser;
    }

    clearSession() {
        this.currentUser = null;
    }

    isAuthenticated(): boolean {
        return !!this.currentUser;
    }
}
