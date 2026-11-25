import { describe, expect, it } from 'vitest';
import { buildDisplayBoard } from './queue-display.component';

describe('buildDisplayBoard', () => {
    it('shows only token numbers: serving, then the next waiting in queue order', () => {
        const board = buildDisplayBoard([
            { status: 'in-consult', token_no: 4, patient_name: 'Asha Rao' },
            { status: 'waiting', token_no: 7, patient_name: 'Ravi K' },
            { status: 'waiting', token_no: 5, patient_name: 'Meena S' },
            { status: 'waiting', token_no: null, patient_name: 'Old entry' },
        ]);
        expect(board).toEqual({ serving: [4], next: [7, 5], waiting: 3 });
        expect(JSON.stringify(board)).not.toMatch(/Asha|Ravi|Meena/);
    });

    it('caps the next list and tolerates bad input', () => {
        const queue = Array.from({ length: 9 }, (_, i) => ({ status: 'waiting', token_no: i + 1 }));
        expect(buildDisplayBoard(queue, 5).next).toEqual([1, 2, 3, 4, 5]);
        expect(buildDisplayBoard(null as any)).toEqual({ serving: [], next: [], waiting: 0 });
    });
});
