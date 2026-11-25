import { describe, expect, it, vi } from 'vitest';
import { LabResultsPanelComponent } from './lab-results-panel.component';

const zone = { run: (fn: () => any) => fn() } as any;
const make = (invoke: any, role = 'doctor') => {
    const c = new LabResultsPanelComponent({ invoke } as any, zone, { error: vi.fn() } as any);
    c.patientId = 1;
    c.role = role;
    return c;
};

describe('LabResultsPanelComponent', () => {
    it('prefills catalog analytes and ranges, flags live, and saves values', async () => {
        const invoke = vi.fn(async (method: string) => (method === 'getLabOrders' ? [] : {}));
        const c = make(invoke);
        c.startEntry({ id: 5, test_code: 'LIPID', test_name: 'Lipid profile', results: [] });
        expect(c.draft.map((d) => d.code)).toEqual(['TC', 'TG', 'HDL', 'LDL']);
        c.draft[0].value = '240';
        c.draft[2].value = '32';
        expect(c.draftFlag(c.draft[0])).toBe('H');
        expect(c.draftFlag(c.draft[2])).toBe('L');
        await c.save({ id: 5 });
        const [, payload] = invoke.mock.calls.find((call: any[]) => call[0] === 'saveLabResults')!;
        expect(payload.orderId).toBe(5);
        expect(payload.values[0]).toMatchObject({ analyte_code: 'TC', value: '240', ref_high: 200 });
        expect(c.editingId).toBeNull();
    });

    it('shows the trend against the previous result and gates actions by role', () => {
        const c = make(vi.fn(), 'receptionist');
        c.orders = [
            { results: [{ id: 1, analyte_code: 'HBA1C', value_num: 8.4, recorded_at: '2026-10-02 05:00:00' }] },
            { results: [{ id: 2, analyte_code: 'HBA1C', value_num: 7.1, recorded_at: '2026-11-20 05:00:00' }] }
        ];
        expect(c.trend(c.orders[1].results[0])).toMatch(/^↓ was 8.4 on /);
        expect(c.trend(c.orders[0].results[0])).toBe('');
        expect(c.canRecord).toBe(false);
        expect(make(vi.fn(), 'nurse').canRecord).toBe(true);
        expect(make(vi.fn(), 'nurse').canCancel).toBe(false);
    });
});
