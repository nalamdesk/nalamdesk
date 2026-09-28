import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ICellRendererAngularComp } from 'ag-grid-angular';
import { ICellRendererParams } from 'ag-grid-community';

@Component({
  selector: 'app-action-renderer',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="flex justify-end gap-3 h-full items-center">
      <button (click)="onEdit()" class="text-gray-400 hover:text-blue-600 transition-colors" title="Edit">
        ✏️
      </button>
      <button *ngIf="showPermissions" (click)="onPermissions()" class="text-gray-400 hover:text-blue-600 transition-colors" title="Permissions">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-4 h-4"><path stroke-linecap="round" stroke-linejoin="round" d="M15 7.5a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm-9 9.75a6 6 0 0 1 6-6h1.5a6 6 0 0 1 5.25 3.12l1.11 2.035a.75.75 0 0 1-.663 1.095H6.75a.75.75 0 0 1-.75-.75v-.5Z" /></svg>
      </button>
      <button *ngIf="canDelete" (click)="onDelete()" class="text-gray-400 hover:text-red-600 transition-colors" title="Delete">
        🗑️
      </button>
      <span *ngIf="!canDelete" class="text-gray-200 cursor-not-allowed" title="Cannot delete this user">🗑️</span>
    </div>
  `,
  styles: []
})
export class ActionRendererComponent implements ICellRendererAngularComp {
  params: any;

  agInit(params: ICellRendererParams): void {
    this.params = params;
  }

  refresh(params: ICellRendererParams): boolean {
    this.params = params;
    return true;
  }

  get canDelete(): boolean {
    if (this.params.canDelete) {
      return this.params.canDelete(this.params.data);
    }
    return true;
  }

  get showPermissions(): boolean {
    return typeof this.params.onPermissions === 'function';
  }

  onPermissions() {
    if (this.params.onPermissions) {
      this.params.onPermissions(this.params.data);
    }
  }

  onEdit() {
    if (this.params.onEdit) {
      this.params.onEdit(this.params.data);
    }
  }

  onDelete() {
    if (this.params.onDelete) {
      this.params.onDelete(this.params.data);
    }
  }
}
