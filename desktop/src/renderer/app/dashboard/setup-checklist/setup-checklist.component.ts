import { Component, EventEmitter, Input, NgZone, OnInit, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { DataService } from '../../services/api.service';
import { CloudService } from '../../services/cloud.service';

export interface SetupStep {
  id: 'clinic' | 'doctor' | 'patient' | 'backup' | 'cloud';
  title: string;
  hint: string;
  done: boolean;
  optional?: boolean;
  route: string[];
  queryParams?: Record<string, string>;
}

export interface SetupFacts {
  clinicName: string;
  doctorCount: number;
  patientCount: number;
  lastBackupAt: string | null;
  cloudPaired: boolean;
}

export function buildSetupSteps(f: SetupFacts): SetupStep[] {
  return [
    { id: 'clinic', title: 'Add your clinic details', hint: 'Name and address print on every prescription.',
      done: !!f.clinicName.trim(), route: ['/settings'], queryParams: { tab: 'general' } },
    { id: 'doctor', title: 'Add a doctor', hint: 'Doctors sign visits with their registration number.',
      done: f.doctorCount > 0, route: ['/settings'], queryParams: { tab: 'users' } },
    { id: 'patient', title: 'Register your first patient', hint: 'Age and mobile are enough to start.',
      done: f.patientCount > 0, route: ['/patients'] },
    { id: 'backup', title: 'Take a first backup', hint: 'Keep a copy off this computer, such as on a USB drive.',
      done: !!f.lastBackupAt, route: ['/settings'], queryParams: { tab: 'backup' } },
    { id: 'cloud', title: 'Turn on online booking', hint: 'Pair with NalamDesk Cloud so patients can request slots.',
      done: f.cloudPaired, optional: true, route: ['/settings'], queryParams: { tab: 'general' } }
  ];
}

/** Admin first-run checklist on the dashboard: each step checks itself from live data. */
@Component({
  selector: 'app-setup-checklist',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div *ngIf="steps.length && !allRequiredDone" class="mb-8 rounded-2xl border border-gray-200 bg-white p-5" data-testid="setup-checklist">
      <div class="flex items-start justify-between gap-4 mb-3">
        <div>
          <h2 class="text-lg font-bold text-gray-800">Get your clinic ready</h2>
          <p class="text-sm text-gray-500">{{ doneCount }} of {{ requiredCount }} done</p>
        </div>
        <button type="button" class="text-xs text-gray-500 underline" (click)="dismiss()">Hide</button>
      </div>
      <progress class="progress progress-primary w-full mb-4" [value]="doneCount" [max]="requiredCount"></progress>
      <ol class="space-y-2">
        <li *ngFor="let s of steps" class="flex items-center gap-3">
          <span class="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold shrink-0"
                [class.bg-green-100]="s.done" [class.text-green-700]="s.done"
                [class.bg-gray-100]="!s.done" [class.text-gray-500]="!s.done">{{ s.done ? '✓' : '' }}</span>
          <div class="flex-1">
            <p class="text-sm font-medium" [class.text-gray-400]="s.done" [class.line-through]="s.done" [class.text-gray-800]="!s.done">
              {{ s.title }}<span *ngIf="s.optional" class="text-gray-400 font-normal"> (optional)</span>
            </p>
            <p *ngIf="!s.done" class="text-xs text-gray-500">{{ s.hint }}</p>
          </div>
          <button *ngIf="!s.done" type="button" class="btn btn-xs btn-outline" (click)="go(s)">Open</button>
        </li>
      </ol>
    </div>
  `
})
export class SetupChecklistComponent implements OnInit {
  static readonly DISMISSED_KEY = 'nd.setup-checklist.dismissed';
  @Input() patientCount = 0;
  @Output() hidden = new EventEmitter<void>();
  steps: SetupStep[] = [];

  constructor(
    private dataService: DataService,
    private router: Router,
    private ngZone: NgZone,
    private cloud?: CloudService
  ) { }

  get requiredCount(): number { return this.steps.filter((s) => !s.optional).length; }
  get doneCount(): number { return this.steps.filter((s) => !s.optional && s.done).length; }
  get allRequiredDone(): boolean { return this.steps.length > 0 && this.doneCount === this.requiredCount; }

  ngOnInit(): void {
    let dismissed = false;
    try { dismissed = localStorage.getItem(SetupChecklistComponent.DISMISSED_KEY) === '1'; } catch { /* ignore */ }
    if (!dismissed) void this.load();
  }

  async load(): Promise<void> {
    const settle = async <T>(p: Promise<T>, fallback: T): Promise<T> => { try { return await p; } catch { return fallback; } };
    const backupHealth = (window as any).electron?.backup?.getLocalBackupHealth
      ? (window as any).electron.backup.getLocalBackupHealth()
      : this.dataService.invoke('backupGetHealth');
    const [settings, users, health, cloud] = await Promise.all([
      settle(this.dataService.invoke<any>('getPublicSettings'), null),
      settle(this.dataService.invoke<any[]>('getUsers'), [] as any[]),
      settle(backupHealth as Promise<any>, null),
      settle(this.cloud ? this.cloud.getStatus() : Promise.resolve(null), null)
    ]);
    const steps = buildSetupSteps({
      clinicName: String(settings?.clinic_name || ''),
      doctorCount: (users || []).filter((u: any) => u?.role === 'doctor' && u?.active !== 0).length,
      patientCount: this.patientCount,
      lastBackupAt: health?.lastBackupAt ?? null,
      cloudPaired: cloud?.state === 'paired'
    });
    this.ngZone.run(() => { this.steps = steps; });
  }

  go(step: SetupStep): void {
    void this.router.navigate(step.route, step.queryParams ? { queryParams: step.queryParams } : undefined);
  }

  dismiss(): void {
    try { localStorage.setItem(SetupChecklistComponent.DISMISSED_KEY, '1'); } catch { /* ignore */ }
    this.steps = [];
    this.hidden.emit();
  }
}
