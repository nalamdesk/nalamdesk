import { Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

/**
 * Small audited-reason prompt: every destructive or correcting action in
 * the lifecycle model (archive, entered-in-error, remove) needs a recorded
 * reason. Emits the trimmed reason, or null on cancel.
 */
@Component({
  selector: 'app-reason-dialog',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div *ngIf="open" class="fixed inset-0 bg-black/50 z-[90] flex items-center justify-center p-4">
      <div class="bg-white rounded-lg shadow-xl w-full max-w-md overflow-hidden">
        <div class="px-6 py-4 border-b bg-gray-50">
          <h2 class="text-lg font-bold text-gray-800">{{ title }}</h2>
          <p *ngIf="message" class="text-xs text-gray-500 mt-1">{{ message }}</p>
        </div>
        <div class="p-6">
          <label class="block text-xs font-bold text-gray-500 uppercase mb-1">Reason {{ required ? '(required, audited)' : '(optional, audited)' }}</label>
          <input [(ngModel)]="reason" [placeholder]="placeholder || 'Why is this happening?'"
                 class="w-full border p-2 rounded text-sm outline-none focus:ring-2 focus:ring-blue-500" />
        </div>
        <div class="px-6 py-3 border-t bg-gray-50 flex justify-end gap-2">
          <button (click)="cancel()" class="px-4 py-2 text-sm text-gray-600 hover:bg-gray-200 rounded border bg-white">Cancel</button>
          <button (click)="confirm()" [disabled]="required && !reason.trim()"
                  class="px-4 py-2 text-sm text-white font-medium rounded bg-blue-600 hover:bg-blue-700 disabled:opacity-50">{{ confirmText || 'Confirm' }}</button>
        </div>
      </div>
    </div>
  `,
  styles: []
})
export class ReasonDialogComponent {
  @Input() open = false;
  @Input() title = '';
  @Input() message = '';
  @Input() placeholder = '';
  @Input() confirmText = 'Confirm';
  @Input() required = true;
  @Output() decided = new EventEmitter<string | null>();

  reason = '';

  confirm() {
    const value = this.reason.trim();
    this.reason = '';
    this.decided.emit(value || null);
  }

  cancel() {
    this.reason = '';
    this.decided.emit(null);
  }
}
