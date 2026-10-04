export const CATALOG_SEARCH_LIMIT = 20;
export const CATALOG_SEARCH_LIMIT_MAX = 50;
export const CATALOG_QUERY_MAX = 80;

export interface CatalogRow {
    id: number;
    name: string;
    active: number;
    created_at?: string;
    updated_at?: string;
}

export interface MedicineCatalogRow extends CatalogRow {
    form: string | null;
    dosage: string | null;
    route: string | null;
    frequency: string | null;
    duration: string | null;
    instruction: string | null;
    generic_name: string | null;
    brand_name: string | null;
    snomed_form_code: string | null;
    snomed_route_code: string | null;
}

export interface ConditionCatalogRow extends CatalogRow {
    icd10_code: string | null;
    icd11_code: string | null;
    icd11_uri: string | null;
    snomed_code: string | null;
}

export interface PrescriptionLine {
    medicine: string;
    form: string;
    dosage: string;
    route: string;
    frequency: string;
    duration: string;
    instruction: string;
    medicine_id?: number | null;
}

type SqliteDb = {
    prepare: (sql: string) => {
        get: (...args: any[]) => any;
        all: (...args: any[]) => any[];
        run: (...args: any[]) => { lastInsertRowid: number | bigint; changes: number };
    };
    exec: (sql: string) => unknown;
    transaction: <T extends (...args: any[]) => any>(fn: T) => T & { immediate: T };
};

interface CatalogWriteFields {
    name: string;
    form?: string;
    dosage?: string;
    route?: string;
    frequency?: string;
    duration?: string;
    instruction?: string;
    generic_name?: string | null;
    brand_name?: string | null;
    snomed_form_code?: string | null;
    snomed_route_code?: string | null;
    icd10_code?: string | null;
    icd11_code?: string | null;
    icd11_uri?: string | null;
    snomed_code?: string | null;
}

export function searchConditions(db: SqliteDb, query?: string, limit?: number): ConditionCatalogRow[] {
    return searchActive(db, 'condition_catalog', query, limit) as ConditionCatalogRow[];
}

export function searchMedicines(db: SqliteDb, query?: string, limit?: number): MedicineCatalogRow[] {
    return searchActive(db, 'medicine_catalog', query, limit) as MedicineCatalogRow[];
}

export function createCondition(db: SqliteDb, input: { name?: string; icd10_code?: string; icd11_code?: string; icd11_uri?: string; snomed_code?: string } | string): ConditionCatalogRow {
    const raw = typeof input === 'string' ? { name: input } : input;
    const name = normalizeName(raw?.name);
    return insertNamed(db, 'condition_catalog', {
        name,
        icd10_code: normalizeUpperCode(raw?.icd10_code),
        icd11_code: normalizeUpperCode(raw?.icd11_code),
        icd11_uri: normalizeCode(raw?.icd11_uri),
        snomed_code: normalizeUpperCode(raw?.snomed_code)
    }) as ConditionCatalogRow;
}

export function createMedicine(db: SqliteDb, input: Partial<MedicineCatalogRow> & { name?: string }): MedicineCatalogRow {
    const name = normalizeName(input?.name);
    const defaults = defaultRxFields(input);
    // Zero-Roadblock: free-text entries persist immediately with a NULL
    // generic — the workflow never blocks on an uncatalogued medicine.
    const row = insertNamed(db, 'medicine_catalog', {
        name,
        ...defaults,
        generic_name: normalizeCode(input?.generic_name),
        brand_name: normalizeOptionalName(input?.brand_name) || null,
        snomed_form_code: normalizeUpperCode(input?.snomed_form_code),
        snomed_route_code: normalizeUpperCode(input?.snomed_route_code)
    });
    return { ...row, ...defaults };
}

export function getConditionMedPresets(db: SqliteDb, conditionId: number): PrescriptionLine[] {
    const id = Number(conditionId);
    if (!Number.isInteger(id) || id <= 0) return [];
    const rows = db.prepare(`
        SELECT p.medicine_id, p.medicine, p.form, p.dosage, p.route, p.frequency, p.duration, p.instruction
        FROM condition_med_presets p
        LEFT JOIN medicine_catalog m ON m.id = p.medicine_id
        WHERE p.condition_id = ?
          AND (p.medicine_id IS NULL OR m.active = 1)
        ORDER BY p.sort_order ASC, p.id ASC
    `).all(id);
    return rows.map((row) => toRxLine(row));
}

export function listConditions(db: SqliteDb, includeRetired = false): CatalogRow[] {
    return listCatalog(db, 'condition_catalog', includeRetired);
}

export function listMedicines(db: SqliteDb, includeRetired = false): MedicineCatalogRow[] {
    return listCatalog(db, 'medicine_catalog', includeRetired) as MedicineCatalogRow[];
}

export function updateCondition(db: SqliteDb, input: { id?: number; name?: string; icd10_code?: string; icd11_code?: string; icd11_uri?: string; snomed_code?: string }): ConditionCatalogRow {
    const id = requireId(input?.id);
    const name = normalizeName(input?.name);
    return updateNamed(db, 'condition_catalog', id, {
        name,
        icd10_code: normalizeUpperCode(input?.icd10_code),
        icd11_code: normalizeUpperCode(input?.icd11_code),
        icd11_uri: normalizeCode(input?.icd11_uri),
        snomed_code: normalizeUpperCode(input?.snomed_code)
    }) as ConditionCatalogRow;
}

export function updateMedicine(db: SqliteDb, input: Partial<MedicineCatalogRow> & { id?: number; name?: string }): MedicineCatalogRow {
    const id = requireId(input?.id);
    const existing = db.prepare('SELECT * FROM medicine_catalog WHERE id = ?').get(id) as MedicineCatalogRow | undefined;
    if (!existing) throw new Error('CATALOG_NOT_FOUND');
    const name = normalizeName(input?.name != null ? input.name : existing.name);
    const defaults = defaultRxFields(mergeMedicineFields(existing, input));
    return updateNamed(db, 'medicine_catalog', id, {
        name,
        ...defaults,
        generic_name: input?.generic_name !== undefined ? normalizeCode(input.generic_name) : existing.generic_name,
        brand_name: input?.brand_name !== undefined ? (normalizeOptionalName(input.brand_name) || null) : existing.brand_name,
        snomed_form_code: input?.snomed_form_code !== undefined ? normalizeUpperCode(input.snomed_form_code) : existing.snomed_form_code,
        snomed_route_code: input?.snomed_route_code !== undefined ? normalizeUpperCode(input.snomed_route_code) : existing.snomed_route_code
    }) as MedicineCatalogRow;
}

export function retireCondition(db: SqliteDb, id: number): { id: number; active: number } {
    return retireRow(db, 'condition_catalog', id);
}

export function retireMedicine(db: SqliteDb, id: number): { id: number; active: number } {
    return retireRow(db, 'medicine_catalog', id);
}

export function replaceConditionMedPresets(
    db: SqliteDb,
    input: { conditionId?: number; lines?: Array<Partial<PrescriptionLine>> }
): PrescriptionLine[] {
    const conditionId = requireId(input?.conditionId);
    const condition = db.prepare('SELECT id FROM condition_catalog WHERE id = ?').get(conditionId);
    if (!condition) throw new Error('CONDITION_NOT_FOUND');

    const lines = Array.isArray(input?.lines) ? input.lines : [];
    const run = db.transaction(() => {
        db.prepare('DELETE FROM condition_med_presets WHERE condition_id = ?').run(conditionId);
        const insert = db.prepare(`
            INSERT INTO condition_med_presets (
                condition_id, sort_order, medicine_id, medicine, form, dosage, route, frequency, duration, instruction
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        lines.forEach((line, index) => {
            const rx = resolvePresetLine(db, line);
            insert.run(
                conditionId,
                index,
                rx.medicine_id || null,
                rx.medicine,
                rx.form,
                rx.dosage,
                rx.route,
                rx.frequency,
                rx.duration,
                rx.instruction
            );
        });
        return getConditionMedPresets(db, conditionId);
    });
    return typeof (run as any).immediate === 'function' ? (run as any).immediate() : run();
}

function searchActive(db: SqliteDb, table: 'condition_catalog' | 'medicine_catalog', query?: string, limit?: number) {
    const capped = capLimit(limit);
    const term = String(query || '').trim().slice(0, CATALOG_QUERY_MAX);
    if (!term) {
        return db.prepare(`SELECT * FROM ${table} WHERE active = 1 ORDER BY name COLLATE NOCASE LIMIT ?`).all(capped);
    }
    const contains = likeContains(term);
    const prefix = likePrefix(term);
    // Medicines match on brand, generic composition, or name: a doctor
    // typing either side of GENERIC (Brand) lands on the same row.
    const extraCount = table === 'medicine_catalog' ? 2 : table === 'condition_catalog' ? 1 : 0;
    const extra = table === 'medicine_catalog'
        ? 'OR generic_name LIKE ? ESCAPE \'\\\' OR brand_name LIKE ? ESCAPE \'\\\''
        : table === 'condition_catalog'
            ? 'OR icd10_code LIKE ? ESCAPE \'\\\''
            : '';
    const extras = Array.from({ length: extraCount }, () => contains);
    return db.prepare(`
        SELECT * FROM ${table}
        WHERE active = 1 AND (name LIKE ? ESCAPE '\\' ${extra})
        ORDER BY CASE WHEN name LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END, name COLLATE NOCASE
        LIMIT ?
    `).all(contains, ...extras, prefix, capped);
}

function listCatalog(db: SqliteDb, table: 'condition_catalog' | 'medicine_catalog', includeRetired: boolean) {
    if (includeRetired) {
        return db.prepare(`SELECT * FROM ${table} ORDER BY active DESC, name COLLATE NOCASE`).all();
    }
    return db.prepare(`SELECT * FROM ${table} WHERE active = 1 ORDER BY name COLLATE NOCASE`).all();
}

function insertNamed(db: SqliteDb, table: 'condition_catalog' | 'medicine_catalog', fields: CatalogWriteFields) {
    try {
        if (table === 'condition_catalog') {
            const result = db.prepare(`
                INSERT INTO condition_catalog (name, icd10_code, icd11_code, icd11_uri, snomed_code, active, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            `).run(fields.name, fields.icd10_code ?? null, fields.icd11_code ?? null, fields.icd11_uri ?? null, fields.snomed_code ?? null);
            return db.prepare('SELECT * FROM condition_catalog WHERE id = ?').get(Number(result.lastInsertRowid));
        }
        const result = db.prepare(`
            INSERT INTO medicine_catalog (
                name, form, dosage, route, frequency, duration, instruction,
                generic_name, brand_name, snomed_form_code, snomed_route_code,
                active, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `).run(fields.name, fields.form, fields.dosage, fields.route, fields.frequency, fields.duration,
            fields.instruction, fields.generic_name ?? null, fields.brand_name ?? null,
            fields.snomed_form_code ?? null, fields.snomed_route_code ?? null);
        return db.prepare('SELECT * FROM medicine_catalog WHERE id = ?').get(Number(result.lastInsertRowid));
    } catch (error) {
        throw mapConstraint(error);
    }
}

function updateNamed(db: SqliteDb, table: 'condition_catalog' | 'medicine_catalog', id: number, fields: CatalogWriteFields) {
    const existing = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
    if (!existing) throw new Error('CATALOG_NOT_FOUND');
    try {
        if (table === 'condition_catalog') {
            db.prepare(`
                UPDATE condition_catalog SET name = ?, icd10_code = ?, icd11_code = ?, icd11_uri = ?, snomed_code = ?,
                    updated_at = CURRENT_TIMESTAMP WHERE id = ?
            `).run(fields.name, fields.icd10_code ?? null, fields.icd11_code ?? null, fields.icd11_uri ?? null, fields.snomed_code ?? null, id);
        } else {
            db.prepare(`
                UPDATE medicine_catalog
                SET name = ?, form = ?, dosage = ?, route = ?, frequency = ?, duration = ?, instruction = ?,
                    generic_name = ?, brand_name = ?, snomed_form_code = ?, snomed_route_code = ?,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `).run(fields.name, fields.form, fields.dosage, fields.route, fields.frequency, fields.duration,
                fields.instruction, fields.generic_name ?? null, fields.brand_name ?? null,
                fields.snomed_form_code ?? null, fields.snomed_route_code ?? null, id);
        }
        return db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
    } catch (error) {
        throw mapConstraint(error);
    }
}

/** Optional codes and names: blank means unmapped. Case preserved. */
function normalizeCode(value: unknown): string | null {
    if (value == null) return null;
    const text = String(value).trim().replace(/\s+/g, ' ');
    return text ? text.slice(0, 64) : null;
}

/** ICD-10 / SNOMED codes are conventionally uppercase. */
function normalizeUpperCode(value: unknown): string | null {
    const text = normalizeCode(value);
    return text ? text.toUpperCase().slice(0, 32) : null;
}

function retireRow(db: SqliteDb, table: 'condition_catalog' | 'medicine_catalog', id: number) {
    const numericId = requireId(id);
    const existing = db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(numericId);
    if (!existing) throw new Error('CATALOG_NOT_FOUND');
    db.prepare(`UPDATE ${table} SET active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(numericId);
    return { id: numericId, active: 0 };
}

function resolvePresetLine(db: SqliteDb, line: Partial<PrescriptionLine>): PrescriptionLine {
    let medicineId = line.medicine_id != null ? Number(line.medicine_id) : null;
    let catalog: MedicineCatalogRow | undefined;
    if (medicineId && Number.isInteger(medicineId)) {
        catalog = db.prepare('SELECT * FROM medicine_catalog WHERE id = ?').get(medicineId);
    }
    const medicine = normalizeOptionalName(line.medicine) || catalog?.name || '';
    if (!medicine) throw new Error('NAME_REQUIRED');
    const defaults = catalog ? defaultRxFields(catalog) : defaultRxFields(line);
    return {
        medicine_id: catalog?.id || medicineId || null,
        medicine,
        form: line.form || defaults.form,
        dosage: line.dosage ?? defaults.dosage,
        route: line.route || defaults.route,
        frequency: line.frequency || defaults.frequency,
        duration: line.duration || defaults.duration,
        instruction: line.instruction || defaults.instruction
    };
}

function toRxLine(row: any): PrescriptionLine {
    const defaults = defaultRxFields(row);
    return {
        medicine_id: row.medicine_id || null,
        medicine: row.medicine,
        form: row.form || defaults.form,
        dosage: row.dosage ?? defaults.dosage,
        route: row.route || defaults.route,
        frequency: row.frequency || defaults.frequency,
        duration: row.duration || defaults.duration,
        instruction: row.instruction || defaults.instruction
    };
}

function mergeMedicineFields(
    existing: MedicineCatalogRow,
    input: Partial<MedicineCatalogRow>
): Partial<MedicineCatalogRow> {
    return {
        form: input.form !== undefined ? input.form : existing.form,
        dosage: input.dosage !== undefined ? input.dosage : existing.dosage,
        route: input.route !== undefined ? input.route : existing.route,
        frequency: input.frequency !== undefined ? input.frequency : existing.frequency,
        duration: input.duration !== undefined ? input.duration : existing.duration,
        instruction: input.instruction !== undefined ? input.instruction : existing.instruction
    };
}

function defaultRxFields(input: Partial<MedicineCatalogRow> | Partial<PrescriptionLine> = {}): Omit<PrescriptionLine, 'medicine' | 'medicine_id'> {
    const instruction = (input as any).instruction || (input as any).instructions || 'After Food';
    return {
        form: (input as any).form || 'Tab',
        dosage: (input as any).dosage || '',
        route: (input as any).route || 'Oral',
        frequency: (input as any).frequency || '1-0-1',
        duration: (input as any).duration || '3 days',
        instruction
    };
}

function normalizeName(value: unknown): string {
    const name = normalizeOptionalName(value);
    if (!name) throw new Error('NAME_REQUIRED');
    return name;
}

function normalizeOptionalName(value: unknown): string {
    if (typeof value !== 'string' && typeof value !== 'number') return '';
    return String(value).trim().replace(/\s+/g, ' ').slice(0, CATALOG_QUERY_MAX);
}

function requireId(value: unknown): number {
    const id = Number(value);
    if (!Number.isInteger(id) || id <= 0) throw new Error('CATALOG_NOT_FOUND');
    return id;
}

function capLimit(limit?: number): number {
    const parsed = Number(limit);
    if (!Number.isInteger(parsed) || parsed <= 0) return CATALOG_SEARCH_LIMIT;
    return Math.min(parsed, CATALOG_SEARCH_LIMIT_MAX);
}

function likeContains(term: string): string {
    return `%${escapeLike(term)}%`;
}

function likePrefix(term: string): string {
    return `${escapeLike(term)}%`;
}

function escapeLike(term: string): string {
    return term.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

function mapConstraint(error: unknown): Error {
    const message = error instanceof Error ? error.message : (typeof error === 'string' ? error : '');
    if (/UNIQUE|constraint/i.test(message)) return new Error('DUPLICATE_ACTIVE_NAME');
    if (error instanceof Error) return error;
    return new Error(message || 'CATALOG_WRITE_FAILED');
}
