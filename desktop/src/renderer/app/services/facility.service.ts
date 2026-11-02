import { Injectable, Optional, computed, signal } from '@angular/core';
import { AuthService } from './auth.service';
import { ServerConnectionService } from './server-connection.service';

const LAST_FACILITY_PREFIX = 'nalamdesk_last_facility:';

export type SwitchResult = { ok: true } | { ok: false; error: string };

/**
 * Which facility the session works in, and the facilities the user may
 * switch to (#195, #214). The single-PC app asks its main process; server
 * clients ask the server, which reissues the session's token.
 */
@Injectable({ providedIn: 'root' })
export class FacilityService {
    readonly facilities = signal<FacilityGrant[]>([]);
    readonly currentId = signal<number | null>(null);
    readonly current = computed(() => this.facilities().find(f => f.id === this.currentId()) ?? null);
    /** The switcher only appears when there is somewhere to switch to. */
    readonly canSwitch = computed(() => this.facilities().length > 1);

    constructor(private readonly auth: AuthService, @Optional() private readonly server?: ServerConnectionService) { }

    /** Takes the facilities a sign-in returned, so the picker needs no extra call. */
    seed(facilityId: number | undefined, facilities: FacilityGrant[] | undefined): void {
        this.facilities.set(facilities ?? []);
        this.currentId.set(facilityId ?? null);
    }

    async load(): Promise<void> {
        try {
            const result = window.electron
                ? await window.electron.getFacilities()
                : await this.server?.call<{ facilityId: number; facilities: FacilityGrant[] }>('GET', '/api/auth/facilities');
            if (!result) return;
            this.seed(Number(result.facilityId), Array.isArray(result.facilities) ? result.facilities : []);
        } catch {
            // Older servers have no facilities: the shell stays as it was.
        }
    }

    async switchTo(facilityId: number): Promise<SwitchResult> {
        try {
            let role: string;
            if (window.electron) {
                const result = await window.electron.switchFacility(facilityId);
                if (!result?.success) return { ok: false, error: result?.error ?? 'NO_FACILITY_ACCESS' };
                role = result.user?.role;
            } else if (this.server) {
                role = (await this.server.switchFacility(facilityId)).role;
            } else {
                return { ok: false, error: 'NOT_SIGNED_IN' };
            }
            this.auth.applyFacility(facilityId, role);
            this.currentId.set(facilityId);
            this.remember(facilityId);
            return { ok: true };
        } catch (e: any) {
            return { ok: false, error: e?.message || 'SWITCH_FAILED' };
        }
    }

    /** The facility this user picked last time on this computer, if they still have it. */
    lastUsed(): number | null {
        const username = this.auth.getUser()?.username;
        if (!username) return null;
        try {
            const id = Number(localStorage.getItem(LAST_FACILITY_PREFIX + username));
            return this.facilities().some(f => f.id === id) ? id : null;
        } catch {
            return null;
        }
    }

    remember(facilityId: number): void {
        const username = this.auth.getUser()?.username;
        if (!username) return;
        try {
            localStorage.setItem(LAST_FACILITY_PREFIX + username, String(facilityId));
        } catch { /* a preference only */ }
    }
}

/** Plain-language label for a facility role. */
export function roleLabel(role: string | null | undefined): string {
    const text = String(role ?? '');
    return text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
}
