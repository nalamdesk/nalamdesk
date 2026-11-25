import { describe, expect, it, vi } from 'vitest';
import { PharmacyComponent, stockStatus, visitsToDispense } from './pharmacy.component';
import { localDateISO } from '../../../shared/local-date';

describe('pharmacy helpers', () => {
    it('ranks stock status: out, low, expiring, ok', () => {
        expect(stockStatus({ on_hand: 0 })).toBe('out');
        expect(stockStatus({ on_hand: 5, low: true, expiring_soon: true })).toBe('low');
        expect(stockStatus({ on_hand: 5, expiring_soon: true })).toBe('expiring');
        expect(stockStatus({ on_hand: 5 })).toBe('ok');
    });

    it('lists only visits from today with a prescription, using the local day', () => {
        const now = new Date();
        const utc = now.toISOString().slice(0, 19).replace('T', ' ');
        const visits = [
            { id: 1, date: utc, prescription: [{ medicine: 'A' }] },
            { id: 2, date: utc, prescription: [] },
            { id: 3, date: '2020-01-01 10:00:00', prescription: [{ medicine: 'B' }] }
        ];
        expect(visitsToDispense(visits, localDateISO(now)).map((v) => v.id)).toEqual([1]);
    });
});

describe('PharmacyComponent', () => {
    const zone = { run: (fn: () => any) => fn() } as any;
    it('suggests what is still owed, capped by stock, and dispenses only positive lines', async () => {
        const invoke = vi.fn(async (method: string) => {
            if (method === 'getDispensePlan') return { visit_id: 9, lines: [
                { medicine: 'Paracetamol 650', prescribed_qty: 9, dispensed_qty: 0, in_stock: 6 },
                { medicine: 'ORS', prescribed_qty: 2, dispensed_qty: 2, in_stock: 10 }
            ] };
            if (method === 'dispenseVisit') return { total: 12 };
            return [];
        });
        const c = new PharmacyComponent({ invoke } as any, zone, { error: vi.fn(), success: vi.fn() } as any,
            { getUser: () => ({ role: 'receptionist' }) } as any);
        await c.openPlan({ id: 9, patient_name: 'Asha' });
        expect(c.giveQty).toEqual([6, 0]);
        await c.dispense();
        expect(invoke).toHaveBeenCalledWith('dispenseVisit', { visitId: 9, lines: [{ medicine: 'Paracetamol 650', medicine_id: undefined, qty: 6 }] });
        expect(c.lastTotal).toBe(12);
        expect(c.canDispense).toBe(true);
        expect(c.canReceive).toBe(false);
    });
});
