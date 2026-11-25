import { Component, NgZone, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DataService } from '../services/api.service';
import { ToastService } from '../shared/services/toast.service';
import { localDateISO } from '../../../shared/local-date';

export type ReportPreset = 'today' | 'week' | 'month' | 'last-month' | 'custom';

/** Clinic-local [from, to] for a preset; weeks start on Monday. */
export function presetRange(preset: Exclude<ReportPreset, 'custom'>, now = new Date()): { from: string; to: string } {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  switch (preset) {
    case 'today':
      return { from: localDateISO(today), to: localDateISO(today) };
    case 'week': {
      const start = new Date(today);
      start.setDate(today.getDate() - ((today.getDay() + 6) % 7));
      return { from: localDateISO(start), to: localDateISO(today) };
    }
    case 'month':
      return { from: localDateISO(new Date(today.getFullYear(), today.getMonth(), 1)), to: localDateISO(today) };
    case 'last-month':
      return {
        from: localDateISO(new Date(today.getFullYear(), today.getMonth() - 1, 1)),
        to: localDateISO(new Date(today.getFullYear(), today.getMonth(), 0))
      };
  }
}

function csvCell(value: unknown): string {
  const text = value == null ? '' : String(value);
  // Leading = + - @ would run as a formula in Excel.
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** The report as one CSV (sections separated by blank lines), ready for Excel. */
export function reportToCsv(r: any): string {
  const rows: unknown[][] = [
    ['NalamDesk practice report', `${r.from} to ${r.to}`],
    [],
    ['Visits', r.visits],
    ['Patients seen', r.patients],
    ['New patients', r.newPatients],
    ['Returning patients', r.returningPatients],
    ['Billed', r.collections?.billed ?? 0],
    ['Collected', r.collections?.collected ?? 0],
    [],
    ['Collections by method', 'Amount'],
    ...Object.entries(r.collections?.byMethod || {}).map(([m, v]) => [m, v]),
    [],
    ['Day', 'Visits'],
    ...(r.byDay || []).map((d: any) => [d.day, d.visits]),
    [],
    ['Doctor', 'Visits'],
    ...(r.byDoctor || []).map((d: any) => [d.doctor, d.visits]),
    [],
    ['Top diagnoses', 'Visits'],
    ...(r.topDiagnoses || []).map((d: any) => [d.diagnosis, d.visits])
  ];
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

@Component({
  selector: 'app-reports',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="h-full w-full overflow-y-auto p-4 md:p-6 space-y-6">
      <div class="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 class="text-2xl font-bold text-gray-800">Reports</h1>
          <p class="text-sm text-gray-500" *ngIf="report">{{ report.from | date:'d MMM y' }} – {{ report.to | date:'d MMM y' }}</p>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <div class="join">
            <button *ngFor="let p of presets" type="button" class="btn btn-sm join-item"
                    [class.btn-active]="preset === p.id" (click)="choose(p.id)">{{ p.label }}</button>
          </div>
          <input type="date" class="input input-bordered input-sm" aria-label="From date" [(ngModel)]="from" (change)="preset = 'custom'" />
          <input type="date" class="input input-bordered input-sm" aria-label="To date" [(ngModel)]="to" (change)="preset = 'custom'" />
          <button type="button" class="btn btn-sm" (click)="load()" [disabled]="loading">Show</button>
          <button type="button" class="btn btn-sm btn-outline" (click)="exportCsv()" [disabled]="!report">Export to Excel (CSV)</button>
        </div>
      </div>

      <div *ngIf="report" class="grid grid-cols-2 md:grid-cols-5 gap-4" data-testid="report-kpis">
        <div *ngFor="let k of kpis()" class="bg-white rounded-xl border border-gray-200 p-4">
          <p class="text-xs uppercase tracking-wide text-gray-500">{{ k.label }}</p>
          <p class="text-2xl font-semibold text-gray-800 mt-1 tabular-nums">{{ k.value }}</p>
        </div>
      </div>

      <div *ngIf="report" class="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section class="bg-white rounded-xl border border-gray-200 p-5">
          <h2 class="font-semibold text-gray-800 mb-3">Visits per day</h2>
          <p *ngIf="!report.byDay.length" class="text-sm text-gray-400">No finished visits in this range.</p>
          <div *ngFor="let d of report.byDay" class="flex items-center gap-3 py-0.5 text-sm">
            <span class="w-24 text-gray-500 tabular-nums">{{ d.day | date:'EEE d MMM' }}</span>
            <div class="flex-1 h-3 bg-gray-100 rounded">
              <div class="h-3 bg-blue-500 rounded" [style.width.%]="barWidth(d.visits)"></div>
            </div>
            <span class="w-8 text-right tabular-nums">{{ d.visits }}</span>
          </div>
        </section>

        <section class="bg-white rounded-xl border border-gray-200 p-5 space-y-5">
          <div>
            <h2 class="font-semibold text-gray-800 mb-2">Collections by method</h2>
            <p *ngIf="!methods().length" class="text-sm text-gray-400">No payments recorded.</p>
            <div *ngFor="let m of methods()" class="flex justify-between text-sm py-0.5">
              <span class="capitalize text-gray-600">{{ m[0] }}</span><span class="tabular-nums">{{ m[1] | number:'1.2-2' }}</span>
            </div>
          </div>
          <div>
            <h2 class="font-semibold text-gray-800 mb-2">By doctor</h2>
            <div *ngFor="let d of report.byDoctor" class="flex justify-between text-sm py-0.5">
              <span class="text-gray-600">{{ d.doctor }}</span><span class="tabular-nums">{{ d.visits }}</span>
            </div>
          </div>
          <div>
            <h2 class="font-semibold text-gray-800 mb-2">Top diagnoses</h2>
            <p *ngIf="!report.topDiagnoses.length" class="text-sm text-gray-400">None recorded.</p>
            <div *ngFor="let d of report.topDiagnoses" class="flex justify-between text-sm py-0.5">
              <span class="text-gray-600">{{ d.diagnosis }}</span><span class="tabular-nums">{{ d.visits }}</span>
            </div>
          </div>
        </section>
      </div>
    </div>
  `
})
export class ReportsComponent implements OnInit {
  readonly presets: { id: Exclude<ReportPreset, 'custom'>; label: string }[] = [
    { id: 'today', label: 'Today' },
    { id: 'week', label: 'This week' },
    { id: 'month', label: 'This month' },
    { id: 'last-month', label: 'Last month' }
  ];
  preset: ReportPreset = 'today';
  from = '';
  to = '';
  report: any = null;
  loading = false;

  constructor(private dataService: DataService, private ngZone: NgZone, private toast: ToastService) { }

  ngOnInit(): void {
    this.choose('today');
  }

  choose(preset: Exclude<ReportPreset, 'custom'>): void {
    this.preset = preset;
    const range = presetRange(preset);
    this.from = range.from;
    this.to = range.to;
    void this.load();
  }

  async load(): Promise<void> {
    this.loading = true;
    try {
      const report = await this.dataService.invoke<any>('getPracticeReport', { from: this.from, to: this.to });
      this.ngZone.run(() => { this.report = report; });
    } catch (e: any) {
      this.toast.error(e?.message || 'Could not load the report');
    } finally {
      this.ngZone.run(() => { this.loading = false; });
    }
  }

  kpis(): { label: string; value: string | number }[] {
    const r = this.report;
    if (!r) return [];
    const money = (n: number) => Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
    return [
      { label: 'Visits', value: r.visits },
      { label: 'Patients seen', value: r.patients },
      { label: 'New patients', value: r.newPatients },
      { label: 'Billed', value: money(r.collections.billed) },
      { label: 'Collected', value: money(r.collections.collected) }
    ];
  }

  methods(): [string, number][] {
    return Object.entries(this.report?.collections?.byMethod || {}) as [string, number][];
  }

  barWidth(visits: number): number {
    const max = Math.max(1, ...(this.report?.byDay || []).map((d: any) => Number(d.visits) || 0));
    return Math.round((Number(visits) / max) * 100);
  }

  exportCsv(): void {
    if (!this.report) return;
    // BOM so Excel reads names in Tamil, Hindi and other scripts correctly.
    const blob = new Blob(['﻿' + reportToCsv(this.report)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `NalamDesk-report-${this.report.from}-to-${this.report.to}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
