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
    dosage: string;
    route: string;
    frequency: string;
    duration: string;
    instruction?: string;
}

/**
 * Sections an OPConsultRecord Composition carries, in the order of the NRCES
 * OPConsultRecord section slices, with the SNOMED code each slice fixes.
 * Diagnosis travels in the chief complaints narrative: the profile has no
 * diagnosis section.
 */
export const OP_CONSULT_SECTIONS = [
    { title: 'Chief complaints', code: '422843007', display: 'Chief complaint section' },
    { title: 'Physical examination', code: '425044008', display: 'Physical exam section' },
    { title: 'Allergies', code: '722446000', display: 'Allergy record' },
    { title: 'Medical history', code: '371529009', display: 'History and physical report' },
    { title: 'Medications', code: '721912009', display: 'Medication summary document' }
] as const;

export type OpConsultSection = (typeof OP_CONSULT_SECTIONS)[number]['title'];

const NRCES_BASE = 'https://nrces.in/ndhm/fhir/r4/StructureDefinition/';

/** The NRCES (ndhm.in 6.5.0) profile each OPConsultRecord resource declares. */
export const NRCES_PROFILE: Partial<Record<string, string>> = {
    Bundle: `${NRCES_BASE}DocumentBundle`,
    Composition: `${NRCES_BASE}OPConsultRecord`,
    Patient: `${NRCES_BASE}Patient`,
    Practitioner: `${NRCES_BASE}Practitioner`,
    Organization: `${NRCES_BASE}Organization`,
    Encounter: `${NRCES_BASE}Encounter`,
    Condition: `${NRCES_BASE}Condition`,
    AllergyIntolerance: `${NRCES_BASE}AllergyIntolerance`,
    Observation: `${NRCES_BASE}ObservationVitalSigns`,
    MedicationRequest: `${NRCES_BASE}MedicationRequest`
};

/** IPS sections with the LOINC document-ontology codes consumers classify on. */
export const IPS_SECTIONS = [
    { title: 'Medication Summary', code: '10160-0' },
    { title: 'Allergies and Intolerances', code: '48765-2' },
    { title: 'Active Problems', code: '11450-4' },
    { title: 'Results', code: '30954-2' }
] as const;

/**
 * Narrow check: does this MedicationRequest carry everything the export
 * gate requires? The serializer pre-screens the source line (dose, route,
 * frequency, duration); this predicate guards the structural contract —
 * subject, requester, date, medication, and at least one dosage instruction.
 */
export function isExportableMedicationRequest(request: MedicationRequest): boolean {
    if (!request.subject?.reference) return false;
    if (!request.requester?.reference) return false;
    if (!request.authoredOn) return false;
    if (!request.medicationCodeableConcept?.text && !request.medicationReference?.reference) return false;
    if (!request.dosageInstruction || request.dosageInstruction.length === 0) return false;
    return true;
}
