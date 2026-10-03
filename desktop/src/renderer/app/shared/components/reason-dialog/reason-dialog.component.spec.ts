/**
 * @vitest-environment jsdom
 */
import '@angular/compiler';
import { describe, expect, it } from 'vitest';
import { ReasonDialogComponent } from './reason-dialog.component';

describe('ReasonDialogComponent', () => {
    it('emits the trimmed reason on confirm and clears the field', () => {
        const component = new ReasonDialogComponent();
        const seen: Array<string | null> = [];
        component.decided.subscribe((v) => seen.push(v));
        component.reason = '  duplicate chart  ';
        component.confirm();
        expect(seen).toEqual(['duplicate chart']);
        expect(component.reason).toBe('');
    });

    it('emits null on confirm when empty and not required', () => {
        const component = new ReasonDialogComponent();
        component.required = false;
        const seen: Array<string | null> = [];
        component.decided.subscribe((v) => seen.push(v));
        component.reason = '   ';
        component.confirm();
        expect(seen).toEqual([null]);
    });

    it('emits null on cancel and clears the field', () => {
        const component = new ReasonDialogComponent();
        const seen: Array<string | null> = [];
        component.decided.subscribe((v) => seen.push(v));
        component.reason = 'typed then cancelled';
        component.cancel();
        expect(seen).toEqual([null]);
        expect(component.reason).toBe('');
    });
});
