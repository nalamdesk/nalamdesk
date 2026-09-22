/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { ViewToggleComponent, restoreCompactView, persistCompactView } from './view-toggle.component';

describe('ViewToggleComponent', () => {
    it('emits only when the view actually changes', () => {
        const toggle = new ViewToggleComponent();
        const emit = vi.spyOn(toggle.valueChange, 'emit');
        toggle.value = 'cards';
        toggle.pick('cards');
        expect(emit).not.toHaveBeenCalled();
        toggle.pick('grid');
        expect(emit).toHaveBeenCalledWith('grid');
    });

    it('round-trips the persisted view with a cards fallback', () => {
        localStorage.clear();
        expect(restoreCompactView('test.view')).toBe('cards');
        expect(restoreCompactView('test.view', 'grid')).toBe('grid');
        persistCompactView('test.view', 'grid');
        expect(restoreCompactView('test.view')).toBe('grid');
        localStorage.setItem('test.view', 'nonsense');
        expect(restoreCompactView('test.view')).toBe('cards');
        localStorage.clear();
    });
});
