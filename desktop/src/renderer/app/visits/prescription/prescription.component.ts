import { Component, Input, Output, EventEmitter, signal, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { CatalogTypeaheadComponent } from '../../shared/components/catalog-typeahead/catalog-typeahead.component';
import { DataService } from '../../services/api.service';

@Component({
  selector: 'app-prescription',
  standalone: true,
  imports: [CommonModule, FormsModule, CatalogTypeaheadComponent],
  template: `
    <div class="card bg-base-100 border border-base-200" [class.opacity-70]="disabled">
      <div class="card-body p-3 md:p-4">
        <h3 class="card-title text-sm mb-2">Prescription</h3>
        
        <!-- Header (Desktop Only) -->
        <!-- Column labels aligned to the row grid below so doctors can scan at a glance -->
        <div *ngIf="items().length > 0" class="hidden md:grid grid-cols-12 gap-2 px-1 pb-1 text-[11px] font-bold uppercase tracking-wider text-gray-500" aria-hidden="true">
          <div class="md:col-span-3">Medicine</div>
          <div class="md:col-span-1">Form</div>
          <div class="md:col-span-1">Dose</div>
          <div class="md:col-span-1">Route</div>
          <div class="md:col-span-2">Frequency</div>
          <div class="md:col-span-2">Duration</div>
          <div class="md:col-span-2">Instructions</div>
        </div>

        <div class="grid grid-cols-12 gap-2 mb-3 md:mb-2 items-start md:items-center bg-gray-50 md:bg-transparent p-3 md:p-0 rounded-lg md:rounded-none relative border md:border-none border-gray-100"
             *ngFor="let item of items(); let i = index; trackBy: trackByLine">
          
          <!-- Mobile Delete (Absolute Top Right) -->
          <button class="md:hidden absolute top-1 right-1 btn btn-xs btn-ghost text-error" (click)="remove(i)" [disabled]="disabled" aria-label="Remove medicine">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="w-3.5 h-3.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
          </button>

          <!-- 1. Medicine (Full Width on Mobile) -->
          <div class="col-span-12 md:col-span-3">
            <span class="text-xs text-gray-500 md:hidden font-bold">Medicine</span>
            <app-catalog-typeahead
              [value]="item.medicine"
              [disabled]="disabled"
              [placeholder]="'Medicine Name'"
              [testId]="'rx-medicine-' + i"
              [searchFn]="searchMedicines"
              [createFn]="createMedicine"
              (valueChange)="onMedicineTyped(i, $event)"
              (picked)="onMedicinePicked(i, $event)">
            </app-catalog-typeahead>
          </div>

          <!-- 2. Form (1/3 Mobile) -->
          <div class="col-span-4 md:col-span-1">
             <span class="text-xs text-gray-500 md:hidden">Form</span>
             <select [(ngModel)]="item.form" (ngModelChange)="emitChange()" [disabled]="disabled" aria-label="Dosage form" class="select select-bordered select-sm w-full px-1">
               <option value="Tab">Tab</option>
               <option value="Cap">Cap</option>
               <option value="Syr">Syr</option>
               <option value="Inj">Inj</option>
               <option value="Oint">Oint</option>
               <option value="Drop">Drop</option>
             </select>
          </div>

          <!-- 3. Dosage (1/3 Mobile) -->
           <div class="col-span-4 md:col-span-1">
            <span class="text-xs text-gray-500 md:hidden">Dose</span>
            <input type="text" placeholder="500mg" aria-label="Dosage"
                   [(ngModel)]="item.dosage" (ngModelChange)="emitChange()"
                   [disabled]="disabled"
                   class="input input-bordered input-sm w-full px-1" />
          </div>

          <!-- 4. Route (1/3 Mobile) -->
          <div class="col-span-4 md:col-span-1">
             <span class="text-xs text-gray-500 md:hidden">Route</span>
             <select [(ngModel)]="item.route" (ngModelChange)="emitChange()" [disabled]="disabled" aria-label="Route of administration" class="select select-bordered select-sm w-full px-1">
               <option value="Oral">Oral</option>
               <option value="IV">IV</option>
               <option value="IM">IM</option>
               <option value="SC">SC</option>
               <option value="Topical">Topical</option>
             </select>
          </div>

          <!-- 5. Frequency (1/2 Mobile) -->
          <div class="col-span-6 md:col-span-2">
            <span class="text-xs text-gray-500 md:hidden">Frequency</span>
            <select [(ngModel)]="item.frequency" (ngModelChange)="emitChange()" [disabled]="disabled" aria-label="Frequency" class="select select-bordered select-sm w-full">
              <option value="1-0-1">1-0-1 (BID)</option>
              <option value="1-1-1">1-1-1 (TID)</option>
              <option value="1-0-0">1-0-0 (OD)</option>
              <option value="0-0-1">0-0-1 (HS)</option>
              <option value="0-1-0">0-1-0 (Afternoon)</option>
              <option value="SOS">SOS</option>
              <option value="STAT">STAT</option>
            </select>
          </div>

          <!-- 6. Duration (1/2 Mobile) -->
          <div class="col-span-6 md:col-span-2">
            <span class="text-xs text-gray-500 md:hidden">Duration</span>
            <input type="text" placeholder="3 days" aria-label="Duration"
                   [(ngModel)]="item.duration" (ngModelChange)="emitChange()"
                   [disabled]="disabled"
                   class="input input-bordered input-sm w-full" />
          </div>

          <!-- 7. Instruction (Full Mobile) + Desktop Delete -->
          <div class="col-span-12 md:col-span-2 flex gap-1 items-end">
            <div class="w-full">
                <span class="text-xs text-gray-500 md:hidden">Instruction</span>
                <select [(ngModel)]="item.instruction" (ngModelChange)="emitChange()" [disabled]="disabled" aria-label="Instructions" class="select select-bordered select-sm w-full px-1">
                    <option value="After Food">After Food</option>
                    <option value="Before Food">Before Food</option>
                    <option value="With Food">With Food</option>
                    <option value="Empty Stomach">Empty Stomach</option>
                </select>
            </div>
            
            <button class="hidden md:flex btn btn-sm btn-square btn-ghost text-error" (click)="remove(i)" [disabled]="disabled" aria-label="Remove medicine">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="w-4 h-4"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
            </button>
          </div>
        </div>
        
        <div class="flex justify-between mt-2">
           <button class="btn btn-sm btn-ghost gap-2 text-blue-600 hover:bg-blue-50" (click)="add()" [disabled]="disabled">
            + Add Medicine
          </button>
        </div>
      </div>
    </div>
  `
})
export class PrescriptionComponent {
  private readonly dataService = inject(DataService, { optional: true });

  @Input() set initialData(value: any[]) {
    if (value && value.length > 0) this.items.set(value);
  }
  @Input() disabled = false;
  @Output() changed = new EventEmitter<any[]>();

  items = signal<any[]>([
    { medicine: '', form: 'Tab', dosage: '', route: 'Oral', frequency: '1-0-1', duration: '3 days', instruction: 'After Food' }
  ]);

  searchMedicines = (query: string) => this.dataService
    ? this.dataService.invoke('searchMedicines', query)
    : Promise.resolve([]);

  createMedicine = (name: string) => this.dataService
    ? this.dataService.invoke('createMedicine', { name })
    : Promise.resolve({ id: 0, name });

  trackByLine(index: number): number {
    // Identity-stable rows: patchLine() replaces the line object on every
    // keystroke, so without this Angular recreates the row DOM (and the
    // typeahead input inside it) and the field loses focus after one char.
    return index;
  }

  add() {
    if (this.disabled) return;
    this.items.update(list => [...list, { medicine: '', form: 'Tab', dosage: '', route: 'Oral', frequency: '1-0-1', duration: '3 days', instruction: 'After Food' }]);
    this.emitChange();
  }

  remove(index: number) {
    if (this.disabled) return;
    this.items.update(list => list.filter((_, i) => i !== index));
    this.emitChange();
  }

  emitChange() {
    if (this.disabled) return;
    this.changed.emit(this.items());
  }

  onMedicineTyped(index: number, name: string) {
    this.patchLine(index, { medicine: name });
  }

  onMedicinePicked(index: number, hit: any) {
    this.patchLine(index, {
      medicine: hit.name,
      generic_name: hit.generic_name || null,
      brand_name: hit.brand_name || null,
      form: hit.form || this.items()[index]?.form || 'Tab',
      dosage: hit.dosage ?? this.items()[index]?.dosage ?? '',
      route: hit.route || this.items()[index]?.route || 'Oral',
      frequency: hit.frequency || this.items()[index]?.frequency || '1-0-1',
      duration: hit.duration || this.items()[index]?.duration || '3 days',
      instruction: hit.instruction || this.items()[index]?.instruction || 'After Food'
    });
  }

  private patchLine(index: number, patch: Record<string, unknown>) {
    if (this.disabled) return;
    this.items.update((list) => list.map((item, i) => i === index ? { ...item, ...patch } : item));
    this.emitChange();
  }
}
