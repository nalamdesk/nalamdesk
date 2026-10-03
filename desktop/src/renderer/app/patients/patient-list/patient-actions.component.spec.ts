/**
 * @vitest-environment jsdom
 */
import '@angular/compiler';
import { describe, expect, it } from 'vitest';
import { PatientActionsRenderer } from './patient-actions.component';

function makeParams(overrides: any = {}) {
    return {
        data: { id: 7, active: 1 },
        onQueue: undefined,
        onEdit: undefined,
        onArchive: undefined,
        onUnarchive: undefined,
        ...overrides
    } as any;
}

describe('PatientActionsRenderer', () => {
    it('forwards queue, edit, archive, and restore to the row handlers', () => {
        const component = new PatientActionsRenderer();
        const seen: string[] = [];
        const stop = { stopPropagation: () => undefined } as any;
        component.agInit(makeParams({
            onQueue: (row: any) => seen.push(`queue:${row.id}`),
            onEdit: (row: any) => seen.push(`edit:${row.id}`),
            onArchive: (row: any) => seen.push(`archive:${row.id}`),
            onUnarchive: (row: any) => seen.push(`restore:${row.id}`)
        }));
        component.onQueue(stop);
        component.onEdit(stop);
        component.onArchive(stop);
        component.onUnarchive(stop);
        expect(seen).toEqual(['queue:7', 'edit:7', 'archive:7', 'restore:7']);
        expect(component.refresh(makeParams({}))).toBe(true);
    });

    it('ignores missing handlers without throwing', () => {
        const component = new PatientActionsRenderer();
        const stop = { stopPropagation: () => undefined } as any;
        component.agInit(makeParams({}));
        expect(() => {
            component.onQueue(stop);
            component.onEdit(stop);
            component.onArchive(stop);
            component.onUnarchive(stop);
        }).not.toThrow();
    });
});
