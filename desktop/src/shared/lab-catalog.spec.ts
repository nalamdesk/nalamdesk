import { describe, expect, it } from 'vitest';
import { LAB_TESTS, findLabTest, flagResult } from './lab-catalog';

describe('lab catalog', () => {
    it('has unique test codes and analyte codes per test', () => {
        const codes = LAB_TESTS.map((t) => t.code);
        expect(new Set(codes).size).toBe(codes.length);
        for (const t of LAB_TESTS) {
            const a = t.analytes.map((x) => x.code);
            expect(new Set(a).size, t.code).toBe(a.length);
            expect(a.length, t.code).toBeGreaterThan(0);
        }
        expect(findLabTest('HBA1C')?.analytes[0].unit).toBe('%');
    });

    it('flags high and low only against numeric ranges', () => {
        expect(flagResult(8.1, 4, 5.7)).toBe('H');
        expect(flagResult(9, 12, 17)).toBe('L');
        expect(flagResult(14, 12, 17)).toBeNull();
        expect(flagResult(null, 12, 17)).toBeNull();
        expect(flagResult(5, undefined, undefined)).toBeNull();
    });
});
