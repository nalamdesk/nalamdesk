/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CatalogTypeaheadComponent } from './catalog-typeahead.component';

describe('CatalogTypeaheadComponent', () => {
    let component: CatalogTypeaheadComponent;

    beforeEach(() => {
        component = new CatalogTypeaheadComponent();
        component.searchFn = vi.fn().mockResolvedValue([{ id: 1, name: 'Influenza' }]);
        component.createFn = vi.fn().mockResolvedValue({ id: 2, name: 'Viral fever' });
    });

    it('emits a picked catalog row', () => {
        const picked = vi.fn();
        component.picked.subscribe(picked);
        component.pick({ id: 1, name: 'Influenza' });
        expect(component.value).toBe('Influenza');
        expect(picked).toHaveBeenCalledWith({ id: 1, name: 'Influenza' });
        expect(component.open).toBe(false);
    });

    it('adds a new catalog row then selects it', async () => {
        component.value = 'Viral fever';
        const picked = vi.fn();
        component.picked.subscribe(picked);
        await component.addNew();
        expect(component.createFn).toHaveBeenCalledWith('Viral fever');
        expect(picked).toHaveBeenCalledWith({ id: 2, name: 'Viral fever' });
    });

    it('keeps typed text usable when add new fails', async () => {
        component.value = 'Viral fever';
        component.createFn = vi.fn().mockRejectedValue(new Error('DUPLICATE_ACTIVE_NAME'));
        await component.addNew();
        expect(component.value).toBe('Viral fever');
        expect(component.error).toMatch(/already/i);
    });

    it('searches on focus and debounce, and ignores failed searches', async () => {
        vi.useFakeTimers();
        component.onInput('flu');
        await vi.advanceTimersByTimeAsync(160);
        expect(component.searchFn).toHaveBeenCalledWith('flu');
        vi.useRealTimers();

        component.searchFn = vi.fn().mockRejectedValue(new Error('offline'));
        component.value = 'x';
        component.onFocus();
        await Promise.resolve();
        expect(component.hits).toEqual([]);
    });

    it('offers Add new only when the typed name is not already a hit', () => {
        component.value = 'Viral fever';
        component.hits = [{ id: 1, name: 'Influenza' }];
        expect(component.canAdd).toBe(true);
        component.hits = [{ id: 2, name: 'Viral fever' }];
        expect(component.canAdd).toBe(false);
    });

    it('subtitles enriched rows with generic, brand, and ICD codes', () => {
        expect(component.hitSubtitle({ id: 1, name: 'Crocin 500', generic_name: 'Paracetamol', brand_name: 'Crocin' } as any))
            .toBe('Paracetamol (Crocin)');
        expect(component.hitSubtitle({ id: 2, name: 'Essential hypertension', icd10_code: 'I10', icd11_code: 'BA00.Z' } as any))
            .toBe('ICD-11 BA00.Z');
        expect(component.hitSubtitle({ id: 3, name: 'Old entry' } as any)).toBe('');
        expect(component.hitSubtitle({ id: 4, name: 'Paracetamol', generic_name: 'Paracetamol' } as any)).toBe('');
    });

    it('maps add-new validation errors', async () => {
        component.value = ' ';
        await component.addNew();
        component.value = 'x';
        component.createFn = vi.fn().mockRejectedValue(new Error('NAME_REQUIRED'));
        await component.addNew();
        expect(component.error).toMatch(/required/i);
        component.createFn = vi.fn().mockRejectedValue('offline');
        await component.addNew();
        expect(component.error).toMatch(/keep the typed name/i);
        component.ngOnDestroy();
    });

    it('ignores an older search that finishes after a newer query', async () => {
        let resolveOlder: (hits: { id: number; name: string }[]) => void = () => undefined;
        let resolveNewer: (hits: { id: number; name: string }[]) => void = () => undefined;
        const older = new Promise<{ id: number; name: string }[]>((resolve) => {
            resolveOlder = resolve;
        });
        const newer = new Promise<{ id: number; name: string }[]>((resolve) => {
            resolveNewer = resolve;
        });
        let calls = 0;
        component.searchFn = vi.fn().mockImplementation(() => {
            calls += 1;
            return calls === 1 ? older : newer;
        });

        component.value = 'fl';
        component.onFocus();
        component.value = 'flu';
        component.onFocus();

        resolveOlder([{ id: 1, name: 'Flower' }]);
        await Promise.resolve();
        expect(component.hits).toEqual([]);

        resolveNewer([{ id: 2, name: 'Influenza' }]);
        await Promise.resolve();
        expect(component.hits).toEqual([{ id: 2, name: 'Influenza' }]);
    });
});
