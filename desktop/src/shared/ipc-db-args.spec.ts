import { describe, it, expect } from 'vitest';
import { resolveDbMethodArgs } from './ipc-db-args';

describe('resolveDbMethodArgs addToQueue', () => {
    it('passes urgency-only requests through so priority derives from urgency', () => {
        const args = resolveDbMethodArgs('addToQueue', [{ patientId: 5, urgency: 'immediate' }], 99);
        expect(args[0]).toBe(5);
        expect(args[1]).toEqual(expect.objectContaining({ urgency: 'immediate' }));
        expect(args[2]).toBe(99);
    });

    it('preserves explicit numeric priority alongside urgency', () => {
        const args = resolveDbMethodArgs(
            'addToQueue',
            [{ patientId: 5, priority: 2, urgency: 'priority', triage_notes: 'Chest pain' }],
            99
        );
        expect(args[1]).toEqual(expect.objectContaining({
            priority: 2,
            urgency: 'priority',
            triage_notes: 'Chest pain'
        }));
    });

    it('keeps the scalar fast path for plain check-ins', () => {
        expect(resolveDbMethodArgs('addToQueue', [{ patientId: 5, priority: 1 }], 99))
            .toEqual([5, 1, 99]);
    });

    it('unpacks share-token acknowledgement with the acting user', () => {
        expect(resolveDbMethodArgs('abdmAcceptShareToken', [{ tokenId: 7 }], 99))
            .toEqual([{ tokenId: 7 }, 99]);
    });
});
