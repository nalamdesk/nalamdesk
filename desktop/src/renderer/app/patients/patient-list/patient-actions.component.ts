import { Component } from '@angular/core';
import { ICellRendererAngularComp } from 'ag-grid-angular';
import { ICellRendererParams } from 'ag-grid-community';
import { CommonModule } from '@angular/common';

@Component({
    selector: 'app-patient-actions-renderer',
    standalone: true,
    imports: [CommonModule],
    template: `
    <div class="flex items-center h-full gap-2">
      <button 
        (click)="onQueue($event)" 
        [disabled]="params.data.inQueue"
        [class.text-gray-400]="params.data.inQueue"
        [class.text-green-600]="!params.data.inQueue"
        class="btn btn-xs btn-ghost hover:bg-green-50 font-medium disabled:bg-transparent">
        {{ params.data.inQueue ? 'In Queue' : 'Queue' }}
      </button>
      <button (click)="onEdit($event)" class="btn btn-xs btn-ghost text-indigo-600 hover:bg-indigo-50">
        Edit
      </button>
      <button *ngIf="params.data?.active !== 0" (click)="onArchive($event)" class="btn btn-xs btn-ghost text-amber-600 hover:bg-amber-50">
        Archive
      </button>
      <button *ngIf="params.data?.active === 0" (click)="onUnarchive($event)" class="btn btn-xs btn-ghost text-emerald-600 hover:bg-emerald-50">
        Restore
      </button>
    </div>
  `,
    styles: [`:host { display: block; height: 100%; }`]
})
export class PatientActionsRenderer implements ICellRendererAngularComp {
    params: any;

    agInit(params: ICellRendererParams): void {
        this.params = params;
    }

    refresh(params: ICellRendererParams): boolean {
        this.params = params;
        return true;
    }

    onQueue(event: MouseEvent) {
        event.stopPropagation();
        if (this.params.onQueue) {
            this.params.onQueue(this.params.data);
        }
    }

    onEdit(event: MouseEvent) {
        event.stopPropagation();
        if (this.params.onEdit) {
            this.params.onEdit(this.params.data);
        }
    }

    onArchive(event: MouseEvent) {
        event.stopPropagation();
        if (this.params.onArchive) {
            this.params.onArchive(this.params.data);
        }
    }

    onUnarchive(event: MouseEvent) {
        event.stopPropagation();
        if (this.params.onUnarchive) {
            this.params.onUnarchive(this.params.data);
        }
    }
}
