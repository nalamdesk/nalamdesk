import { Injectable, signal } from '@angular/core';
import { Router } from '@angular/router';

export interface TourStep {
    route: string;
    /** Primary spotlight target; the card centers when absent. */
    selector: string;
    title: string;
    body: string;
}

const TOUR_DISMISSED_KEY = 'nd.tour.dismissed';

/**
 * Classic guided product tour: route-hopping spotlight steps with Back /
 * Next / Skip, resumable from the user menu. Steps target page chrome
 * (component hosts, stat cards) so the tour works with or without demo
 * data. Progress is intentionally not persisted mid-tour: a skipped or
 * finished tour records dismissal; anything else restarts from step one.
 */
@Injectable({
    providedIn: 'root'
})
export class TourService {
    private readonly _index = signal<number | null>(null);
    private readonly _role = signal<string>('');
    readonly index = this._index.asReadonly();

    constructor(private readonly router: Router) { }

    private static readonly BASE_STEPS: TourStep[] = [
        {
            route: '/dashboard',
            selector: 'app-dashboard .stat',
            title: 'Practice at a glance',
            body: 'Patient totals, today\u2019s visits, and online booking requests land here first. This is your morning starting point.'
        },
        {
            route: '/queue',
            selector: 'app-queue',
            title: 'Today\u2019s queue',
            body: 'Walk-ins check in here. Triage urgency, reorder, call the next patient, and begin the consultation from this list.'
        },
        {
            route: '/patients',
            selector: 'app-patient-list',
            title: 'Patient records',
            body: 'Search, register, and open charts here. Every allergy, condition, and prescription lives on the patient chart.'
        },
        {
            route: '/visits',
            selector: 'app-visit-list',
            title: 'Visit history',
            body: 'Completed encounters accumulate here for review, follow-up, and daily reconciliation.'
        },
        {
            route: '/online-booking',
            selector: 'app-online-booking',
            title: 'Online bookings',
            body: 'Accept web booking requests into confirmed appointments. Accept books first, then marks the request done.'
        }
    ];

    private static readonly ADMIN_STEP: TourStep = {
        route: '/settings',
        selector: 'app-settings',
        title: 'Clinic settings',
        body: 'As admin you manage users, custom roles, ABDM gateway keys, backups, and demo data from Settings.'
    };

    stepsFor(role: string): TourStep[] {
        return role === 'admin'
            ? [...TourService.BASE_STEPS, TourService.ADMIN_STEP]
            : [...TourService.BASE_STEPS];
    }

    get dismissed(): boolean {
        try {
            return localStorage.getItem(TOUR_DISMISSED_KEY) === '1';
        } catch {
            return false;
        }
    }

    start(role: string): void {
        this._role.set(role || '');
        this._index.set(0);
        void this.router.navigate([this.current()!.route]);
    }

    current(): TourStep | null {
        const at = this._index();
        if (at == null) return null;
        const steps = this.stepsFor(this._role());
        return steps[at] ?? null;
    }

    stepCount(): number {
        return this.stepsFor(this._role()).length;
    }

    position(): number {
        return this._index() ?? 0;
    }

    isActive(): boolean {
        return this._index() != null;
    }

    next(): void {
        const at = this._index();
        if (at == null) return;
        if (at + 1 >= this.stepCount()) {
            this.finish();
            return;
        }
        this._index.set(at + 1);
        void this.router.navigate([this.current()!.route]);
    }

    back(): void {
        const at = this._index();
        if (at == null || at === 0) return;
        this._index.set(at - 1);
        void this.router.navigate([this.current()!.route]);
    }

    skip(): void {
        this.dismiss();
        this._index.set(null);
    }

    finish(): void {
        this.dismiss();
        this._index.set(null);
        void this.router.navigate(['/dashboard']);
    }

    private dismiss(): void {
        try {
            localStorage.setItem(TOUR_DISMISSED_KEY, '1');
        } catch { /* private-mode browsers: tour simply reappears */ }
    }
}
