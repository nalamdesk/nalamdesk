import { Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';

export type CompactView = 'cards' | 'grid';

/** Read a persisted narrow-viewport layout; falls back when storage is missing. */
export function restoreCompactView(key: string, fallback: CompactView = 'cards'): CompactView {
    try {
        const saved = localStorage.getItem(key);
        if (saved === 'cards' || saved === 'grid') return saved;
    } catch { /* private mode: session-only preference */ }
    return fallback;
}

/** Persist a narrow-viewport layout; silently session-only when storage fails. */
export function persistCompactView(key: string, view: CompactView): void {
    try {
        localStorage.setItem(key, view);
    } catch { /* private mode: session-only preference */ }
}

/**
 * Narrow-viewport Cards | Grid switch. Desktop layouts always use the grid;
 * hosts show this control under `md:` and swap their own containers.
 */
@Component({
    selector: 'app-view-toggle',
    standalone: true,
    imports: [CommonModule],
    template: `
    <div class="flex rounded-md border border-gray-300 overflow-hidden" role="group" [attr.aria-label]="label">
      <button type="button" (click)="pick('cards')" [attr.aria-pressed]="value === 'cards'"
              class="px-3 py-1.5 text-xs font-semibold transition-colors"
              [ngClass]="value === 'cards' ? 'bg-blue-600 text-white' : 'bg-white text-gray-600'">Cards</button>
      <button type="button" (click)="pick('grid')" [attr.aria-pressed]="value === 'grid'"
              class="px-3 py-1.5 text-xs font-semibold transition-colors border-l border-gray-300"
              [ngClass]="value === 'grid' ? 'bg-blue-600 text-white' : 'bg-white text-gray-600'">Grid</button>
    </div>
  `
})
export class ViewToggleComponent {
    @Input() value: CompactView = 'cards';
    @Input() label = 'View';
    @Output() valueChange = new EventEmitter<CompactView>();

    pick(view: CompactView): void {
        if (view !== this.value) this.valueChange.emit(view);
    }
}
