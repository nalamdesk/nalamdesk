import { Component, NgZone, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DataService } from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { DialogService } from '../shared/services/dialog.service';
import { ReasonDialogComponent } from '../shared/components/reason-dialog/reason-dialog.component';

interface DayRow {
    id: number;
    patient_id: number;
    patient_name: string;
    patient_mobile: string;
    date: string;
    time: string;
    reason: string;
    status: string;
    status_reason?: string;
    original_date?: string;
    original_time?: string;
    queue_entry_id?: number;
    visit_id?: number;
}

@Component({
    selector: 'app-appointments',
    standalone: true,
    imports: [CommonModule, FormsModule, ReasonDialogComponent],
    template: `
    <div class="h-full bg-gray-100 p-4 md:p-6 flex flex-col overflow-hidden">
      <div class="flex flex-wrap items-end justify-between gap-2 mb-4">
        <div>
          <h1 class="text-2xl font-bold text-gray-800">Appointments</h1>
          <p class="text-sm text-gray-500">{{ rows.length }} bookings · {{ counts }}</p>
        </div>
        <div class="flex items-center gap-2">
          <input type="date" [(ngModel)]="day" (ngModelChange)="load()" aria-label="Appointment day"
                 class="border border-gray-300 rounded-md px-2.5 py-1.5 text-sm bg-white" />
          <button (click)="openCreate()" class="bg-blue-600 text-white px-4 py-1.5 rounded-md hover:bg-blue-700 text-sm font-medium">
            + Book
          </button>
        </div>
      </div>

      <div class="flex-1 overflow-y-auto space-y-2 pb-4">
        <div *ngIf="rows.length === 0" class="text-center text-sm text-gray-500 py-8">No bookings for this day</div>
        <div *ngFor="let r of rows" class="bg-white rounded-lg border border-gray-200 p-3 shadow-sm">
          <div class="flex items-center gap-3">
            <div class="text-sm font-mono font-bold text-gray-700 w-12 shrink-0">{{ r.time || '--:--' }}</div>
            <div class="min-w-0 flex-1">
              <div class="font-bold text-gray-800 truncate">{{ r.patient_name || 'Unknown patient' }}</div>
              <div class="text-xs text-gray-500 truncate">{{ r.reason || 'No reason recorded' }}</div>
              <div *ngIf="r.original_date || r.original_time" class="text-[11px] text-amber-600">
                Moved from {{ r.original_date }} {{ r.original_time }}
              </div>
            </div>
            <span class="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full shrink-0" [ngClass]="statusClass(r.status)">
              {{ r.status }}
            </span>
          </div>
          <div class="mt-2 flex flex-wrap items-center gap-1.5">
            <button *ngIf="r.status === 'booked'" (click)="transition(r, 'confirmed')" class="btn btn-xs btn-ghost border border-gray-200">Confirm</button>
            <button *ngIf="r.status === 'confirmed'" (click)="checkIn(r)" class="btn btn-xs btn-primary">Check in</button>
            <button *ngIf="canFulfill(r)" (click)="toggleLink(r)" class="btn btn-xs btn-ghost border border-gray-200">Link visit</button>
            <button *ngIf="canReschedule(r)" (click)="openReschedule(r)" class="btn btn-xs btn-ghost border border-gray-200">Reschedule</button>
            <button *ngIf="canCancel(r)" (click)="askReason(r, 'cancelled')" class="btn btn-xs btn-ghost border border-red-200 text-red-600">Cancel</button>
            <button *ngIf="r.status === 'confirmed' || r.status === 'arrived'" (click)="askReason(r, 'no-show')" class="btn btn-xs btn-ghost border border-gray-200">No-show</button>
            <button (click)="toggleHistory(r)" class="btn btn-xs btn-ghost text-gray-500">History</button>
          </div>
          <div *ngIf="linkingId === r.id" class="mt-2 border-t border-gray-100 pt-2 text-xs text-gray-600 space-y-1">
            <div *ngIf="(linkCandidates[r.id] || []).length === 0" class="text-gray-400">No finished, unlinked visits for this patient yet</div>
            <div *ngFor="let v of linkCandidates[r.id]" class="flex items-center justify-between gap-2">
              <span>Visit #{{ v.id }} · {{ v.started_at || v.created_at || '' }} · {{ v.diagnosis || 'no diagnosis' }}</span>
              <button (click)="fulfill(r, v)" [disabled]="linkingBusy" class="btn btn-xs btn-primary disabled:opacity-50">Link</button>
            </div>
          </div>
          <div *ngIf="expandedId === r.id" class="mt-2 border-t border-gray-100 pt-2 text-xs text-gray-600 space-y-1">
            <div *ngIf="(history[r.id] || []).length === 0" class="text-gray-400">No history yet</div>
            <div *ngFor="let h of history[r.id]">
              <span class="font-mono">{{ h.created_at }}</span>
              {{ h.from_status }} → <b>{{ h.to_status }}</b>
              <span *ngIf="h.reason" class="text-gray-500">· {{ h.reason }}</span>
              <span *ngIf="h.actor_name" class="text-gray-400">· {{ h.actor_name }}</span>
            </div>
            <div *ngIf="r.status_reason" class="text-gray-500">Reason: {{ r.status_reason }}</div>
          </div>
        </div>
      </div>

      <div *ngIf="showCreate" class="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
        <div class="bg-white rounded-lg w-full max-w-md shadow-xl overflow-hidden">
          <div class="px-6 py-4 border-b bg-gray-50">
            <h2 class="text-lg font-bold text-gray-800">{{ rescheduling ? 'Reschedule booking' : 'Book appointment' }}</h2>
          </div>
          <div class="p-6 space-y-3" *ngIf="!rescheduling">
            <input [(ngModel)]="form.patientQuery" (ngModelChange)="searchPatients()" placeholder="Search patient by name or mobile"
                   class="w-full border p-2 rounded text-sm outline-none focus:ring-2 focus:ring-blue-500" />
            <div *ngIf="patientHits.length > 0" class="border rounded max-h-32 overflow-y-auto text-sm">
              <button *ngFor="let p of patientHits" (click)="pickPatient(p)" class="block w-full text-left px-3 py-1.5 hover:bg-blue-50">
                {{ p.name }} <span class="text-gray-400 text-xs">{{ p.mobile }}</span>
              </button>
            </div>
            <p *ngIf="form.patientId" class="text-xs text-green-700">Patient #{{ form.patientId }} selected</p>
          </div>
          <div class="p-6 space-y-3">
            <div class="grid grid-cols-2 gap-2">
              <input type="date" [(ngModel)]="form.date" (ngModelChange)="checkConflicts()" class="border p-2 rounded text-sm" />
              <input type="time" [(ngModel)]="form.time" (ngModelChange)="checkConflicts()" class="border p-2 rounded text-sm" />
            </div>
            <input [(ngModel)]="form.reason" placeholder="Reason for visit (optional)" class="w-full border p-2 rounded text-sm" />
            <div *ngIf="conflicts.length > 0" class="rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
              {{ conflicts.length }} overlapping booking(s). Saving proceeds as an explicit override.
            </div>
          </div>
          <div class="px-6 py-3 border-t bg-gray-50 flex justify-end gap-2">
            <button (click)="closeCreate()" class="px-4 py-2 text-sm text-gray-600 hover:bg-gray-200 rounded border bg-white">Cancel</button>
            <button (click)="saveBooking()" [disabled]="(!rescheduling && !form.patientId) || !form.date || !form.time || saving"
                    class="px-4 py-2 text-sm text-white font-medium rounded bg-blue-600 hover:bg-blue-700 disabled:opacity-50">{{ saving ? 'Saving…' : 'Save' }}</button>
          </div>
        </div>
      </div>

      <app-reason-dialog
        [open]="showReasonDialog"
        [title]="reasonTitle"
        message="Recorded in history and audit with your name."
        placeholder="Reason (required)"
        [confirmText]="reasonTarget === 'cancelled' ? 'Cancel booking' : 'Mark no-show'"
        (decided)="onReasonDecided($event)">
      </app-reason-dialog>
    </div>
  `
})
export class AppointmentsComponent implements OnInit {
    private dataService: DataService = inject(DataService);
    private authService: AuthService = inject(AuthService, { optional: true }) as any;
    private dialogService = inject(DialogService, { optional: true } as any) as any;

    /** Clinic-local day (YYYY-MM-DD): UTC dates open on the wrong day abroad. */
    day = localDay();
    rows: DayRow[] = [];
    loading = false;
    expandedId: number | null = null;
    history: Record<number, any[]> = {};

    showCreate = false;
    saving = false;
    rescheduling: DayRow | null = null;
    form = { patientQuery: '', patientId: null as number | null, date: '', time: '', reason: '' };
    patientHits: any[] = [];
    conflicts: any[] = [];

    showReasonDialog = false;
    reasonTitle = '';
    reasonTarget: 'cancelled' | 'no-show' = 'cancelled';
    reasonRow: DayRow | null = null;

    linkingId: number | null = null;
    linkCandidates: Record<number, any[]> = {};
    linkingBusy = false;

    private loadSeq = 0;
    private searchSeq = 0;
    private conflictSeq = 0;

    ngOnInit() {
        void this.load();
    }

    get counts(): string {
        const c: Record<string, number> = {};
        for (const r of this.rows) c[r.status] = (c[r.status] || 0) + 1;
        return Object.entries(c).map(([k, v]) => `${v} ${k}`).join(' · ') || 'none';
    }

    statusClass(status: string): string {
        switch (status) {
            case 'confirmed': return 'bg-blue-100 text-blue-700';
            case 'arrived': return 'bg-green-100 text-green-700';
            case 'fulfilled': return 'bg-gray-200 text-gray-600';
            case 'cancelled': return 'bg-red-100 text-red-600';
            case 'no-show': return 'bg-amber-100 text-amber-700';
            default: return 'bg-gray-100 text-gray-600';
        }
    }

    canReschedule(r: DayRow): boolean {
        return ['proposed', 'booked', 'confirmed'].includes(r.status);
    }

    canCancel(r: DayRow): boolean {
        return !['fulfilled', 'cancelled', 'no-show'].includes(r.status);
    }

    /** Only the treating roles close a booking against a finished visit. */
    canFulfill(r: DayRow): boolean {
        if (r.status !== 'arrived') return false;
        const role = this.authService?.getUser?.()?.role;
        return role === 'doctor' || role === 'admin';
    }

    async toggleLink(r: DayRow): Promise<void> {
        if (this.linkingId === r.id) {
            this.linkingId = null;
            return;
        }
        this.linkingId = r.id;
        this.linkCandidates[r.id] = [];
        try {
            const visits = await this.dataService.invoke<any[]>('getVisits', r.patient_id) || [];
            const finished = visits.filter((v: any) => String(v.status || '') === 'finished');
            const free: any[] = [];
            for (const v of finished) {
                try {
                    const linked = await this.dataService.invoke<any>('getAppointmentByVisit', v.id);
                    if (!linked) free.push(v);
                } catch {
                    free.push(v);
                }
            }
            this.linkCandidates[r.id] = free;
        } catch (e) {
            console.error('Failed to load linkable visits', e);
        }
    }

    async fulfill(r: DayRow, visit: any): Promise<void> {
        if (this.linkingBusy) return;
        this.linkingBusy = true;
        try {
            await this.dataService.invoke('fulfillAppointment', { id: r.id, visitId: visit.id });
            this.linkingId = null;
            await this.refreshHistory(r.id);
            await this.load();
        } catch (e) {
            await this.dialogService?.open({
                title: 'Link failed',
                message: e instanceof Error ? e.message : 'Could not link the visit.',
                type: 'error'
            });
        } finally {
            this.linkingBusy = false;
        }
    }

    async load(): Promise<void> {
        const seq = ++this.loadSeq;
        const day = this.day;
        this.loading = true;
        try {
            const rows = await this.dataService.invoke<any[]>('getAppointments', day);
            // Stale LAN responses must not overwrite a newer day selection.
            if (seq !== this.loadSeq || day !== this.day) return;
            this.rows = rows || [];
        } catch (e) {
            console.error('Failed to load appointments', e);
        } finally {
            if (seq === this.loadSeq) this.loading = false;
        }
    }

    async toggleHistory(r: DayRow): Promise<void> {
        if (this.expandedId === r.id) {
            this.expandedId = null;
            return;
        }
        this.expandedId = r.id;
        await this.refreshHistory(r.id);
    }

    /** Reloads one booking's history, clearing it after writes (Greptile #5). */
    private async refreshHistory(id: number): Promise<void> {
        if (this.expandedId !== id) {
            delete this.history[id];
            return;
        }
        try {
            this.history[id] = await this.dataService.invoke<any[]>('getAppointmentHistory', id) || [];
        } catch {
            this.history[id] = [];
        }
    }

    async transition(r: DayRow, to: string, reason?: string): Promise<void> {
        try {
            await this.dataService.invoke('transitionAppointment', { id: r.id, to, reason });
            await this.refreshHistory(r.id);
            await this.load();
        } catch (e) {
            await this.dialogService?.open({
                title: 'Update failed',
                message: e instanceof Error ? e.message : 'Could not update the booking.',
                type: 'error'
            });
        }
    }

    async checkIn(r: DayRow): Promise<void> {
        try {
            await this.dataService.invoke('checkInAppointment', r.id);
            await this.refreshHistory(r.id);
            await this.load();
        } catch (e) {
            await this.dialogService?.open({
                title: 'Check-in failed',
                message: e instanceof Error ? e.message : 'Could not check in.',
                type: 'error'
            });
        }
    }

    askReason(r: DayRow, target: 'cancelled' | 'no-show'): void {
        this.reasonRow = r;
        this.reasonTarget = target;
        this.reasonTitle = target === 'cancelled' ? 'Cancel booking' : 'Mark no-show';
        this.showReasonDialog = true;
    }

    async onReasonDecided(reason: string | null): Promise<void> {
        this.showReasonDialog = false;
        const row = this.reasonRow;
        this.reasonRow = null;
        if (!reason || !row) return;
        await this.transition(row, this.reasonTarget, reason);
    }

    openCreate(): void {
        this.rescheduling = null;
        this.form = { patientQuery: '', patientId: null, date: this.day, time: '', reason: '' };
        this.patientHits = [];
        this.conflicts = [];
        this.showCreate = true;
    }

    openReschedule(r: DayRow): void {
        this.rescheduling = r;
        this.form = { patientQuery: '', patientId: r.patient_id, date: r.date, time: r.time, reason: r.reason || '' };
        this.conflicts = [];
        this.showCreate = true;
        void this.checkConflicts();
    }

    closeCreate(): void {
        this.showCreate = false;
        this.rescheduling = null;
    }

    async searchPatients(): Promise<void> {
        // A fresh keystroke voids the previous pick: saving must name the
        // patient shown in the field, never a stale selection (Greptile #1).
        this.form.patientId = null;
        const seq = ++this.searchSeq;
        const q = this.form.patientQuery.trim();
        if (q.length < 2) {
            this.patientHits = [];
            return;
        }
        try {
            const hits = await this.dataService.invoke<any[]>('getPatients', q) || [];
            if (seq !== this.searchSeq) return;
            this.patientHits = hits;
        } catch {
            if (seq !== this.searchSeq) return;
            this.patientHits = [];
        }
    }

    pickPatient(p: any): void {
        this.form.patientId = Number(p.id);
        this.form.patientQuery = p.name;
        this.patientHits = [];
    }

    async checkConflicts(): Promise<void> {
        if (!this.form.date || !this.form.time) {
            this.conflicts = [];
            return;
        }
        const seq = ++this.conflictSeq;
        const date = this.form.date;
        const time = this.form.time;
        try {
            const found = await this.dataService.invoke<any[]>('detectConflicts', {
                date,
                time,
                excludeId: this.rescheduling?.id
            }) || [];
            if (seq !== this.conflictSeq || date !== this.form.date || time !== this.form.time) return;
            this.conflicts = found;
        } catch {
            if (seq !== this.conflictSeq) return;
            this.conflicts = [];
        }
    }

    async saveBooking(): Promise<void> {
        // Double clicks must not book twice: one request at a time (Greptile #2).
        if (this.saving) return;
        this.saving = true;
        try {
            if (this.rescheduling) {
                await this.dataService.invoke('saveAppointment', {
                    id: this.rescheduling.id,
                    date: this.form.date,
                    time: this.form.time,
                    reason: this.form.reason
                });
                const moved = this.rescheduling;
                this.closeCreate();
                // Follow a cross-day move to the booking's new day.
                this.day = this.form.date || this.day;
                await this.refreshHistory(moved.id);
                await this.load();
            } else {
                await this.dataService.invoke('saveAppointment', {
                    patient_id: this.form.patientId,
                    date: this.form.date,
                    time: this.form.time,
                    reason: this.form.reason
                });
                this.closeCreate();
                await this.load();
            }
        } catch (e) {
            await this.dialogService?.open({
                title: 'Save failed',
                message: e instanceof Error ? e.message : 'Could not save the booking.',
                type: 'error'
            });
        } finally {
            this.saving = false;
        }
    }
}

/** Clinic-local day as YYYY-MM-DD (Greptile #6: UTC opens the wrong day). */
function localDay(when: Date = new Date()): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;
}
