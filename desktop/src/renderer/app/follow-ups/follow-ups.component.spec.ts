import { describe, expect, it, vi } from 'vitest';
import { FollowUpsComponent, followUpBucket, followUpLabel } from './follow-ups.component';

describe('follow-up labels', () => {
    it('buckets and words due dates for the desk', () => {
        expect([followUpBucket(-3), followUpBucket(0), followUpBucket(2)]).toEqual(['overdue', 'today', 'upcoming']);
        expect(followUpLabel(-3)).toBe('3 days overdue');
        expect(followUpLabel(-1)).toBe('1 day overdue');
        expect(followUpLabel(0)).toBe('Due today');
        expect(followUpLabel(1)).toBe('Due tomorrow');
        expect(followUpLabel(5)).toBe('Due in 5 days');
    });
});

describe('FollowUpsComponent', () => {
    const zone = { run: (fn: () => any) => fn() } as any;
    const make = (invoke: any, role = 'receptionist') => new FollowUpsComponent(
        { invoke } as any, { navigate: vi.fn() } as any, zone,
        { success: vi.fn(), error: vi.fn() } as any,
        { getUser: () => ({ role }) } as any, { refresh: vi.fn() } as any);

    it('loads and counts follow-ups by bucket', async () => {
        const invoke = vi.fn(async () => [
            { id: 1, days_until_due: -2 }, { id: 2, days_until_due: 0 }, { id: 3, days_until_due: 4 }, { id: 4, days_until_due: -1 }
        ]);
        const c = make(invoke);
        await c.load();
        expect(c.counts).toEqual({ overdue: 2, today: 1, upcoming: 1 });
        expect(c.canClose).toBe(true);
    });

    it('closes with the chosen status and reloads; nurses only read', async () => {
        const invoke = vi.fn(async (method: string) => (method === 'getFollowUps' ? [] : { changes: 1 }));
        const c = make(invoke);
        await c.close({ id: 7 }, 'dismissed', 'Moved away');
        expect(invoke).toHaveBeenCalledWith('closeFollowUp', { id: 7, status: 'dismissed', reason: 'Moved away' });
        expect(invoke).toHaveBeenLastCalledWith('getFollowUps');
        expect(make(invoke, 'nurse').canClose).toBe(false);
    });
});
