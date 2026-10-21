/**
 * Prescription orders (issue #20).
 *
 * A finished visit's prescription is a medication order: every line names
 * the medicine, dose, form, route, schedule and course, and the order as a
 * whole carries a durable number, status, requester and authored time (the
 * FHIR MedicationRequest shape). This module holds the rules both sides
 * share: the renderer checks lines before Finish, and the main process
 * enforces the same checks before it stores an order.
 */

import { FREQUENCY_PATTERN } from './fhir/nrces';
import { parseDurationDays, parseFrequency } from './clinical-timing';

/** Lifecycle of a stored order. Corrections cancel the old version. */
export const RX_STATUSES = ['active', 'cancelled', 'entered-in-error'] as const;
export type RxStatus = (typeof RX_STATUSES)[number];

/** Routes each known dosage form can be given by. Unknown forms are not checked. */
const FORM_ROUTES: Record<string, string[]> = {
    Tab: ['Oral'],
    Cap: ['Oral'],
    Syr: ['Oral'],
    Inj: ['IV', 'IM', 'SC'],
    Oint: ['Topical'],
    Drop: ['Oral', 'Topical']
};

/** What one unit of each form is dispensed as. */
const DISPENSE_UNITS: Record<string, string> = {
    Tab: 'tablet',
    Cap: 'capsule',
    Syr: 'bottle',
    Inj: 'vial',
    Oint: 'tube',
    Drop: 'bottle'
};

/** Most refills a single order may carry. */
export const MAX_REFILLS = 11;

/** A prescription line as the visit form and the order tables hold it. */
export interface RxLine {
    medicine?: string | null;
    medicine_id?: number | null;
    generic_name?: string | null;
    brand_name?: string | null;
    form?: string | null;
    dosage?: string | null;
    route?: string | null;
    frequency?: string | null;
    duration?: string | null;
    instruction?: string | null;
    quantity?: number | string | null;
    quantity_unit?: string | null;
    /** Set when the quantity was worked out, not typed: it is worked out again on change. */
    quantity_derived?: boolean | null;
    refills?: number | string | null;
    free_text?: boolean | null;
}

/** A line that passed the checks, normalized for storage. */
export interface FinalRxLine {
    medicine: string;
    medicine_id: number | null;
    generic_name: string | null;
    brand_name: string | null;
    form: string;
    dosage: string;
    route: string;
    frequency: string;
    duration: string;
    instruction: string;
    quantity: number | null;
    quantity_unit: string | null;
    quantity_derived: boolean;
    refills: number;
    free_text: boolean;
}

export interface RxIssue {
    /** 1-based line number as the doctor sees it. */
    line: number;
    medicine: string;
    message: string;
}

const OPEN_ENDED_DURATION = /until review|till review|chronic|long term|continue|ongoing|lifetime|sos|prn|as needed|when required/;

function text(value: unknown): string {
    return value == null ? '' : String(value).trim();
}

/** Blank rows (no medicine, no dose) are dropped, not rejected. */
export function isBlankRxLine(line: RxLine | null | undefined): boolean {
    return !text(line?.medicine) && !text(line?.dosage);
}

/**
 * Units to dispense for a finite course of a counted form: doses a day
 * times days, times the count in the dose ("2 tabs"). Null when the form,
 * schedule or course can't be counted, so nothing is invented.
 */
export function suggestedQuantity(line: RxLine): number | null {
    const form = text(line.form);
    if (form !== 'Tab' && form !== 'Cap') return null;
    const frequency = parseFrequency(line.frequency);
    const count = doseCount(line.dosage);
    if (frequency === 'STAT') return count;
    const pattern = FREQUENCY_PATTERN[frequency];
    const days = parseDurationDays(line.duration);
    if (!pattern || days == null || OPEN_ENDED_DURATION.test(text(line.duration).toLowerCase())) return null;
    return Math.ceil((pattern.frequency / pattern.period) * days * count);
}

/** "2 tabs" -> 2; a strength like "500mg" is one unit. */
function doseCount(dosage: unknown): number {
    const match = /^(\d+(?:\.\d+)?)\s*(tab|tabs|tablet|tablets|cap|caps|capsule|capsules)\b/i.exec(text(dosage));
    const count = match ? Number(match[1]) : 1;
    return Number.isFinite(count) && count > 0 ? count : 1;
}

function optionalNumber(value: unknown): number | null | 'invalid' {
    if (value == null || text(value) === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : 'invalid';
}

/**
 * Checks every non-blank line and returns the stored form of the order.
 * Issues name the line and what is wrong; an order with any issue must
 * not be stored or printed as final.
 */
export function finalizeRxLines(lines: RxLine[] | null | undefined): { lines: FinalRxLine[]; issues: RxIssue[] } {
    const issues: RxIssue[] = [];
    const out: FinalRxLine[] = [];
    (Array.isArray(lines) ? lines : []).forEach((line, index) => {
        if (isBlankRxLine(line)) return;
        const medicine = text(line.medicine);
        const lineIssues: string[] = [];
        const form = text(line.form);
        const route = text(line.route);
        const dosage = text(line.dosage);
        const frequency = parseFrequency(line.frequency);
        const duration = text(line.duration);

        if (!medicine) lineIssues.push('medicine is required');
        if (!dosage) lineIssues.push('dose is required');
        if (!form) lineIssues.push('form is required');
        if (!route) lineIssues.push('route is required');
        if (!frequency) lineIssues.push('frequency is required');
        if (form && route && FORM_ROUTES[form] && !FORM_ROUTES[form].includes(route)) {
            lineIssues.push(`${form} cannot be given by the ${route} route`);
        }

        const days = parseDurationDays(duration);
        const openEnded = OPEN_ENDED_DURATION.test(duration.toLowerCase());
        if (frequency === 'STAT') {
            if (openEnded || (days != null && days > 1)) {
                lineIssues.push('a STAT dose is given once, so it cannot run for a course');
            }
        } else if (!duration) {
            lineIssues.push('duration is required');
        } else if (days == null && !openEnded) {
            lineIssues.push(`duration "${duration}" needs a number and unit (5 days, 2 weeks) or "until review"`);
        }

        const quantity = line.quantity_derived ? null : optionalNumber(line.quantity);
        if (quantity === 'invalid' || (quantity != null && quantity <= 0)) {
            lineIssues.push('quantity must be a positive number');
        }
        const refills = optionalNumber(line.refills);
        if (refills === 'invalid' || (refills != null && (!Number.isInteger(refills) || refills < 0 || refills > MAX_REFILLS))) {
            lineIssues.push(`refills must be a whole number from 0 to ${MAX_REFILLS}`);
        } else if (refills != null && refills > 0 && frequency === 'STAT') {
            lineIssues.push('a STAT dose cannot carry refills');
        }

        if (lineIssues.length > 0) {
            for (const message of lineIssues) issues.push({ line: index + 1, medicine, message });
            return;
        }
        const medicineId = Number(line.medicine_id);
        const hasCatalogId = Number.isInteger(medicineId) && medicineId > 0;
        const normalized: FinalRxLine = {
            medicine,
            medicine_id: hasCatalogId ? medicineId : null,
            generic_name: text(line.generic_name) || null,
            brand_name: text(line.brand_name) || null,
            form,
            dosage,
            route,
            frequency,
            duration: frequency === 'STAT' && !duration ? 'single dose' : duration,
            instruction: text(line.instruction),
            quantity: null,
            quantity_unit: null,
            quantity_derived: false,
            refills: (refills as number | null) ?? 0,
            // Typed names that never matched the catalog are kept, but marked
            // so they never pass for a coded medicine.
            free_text: !hasCatalogId
        };
        normalized.quantity = (quantity as number | null) ?? suggestedQuantity(normalized);
        normalized.quantity_derived = quantity == null && normalized.quantity != null;
        normalized.quantity_unit = normalized.quantity == null
            ? null
            : text(line.quantity_unit) || DISPENSE_UNITS[form] || 'unit';
        out.push(normalized);
    });
    return { lines: out, issues };
}

/** One readable message for a dialog or an error: "Line 1 (Crocin): dose is required." */
export function formatRxIssues(issues: RxIssue[]): string {
    return issues
        .map((issue) => `Line ${issue.line}${issue.medicine ? ` (${issue.medicine})` : ''}: ${issue.message}.`)
        .join(' ');
}

const CLINICAL_FIELDS: Array<keyof FinalRxLine> = [
    'medicine', 'medicine_id', 'form', 'dosage', 'route', 'frequency', 'duration',
    'instruction', 'quantity', 'quantity_unit', 'refills'
];

/** True when two finalized orders say the same thing clinically. */
export function sameRxOrder(a: FinalRxLine[], b: FinalRxLine[]): boolean {
    if (a.length !== b.length) return false;
    return a.every((line, i) => CLINICAL_FIELDS.every((field) => (line[field] ?? null) === (b[i][field] ?? null)));
}

/**
 * Comparable key for lines that may never have been finalized (visits from
 * before orders existed): non-blank lines, clinical fields as trimmed text.
 */
export function rxLinesKey(lines: RxLine[] | null | undefined): string {
    const rows = (Array.isArray(lines) ? lines : [])
        .filter((line) => !isBlankRxLine(line))
        .map((line) => ['medicine', 'form', 'dosage', 'route', 'frequency', 'duration', 'instruction']
            .map((field) => field === 'frequency'
                ? parseFrequency((line as any)[field])
                : text((line as any)[field])));
    return JSON.stringify(rows);
}
