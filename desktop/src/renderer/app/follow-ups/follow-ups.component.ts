import { Component, NgZone, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { DataService } from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { ToastService } from '../shared/services/toast.service';
import { QueueCountService } from '../shared/services/queue-count.service';

export type FollowUpBucket = 'overdue' | 'today' | 'upcoming';

export function followUpBucket(daysUntilDue: number): FollowUpBucket {
  if (daysUntilDue < 0) return 'overdue';
  if (daysUntilDue === 0) return 'today';
  return 'upcoming';
}

export function followUpLabel(daysUntilDue: number): string {
  if (daysUntilDue < -1) return `${-daysUntilDue} days overdue`;
  if (daysUntilDue === -1) return '1 day overdue';
  if (daysUntilDue === 0) return 'Due today';
  if (daysUntilDue === 1) return 'Due tomorrow';
  return `Due in ${daysUntilDue} days`;
}

@Component({
  selector: 'app-follow-ups',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="h-full w-full overflow-y-auto p-4 md:p-6">
      <div class="flex flex-wrap items-end justify-between gap-2 mb-4">
        <div>
          <h1 class="text-2xl font-bold text-gray-800">Follow-ups</h1>
          <p class="text-sm text-gray-500">{{ counts.overdue }} overdue · {{ counts.today }} due today · {{ counts.upcoming }} this week</p>
        </div>
        <button type="button" class="btn btn-sm btn-outline" (click)="load()" [disabled]="loading">Refresh</button>
      </div>

      <div *ngIf="!loading && items.length === 0" class="bg-white rounded-xl border border-gray-200 p-10 text-center text-gray-500" data-testid="follow-ups-empty">
        <p class="font-medium">No follow-ups due this week</p>
        <p class="text-xs text-gray-400 mt-1">Doctors set "Review after" during a consultation. Those patients show up here when they're due.</p>
      </div>

      <ul *ngIf="items.length" class="space-y-2" data-testid="follow-ups-list">
        <li *ngFor="let f of items" class="bg-white rounded-xl border p-4 flex flex-wrap items-center gap-4"
            [class.border-red-200]="bucket(f) === 'overdue'" [class.border-gray-200]="bucket(f) !== 'overdue'">
          <div class="min-w-[9rem]">
            <span class="badge badge-sm"
                  [class.badge-error]="bucket(f) === 'overdue'" [class.badge-warning]="bucket(f) === 'today'"
                  [class.badge-ghost]="bucket(f) === 'upcoming'">{{ label(f) }}</span>
            <p class="text-xs text-gray-500 mt-1">{{ f.due_date | date:'EEE, d MMM' }}</p>
          </div>
          <div class="flex-1 min-w-[12rem]">
            <button type="button" class="font-semibold text-gray-800 hover:underline text-left" (click)="openPatient(f)">{{ f.patient_name }}</button>
            <p class="text-xs text-gray-500">
              {{ f.diagnosis || 'No diagnosis' }} · seen {{ f.visit_date | date:'d MMM' }}<span *ngIf="f.doctor_name"> by {{ f.doctor_name }}</span>
            </p>
            <p *ngIf="f.seen_since" class="text-xs text-green-700 mt-1">Already seen again since. Mark as done.</p>
          </div>
          <a *ngIf="f.mobile" class="text-sm font-mono text-blue-700 hover:underline" [href]="'tel:' + f.mobile">{{ f.mobile }}</a>
          <div class="flex gap-2 ml-auto">
            <button *ngIf="canQueue" type="button" class="btn btn-xs btn-primary" [disabled]="f.in_queue || busyId === f.id" (click)="addToQueue(f)">
              {{ f.in_queue ? 'In queue' : 'Add to queue' }}
            </button>
            <button *ngIf="canClose" type="button" class="btn btn-xs" [disabled]="busyId === f.id" (click)="close(f, 'done')">Done</button>
            <button *ngIf="canClose" type="button" class="btn btn-xs btn-ghost" [disabled]="busyId === f.id" (click)="startDismiss(f)">Dismiss</button>
          </div>
          <div *ngIf="dismissingId === f.id" class="w-full flex flex-wrap items-center gap-2">
            <input type="text" [(ngModel)]="dismissReason" placeholder="Why? e.g. moved away, no longer needed"
                   aria-label="Reason to dismiss" class="input input-bordered input-sm flex-1 min-w-[14rem]" />
            <button type="button" class="btn btn-sm" [disabled]="!dismissReason.trim()" (click)="close(f, 'dismissed', dismissReason)">Dismiss follow-up</button>
            <button type="button" class="btn btn-sm btn-ghost" (click)="dismissingId = null">Cancel</button>
          </div>
        </li>
      </ul>
    </div>
  `
})
export class FollowUpsComponent implements OnInit {
  items: any[] = [];
  loading = false;
  busyId: number | null = null;
  dismissingId: number | null = null;
  dismissReason = '';
  counts = { overdue: 0, today: 0, upcoming: 0 };
  canQueue = false;
  canClose = false;

  constructor(
    private dataService: DataService,
    private router: Router,
    private ngZone: NgZone,
    private toast: ToastService,
    private auth?: AuthService,
    private queueCount?: QueueCountService
  ) {
    const role = this.auth?.getUser()?.role;
    this.canQueue = role !== 'nurse';
    this.canClose = role !== 'nurse';
  }

  ngOnInit(): void {
    void this.load();
  }

  bucket(f: any): FollowUpBucket { return followUpBucket(Number(f.days_until_due)); }
  label(f: any): string { return followUpLabel(Number(f.days_until_due)); }

  async load(): Promise<void> {
    this.loading = true;
    try {
      const rows = await this.dataService.invoke<any[]>('getFollowUps');
      this.ngZone.run(() => {
        this.items = rows || [];
        const counts = { overdue: 0, today: 0, upcoming: 0 };
        for (const f of this.items) counts[this.bucket(f)] += 1;
        this.counts = counts;
      });
    } catch (e: any) {
      console.error('[FollowUps] load failed', e);
      this.toast.error(e?.message || 'Could not load follow-ups');
    } finally {
      this.ngZone.run(() => { this.loading = false; });
    }
  }

  async addToQueue(f: any): Promise<void> {
    this.busyId = f.id;
    try {
      const queued = await this.dataService.invoke<any>('addToQueue', { patientId: f.patient_id, priority: 1 });
      const token = queued?.token_no != null ? ` as token #${queued.token_no}` : '';
      this.toast.success(`${f.patient_name} added to the queue${token}.`);
      void this.queueCount?.refresh();
      await this.load();
    } catch (e: any) {
      this.toast.error(e?.message || 'Could not add to queue');
    } finally {
      this.busyId = null;
    }
  }

  startDismiss(f: any): void {
    this.dismissingId = f.id;
    this.dismissReason = '';
  }

  async close(f: any, status: 'done' | 'dismissed', reason = ''): Promise<void> {
    this.busyId = f.id;
    try {
      await this.dataService.invoke('closeFollowUp', { id: f.id, status, reason });
      this.dismissingId = null;
      await this.load();
    } catch (e: any) {
      this.toast.error(e?.message || 'Could not update follow-up');
    } finally {
      this.busyId = null;
    }
  }

  openPatient(f: any): void {
    void this.router.navigate(['/patients', f.patient_id]);
  }
}
