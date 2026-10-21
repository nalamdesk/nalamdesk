import { describe, expect, it } from 'vitest';
import {
    finalizeRxLines, formatRxIssues, isBlankRxLine, rxLinesKey, sameRxOrder, suggestedQuantity
} from './prescription-order';

const LINE = {
    medicine: 'Crocin 500', medicine_id: 4, form: 'Tab', dosage: '500mg', route: 'Oral',
    frequency: 'BID', duration: '5 days', instruction: 'After Food'
};

function messages(lines: any[]) {
    return finalizeRxLines(lines).issues.map((issue) => issue.message);
}

describe('finalizeRxLines', () => {
    it('normalizes a complete line and works out the quantity', () => {
        const { lines, issues } = finalizeRxLines([{ ...LINE, generic_name: ' Paracetamol ', brand_name: '' }]);
        expect(issues).toEqual([]);
        expect(lines).toEqual([{
            medicine: 'Crocin 500', medicine_id: 4, generic_name: 'Paracetamol', brand_name: null,
            form: 'Tab', dosage: '500mg', route: 'Oral', frequency: '1-0-1', duration: '5 days',
            instruction: 'After Food', quantity: 10, quantity_unit: 'tablet', quantity_derived: true,
            refills: 0, free_text: false
        }]);
    });

    it('drops blank rows and marks names that never matched the catalog', () => {
        const { lines } = finalizeRxLines([{ medicine: ' ', dosage: '' }, { ...LINE, medicine_id: null }, null as any]);
        expect(lines).toHaveLength(1);
        expect(lines[0].free_text).toBe(true);
        expect(lines[0].medicine_id).toBeNull();
        expect(finalizeRxLines(undefined)).toEqual({ lines: [], issues: [] });
    });

    it('names every missing field', () => {
        expect(messages([{ dosage: '1 tab' }])).toEqual([
            'medicine is required', 'form is required', 'route is required',
            'frequency is required', 'duration is required'
        ]);
        expect(messages([{ medicine: 'Crocin' }])).toContain('dose is required');
    });

    it('rejects a route the form cannot take, and skips the check for unknown forms', () => {
        expect(messages([{ ...LINE, route: 'IV' }])).toEqual(['Tab cannot be given by the IV route']);
        expect(messages([{ ...LINE, form: 'Inj', route: 'Oral' }])).toEqual(['Inj cannot be given by the Oral route']);
        expect(messages([{ ...LINE, form: 'Drop', route: 'Topical' }])).toEqual([]);
        expect(messages([{ ...LINE, form: 'Sachet', route: 'Oral' }])).toEqual([]);
    });

    it('checks durations against the schedule', () => {
        expect(messages([{ ...LINE, duration: '3' }])[0]).toMatch(/duration "3" needs a number and unit/);
        expect(messages([{ ...LINE, duration: 'until review' }])).toEqual([]);
        expect(messages([{ ...LINE, frequency: 'STAT', duration: '' }])).toEqual([]);
        expect(messages([{ ...LINE, frequency: 'STAT', duration: '5 days' }]))
            .toEqual(['a STAT dose is given once, so it cannot run for a course']);
        expect(messages([{ ...LINE, frequency: 'STAT', duration: 'until review' }]))
            .toEqual(['a STAT dose is given once, so it cannot run for a course']);
        expect(finalizeRxLines([{ ...LINE, frequency: 'now', duration: '' }]).lines[0])
            .toMatchObject({ frequency: 'STAT', duration: 'single dose', quantity: 1 });
    });

    it('checks quantity and refills', () => {
        expect(messages([{ ...LINE, quantity: 0 }])).toEqual(['quantity must be a positive number']);
        expect(messages([{ ...LINE, quantity: 'ten' }])).toEqual(['quantity must be a positive number']);
        expect(messages([{ ...LINE, refills: 1.5 }])).toEqual(['refills must be a whole number from 0 to 11']);
        expect(messages([{ ...LINE, refills: 12 }])).toEqual(['refills must be a whole number from 0 to 11']);
        expect(messages([{ ...LINE, refills: 'x' }])).toEqual(['refills must be a whole number from 0 to 11']);
        expect(messages([{ ...LINE, frequency: 'STAT', duration: '', refills: 1 }])).toEqual(['a STAT dose cannot carry refills']);
        const typed = finalizeRxLines([{ ...LINE, quantity: '15', quantity_unit: 'strip', refills: '2' }]).lines[0];
        expect(typed).toMatchObject({ quantity: 15, quantity_unit: 'strip', quantity_derived: false, refills: 2 });
    });

    it('works a derived quantity out again when the schedule changes', () => {
        const first = finalizeRxLines([LINE]).lines[0];
        const changed = finalizeRxLines([{ ...first, frequency: '1-1-1' }]).lines[0];
        expect(changed).toMatchObject({ quantity: 15, quantity_derived: true });
    });
});

describe('suggestedQuantity', () => {
    it('counts tablets and capsules over a finite course', () => {
        expect(suggestedQuantity({ ...LINE, frequency: '1-1-1', duration: '1 week' })).toBe(21);
        expect(suggestedQuantity({ ...LINE, form: 'Cap', dosage: '2 caps', frequency: 'OD', duration: '3 days' })).toBe(6);
    });

    it('makes nothing up when the course or form cannot be counted', () => {
        expect(suggestedQuantity({ ...LINE, duration: 'until review' })).toBeNull();
        expect(suggestedQuantity({ ...LINE, frequency: 'SOS' })).toBeNull();
        expect(suggestedQuantity({ ...LINE, form: 'Syr' })).toBeNull();
        expect(suggestedQuantity({ ...LINE, duration: '' })).toBeNull();
    });
});

describe('formatRxIssues', () => {
    it('reads as one sentence per issue', () => {
        expect(formatRxIssues([
            { line: 1, medicine: 'Crocin', message: 'dose is required' },
            { line: 2, medicine: '', message: 'medicine is required' }
        ])).toBe('Line 1 (Crocin): dose is required. Line 2: medicine is required.');
    });
});

describe('order comparison', () => {
    it('treats orders as equal only when every clinical field matches', () => {
        const a = finalizeRxLines([LINE]).lines;
        expect(sameRxOrder(a, finalizeRxLines([{ ...LINE, frequency: '1-0-1' }]).lines)).toBe(true);
        expect(sameRxOrder(a, finalizeRxLines([{ ...LINE, dosage: '650mg' }]).lines)).toBe(false);
        expect(sameRxOrder(a, [])).toBe(false);
    });

    it('keys raw lines from before orders existed', () => {
        expect(rxLinesKey([{ medicine: ' Syrup ', frequency: 'TID' }, { medicine: '' }]))
            .toBe(rxLinesKey([{ medicine: 'Syrup', frequency: '1-1-1' }]));
        expect(rxLinesKey(null)).toBe('[]');
        expect(isBlankRxLine(undefined)).toBe(true);
    });
});
