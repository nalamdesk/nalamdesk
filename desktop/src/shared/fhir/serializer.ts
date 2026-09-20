/**
 * Dual clinical-record serializer: ABDM OPConsultRecord + HL7 IPS.
 *
 * Pure functions over an explicit input contract so main, renderer, and
 * tests share one implementation with no I/O. Partial exports are honest:
 * lines that fail the NRCeS gate are omitted from MedicationRequest entries
 * and reported in `warnings` instead of being silently dropped or invented.
 */

import type {
    AllergyIntolerance, Bundle, Composition, Condition, Dosage, Encounter,
    MedicationRequest, Observation, Organization, Patient, Practitioner,
    Resource
} from './r4';
import {
    FREQUENCY_PATTERN, OP_CONSULT_SECTIONS, isExportableMedicationRequest
} from './nrces';

export interface ExportPrescriptionLine {
    medicine: string;
    dosage?: string;
    route?: string;
    frequency?: string;
    duration?: string;
    instruction?: string;
}

export interface ExportAllergy {
    substance: string;
    criticality?: string;
    severity?: string;
    reaction?: string;
    status?: string;
}

export interface ExportCondition {
    name: string;
    code?: string;
    status?: string;
    onsetDate?: string;
}

export interface ExportVitals {
    systolic_bp?: number | null;
    diastolic_bp?: number | null;
    pulse?: number | null;
    temperature?: number | null;
    temperatureUnits?: string;
    spo2?: number | null;
    weight?: number | null;
    weightUnits?: string;
    height?: number | null;
}

export interface EncounterExportInput {
    patient: {
        id: number | string;
        name: string;
        mobile?: string;
        age?: number | null;
        gender?: string;
        dob?: string | null;
        address?: string;
        abhaAddress?: string | null;
    };
    practitioner: { id: number | string; name: string; licenseNumber?: string; specialty?: string };
    clinic: { name: string; address?: string };
    encounter: {
        id: number | string;
        date?: string;
        diagnosis?: string;
        diagnosisType?: string;
        symptoms?: string;
        examinationNotes?: string;
    };
    prescriptions?: ExportPrescriptionLine[];
    allergies?: ExportAllergy[];
    conditions?: ExportCondition[];
    vitals?: ExportVitals | null;
}

export interface ExportResult {
    bundle: Bundle;
    warnings: string[];
}

const LOINC = 'http://loinc.org';

function ref(resource: string, id: number | string): { reference: string } {
    return { reference: `${resource}/${id}` };
}

function dosageFor(line: ExportPrescriptionLine): Dosage {
    const dosage: Dosage = {};
    const pattern = FREQUENCY_PATTERN[line.frequency || ''];
    if (pattern) {
        dosage.timing = {
            repeat: { frequency: pattern.frequency, period: pattern.period, periodUnit: pattern.periodUnit }
        };
    } else if (line.frequency) {
        dosage.text = line.frequency;
    }
    if (line.route) dosage.route = { text: line.route };
    if (line.dosage) dosage.text = [dosage.text, line.dosage].filter(Boolean).join(' ');
    return dosage;
}

function medicationRequest(
    line: ExportPrescriptionLine,
    input: EncounterExportInput,
    date: string
): MedicationRequest | null {
    const request: MedicationRequest = {
        resourceType: 'MedicationRequest',
        status: 'active',
        intent: 'order',
        medicationCodeableConcept: { text: line.medicine },
        subject: ref('Patient', input.patient.id),
        requester: ref('Practitioner', input.practitioner.id),
        authoredOn: date,
        dosageInstruction: [dosageFor(line)]
    };
    if (line.instruction) request.note = [{ text: line.instruction }];
    if (line.duration) {
        request.dispenseRequest = { expectedSupplyDuration: { value: 1, unit: line.duration } };
    }
    if (!isExportableMedicationRequest(request)) return null;
    return request;
}

function allergyResource(allergy: ExportAllergy, patientId: number | string): AllergyIntolerance {
    const criticality = allergy.criticality === 'high' ? 'high'
        : allergy.criticality === 'unable-to-assess' ? 'unable-to-assess' : 'low';
    return {
        resourceType: 'AllergyIntolerance',
        clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical', code: 'active' }] },
        type: 'allergy',
        criticality,
        code: { text: allergy.substance },
        patient: ref('Patient', patientId),
        reaction: allergy.reaction ? [{ manifestation: [{ text: allergy.reaction }] }] : undefined
    };
}

function conditionResource(condition: ExportCondition, patientId: number | string): Condition {
    return {
        resourceType: 'Condition',
        clinicalStatus: {
            coding: [{
                system: 'http://terminology.hl7.org/CodeSystem/condition-clinical',
                code: condition.status === 'active' ? 'active' : 'resolved'
            }]
        },
        code: condition.code ? { coding: [{ system: 'http://hl7.org/fhir/sid/icd-10', code: condition.code }], text: condition.name } : { text: condition.name },
        subject: ref('Patient', patientId),
        onsetDateTime: condition.onsetDate || undefined
    };
}

function vitalObservations(vitals: ExportVitals | null | undefined, patientId: number | string): Observation[] {
    if (!vitals) return [];
    const out: Observation[] = [];
    const push = (code: string, display: string, value: number | null | undefined, unit?: string): void => {
        if (value == null || Number.isNaN(Number(value))) return;
        out.push({
            resourceType: 'Observation',
            status: 'final',
            code: { coding: [{ system: LOINC, code, display }] },
            subject: ref('Patient', patientId),
            valueQuantity: { value: Number(value), unit }
        });
    };
    if (vitals.systolic_bp != null && vitals.diastolic_bp != null) {
        push('8480-6', 'Systolic blood pressure', vitals.systolic_bp, 'mmHg');
        push('8462-4', 'Diastolic blood pressure', vitals.diastolic_bp, 'mmHg');
    }
    push('8867-4', 'Heart rate', vitals.pulse, 'bpm');
    push('8310-5', 'Body temperature', vitals.temperature, vitals.temperatureUnits || '°F');
    push('2708-6', 'Oxygen saturation', vitals.spo2, '%');
    push('29463-7', 'Body weight', vitals.weight, vitals.weightUnits || 'kg');
    push('8302-2', 'Body height', vitals.height, 'cm');
    return out;
}

function patientResource(input: EncounterExportInput): Patient {
    const identifiers = [];
    if (input.patient.abhaAddress) {
        identifiers.push({ system: 'https://abdm.gov.in/abha', value: input.patient.abhaAddress });
    }
    return {
        resourceType: 'Patient',
        identifier: identifiers.length > 0 ? identifiers : undefined,
        name: [{ text: input.patient.name }],
        telecom: input.patient.mobile ? [{ system: 'phone', value: input.patient.mobile }] : undefined,
        gender: (input.patient.gender || '').toLowerCase().startsWith('f') ? 'female'
            : (input.patient.gender || '').toLowerCase().startsWith('m') ? 'male' : 'unknown',
        birthDate: input.patient.dob || undefined,
        address: input.patient.address ? [{ text: input.patient.address }] : undefined
    };
}

function practitionerResource(input: EncounterExportInput): Practitioner {
    const identifiers = [];
    if (input.practitioner.licenseNumber) {
        identifiers.push({ system: 'https://indianmedicalcouncil.gov.in/license', value: input.practitioner.licenseNumber });
    }
    return {
        resourceType: 'Practitioner',
        identifier: identifiers.length > 0 ? identifiers : undefined,
        name: [{ text: input.practitioner.name }]
    };
}

function organizationResource(input: EncounterExportInput): Organization {
    return {
        resourceType: 'Organization',
        name: input.clinic.name,
        address: input.clinic.address ? [{ text: input.clinic.address }] : undefined
    };
}

function encounterResource(input: EncounterExportInput, date: string): Encounter {
    return {
        resourceType: 'Encounter',
        status: 'finished',
        subject: ref('Patient', input.patient.id),
        participant: [{ individual: ref('Practitioner', input.practitioner.id) }],
        period: { start: date }
    };
}

function compositionResource(
    input: EncounterExportInput,
    date: string,
    profile: 'op-consult' | 'ips',
    entryRefs: string[]
): Composition {
    return {
        resourceType: 'Composition',
        status: 'final',
        type: profile === 'ips'
            ? { coding: [{ system: 'http://loinc.org', code: '60591-5', display: 'Patient summary Document' }] }
            : { text: 'OP Consultation Record' },
        subject: ref('Patient', input.patient.id),
        encounter: ref('Encounter', input.encounter.id),
        date,
        author: [ref('Practitioner', input.practitioner.id)],
        title: profile === 'ips'
            ? `Patient Summary - ${input.patient.name}`
            : `OP Consultation - ${input.patient.name}`,
        section: OP_CONSULT_SECTIONS.map((title) => ({ title, entry: entryRefs.map((r) => ({ reference: r })) }))
    };
}

function bundleFor(
    input: EncounterExportInput,
    date: string,
    profile: 'op-consult' | 'ips'
): { bundle: Bundle; warnings: string[] } {
    const warnings: string[] = [];
    const resources: Resource[] = [];
    const push = (resource: Resource, localId: string): string => {
        resources.push(resource);
        return `${resource.resourceType}/${localId}`;
    };

    const patientRef = push(patientResource(input), String(input.patient.id));
    const practitionerRef = push(practitionerResource(input), String(input.practitioner.id));
    push(organizationResource(input), 'clinic');
    const encounterRef = push(encounterResource(input, date), String(input.encounter.id));
    void patientRef;
    void practitionerRef;
    void encounterRef;

    const entryRefs: string[] = [
        `Patient/${input.patient.id}`,
        `Practitioner/${input.practitioner.id}`,
        `Encounter/${input.encounter.id}`
    ];

    for (const condition of input.conditions || []) {
        if (!condition.name?.trim()) continue;
        const refId = `condition-${entryRefs.length}`;
        resources.push({ ...conditionResource(condition, input.patient.id) });
        entryRefs.push(`Condition/${refId}`);
    }

    for (const allergy of input.allergies || []) {
        if (!allergy.substance?.trim() || allergy.status === 'inactive') continue;
        const refId = `allergy-${entryRefs.length}`;
        resources.push({ ...allergyResource(allergy, input.patient.id) });
        entryRefs.push(`AllergyIntolerance/${refId}`);
    }

    for (const observation of vitalObservations(input.vitals, input.patient.id)) {
        const refId = `observation-${entryRefs.length}`;
        resources.push({ ...observation });
        entryRefs.push(`Observation/${refId}`);
    }

    for (const line of input.prescriptions || []) {
        if (!line.medicine?.trim()) continue;
        const built = medicationRequest(line, input, date);
        if (!built) {
            warnings.push(`Prescription line omitted from export (incomplete): ${line.medicine}`);
            continue;
        }
        if (!FREQUENCY_PATTERN[line.frequency || ''] && line.frequency) {
            warnings.push(`Frequency kept as free text (no coded mapping): ${line.medicine} — ${line.frequency}`);
        }
        const refId = `medicationrequest-${entryRefs.length}`;
        resources.push({ ...built });
        entryRefs.push(`MedicationRequest/${refId}`);
    }

    const composition = compositionResource(input, date, profile, entryRefs);
    const bundle: Bundle = {
        resourceType: 'Bundle',
        type: 'document',
        timestamp: date,
        entry: [
            { fullUrl: 'Composition/record', resource: composition },
            ...resources.map((resource, index) => ({
                fullUrl: entryRefs[index],
                resource
            }))
        ]
    };
    return { bundle, warnings };
}

/** ABDM OPConsultRecord document bundle for one finished encounter. */
export function buildOpConsultRecord(input: EncounterExportInput, date?: string): ExportResult {
    const at = date || new Date().toISOString();
    const { bundle, warnings } = bundleFor(input, at, 'op-consult');
    return { bundle, warnings };
}

/** HL7 IPS patient-summary document bundle for one finished encounter. */
export function buildIpsDocument(input: EncounterExportInput, date?: string): ExportResult {
    const at = date || new Date().toISOString();
    const { bundle, warnings } = bundleFor(input, at, 'ips');
    return { bundle, warnings };
}
