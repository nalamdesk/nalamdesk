/**
 * NRCeS (National Resource Center for EHR Standards) prescription profile
 * guidance, as machine-readable constants plus TypeScript narrowing.
 *
 * These are the must-support expectations a prescription record must satisfy
 * before it can be serialized as a standards-compliant MedicationRequest.
 * Anything below marked TODO (live reconfirm) needs a check against the
 * current NRCeS/ABDM documentation during integration, not a guess now.
 */

import type { MedicationRequest } from './r4';

/** Fields a prescription must carry to be exportable. Absence blocks export. */
export const PRESCRIPTION_MUST_SUPPORT = [
    'medication',
    'dose',
    'route',
    'frequency',
    'duration',
    'requester',
    'authoredOn'
] as const;

export type PrescriptionMustSupport = (typeof PRESCRIPTION_MUST_SUPPORT)[number];

/** Frequency shorthands used in Indian clinics and their structural meaning. */
export const FREQUENCY_PATTERN: Record<string, { frequency: number; period: number; periodUnit: 'd' }> = {
    '1-0-1': { frequency: 2, period: 1, periodUnit: 'd' },
    '1-1-1': { frequency: 3, period: 1, periodUnit: 'd' },
    '1-0-0': { frequency: 1, period: 1, periodUnit: 'd' },
    '0-0-1': { frequency: 1, period: 1, periodUnit: 'd' },
    '0-1-0': { frequency: 1, period: 1, periodUnit: 'd' }
};

export type KnownFrequency = keyof typeof FREQUENCY_PATTERN;

/** Lifecycle states a prescription line moves through in NalamDesk. */
export type PrescriptionLineStatus = 'draft' | 'active' | 'completed' | 'cancelled';

/** A prescription line that satisfies the export gate. */
export interface ExportablePrescriptionLine {
    medicine: string;
    dosage?: string;
    route?: string;
    frequency: string;
    duration?: string;
    instruction?: string;
}

/** Sections an OPConsultRecord Composition carries, in order. */
export const OP_CONSULT_SECTIONS = [
    'Chief Complaints',
    'Observations',
    'Diagnosis',
    'Prescription',
    'Advice'
] as const;

export type OpConsultSection = (typeof OP_CONSULT_SECTIONS)[number];

/**
 * Narrow check: does this MedicationRequest carry everything the export
 * gate requires? Used by the Phase-2 serializer before emitting a record.
 */
export function isExportableMedicationRequest(request: MedicationRequest): boolean {
    if (!request.subject?.reference) return false;
    if (!request.requester?.reference) return false;
    if (!request.authoredOn) return false;
    if (!request.medicationCodeableConcept?.text && !request.medicationReference?.reference) return false;
    return true;
}
