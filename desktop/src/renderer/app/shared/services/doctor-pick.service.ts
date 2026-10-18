import { Injectable, signal } from '@angular/core';

/**
 * App-wide attending-doctor picker for admin-initiated consultations.
 * Rendered once in the main layout; any host awaits `request()`.
 *
 * - No doctors -> resolves null (host shows the no-practitioner error).
 * - Exactly one doctor -> resolves immediately with the standing reason
 *   (no choice is being made, so no justification is asked).
 * - Several doctors -> opens the modal; resolves the chosen id plus the
 *   admin's typed reason, or null on cancel. The reason is audit-logged
 *   with the encounter (KB-1: picker-reason audit).
 */
export interface AttendingPick {
    id: number;
    reason: string;
}

/** Standing reason when there is no choice to justify. */
export const SOLE_PRACTITIONER_REASON = 'Only active practitioner on file';

@Injectable({
    providedIn: 'root'
})
export class DoctorPickService {
    readonly open = signal(false);
    readonly doctors = signal<any[]>([]);
    readonly reasonInput = signal('');
    readonly reasonError = signal(false);

    // Every concurrent request is tracked: two consult starts racing the same
    // modal must both settle. They share the chosen attending doctor, which is
    // safe because the admin explicitly selected that practitioner and each
    // encounter records its own provenance.
    private pendingPicks: Array<(pick: AttendingPick | null) => void> = [];

    request(doctors: any[]): Promise<AttendingPick | null> {
        const list = doctors || [];
        if (list.length === 0) return Promise.resolve(null);
        if (list.length === 1) {
            return Promise.resolve({ id: list[0].id, reason: SOLE_PRACTITIONER_REASON });
        }
        this.reasonInput.set('');
        this.reasonError.set(false);
        this.doctors.set(list);
        this.open.set(true);
        return new Promise<AttendingPick | null>((resolve) => {
            this.pendingPicks.push(resolve);
        });
    }

    choose(id: number | null): void {
        const reason = this.reasonInput().trim();
        if (id != null && !reason) {
            this.reasonError.set(true);
            return;
        }
        this.open.set(false);
        this.doctors.set([]);
        this.reasonInput.set('');
        this.reasonError.set(false);
        const waiting = this.pendingPicks;
        this.pendingPicks = [];
        waiting.forEach((resolve) => resolve(id == null ? null : { id, reason }));
    }
}
