import { Component, NgZone, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DataService } from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { ToastService } from '../shared/services/toast.service';
import { localDateISO } from '../../../shared/local-date';

export function stockStatus(item: any): 'out' | 'low' | 'expiring' | 'ok' {
  if (!item || Number(item.on_hand) <= 0) return 'out';
  if (item.low) return 'low';
  if (item.expiring_soon) return 'expiring';
  return 'ok';
}

/** Today's finished visits that still have something left to hand over. */
export function visitsToDispense(visits: any[], today: string): any[] {
  return (visits || []).filter((v) => {
    const day = String(v?.date || '').replace(' ', 'T');
    const local = day ? localDateISO(new Date(day.endsWith('Z') ? day : `${day}Z`)) : '';
    return local === today && Array.isArray(v?.prescription) && v.prescription.length > 0;
  });
}

@Component({
  selector: 'app-pharmacy',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="h-full w-full overflow-y-auto p-4 md:p-6 space-y-6">
      <div class="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 class="text-2xl font-bold text-gray-800">Pharmacy</h1>
          <p class="text-sm text-gray-500">{{ stock.length }} medicines · {{ lowCount }} low or out · {{ expiringCount }} expiring within 60 days</p>
        </div>
        <div class="join">
          <button type="button" class="btn btn-sm join-item" [class.btn-active]="view === 'dispense'" (click)="view = 'dispense'">Dispense</button>
          <button type="button" class="btn btn-sm join-item" [class.btn-active]="view === 'stock'" (click)="view = 'stock'">Stock</button>
        </div>
      </div>

      <!-- DISPENSE -->
      <section *ngIf="view === 'dispense'" class="grid grid-cols-1 lg:grid-cols-3 gap-6" data-testid="dispense">
        <div class="bg-white rounded-xl border border-gray-200 p-4 lg:col-span-1">
          <h2 class="font-semibold text-gray-800 mb-2">Today's prescriptions</h2>
          <p *ngIf="!todayVisits.length" class="text-sm text-gray-400">No finished visits with a prescription today.</p>
          <button *ngFor="let v of todayVisits" type="button" class="w-full text-left px-3 py-2 rounded-lg hover:bg-gray-50 border mb-2"
                  [class.border-blue-400]="plan?.visit_id === v.id" [class.border-transparent]="plan?.visit_id !== v.id"
                  (click)="openPlan(v)">
            <span class="font-medium text-gray-800">{{ v.patient_name }}</span>
            <span class="block text-xs text-gray-500">{{ v.diagnosis || 'No diagnosis' }} · {{ v.doctor_name }}</span>
          </button>
        </div>
        <div class="bg-white rounded-xl border border-gray-200 p-4 lg:col-span-2">
          <p *ngIf="!plan" class="text-sm text-gray-400">Pick a patient to see their medicines.</p>
          <div *ngIf="plan">
            <h2 class="font-semibold text-gray-800 mb-3">{{ planPatient }}</h2>
            <table class="table table-sm">
              <thead><tr><th>Medicine</th><th>Prescribed</th><th>In stock</th><th>Given</th><th class="w-28">Give now</th></tr></thead>
              <tbody>
                <tr *ngFor="let l of plan.lines; let i = index">
                  <td><span class="font-medium">{{ l.medicine }}</span><span class="block text-xs text-gray-500">{{ l.dosage }} · {{ l.frequency }} · {{ l.duration }}</span></td>
                  <td class="tabular-nums">{{ l.prescribed_qty ?? '—' }} {{ l.quantity_unit || '' }}</td>
                  <td class="tabular-nums" [class.text-red-600]="l.in_stock < (giveQty[i] || 0)">{{ l.in_stock }}</td>
                  <td class="tabular-nums">{{ l.dispensed_qty }}</td>
                  <td><input type="number" min="0" class="input input-bordered input-xs w-24" [(ngModel)]="giveQty[i]" [name]="'give' + i"
                             [attr.aria-label]="'Quantity of ' + l.medicine" /></td>
                </tr>
              </tbody>
            </table>
            <div class="flex items-center gap-3 mt-3">
              <button type="button" class="btn btn-sm btn-primary" [disabled]="!canDispense || busy" (click)="dispense()">Dispense</button>
              <span *ngIf="lastTotal != null" class="text-sm text-gray-600">Dispensed. MRP total {{ lastTotal | number:'1.2-2' }}</span>
            </div>
            <p class="text-xs text-gray-400 mt-2">Takes the batch expiring first. Expired batches are never dispensed.</p>
          </div>
        </div>
      </section>

      <!-- STOCK -->
      <section *ngIf="view === 'stock'" class="space-y-4" data-testid="stock">
        <form *ngIf="canReceive" class="bg-white rounded-xl border border-gray-200 p-4 grid grid-cols-2 md:grid-cols-7 gap-2 items-end" (ngSubmit)="receive()">
          <label class="col-span-2 text-xs text-gray-500">Medicine
            <input class="input input-bordered input-sm w-full" name="m" [(ngModel)]="form.medicine_name" list="med-names" required /></label>
          <datalist id="med-names"><option *ngFor="let m of medicines" [value]="m.name"></option></datalist>
          <label class="text-xs text-gray-500">Batch<input class="input input-bordered input-sm w-full" name="b" [(ngModel)]="form.batch_no" required /></label>
          <label class="text-xs text-gray-500">Expiry<input type="date" class="input input-bordered input-sm w-full" name="e" [(ngModel)]="form.expiry_date" required /></label>
          <label class="text-xs text-gray-500">Quantity<input type="number" min="1" class="input input-bordered input-sm w-full" name="q" [(ngModel)]="form.qty" required /></label>
          <label class="text-xs text-gray-500">MRP per unit<input type="number" min="0" step="0.01" class="input input-bordered input-sm w-full" name="p" [(ngModel)]="form.mrp" /></label>
          <button type="submit" class="btn btn-sm btn-primary" [disabled]="busy">Receive stock</button>
        </form>

        <div class="bg-white rounded-xl border border-gray-200 overflow-x-auto">
          <table class="table table-sm">
            <thead><tr><th>Medicine</th><th>On hand</th><th>Nearest expiry</th><th>Status</th><th>Reorder at</th><th>Batches</th></tr></thead>
            <tbody>
              <tr *ngIf="!stock.length"><td colspan="6" class="text-center text-gray-400 py-6">No stock yet. Receive your first delivery above.</td></tr>
              <tr *ngFor="let s of stock">
                <td class="font-medium">{{ s.medicine_name }}</td>
                <td class="tabular-nums">{{ s.on_hand }} <span *ngIf="s.expired_qty" class="text-xs text-red-600">(+{{ s.expired_qty }} expired)</span></td>
                <td>{{ s.nearest_expiry ? (s.nearest_expiry | date:'MMM y') : '—' }}</td>
                <td><span class="badge badge-sm" [class.badge-error]="status(s) === 'out' || status(s) === 'low'"
                          [class.badge-warning]="status(s) === 'expiring'" [class.badge-ghost]="status(s) === 'ok'">{{ statusLabel(s) }}</span></td>
                <td><input *ngIf="canReceive" type="number" min="0" class="input input-bordered input-xs w-20" [value]="s.reorder_level"
                           [attr.aria-label]="'Reorder level for ' + s.medicine_name" (change)="setLevel(s, $any($event.target).value)" />
                    <span *ngIf="!canReceive">{{ s.reorder_level || '—' }}</span></td>
                <td class="text-xs">
                  <div *ngFor="let b of s.batches" class="flex items-center gap-2">
                    <span class="font-mono">{{ b.batch_no }}</span>
                    <span [class.text-red-600]="b.expired" [class.text-amber-700]="!b.expired && b.expiring_soon">exp {{ b.expiry_date | date:'MMM y' }}</span>
                    <span class="tabular-nums">{{ b.qty_on_hand }}</span>
                    <button *ngIf="canReceive" type="button" class="link link-hover text-gray-500" (click)="startAdjust(b)">adjust</button>
                  </div>
                  <form *ngIf="adjusting && s.batches.includes(adjusting.batch)" class="flex flex-wrap items-center gap-1 mt-1" (ngSubmit)="saveAdjust()">
                    <span class="font-mono">{{ adjusting.batch.batch_no }}</span>
                    <input type="number" class="input input-bordered input-xs w-20" name="delta" [(ngModel)]="adjusting.delta" aria-label="Change in units (negative removes)" />
                    <input class="input input-bordered input-xs w-48" name="reason" [(ngModel)]="adjusting.reason" placeholder="Reason, e.g. damaged, expired" aria-label="Reason" />
                    <button type="submit" class="btn btn-xs" [disabled]="!adjusting.reason.trim() || !adjusting.delta">Save</button>
                    <button type="button" class="btn btn-xs btn-ghost" (click)="adjusting = null">Cancel</button>
                  </form>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>
  `
})
export class PharmacyComponent implements OnInit {
  view: 'dispense' | 'stock' = 'dispense';
  stock: any[] = [];
  medicines: any[] = [];
  todayVisits: any[] = [];
  plan: any = null;
  planPatient = '';
  giveQty: number[] = [];
  lastTotal: number | null = null;
  busy = false;
  adjusting: { batch: any; delta: number; reason: string } | null = null;
  form: any = { medicine_name: '', batch_no: '', expiry_date: '', qty: null, mrp: null };
  private role = '';

  constructor(
    private dataService: DataService,
    private ngZone: NgZone,
    private toast: ToastService,
    private auth?: AuthService
  ) {
    this.role = this.auth?.getUser()?.role || '';
  }

  get canReceive(): boolean { return ['admin', 'doctor'].includes(this.role); }
  get canDispense(): boolean { return ['admin', 'doctor', 'receptionist'].includes(this.role); }
  get lowCount(): number { return this.stock.filter((s) => ['out', 'low'].includes(stockStatus(s))).length; }
  get expiringCount(): number { return this.stock.filter((s) => stockStatus(s) === 'expiring').length; }

  ngOnInit(): void {
    void this.loadStock();
    void this.loadToday();
    void this.dataService.invoke<any[]>('listMedicines').then((m) => { this.medicines = m || []; }).catch(() => undefined);
  }

  status(s: any) { return stockStatus(s); }
  statusLabel(s: any): string {
    return ({ out: 'Out of stock', low: 'Low', expiring: 'Expiring soon', ok: 'OK' } as const)[stockStatus(s)];
  }

  async loadStock(): Promise<void> {
    try {
      const stock = await this.dataService.invoke<any[]>('getStock');
      this.ngZone.run(() => { this.stock = stock || []; });
    } catch (e: any) {
      this.toast.error(e?.message || 'Could not load stock');
    }
  }

  async loadToday(): Promise<void> {
    try {
      const visits = await this.dataService.invoke<any[]>('getAllVisits', 100);
      this.ngZone.run(() => { this.todayVisits = visitsToDispense(visits || [], localDateISO()); });
    } catch { /* list stays empty */ }
  }

  async openPlan(v: any): Promise<void> {
    try {
      const plan = await this.dataService.invoke<any>('getDispensePlan', v.id);
      this.ngZone.run(() => {
        this.plan = plan;
        this.planPatient = v.patient_name;
        this.lastTotal = null;
        this.giveQty = (plan?.lines || []).map((l: any) =>
          Math.max(0, Math.min(l.in_stock, (l.prescribed_qty ?? 0) - l.dispensed_qty)));
      });
    } catch (e: any) {
      this.toast.error(e?.message || 'Could not load the prescription');
    }
  }

  async dispense(): Promise<void> {
    if (!this.plan) return;
    const lines = this.plan.lines
      .map((l: any, i: number) => ({ medicine: l.medicine, medicine_id: l.medicine_id, qty: Number(this.giveQty[i] || 0) }))
      .filter((l: any) => l.qty > 0);
    if (!lines.length) { this.toast.error('Enter a quantity to give'); return; }
    this.busy = true;
    try {
      const out = await this.dataService.invoke<any>('dispenseVisit', { visitId: this.plan.visit_id, lines });
      const visit = { id: this.plan.visit_id, patient_name: this.planPatient };
      await this.openPlan(visit);
      this.lastTotal = out?.total ?? null;
      await this.loadStock();
    } catch (e: any) {
      this.toast.error(e?.message || 'Could not dispense');
    } finally {
      this.busy = false;
    }
  }

  async receive(): Promise<void> {
    this.busy = true;
    try {
      const match = this.medicines.find((m) => String(m.name).toLowerCase() === String(this.form.medicine_name).trim().toLowerCase());
      await this.dataService.invoke('receiveStock', { ...this.form, medicine_id: match?.id ?? null });
      this.toast.success(`Received ${this.form.qty} ${this.form.medicine_name}`);
      this.form = { medicine_name: '', batch_no: '', expiry_date: '', qty: null, mrp: null };
      await this.loadStock();
    } catch (e: any) {
      this.toast.error(e?.message || 'Could not receive stock');
    } finally {
      this.busy = false;
    }
  }

  async setLevel(s: any, value: string): Promise<void> {
    try {
      await this.dataService.invoke('setReorderLevel', { medicine_id: s.medicine_id, medicine_name: s.medicine_name, reorder_level: Number(value) });
      await this.loadStock();
    } catch (e: any) {
      this.toast.error(e?.message || 'Could not save the reorder level');
    }
  }

  startAdjust(batch: any): void {
    // An expired batch defaults to writing it all off; otherwise a recount of -1.
    this.adjusting = { batch, delta: batch.expired ? -batch.qty_on_hand : -1, reason: batch.expired ? 'Expired write-off' : '' };
  }

  async saveAdjust(): Promise<void> {
    const adj = this.adjusting;
    if (!adj || !adj.reason.trim() || !Number(adj.delta)) return;
    try {
      await this.dataService.invoke('adjustStock', { batch_id: adj.batch.id, qty_delta: Number(adj.delta), reason: adj.reason.trim() });
      this.adjusting = null;
      await this.loadStock();
    } catch (e: any) {
      this.toast.error(e?.message || 'Could not adjust stock');
    }
  }
}
