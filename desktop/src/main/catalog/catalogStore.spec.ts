import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseService } from '../services/DatabaseService';

const { DatabaseSync } = require('node:sqlite');

class TestDatabase {
    private readonly sqlite = new DatabaseSync(':memory:');
    readonly name = ':memory:';

    exec(sql: string) { return this.sqlite.exec(sql); }
    prepare(sql: string) { return this.sqlite.prepare(sql); }
    close() { return this.sqlite.close(); }
    pragma(sql: string, options?: { simple?: boolean }) {
        const assignment = sql.match(/^user_version\s*=\s*(\d+)$/);
        if (assignment) {
            this.sqlite.exec(`PRAGMA user_version = ${assignment[1]}`);
            return;
        }
        const row = this.sqlite.prepare(`PRAGMA ${sql}`).get() as any;
        return options?.simple ? row?.user_version : row;
    }
    transaction<T extends (...args: any[]) => any>(operation: T): T & { immediate: T } {
        const run = ((...args: any[]) => {
            this.sqlite.exec('BEGIN IMMEDIATE');
            try {
                const value = operation(...args);
                this.sqlite.exec('COMMIT');
                return value;
            } catch (error) {
                this.sqlite.exec('ROLLBACK');
                throw error;
            }
        }) as T & { immediate: T };
        run.immediate = run;
        return run;
    }
}

describe('condition and medicine catalogs', () => {
    let db: any;
    let service: DatabaseService;

    beforeEach(async () => {
        db = new TestDatabase();
        db.exec('PRAGMA foreign_keys = ON');
        service = new DatabaseService();
        service.setDb(db);
        await service.migrate({ skipBackup: true });
        db.prepare("INSERT INTO users (id, username, role, name, active) VALUES (10, 'doctor', 'doctor', 'Dr Test', 1)").run();
        db.prepare("INSERT INTO patients (id, uuid, name) VALUES (1, 'p-1', 'Patient One')").run();
    });

    afterEach(() => db.close());

    it('searches active catalog rows only and caps the result length', () => {
        service.createCondition({ name: 'Influenza' });
        service.createCondition({ name: 'Infected wound' });
        const retired = service.createCondition({ name: 'Old flu' });
        service.retireCondition(retired.id);
        for (let i = 0; i < 25; i++) {
            service.createCondition({ name: `Inflammation ${i}` });
        }

        const hits = service.searchConditions('infl');
        expect(hits.every((row: any) => row.active === 1)).toBe(true);
        expect(hits.some((row: any) => row.name === 'Old flu')).toBe(false);
        expect(hits.length).toBeLessThanOrEqual(20);
        expect(hits[0].name).toMatch(/^Infl/i);
    });

    it('adds a new condition and medicine, then rejects empty or duplicate active names', () => {
        const condition = service.createCondition({ name: '  Viral fever ' });
        expect(condition.name).toBe('Viral fever');
        expect(service.searchConditions('viral')[0].id).toBe(condition.id);

        const medicine = service.createMedicine({ name: 'Paracetamol T1', dosage: '500mg' });
        expect(medicine.dosage).toBe('500mg');
        expect(service.searchMedicines('paracetamol t1').some((row: any) => row.id === medicine.id)).toBe(true);

        expect(() => service.createCondition({ name: '   ' })).toThrow('NAME_REQUIRED');
        expect(() => service.createMedicine({ name: '' })).toThrow('NAME_REQUIRED');
        expect(() => service.createCondition({ name: 'viral fever' })).toThrow('DUPLICATE_ACTIVE_NAME');
        expect(() => service.createMedicine({ name: 'paracetamol t1' })).toThrow('DUPLICATE_ACTIVE_NAME');
    });

    it('applies ordered presets as editable Rx lines', () => {
        const condition = service.createCondition({ name: 'URI' });
        const para = service.createMedicine({ name: 'Para-Rx', dosage: '500mg', frequency: '1-1-1' });
        const cet = service.createMedicine({ name: 'Ceti-Rx', dosage: '10mg' });
        const presets = service.replaceConditionMedPresets({
            conditionId: condition.id,
            lines: [
                { medicine_id: para.id },
                { medicine_id: cet.id, duration: '5 days' }
            ]
        });
        expect(presets).toHaveLength(2);
        expect(presets[0].medicine).toBe('Para-Rx');
        expect(presets[0].dosage).toBe('500mg');
        expect(presets[1].duration).toBe('5 days');
        presets[0].duration = '7 days';
        expect(service.getConditionMedPresets(condition.id)[0].duration).toBe('3 days');
    });

    it('soft-retires catalog rows without changing a saved visit snapshot', () => {
        const condition = service.createCondition({ name: 'Influenza' });
        const medicine = service.createMedicine({ name: 'Osel-Rx', dosage: '75mg' });
        service.replaceConditionMedPresets({
            conditionId: condition.id,
            lines: [{ medicine_id: medicine.id }]
        });

        const queueEntryId = Number(db.prepare('INSERT INTO patient_queue (patient_id, priority) VALUES (1, 1)').run().lastInsertRowid);
        const encounter = service.beginConsultation({
            patientId: 1, queueEntryId, startRequestId: 'start-catalog'
        }, 10);
        const prescription = service.getConditionMedPresets(condition.id);
        prescription[0].duration = '5 days';
        service.saveConsultationProgress({
            encounterId: encounter.id,
            visit: { diagnosis: 'Influenza', prescription, amount_paid: 200 }
        }, 10);

        service.retireCondition(condition.id);
        service.retireMedicine(medicine.id);

        const stored = db.prepare('SELECT diagnosis, prescription_json FROM visits WHERE id = ?').get(encounter.id);
        expect(stored.diagnosis).toBe('Influenza');
        const snapshot = JSON.parse(stored.prescription_json);
        expect(snapshot[0].medicine).toBe('Osel-Rx');
        expect(snapshot[0].duration).toBe('5 days');
        expect(service.searchConditions('Influenza')).toHaveLength(0);
        expect(service.searchMedicines('Osel-Rx')).toHaveLength(0);
        expect(service.listConditions(true).some((row: any) => row.id === condition.id && row.active === 0)).toBe(true);
    });

    it('omits retired medicines when loading condition presets', () => {
        const condition = service.createCondition({ name: 'URI' });
        const active = service.createMedicine({ name: 'Para-Keep' });
        const retired = service.createMedicine({ name: 'Old syrup' });
        service.replaceConditionMedPresets({
            conditionId: condition.id,
            lines: [
                { medicine_id: active.id },
                { medicine_id: retired.id },
                { medicine: 'ORS' }
            ]
        });
        service.retireMedicine(retired.id);

        const presets = service.getConditionMedPresets(condition.id);
        expect(presets.map((line: any) => line.medicine)).toEqual(['Para-Keep', 'ORS']);
    });

    it('keeps existing Rx defaults when a medicine is renamed', () => {
        const medicine = service.createMedicine({
            name: 'Para-Rename', dosage: '500mg', frequency: '1-1-1', duration: '5 days'
        });
        const updated = service.updateMedicine({ id: medicine.id, name: 'Acetaminophen' });
        expect(updated.name).toBe('Acetaminophen');
        expect(updated.dosage).toBe('500mg');
        expect(updated.frequency).toBe('1-1-1');
        expect(updated.duration).toBe('5 days');
    });

    it('updates conditions, lists medicines, and ignores invalid preset ids', () => {
        const condition = service.createCondition({ name: 'URI' });
        const renamed = service.updateCondition({ id: condition.id, name: 'Upper URI' });
        expect(renamed.name).toBe('Upper URI');
        const medicine = service.createMedicine({ name: 'Paracetamol_500' });
        expect(service.searchMedicines('Paracetamol_').some((row: any) => row.id === medicine.id)).toBe(true);
        expect(service.listMedicines().some((row: any) => row.id === medicine.id)).toBe(true);
        expect(service.getConditionMedPresets(0)).toEqual([]);
        expect(() => service.replaceConditionMedPresets({ conditionId: 999, lines: [] })).toThrow('CONDITION_NOT_FOUND');
    });

    it('stores generics, brands, and ICD-10 codes on catalog rows', () => {
        const medicine = service.createMedicine({
            name: 'Crocin 500 T', generic_name: 'Paracetamol', brand_name: 'Crocin'
        });
        expect(medicine.generic_name).toBe('Paracetamol');
        expect(medicine.brand_name).toBe('Crocin');
        const condition = service.createCondition({ name: 'Hypertension X', icd10_code: 'i10' });
        expect(condition.icd10_code).toBe('I10');
    });

    it('finds medicines by generic composition or brand', () => {
        service.createMedicine({ name: 'Crocin 500 T', generic_name: 'Paracetamol', brand_name: 'Crocin' });
        expect(service.searchMedicines('paracetamol').length).toBeGreaterThan(0);
        expect(service.searchMedicines('crocin').length).toBeGreaterThan(0);
        expect(service.searchConditions('I10').some((c: any) => c.icd10_code === 'I10')).toBe(true);
    });

    it('persists uncatalogued free text with a NULL generic (Zero-Roadblock)', () => {
        const medicine = service.createMedicine({ name: 'Village herbal mix' });
        expect(medicine.generic_name).toBeNull();
        expect(service.searchMedicines('herbal')[0].generic_name).toBeNull();
    });

    it('ships seeded generics and ICD-10 codes from migration v40', () => {
        const crocin = service.searchMedicines('paracetamol');
        expect(crocin.some((m: any) => m.generic_name === 'Paracetamol')).toBe(true);
        const hyper = service.searchConditions('I10');
        expect(hyper.some((c: any) => c.icd10_code === 'I10')).toBe(true);
    });

    it('updates generics and codes without losing Rx defaults', () => {
        const medicine = service.createMedicine({ name: 'GenUp', dosage: '500mg' });
        const updated = service.updateMedicine({ id: medicine.id, generic_name: 'Paracetamol', brand_name: 'GenBrand' });
        expect(updated.generic_name).toBe('Paracetamol');
        expect(updated.brand_name).toBe('GenBrand');
        expect(updated.dosage).toBe('500mg');
        const condition = service.createCondition({ name: 'CodeUp' });
        const recoded = service.updateCondition({ id: condition.id, name: 'CodeUp', icd10_code: 'J06.9' });
        expect(recoded.icd10_code).toBe('J06.9');
    });
});
