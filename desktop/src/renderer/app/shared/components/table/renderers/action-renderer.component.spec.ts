/**
 * @vitest-environment jsdom
 */
import '@angular/compiler';
import { describe, expect, it } from 'vitest';
import { ActionRendererComponent } from './action-renderer.component';

function makeParams(overrides: any = {}) {
    return {
        data: { id: 5, username: 'nurse-1' },
        onEdit: undefined,
        onDelete: undefined,
        onPermissions: undefined,
        canDelete: undefined,
        ...overrides
    } as any;
}

describe('ActionRendererComponent', () => {
    it('forwards edit and delete to the row handlers', () => {
        const component = new ActionRendererComponent();
        const seen: string[] = [];
        component.agInit(makeParams({
            onEdit: (row: any) => seen.push(`edit:${row.id}`),
            onDelete: (row: any) => seen.push(`delete:${row.id}`)
        }));
        component.onEdit();
        component.onDelete();
        expect(seen).toEqual(['edit:5', 'delete:5']);
        expect(component.refresh(makeParams({}))).toBe(true);
    });

    it('ignores missing handlers without throwing', () => {
        const component = new ActionRendererComponent();
        component.agInit(makeParams({}));
        expect(() => {
            component.onEdit();
            component.onDelete();
            component.onPermissions();
        }).not.toThrow();
        expect(component.canDelete).toBe(true);
        expect(component.showPermissions).toBe(false);
    });

    it('gates delete and permissions affordances per row', () => {
        const component = new ActionRendererComponent();
        const calls: number[] = [];
        component.agInit(makeParams({
            data: { id: 1, username: 'admin' },
            canDelete: (row: any) => row.username !== 'admin',
            onPermissions: (row: any) => calls.push(row.id)
        }));
        expect(component.canDelete).toBe(false);
        expect(component.showPermissions).toBe(true);
        component.onPermissions();
        expect(calls).toEqual([1]);
    });

    it('exposes deactivate copy and purge affordance for lifecycle rows', () => {
        const component = new ActionRendererComponent();
        const purged: number[] = [];
        component.agInit(makeParams({
            onPurge: (row: any) => purged.push(row.id),
            canPurge: (row: any) => row.username !== 'admin',
            deleteTitle: 'Deactivate',
            deleteDisabledTitle: 'Cannot deactivate this user'
        }));
        expect(component.deleteTitle).toBe('Deactivate');
        expect(component.deleteDisabledTitle).toBe('Cannot deactivate this user');
        expect(component.canPurge).toBe(true);
        component.onPurge();
        expect(purged).toEqual([5]);
    });

    it('falls back to delete copy and hides purge without a handler', () => {
        const component = new ActionRendererComponent();
        component.agInit(makeParams({}));
        expect(component.deleteTitle).toBe('Delete');
        expect(component.deleteDisabledTitle).toBe('Cannot delete this user');
        expect(component.canPurge).toBe(false);
        expect(() => component.onPurge()).not.toThrow();
    });

    it('gates purge per row when a predicate is given', () => {
        const component = new ActionRendererComponent();
        component.agInit(makeParams({
            data: { id: 1, username: 'admin' },
            onPurge: () => undefined,
            canPurge: (row: any) => row.username !== 'admin'
        }));
        expect(component.canPurge).toBe(false);
    });

    it('allows purge by default when no predicate is given', () => {
        const component = new ActionRendererComponent();
        component.agInit(makeParams({ onPurge: () => undefined }));
        expect(component.canPurge).toBe(true);
    });
});
