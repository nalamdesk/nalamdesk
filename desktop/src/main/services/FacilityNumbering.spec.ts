import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseService } from './DatabaseService';
import { TestDatabase } from '../testing/TestDatabase';
import { runWithContext } from '../../shared/request-context';

const MAIN = 1;
const BRANCH = 2;
const OTHER = 3;

async function openService(db: TestDatabase, migrate: boolean): Promise<DatabaseService> {
    db.exec('PRAGMA foreign_keys = ON');
    const service = new DatabaseService();
    service.setDb(db);
    if (migrate) await service.migrate({ skipBackup: true });
    return service;
}

function seedFacilities(db: TestDatabase) {
    db.prepare(`INSERT INTO facilities (id, code, name, kind) VALUES
        (2, 'ann', 'Anna Nagar', 'hospital'), (3, 'VEL', 'Velachery', 'clinic')`).run();
    db.prepare("INSERT INTO users (id, username, role, name, license_number, active) VALUES (10, 'asha', 'doctor', 'Dr. Asha', 'TN-1', 1)").run();
    db.prepare("INSERT INTO patients (id, uuid, name) VALUES (1, 'p-1', 'Meena')").run();
}

function finishedVisit(db: TestDatabase, facilityId: number): number {
    return Number(db.prepare(`INSERT INTO visits (patient_id, doctor_id, author_id, status, facility_id)
        VALUES (1, 10, 10, 'finished', ?)`).run(facilityId).lastInsertRowid);
}

describe('per-facility invoice, receipt and refund numbers (#213)', () => {
    let db: TestDatabase;
    let service: DatabaseService;
    const at = <T>(facilityId: number, operation: () => T): T => runWithContext({ userId: 10, facilityId }, operation);
    const bill = (facilityId: number, rate = 500) => at(facilityId, () => service.createInvoice(
        { visitId: finishedVisit(db, facilityId), items: [{ description: 'Consultation', rate }] }, 10));

    beforeEach(async () => {
        db = new TestDatabase();
        service = await openService(db, true);
        seedFacilities(db);
    });

    afterEach(() => {
        vi.useRealTimers();
        db.close();
    });

    it('gives each facility its own invoice, receipt and refund series', () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(2026, 5, 15, 10));
        const numbers = [bill(MAIN), bill(BRANCH), bill(BRANCH), bill(OTHER), bill(MAIN)].map((i: any) => i.number);
        expect(numbers).toEqual(['INV-100001', 'ANN-INV-2026-000001', 'ANN-INV-2026-000002', 'VEL-INV-2026-000001', 'INV-100002']);

        const invoice = bill(BRANCH);
        const first = at(BRANCH, () => service.recordPayment({ invoiceId: invoice.id, amount: 200 }, 10));
        const second = at(BRANCH, () => service.recordPayment({ invoiceId: invoice.id, amount: 300 }, 10));
        const refund = at(BRANCH, () => service.refundPayment({ paymentId: first.id, amount: 50, reason: 'Overcharged' }, 10)) as any;
        expect([first.receipt_no, second.receipt_no, refund.receipt_no])
            .toEqual(['ANN-RCP-2026-000001', 'ANN-RCP-2026-000002', 'ANN-RFD-2026-000001']);

        // The main facility keeps one RCP- series for payments and refunds, as before.
        const mainInvoice = bill(MAIN);
        const paid = at(MAIN, () => service.recordPayment({ invoiceId: mainInvoice.id, amount: 500 }, 10));
        const mainRefund = at(MAIN, () => service.refundPayment({ paymentId: paid.id, reason: 'Duplicate' }, 10)) as any;
        expect([paid.receipt_no, mainRefund.receipt_no]).toEqual(['RCP-100001', 'RCP-100002']);
    });

    it('starts a new series each year and keeps the old one where it stopped', () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(2026, 11, 31, 23, 59));
        expect([bill(BRANCH).number, bill(BRANCH).number]).toEqual(['ANN-INV-2026-000001', 'ANN-INV-2026-000002']);
        const mainBefore = bill(MAIN).number;

        vi.setSystemTime(new Date(2027, 0, 1, 0, 1));
        expect([bill(BRANCH).number, bill(BRANCH).number]).toEqual(['ANN-INV-2027-000001', 'ANN-INV-2027-000002']);
        // No year in the main facility's series: it just carries on.
        expect([mainBefore, bill(MAIN).number]).toEqual(['INV-100001', 'INV-100002']);
        expect(db.prepare(`SELECT period, last_no FROM facility_sequences
            WHERE facility_id = 2 AND kind = 'invoice' ORDER BY period`).all())
            .toEqual([{ period: '2026', last_no: 2 }, { period: '2027', last_no: 2 }]);
    });

    it('continues from numbers issued before the counter existed', () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(2026, 2, 1));
        // Rows numbered by the old rowid scheme, including a branch invoice
        // that took an INV- number before branches had their own series.
        const visit = finishedVisit(db, MAIN);
        db.prepare(`INSERT INTO invoices (number, visit_id, patient_id, total, facility_id) VALUES
            ('INV-100007', ?, 1, 100, 1), ('INV-100009', ?, 1, 100, 2), ('ANN-INV-2026-000004', ?, 1, 100, 2),
            ('ANN-INV-2025-000090', ?, 1, 100, 2)`).run(visit, visit, visit, visit);
        db.prepare(`INSERT INTO payments (invoice_id, kind, amount, method, receipt_no, facility_id)
            VALUES (1, 'payment', 100, 'cash', 'RCP-100012', 1)`).run();

        expect(bill(MAIN).number).toBe('INV-100010');
        expect(bill(BRANCH).number).toBe('ANN-INV-2026-000005');
        const invoice = bill(MAIN);
        expect(at(MAIN, () => service.recordPayment({ invoiceId: invoice.id, amount: 100 }, 10)).receipt_no).toBe('RCP-100013');
    });

    it('does not use up a number when the insert fails', () => {
        db.exec(`CREATE TRIGGER fail_items BEFORE INSERT ON invoice_items
            WHEN NEW.description = 'boom' BEGIN SELECT RAISE(ABORT, 'disk full'); END`);
        const year = new Date().getFullYear();
        expect(bill(BRANCH).number).toBe(`ANN-INV-${year}-000001`);
        expect(() => at(BRANCH, () => service.createInvoice(
            { visitId: finishedVisit(db, BRANCH), items: [{ description: 'boom', rate: 1 }] }, 10))).toThrow('disk full');
        expect(bill(BRANCH).number).toBe(`ANN-INV-${year}-000002`);
    });

    it('rejects a facility that does not exist', () => {
        db.exec('PRAGMA foreign_keys = OFF');
        const visit = finishedVisit(db, 99);
        expect(() => at(99, () => service.createInvoice({ visitId: visit, items: [{ description: 'X', rate: 1 }] }, 10)))
            .toThrow('Facility #99 not found');
    });
});

describe('per-facility numbers under concurrent requests (#213)', () => {
    let dir: string;
    let connections: TestDatabase[];

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'nalam-seq-'));
        connections = [];
    });

    afterEach(() => {
        for (const connection of connections) connection.close();
        rmSync(dir, { recursive: true, force: true });
    });

    it('never skips or repeats a number across connections to one database', async () => {
        const file = join(dir, 'clinic.db');
        const first = new TestDatabase(file);
        first.exec('PRAGMA journal_mode = WAL');
        const services = [await openService(first, true)];
        seedFacilities(first);
        const second = new TestDatabase(file);
        services.push(await openService(second, false));
        connections = [first, second];

        const visits = Array.from({ length: 40 }, (_, i) => ({ facility: [MAIN, BRANCH][i % 2], visit: finishedVisit(first, [MAIN, BRANCH][i % 2]) }));
        // Requests arrive from many clients at once and are served by either
        // connection in whatever order the event loop picks.
        const results = await Promise.all(visits.map(({ facility, visit }, i) => new Promise<any>((resolve, reject) => {
            setTimeout(() => {
                try {
                    const service = services[(i * 7) % 2];
                    const invoice = runWithContext({ userId: 10, facilityId: facility }, () => service.createInvoice(
                        { visitId: visit, items: [{ description: 'Visit', rate: 100 }] }, 10));
                    const payment = runWithContext({ userId: 10, facilityId: facility }, () => services[(i + 1) % 2]
                        .recordPayment({ invoiceId: invoice.id, amount: 100 }, 10));
                    resolve({ facility, number: invoice.number, receipt: payment.receipt_no });
                } catch (error) {
                    reject(error);
                }
            }, (i * 13) % 5);
        })));

        const year = new Date().getFullYear();
        const sorted = (facility: number, key: 'number' | 'receipt') => results
            .filter(r => r.facility === facility).map(r => r[key]).sort();
        const series = (format: (n: number) => string) => Array.from({ length: 20 }, (_, i) => format(i + 1));
        expect(sorted(MAIN, 'number')).toEqual(series(n => `INV-${100000 + n}`));
        expect(sorted(MAIN, 'receipt')).toEqual(series(n => `RCP-${100000 + n}`));
        expect(sorted(BRANCH, 'number')).toEqual(series(n => `ANN-INV-${year}-${String(n).padStart(6, '0')}`));
        expect(sorted(BRANCH, 'receipt')).toEqual(series(n => `ANN-RCP-${year}-${String(n).padStart(6, '0')}`));
    });
});
