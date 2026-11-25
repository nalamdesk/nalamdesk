import { describe, expect, it } from 'vitest';
import { presetRange, reportToCsv } from './reports.component';

describe('presetRange', () => {
    const wed = new Date(2026, 10, 25, 9, 30); // Wed 25 Nov 2026, local
    it('covers today, the week from Monday, this month and last month', () => {
        expect(presetRange('today', wed)).toEqual({ from: '2026-11-25', to: '2026-11-25' });
        expect(presetRange('week', wed)).toEqual({ from: '2026-11-23', to: '2026-11-25' });
        expect(presetRange('month', wed)).toEqual({ from: '2026-11-01', to: '2026-11-25' });
        expect(presetRange('last-month', wed)).toEqual({ from: '2026-10-01', to: '2026-10-31' });
        expect(presetRange('week', new Date(2026, 10, 29))).toEqual({ from: '2026-11-23', to: '2026-11-29' });
    });
});

describe('reportToCsv', () => {
    it('writes every section and neutralises formula-like cells', () => {
        const csv = reportToCsv({
            from: '2026-11-01', to: '2026-11-25', visits: 3, patients: 2, newPatients: 1, returningPatients: 1,
            byDay: [{ day: '2026-11-25', visits: 3 }],
            byDoctor: [{ doctor: 'Dr Priya, MD', visits: 3 }],
            topDiagnoses: [{ diagnosis: '=HYPERLINK("x")', visits: 1 }],
            collections: { byMethod: { cash: 500, upi: 250 }, collected: 750, billed: 900, invoices: 2 }
        });
        expect(csv).toContain('Visits,3');
        expect(csv).toContain('"Dr Priya, MD",3');
        expect(csv).toContain(`"'=HYPERLINK(""x"")",1`);
        expect(csv).toContain('upi,250');
        expect(csv).toContain('Collected,750');
    });
});
