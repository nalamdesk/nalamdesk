import { describe, expect, it } from 'vitest';
import { localDateISO } from './local-date';

describe('localDateISO', () => {
    it('formats the local calendar date with zero padding', () => {
        expect(localDateISO(new Date(2026, 0, 5, 0, 15))).toBe('2026-01-05');
        expect(localDateISO(new Date(2026, 11, 31, 23, 59))).toBe('2026-12-31');
    });

    it('keeps local midnight on its own day whatever the UTC offset', () => {
        const midnight = new Date(1990, 6, 1);
        expect(localDateISO(midnight)).toBe('1990-07-01');
    });
});
