import { Component, EventEmitter, Input, Output, ElementRef, NgZone, OnInit, OnDestroy, OnChanges, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AgGridAngular } from 'ag-grid-angular';
import { ColDef, GridOptions } from 'ag-grid-community';

@Component({
  selector: 'app-shared-table',
  standalone: true,
  imports: [CommonModule, AgGridAngular, FormsModule],
  template: `
    <div class="h-full flex flex-col relative w-full bg-white rounded-lg border border-gray-200 overflow-hidden shadow-sm">
      
      <!-- Table Toolbar -->
      <div *ngIf="enableTools" class="flex-none px-4 py-3 border-b border-gray-100 flex flex-col md:flex-row justify-between items-start md:items-center gap-3 bg-white">
          <!-- Left: Title or Search (Slot?) -->
          <div class="flex flex-wrap items-center gap-2 w-full md:w-auto">
             <ng-content select="[toolbar-left]"></ng-content>
          </div>

          <!-- Right: Controls -->
          <div class="flex items-center gap-2 self-end md:self-auto">
              
              <!-- Reset Filters -->
              <button (click)="resetState()" class="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-600 hover:text-gray-900 hover:bg-gray-50 rounded-md transition-colors border border-transparent hover:border-gray-200">
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-4 h-4 text-gray-500">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" />
                  </svg>
                  Reset
              </button>

              <!-- Column Selector -->
              <div class="relative">
                  <button (click)="toolsState.showCols = !toolsState.showCols" 
                          class="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-700 bg-white border border-gray-200 rounded-md hover:bg-gray-50 shadow-sm transition-all">
                      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-4 h-4 text-gray-500">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M9 4.5v15m6-15v15m-10.875 0h15.75c.621 0 1.125-.504 1.125-1.125V5.625c0-.621-.504-1.125-1.125-1.125H4.125C3.504 4.5 3 5.004 3 5.625v12.75c0 .621.504 1.125 1.125 1.125Z" />
                      </svg>
                      Cols
                      <span class="text-xs text-gray-400">▼</span>
                  </button>

                  <!-- Popover -->
                  <div *ngIf="toolsState.showCols" 
                       class="absolute right-0 mt-2 w-56 bg-white rounded-lg shadow-xl border border-gray-100 z-50 animate-in fade-in zoom-in-95 duration-100 origin-top-right">
                      <div class="p-2 border-b border-gray-50 bg-gray-50/50 rounded-t-lg">
                          <span class="text-[10px] font-bold text-gray-400 uppercase tracking-wider px-1">Visible Columns</span>
                      </div>
                      <div class="max-h-60 overflow-y-auto p-1">
                          <label *ngFor="let col of toggleableColumns" class="flex items-center gap-3 px-2 py-2 hover:bg-gray-50 rounded cursor-pointer select-none">
                              <input type="checkbox" [checked]="col.visible" (change)="toggleColumn(col.colId, $any($event.target).checked)"
                                     class="rounded border-gray-300 text-blue-600 focus:ring-blue-500 h-4 w-4">
                              <span class="text-sm text-gray-700">{{ col.headerName }}</span>
                          </label>
                      </div>
                  </div>
                  
                  <!-- Backdrop to close -->
                  <div *ngIf="toolsState.showCols" (click)="toolsState.showCols = false" class="fixed inset-0 z-40 cursor-default"></div>
              </div>

          </div>
      </div>

      <div class="flex-1 w-full overflow-x-auto overflow-y-hidden relative">
        <ag-grid-angular
            class="h-full w-full ag-theme-quartz"
            [rowData]="rowData"
            [columnDefs]="columnDefs"
            [defaultColDef]="defaultColDef"
            [paginationPageSize]="pageSize"
            [paginationPageSizeSelector]="[10, 20, 50, 100]"
            [rowSelection]="selectionOptions"
            [rowHeight]="rowHeight"
            [overlayNoRowsTemplate]="noRowsTemplate"
            [animateRows]="true"
            (gridReady)="onGridReady($event)"
            (selectionChanged)="onSelectionChanged($event)"
            (rowClicked)="onRowClicked($event)">
        </ag-grid-angular>

        <!-- Loading Overlay -->
        <div *ngIf="loading" class="absolute inset-0 z-50 bg-white/80 flex flex-col items-center justify-center backdrop-blur-sm">
            <span class="loading loading-spinner loading-md text-primary"></span>
        </div>
      </div>
    </div>
  `,
  styles: [`
    :host {
      display: block;
      height: 100%;
      width: 100%;
    }
  `]
})
export class SharedTableComponent implements OnInit, OnDestroy, OnChanges {
  @Input() rowData: any[] = [];
  @Input() columnDefs: ColDef[] = [];
  @Input() pagination = true;
  @Input() pageSize = 20;
  @Input() rowHeight = 50;
  @Input() loading = false;
  @Input() enableTools = true;
  @Input() quickFilterText = '';
  @Input() multiSelect = false;

  @Output() rowClick = new EventEmitter<any>();
  @Output() gridReady = new EventEmitter<any>();
  @Output() selectionChanged = new EventEmitter<any[]>();

  private gridApi: any;

  /**
   * AG Grid 32 selection model. Multi-select renders an explicit checkbox
   * column (row + header) so batch actions are discoverable; single-select
   * stays click-to-select with no checkbox chrome. Set once per
   * multiSelect change: a template-literal object would reset selection on
   * every change-detection cycle.
   */
  selectionOptions: any = { mode: 'singleRow', checkboxes: false, enableClickSelection: true };

  ngOnInit() {
    this.applySelectionOptions();
  }

  private applySelectionOptions(): void {
    this.selectionOptions = this.multiSelect
      ? { mode: 'multiRow', checkboxes: true, headerCheckbox: true, enableClickSelection: true }
      : { mode: 'singleRow', checkboxes: false, enableClickSelection: true };
  }

  toolsState = { showCols: false };
  toggleableColumns: { colId: string, headerName: string, visible: boolean }[] = [];

  noRowsTemplate = `
    <div class="flex flex-col items-center justify-center p-8 text-gray-500">
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-12 h-12 mb-3 text-gray-300">
        <path stroke-linecap="round" stroke-linejoin="round" d="M3.75 9.776c.112-.017.227-.026.344-.026h15.812c.117 0 .232.009.344.026m-16.5 0a2.25 2.25 0 00-1.883 2.542l.857 6a2.25 2.25 0 002.227 1.932H19.05a2.25 2.25 0 002.227-1.932l.857-6a2.25 2.25 0 00-1.883-2.542m-16.5 0V6A2.25 2.25 0 016 3.75h3.879a1.5 1.5 0 011.06.44l2.122 2.12a1.5 1.5 0 001.06.44H18A2.25 2.25 0 0120.25 9v.776" />
      </svg>
      <span class="text-sm font-medium">No records found</span>
    </div>
  `;

  defaultColDef: ColDef = {
    sortable: true,
    unSortIcon: true,
    filter: true,
    resizable: true,
    flex: 1,
    minWidth: 150,
    suppressHeaderMenuButton: true,
    wrapText: true,     // Keep data wrapping
    autoHeight: true,   // Keep data auto-height
    wrapHeaderText: false, // FORCE single line headers
    autoHeaderHeight: false // Disable auto header height
  };

  private resizeObserver: ResizeObserver | undefined;

  constructor(private elementRef: ElementRef<HTMLElement>, private ngZone: NgZone) { }

  ngOnChanges(changes: SimpleChanges) {
    // Apply Quick Filter when quickFilterText changes
    if (changes['quickFilterText'] && this.gridApi) {
      this.gridApi.setGridOption('quickFilterText', this.quickFilterText);
    }
    if (changes['multiSelect']) {
      this.applySelectionOptions();
    }
  }

  onGridReady(params: any) {
    this.gridApi = params.api;
    this.gridReady.emit(params);
    this.gridApi.sizeColumnsToFit();
    this.updateColumnState();

    // Observe container resize
    this.resizeObserver = new ResizeObserver(() => {
      this.ngZone.run(() => {
        if (this.gridApi) {
          this.gridApi.sizeColumnsToFit();
        }
      });
    });

    this.resizeObserver.observe(this.elementRef.nativeElement);
  }

  onRowClicked(event: any) {
    this.rowClick.emit(event.data);
  }

  onSelectionChanged(event: any) {
    const selectedRows = this.gridApi.getSelectedRows();
    this.selectionChanged.emit(selectedRows);
  }

  toggleColumn(colId: string, visible: boolean) {
    this.gridApi.setColumnsVisible([colId], visible);
    this.updateColumnState();
  }

  resetState() {
    this.gridApi.setFilterModel(null);
    this.gridApi.applyColumnState({ defaultState: { sort: null } });
    this.gridApi.sizeColumnsToFit();
  }

  private updateColumnState() {
    const cols = this.gridApi.getColumns();
    if (cols) {
      this.toggleableColumns = cols.map((c: any) => ({
        colId: c.getColId(),
        headerName: c.getColDef().headerName || c.getColId(),
        visible: c.isVisible()
      }));
    }
  }

  ngOnDestroy() {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
    }
  }
}
