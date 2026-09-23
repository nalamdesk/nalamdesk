import { Component, OnInit, NgZone, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterModule } from '@angular/router';
import { DataService } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { DialogService } from '../../shared/services/dialog.service';
import { SharedTableComponent } from '../../shared/components/table/table.component';
import { ViewToggleComponent, CompactView, restoreCompactView, persistCompactView } from '../../shared/components/view-toggle/view-toggle.component';
import { ColDef } from 'ag-grid-community';

@Component({
  selector: 'app-visit-list',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule, SharedTableComponent, ViewToggleComponent],
  template: `
    <div class="h-full bg-gray-100 p-4 md:p-6 flex flex-col overflow-x-auto overflow-y-hidden">
      <div class="w-full">
        <div class="flex justify-between items-center mb-4">
            <h1 class="text-2xl font-bold text-gray-800">Recent Visits</h1>
            <div class="flex items-center gap-2">
              <app-view-toggle class="md:hidden" [value]="mobileView" (valueChange)="setMobileView($event)" label="Visits view"></app-view-toggle>
              <a routerLink="/patients" class="text-blue-600 hover:text-blue-800 font-medium">Find Patient →</a>
            </div>
        </div>

        <div class="mb-4 relative max-w-md">
          <input
            type="text"
            [(ngModel)]="searchTerm"
            placeholder="Search patient, diagnosis, doctor..."
            aria-label="Search visits"
            class="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all"
          >
          <span class="absolute left-3 top-2.5 text-gray-400">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-5 h-5"><path stroke-linecap="round" stroke-linejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" /></svg>
          </span>
        </div>
        
        <div class="flex-1 h-[calc(100vh-150px)]" [ngClass]="mobileView === 'grid' ? 'block' : 'hidden md:block'">
           <app-shared-table
              [rowData]="visibleVisits()"
              [columnDefs]="colDefs"
              [loading]="loading"
              [multiSelect]="isAdmin"
              (selectionChanged)="selectedVisits = $event"
              (rowClick)="onRowClick($event)"
           >
              <div toolbar-left>
                  <button *ngIf="isAdmin && selectedVisits.length > 0" (click)="deleteSelectedVisits()" 
                          class="bg-red-50 text-red-600 px-3 py-1.5 rounded-md text-xs font-medium border border-red-200 hover:bg-red-100 flex items-center gap-2 animate-in fade-in zoom-in duration-200">
                      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-4 h-4">
                        <path stroke-linecap="round" stroke-linejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />
                      </svg>
                      Delete ({{ selectedVisits.length }})
                  </button>
              </div>
           </app-shared-table>
        </div>
        <!-- Compact cards for narrow viewports: same filtered rows, tap opens the visit -->
        <div class="max-h-[calc(100vh-280px)] min-h-[200px] overflow-y-auto space-y-2 pb-4" [ngClass]="mobileView === 'cards' ? 'block md:hidden' : 'hidden'">
          <div *ngIf="isAdmin" class="flex items-center justify-between px-1">
            <button (click)="toggleCardSelectMode()" class="text-xs font-semibold text-blue-600 hover:text-blue-800">
              {{ cardSelectMode ? 'Cancel' : 'Select' }}
            </button>
            <span *ngIf="cardSelectMode" class="text-xs text-gray-500">{{ selectedVisits.length }} selected</span>
          </div>
          <div *ngIf="visibleVisits().length === 0" class="text-center text-sm text-gray-500 py-8">No visits found</div>
          <div *ngFor="let v of visibleVisits()" (click)="onCardTap(v)"
               class="bg-white rounded-lg border border-gray-200 p-3 shadow-sm"
               [ngClass]="isCardSelected(v) ? 'ring-2 ring-blue-500 border-blue-500' : ''">
            <div class="flex items-center gap-2">
              <div *ngIf="cardSelectMode" class="shrink-0 w-5 h-5 rounded border flex items-center justify-center"
                   [ngClass]="isCardSelected(v) ? 'bg-blue-600 border-blue-600 text-white' : 'border-gray-300 bg-white'">
                <svg *ngIf="isCardSelected(v)" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="3" stroke="currentColor" class="w-3.5 h-3.5"><path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5" /></svg>
              </div>
              <div class="min-w-0 flex-1">
                <div class="font-bold text-gray-800 truncate">{{ v.patient_name }}</div>
                <div class="text-xs text-gray-500 font-mono">{{ v.date ? (v.date | date:'short') : '' }}</div>
              </div>
            </div>
            <div class="text-sm text-gray-600 mt-0.5 line-clamp-2">{{ v.diagnosis || 'No diagnosis recorded' }}</div>
            <div class="mt-1.5 flex items-center justify-between gap-2 text-xs text-gray-500">
              <span class="truncate">{{ v.doctor_name || '—' }}</span>
              <span class="font-semibold text-gray-700 shrink-0">₹{{ v.amount_paid || 0 }}</span>
            </div>
          </div>
          <div *ngIf="cardSelectMode && selectedVisits.length > 0" class="sticky bottom-0 flex items-center gap-2 bg-white border border-gray-200 rounded-lg p-2 shadow-lg">
            <button (click)="deleteSelectedVisits()" class="btn btn-sm btn-error flex-1 text-white">Delete ({{ selectedVisits.length }})</button>
            <button (click)="toggleCardSelectMode()" class="btn btn-sm btn-ghost border border-gray-200">Done</button>
          </div>
        </div>
      </div>
    </div>
  `
})
export class VisitListComponent implements OnInit {
  visits: any[] = [];
  loading = false;
  selectedVisits: any[] = [];
  searchTerm = '';
  // Narrow-viewport layout override; desktop always uses the grid.
  mobileView: CompactView = 'cards';
  private static readonly MOBILE_VIEW_KEY = 'nalamdesk.visits.mobileView';

  setMobileView(view: CompactView): void {
    this.mobileView = view;
    persistCompactView(VisitListComponent.MOBILE_VIEW_KEY, view);
  }

  // Client-side search over the loaded page (getAllVisits caps at 100 rows),
  // matching the queue pattern: one filter for every viewport.
  visibleVisits(): any[] {
    const term = this.searchTerm.trim().toLowerCase();
    if (!term) return this.visits;
    return this.visits.filter((v: any) => [v?.patient_name, v?.diagnosis, v?.doctor_name, v?.symptoms]
      .some((field: unknown) => String(field ?? '').toLowerCase().includes(term)));
  }

  colDefs: ColDef[] = [
    {
      field: 'date',
      headerName: 'Date',
      flex: 1,
      minWidth: 120,
      valueFormatter: (params) => {
        if (!params.value) return '';
        return new Date(params.value).toLocaleString();
      }
    },
    {
      field: 'patient_name',
      headerName: 'Patient',
      flex: 1.5,
      minWidth: 140,
      cellClass: 'font-medium text-blue-600'
    },
    { field: 'diagnosis', headerName: 'Diagnosis', flex: 2, minWidth: 150, wrapText: true, autoHeight: true },
    { field: 'doctor_name', headerName: 'Doctor', flex: 1, minWidth: 110 },
    {
      field: 'amount_paid',
      headerName: 'Amount',
      flex: 0.8,
      minWidth: 110,
      type: 'rightAligned',
      valueFormatter: (params) => params.value ? '₹' + params.value : '₹0'
    }
  ];

  private dataService: DataService = inject(DataService);

  constructor(
    private ngZone: NgZone,
    private router: Router,
    private dialogService?: DialogService,
    private authService?: AuthService
  ) { }

  /** Destructive batch deletes are admin-only (server 403s the rest). */
  get isAdmin(): boolean {
    try {
      return this.authService?.getUser()?.role === 'admin';
    } catch {
      return false;
    }
  }

  ngOnInit() {
    this.mobileView = restoreCompactView(VisitListComponent.MOBILE_VIEW_KEY);
    this.loadVisits();
  }

  async loadVisits() {
    this.loading = true;
    try {
      const data = await this.dataService.invoke<any>('getAllVisits', 100);
      this.ngZone.run(() => {
        this.visits = data;
        this.loading = false;
      });
    } catch (e) {
      console.error('Failed to load visits', e);
      this.loading = false;
    }
  }

  async deleteSelectedVisits() {
    if (this.selectedVisits.length === 0) return;
    const confirmed = await this.dialogService?.open({
      title: `Delete ${this.selectedVisits.length} visits?`,
      message: 'Visit records will be permanently removed. This cannot be undone.',
      type: 'confirm',
      confirmText: 'Delete',
      cancelText: 'Keep'
    });
    if (!confirmed) return;

    try {
      for (const v of this.selectedVisits) {
        await this.dataService.invoke('deleteVisit', v.id);
      }
      this.ngZone.run(() => {
        this.selectedVisits = [];
        this.cardSelectMode = false;
        this.loadVisits();
      });
    } catch (e) {
      console.error(e);
      await this.dialogService?.open({
        title: 'Delete failed',
        message: 'Visits could not be deleted. Check console.',
        type: 'error'
      });
    }
  }

  // Card batch-select (narrow viewports): mirrors grid multi-select for admins.
  cardSelectMode = false;

  toggleCardSelectMode(): void {
    this.cardSelectMode = !this.cardSelectMode;
    if (!this.cardSelectMode) this.selectedVisits = [];
  }

  isCardSelected(visit: any): boolean {
    return this.selectedVisits.some((v: any) => v?.id === visit?.id);
  }

  onCardTap(visit: any): void {
    if (this.cardSelectMode) this.toggleCardSelection(visit);
    else this.goToVisit(visit);
  }

  toggleCardSelection(visit: any): void {
    if (this.isCardSelected(visit)) {
      this.selectedVisits = this.selectedVisits.filter((v: any) => v?.id !== visit?.id);
    } else {
      this.selectedVisits = [...this.selectedVisits, visit];
    }
  }

  onRowClick(data: any) {
    this.goToVisit(data);
  }

  goToVisit(visit: any) {
    this.router.navigate(['/visit', visit.patient_id], {
      queryParams: { visitId: visit.id, mode: 'view' },
      state: { visitId: visit.id, mode: 'view' }
    });
  }
}
