import { Component, EventEmitter, Input, OnDestroy, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

export interface CatalogPick {
    id: number;
    name: string;
    [key: string]: any;
}

@Component({
    selector: 'app-catalog-typeahead',
    standalone: true,
    imports: [CommonModule, FormsModule],
    template: `
    <div class="relative">
      <input type="text"
             [ngModel]="value"
             (ngModelChange)="onInput($event)"
             (focus)="onFocus()"
             [placeholder]="placeholder"
             [disabled]="disabled"
             [attr.data-testid]="testId"
             class="w-full p-2 border border-gray-300 rounded focus:ring-2 focus:ring-blue-500 outline-none font-medium" />
      <div *ngIf="open && !disabled" class="absolute z-30 mt-1 w-full bg-white border border-gray-200 rounded shadow-lg max-h-48 overflow-y-auto">
        <button type="button" *ngFor="let hit of hits"
                class="block w-full text-left px-3 py-2 text-sm hover:bg-blue-50"
                (click)="pick(hit)">
          <span class="block font-medium text-gray-800">{{ hit.name }}</span>
          <span *ngIf="hitSubtitle(hit)" class="block text-xs text-gray-500 truncate">{{ hitSubtitle(hit) }}</span>
        </button>
        <button type="button" *ngIf="canAdd"
                class="block w-full text-left px-3 py-2 text-sm text-blue-700 hover:bg-blue-50 font-medium"
                (click)="addNew()">+ Add new “{{ value.trim() }}”</button>
        <div *ngIf="hits.length === 0 && !canAdd" class="px-3 py-2 text-xs text-gray-400">No matching catalog entries</div>
      </div>
      <p *ngIf="error" class="text-xs text-red-500 mt-1">{{ error }}</p>
    </div>
  `
})
export class CatalogTypeaheadComponent implements OnDestroy {
    @Input() value = '';
    @Input() placeholder = '';
    @Input() disabled = false;
    @Input() testId = 'catalog-typeahead';
    @Input() searchFn?: (query: string) => Promise<CatalogPick[]>;
    @Input() createFn?: (name: string) => Promise<CatalogPick>;
    @Output() valueChange = new EventEmitter<string>();
    @Output() picked = new EventEmitter<CatalogPick>();

    hits: CatalogPick[] = [];
    open = false;
    error = '';
    private timer: ReturnType<typeof setTimeout> | null = null;
    private searchGeneration = 0;

    ngOnDestroy(): void {
        if (this.timer) clearTimeout(this.timer);
        this.searchGeneration += 1;
    }

    onFocus(): void {
        if (this.disabled) return;
        this.open = true;
        void this.search(this.value);
    }

    onInput(next: string): void {
        this.value = next;
        this.valueChange.emit(next);
        this.error = '';
        this.open = true;
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.search(next), 150);
    }

    pick(hit: CatalogPick): void {
        this.searchGeneration += 1;
        this.value = hit.name;
        this.valueChange.emit(hit.name);
        this.open = false;
        this.picked.emit(hit);
    }

    /**
     * Second-line hint for enriched rows (issue #56 PR-B): generic plus
     * brand for medicines, ICD codes for conditions. Plain rows (free-text
     * history, uncoded entries) show no subtitle.
     */
    hitSubtitle(hit: CatalogPick): string {
        const parts: string[] = [];
        const name = String(hit?.name || '').trim().toLowerCase();
        const generic = String(hit?.['generic_name'] || '').trim();
        const brand = String(hit?.['brand_name'] || '').trim();
        if (generic && generic.toLowerCase() !== name) {
            parts.push(brand && brand.toLowerCase() !== generic.toLowerCase() ? `${generic} (${brand})` : generic);
        } else if (brand && brand.toLowerCase() !== name) {
            parts.push(`Brand: ${brand}`);
        }
        const icd11 = String(hit?.['icd11_code'] || '').trim();
        const icd10 = String(hit?.['icd10_code'] || '').trim();
        if (icd11) parts.push(`ICD-11 ${icd11}`);
        else if (icd10) parts.push(`ICD-10 ${icd10}`);
        return parts.join(' · ');
    }

    async addNew(): Promise<void> {
        if (!this.createFn || !this.value.trim()) return;
        try {
            const created = await this.createFn(this.value.trim());
            this.pick(created);
        } catch (error) {
            this.error = this.createError(error);
        }
    }

    get canAdd(): boolean {
        const typed = this.value.trim().toLowerCase();
        if (!typed || !this.createFn) return false;
        return !this.hits.some((hit) => hit.name.trim().toLowerCase() === typed);
    }

    private async search(query: string): Promise<void> {
        if (!this.searchFn) return;
        const generation = ++this.searchGeneration;
        try {
            const hits = await this.searchFn(query);
            if (generation !== this.searchGeneration) return;
            this.hits = hits;
        } catch {
            if (generation !== this.searchGeneration) return;
            this.hits = [];
        }
    }

    private createError(error: unknown): string {
        const message = error instanceof Error ? error.message : (typeof error === 'string' ? error : '');
        if (/NAME_REQUIRED/i.test(message)) return 'Name is required.';
        if (/DUPLICATE_ACTIVE_NAME/i.test(message)) return 'That name is already in the catalog.';
        return 'Could not add this catalog entry. You can keep the typed name.';
    }
}
