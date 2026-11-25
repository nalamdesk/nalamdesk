import { Component, Input, NgZone, OnChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DataService } from '../../services/api.service';
import { ToastService } from '../../shared/services/toast.service';
import { findLabTest, flagResult, LabAnalyte } from '../../../../shared/lab-catalog';
import { ReasonDialogComponent } from '../../shared/components/reason-dialog/reason-dialog.component';

interface DraftValue extends LabAnalyte { value: string; ref_low: number | null; ref_high: number | null; }

/** The patient's investigations: enter results for ordered tests and see each analyte's trend. */
@Component({
  selector: 'app-lab-results-panel',
  standalone: true,
  imports: [CommonModule, FormsModule, ReasonDialogComponent],
  template: `
    <app-reason-dialog [open]="!!cancelling" [title]="'Cancel ' + (cancelling?.test_name || 'test')"
        message="The order stays on the chart as cancelled, with your reason." placeholder="e.g. Patient did it elsewhere"
        confirmText="Cancel test" (decided)="onCancelDecided($event)"></app-reason-dialog>
    <div class="space-y-3" data-testid="lab-results">
      <p *ngIf="!orders.length" class="text-sm text-gray-500">No investigations ordered yet. Doctors add them in the visit's Plan section.</p>
      <div *ngFor="let o of orders" class="bg-white rounded-lg border p-4"
           [class.border-amber-200]="o.status === 'ordered'" [class.border-gray-200]="o.status !== 'ordered'">
        <div class="flex flex-wrap items-center gap-2">
          <span class="font-semibold text-gray-800">{{ o.test_name }}</span>
          <span class="badge badge-sm" [class.badge-warning]="o.status === 'ordered'" [class.badge-success]="o.status === 'resulted'"
                [class.badge-ghost]="o.status === 'cancelled'">{{ statusLabel(o.status) }}</span>
          <span class="text-xs text-gray-500">ordered {{ o.visit_date | date:'d MMM y' }}<span *ngIf="o.ordered_by_name"> by {{ o.ordered_by_name }}</span></span>
          <div class="ml-auto flex gap-2">
            <button *ngIf="canRecord && o.status !== 'cancelled' && editingId !== o.id" type="button" class="btn btn-xs"
                    (click)="startEntry(o)">{{ o.status === 'resulted' ? 'Correct' : 'Enter results' }}</button>
            <button *ngIf="canCancel && o.status === 'ordered' && editingId !== o.id" type="button" class="btn btn-xs btn-ghost"
                    (click)="cancel(o)">Cancel test</button>
          </div>
        </div>

        <table *ngIf="o.results?.length && editingId !== o.id" class="table table-xs mt-2">
          <tbody>
            <tr *ngFor="let r of o.results">
              <td class="text-gray-600 w-1/3">{{ r.analyte_name }}</td>
              <td class="font-mono" [class.text-red-600]="r.flag === 'H'" [class.text-blue-700]="r.flag === 'L'">
                {{ r.value_num ?? r.value_text }} {{ r.unit }} <span *ngIf="r.flag" class="font-bold">{{ r.flag }}</span>
              </td>
              <td class="text-xs text-gray-400"><span *ngIf="r.ref_low != null || r.ref_high != null">ref {{ r.ref_low ?? '' }}–{{ r.ref_high ?? '' }}</span></td>
              <td class="text-xs text-gray-500">{{ trend(r) }}</td>
            </tr>
          </tbody>
        </table>
        <p *ngIf="o.result_note && editingId !== o.id" class="text-xs text-gray-600 mt-1">Note: {{ o.result_note }}</p>
        <p *ngIf="o.cancel_reason" class="text-xs text-gray-500 mt-1">Cancelled: {{ o.cancel_reason }}</p>

        <form *ngIf="editingId === o.id" class="mt-3 space-y-2" (ngSubmit)="save(o)">
          <div *ngFor="let d of draft; let i = index" class="grid grid-cols-12 items-center gap-2">
            <label class="col-span-4 text-sm text-gray-700" [for]="'lab-' + o.id + '-' + i">{{ d.name }}</label>
            <input class="col-span-3 input input-bordered input-sm" [id]="'lab-' + o.id + '-' + i" [name]="'v' + i"
                   [(ngModel)]="d.value" [attr.inputmode]="d.text ? null : 'decimal'" [placeholder]="d.text ? 'Result' : 'Value'" />
            <span class="col-span-1 text-xs text-gray-500">{{ d.unit }}</span>
            <span *ngIf="!d.text" class="col-span-3 text-xs text-gray-400">ref {{ d.ref_low ?? '' }}–{{ d.ref_high ?? '' }}</span>
            <span class="col-span-1 text-xs font-bold" [class.text-red-600]="draftFlag(d) === 'H'" [class.text-blue-700]="draftFlag(d) === 'L'">{{ draftFlag(d) }}</span>
          </div>
          <input class="input input-bordered input-sm w-full" name="note" [(ngModel)]="note" placeholder="Note (optional), e.g. lab name or impression" />
          <div class="flex gap-2">
            <button type="submit" class="btn btn-sm btn-primary" [disabled]="busy">Save results</button>
            <button type="button" class="btn btn-sm btn-ghost" (click)="editingId = null">Cancel</button>
          </div>
        </form>
      </div>
    </div>
  `
})
export class LabResultsPanelComponent implements OnChanges {
  @Input() patientId: number | null = null;
  @Input() role = '';
  orders: any[] = [];
  editingId: number | null = null;
  draft: DraftValue[] = [];
  note = '';
  busy = false;

  constructor(private dataService: DataService, private ngZone: NgZone, private toast: ToastService) { }

  get canRecord(): boolean { return ['admin', 'doctor', 'nurse'].includes(this.role); }
  get canCancel(): boolean { return ['admin', 'doctor'].includes(this.role); }

  ngOnChanges(): void {
    if (this.patientId) void this.load();
  }

  async load(): Promise<void> {
    try {
      const orders = await this.dataService.invoke<any[]>('getLabOrders', this.patientId);
      this.ngZone.run(() => { this.orders = orders || []; });
    } catch (e) {
      console.error('[Labs] load failed', e);
    }
  }

  statusLabel(status: string): string {
    return status === 'ordered' ? 'Awaiting results' : status === 'resulted' ? 'Results in' : 'Cancelled';
  }

  startEntry(order: any): void {
    const known = new Map<string, any>((order.results || []).map((r: any) => [r.analyte_code, r]));
    const analytes: LabAnalyte[] = findLabTest(order.test_code)?.analytes
      ?? (order.results?.length ? order.results.map((r: any) => ({ code: r.analyte_code, name: r.analyte_name, unit: r.unit }))
        : [{ code: order.test_code, name: order.test_name, text: true }]);
    this.draft = analytes.map((a) => {
      const prev = known.get(a.code);
      return {
        ...a,
        value: prev ? String(prev.value_num ?? prev.value_text ?? '') : '',
        ref_low: prev?.ref_low ?? a.low ?? null,
        ref_high: prev?.ref_high ?? a.high ?? null
      };
    });
    this.note = order.result_note || '';
    this.editingId = order.id;
  }

  draftFlag(d: DraftValue): 'H' | 'L' | null {
    if (d.text || d.value === '') return null;
    return flagResult(Number(d.value), d.ref_low, d.ref_high);
  }

  async save(order: any): Promise<void> {
    this.busy = true;
    try {
      await this.dataService.invoke('saveLabResults', {
        orderId: order.id,
        note: this.note,
        values: this.draft.map((d) => ({
          analyte_code: d.code, analyte_name: d.name, value: d.value, unit: d.unit ?? null,
          ref_low: d.ref_low, ref_high: d.ref_high, text: !!d.text
        }))
      });
      this.editingId = null;
      await this.load();
    } catch (e: any) {
      this.toast.error(e?.message || 'Could not save results');
    } finally {
      this.busy = false;
    }
  }

  cancelling: any = null;

  cancel(order: any): void {
    this.cancelling = order;
  }

  async onCancelDecided(reason: string | null): Promise<void> {
    const order = this.cancelling;
    this.cancelling = null;
    if (!order || !reason || !reason.trim()) return;
    try {
      await this.dataService.invoke('cancelLabOrder', { orderId: order.id, reason: reason.trim() });
      await this.load();
    } catch (e: any) {
      this.toast.error(e?.message || 'Could not cancel the test');
    }
  }

  /** "was 8.4 on 2 Oct" from the same analyte's previous numeric result. */
  trend(r: any): string {
    if (r.value_num == null) return '';
    const earlier = this.orders
      .flatMap((o) => o.results || [])
      .filter((x: any) => x.analyte_code === r.analyte_code && x.value_num != null && x.id !== r.id
        && String(x.recorded_at) < String(r.recorded_at))
      .sort((a: any, b: any) => String(b.recorded_at).localeCompare(String(a.recorded_at)))[0];
    if (!earlier) return '';
    const when = new Date(String(earlier.recorded_at).replace(' ', 'T') + 'Z');
    const day = Number.isNaN(when.getTime()) ? '' : ` on ${when.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`;
    const arrow = r.value_num > earlier.value_num ? '↑' : r.value_num < earlier.value_num ? '↓' : '→';
    return `${arrow} was ${earlier.value_num}${day}`;
  }
}
