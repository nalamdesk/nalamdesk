/**
 * Dual clinical-record serializer: ABDM OPConsultRecord + HL7 IPS.
 *
 * Pure functions over an explicit input contract so main, renderer, and
 * tests share one implementation with no I/O. Partial exports are honest:
 * lines that fail the NRCeS gate are omitted from MedicationRequest entries
 * and reported in `warnings` instead of being silently dropped or invented.
 *
 * Known limitation: bundle `fullUrl` values are document-relative
 * (`Patient/1`, `Composition/record`). An offline desktop has no canonical
 * base URL to absolutize them against; revisit with `urn:uuid` or absolute
 * URLs when a share/upload endpoint defines the addressing scheme.
 */

import type {
    AllergyIntolerance, Bundle, Composition, Condition, Dosage, Encounter,
    MedicationRequest, Observation, Organization, Patient, Practitioner,
    Quantity, Resource
} from './r4';
import {
    ExportablePrescriptionLine, FREQUENCY_PATTERN, IPS_SECTIONS, OP_CONSULT_SECTIONS,
    isExportableMedicationRequest
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

function escXml(value: string): string {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// Normalizes stored dates to FHIR dateTime. SQLite CURRENT_TIMESTAMP rows
// arrive as `YYYY-MM-DD HH:MM:SS` (UTC, no separator or zone), which is not
// a valid FHIR instant; ISO inputs pass through `Date` untouched so their
// instants (including non-UTC offsets) survive exactly.
function toFhirDateTime(value?: string): string {
    const raw = String(value || '').trim();
    if (!raw) return new Date().toISOString();
    const sqlite = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}(?::\d{2})?)/.exec(raw);
    if (sqlite) {
        const parsed = new Date(`${sqlite[1]}T${sqlite[2]}Z`);
        if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
    }
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

// Parses UI durations like `3 days` into a real FHIR quantity. Unparseable
// values return undefined so callers omit the field instead of emitting a
// wrong number.
function supplyDuration(duration?: string): Quantity | undefined {
    const match = /^\s*(\d+(?:\.\d+)?)\s*([A-Za-z]*)\s*$/.exec(String(duration || ''));
    if (!match) return undefined;
    const unitMap: Record<string, string> = {
        d: 'days', day: 'days', days: 'days',
        w: 'weeks', week: 'weeks', weeks: 'weeks',
        m: 'months', month: 'months', months: 'months'
    };
    const unit = unitMap[match[2].toLowerCase()] || match[2] || 'days';
    return { value: Number(match[1]), unit };
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
    date: string,
    warnings: string[]
): MedicationRequest | null {
    const missing = (['dosage', 'route', 'frequency', 'duration'] as const)
        .filter((field) => !String(line[field] || '').trim());
    if (missing.length > 0) {
        warnings.push(`Prescription line omitted from export (needs ${missing.join(', ')}): ${line.medicine}`);
        return null;
    }
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
    const supply = supplyDuration(line.duration);
    if (supply) {
        request.dispenseRequest = { expectedSupplyDuration: supply };
    } else if (line.duration) {
        // Unparseable durations (e.g. `3-4 days`, `until review`) still
        // travel with the order as text so the duration is never lost.
        const dosage = request.dosageInstruction?.[0];
        if (dosage) {
            dosage.text = [dosage.text, `for ${line.duration}`].filter(Boolean).join(' ');
        }
        warnings.push(`Duration kept as text (no coded quantity): ${line.medicine} — ${line.duration}`);
    }
    if (!isExportableMedicationRequest(request)) {
        warnings.push(`Prescription line omitted from export (structural check failed): ${line.medicine}`);
        return null;
    }
    return request;
}

function allergyResource(allergy: ExportAllergy, patientId: number | string): AllergyIntolerance {
    const criticality = allergy.criticality === 'high' ? 'high'
        : allergy.criticality === 'unable-to-assess' ? 'unable-to-assess' : 'low';
    const severity = allergy.severity === 'mild' || allergy.severity === 'moderate' || allergy.severity === 'severe'
        ? allergy.severity
        : allergy.severity === 'life-threatening' ? 'severe' : undefined;
    return {
        resourceType: 'AllergyIntolerance',
        clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical', code: 'active' }] },
        type: 'allergy',
        criticality,
        code: { text: allergy.substance },
        patient: ref('Patient', patientId),
        reaction: allergy.reaction ? [{ manifestation: [{ text: allergy.reaction }], severity }] : undefined
    };
}

function conditionResource(condition: ExportCondition, patientId: number | string): Condition {
    // The UI's lifecycle matches FHIR condition-clinical one-to-one; pass
    // recognized statuses through instead of collapsing them to `resolved`.
    const valid = ['active', 'recurrence', 'relapse', 'inactive', 'remission', 'resolved'];
    const status = valid.includes(condition.status || '') ? condition.status : undefined;
    return {
        resourceType: 'Condition',
        clinicalStatus: status
            ? { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: status }] }
            : undefined,
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

function genderFor(value?: string): 'male' | 'female' | 'other' | 'unknown' {
    // `Other` (known to be outside male/female) is distinct from `unknown`
    // (not known); collapsing them loses an explicitly captured value.
    const normalized = String(value || '').toLowerCase();
    if (normalized.startsWith('f')) return 'female';
    if (normalized.startsWith('m')) return 'male';
    if (normalized.startsWith('o')) return 'other';
    return 'unknown';
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
        gender: genderFor(input.patient.gender),
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

function textNarrative(lines: string[]): { status: string; div: string } {
    const items = lines.map((line) => line.trim()).filter((line) => line);
    return {
        status: 'generated',
        div: `<div xmlns="http://www.w3.org/1999/xhtml">${items.map((line) => `<p>${escXml(line)}</p>`).join('')}</div>`
    };
}

interface SectionPlan {
    title: string;
    code?: { system: string; code: string; display: string };
    refs: string[];
    narrative: string[];
}

function compositionResource(
    input: EncounterExportInput,
    date: string,
    profile: 'op-consult' | 'ips',
    sections: SectionPlan[]
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
        section: sections.map((section) => ({
            title: section.title,
            code: section.code ? { coding: [section.code] } : undefined,
            entry: section.refs.map((r) => ({ reference: r })),
            text: textNarrative(section.narrative)
        }))
    };
}

function bundleFor(
    input: EncounterExportInput,
    date: string,
    profile: 'op-consult' | 'ips'
): { bundle: Bundle; warnings: string[] } {
    const warnings: string[] = [];
    // Entries are built as (resource, fullUrl) pairs so references can never
    // drift apart; the Composition sections below each take their own slice.
    const entries: Array<{ fullUrl: string; resource: Resource }> = [];
    const push = (resource: Resource, localId: string): string => {
        const fullUrl = `${resource.resourceType}/${localId}`;
        entries.push({ fullUrl, resource });
        return fullUrl;
    };

    const patientRef = push(patientResource(input), String(input.patient.id));
    const practitionerRef = push(practitionerResource(input), String(input.practitioner.id));
    push(organizationResource(input), 'clinic');
    const encounterRefFull = push(encounterResource(input, date), String(input.encounter.id));
    const coreRefs = [patientRef, practitionerRef, encounterRefFull];

    const conditionRefs: string[] = [];
    for (const condition of input.conditions || []) {
        if (!condition.name?.trim()) continue;
        conditionRefs.push(push(conditionResource(condition, input.patient.id), `condition-${entries.length}`));
    }

    const allergyRefs: string[] = [];
    for (const allergy of input.allergies || []) {
        if (!allergy.substance?.trim() || allergy.status === 'inactive') continue;
        allergyRefs.push(push(allergyResource(allergy, input.patient.id), `allergy-${entries.length}`));
    }

    const observationRefs: string[] = [];
    for (const observation of vitalObservations(input.vitals, input.patient.id)) {
        observationRefs.push(push(observation, `observation-${entries.length}`));
    }

    const prescriptionRefs: string[] = [];
    for (const line of input.prescriptions || []) {
        if (!line.medicine?.trim()) continue;
        const built = medicationRequest(line, input, date, warnings);
        if (!built) continue;
        if (!FREQUENCY_PATTERN[line.frequency || ''] && line.frequency) {
            warnings.push(`Frequency kept as free text (no coded mapping): ${line.medicine} — ${line.frequency}`);
        }
        prescriptionRefs.push(push(built, `medicationrequest-${entries.length}`));
    }

    // Findings narrative: symptoms, diagnosis, and exam notes ride in their
    // own sections so the record carries what the receipt showed. IPS uses
    // its own coded sections rather than the OPConsult layout.
    const loincSection = (code: string, display: string) => ({
        system: 'http://loinc.org', code, display
    });
    const sections: SectionPlan[] = profile === 'ips'
        ? [
            { title: IPS_SECTIONS[0].title, code: loincSection(IPS_SECTIONS[0].code, IPS_SECTIONS[0].title), refs: [...coreRefs, ...prescriptionRefs], narrative: [] },
            { title: IPS_SECTIONS[1].title, code: loincSection(IPS_SECTIONS[1].code, IPS_SECTIONS[1].title), refs: [...coreRefs, ...allergyRefs], narrative: [] },
            {
                title: IPS_SECTIONS[2].title, code: loincSection(IPS_SECTIONS[2].code, IPS_SECTIONS[2].title), refs: [...coreRefs, ...conditionRefs],
                narrative: [
                    ...(input.encounter.diagnosis ? [`Diagnosis: ${input.encounter.diagnosis}${input.encounter.diagnosisType ? ` (${input.encounter.diagnosisType})` : ''}`] : [])
                ]
            },
            { title: IPS_SECTIONS[3].title, code: loincSection(IPS_SECTIONS[3].code, IPS_SECTIONS[3].title), refs: [...coreRefs, ...observationRefs], narrative: [] }
        ]
        : [
        {
            title: OP_CONSULT_SECTIONS[0],
            refs: [...coreRefs, ...conditionRefs, ...observationRefs],
            narrative: [
                ...(input.encounter.symptoms ? [`Complaints: ${input.encounter.symptoms}`] : []),
                ...(input.encounter.examinationNotes ? [`Examination: ${input.encounter.examinationNotes}`] : [])
            ]
        },
        { title: OP_CONSULT_SECTIONS[1], refs: [...coreRefs, ...observationRefs], narrative: [] },
        {
            title: OP_CONSULT_SECTIONS[2],
            refs: [...coreRefs, ...conditionRefs],
            narrative: [
                ...(input.encounter.diagnosis ? [`Diagnosis: ${input.encounter.diagnosis}${input.encounter.diagnosisType ? ` (${input.encounter.diagnosisType})` : ''}`] : [])
            ]
        },
        { title: OP_CONSULT_SECTIONS[3], refs: [...coreRefs, ...prescriptionRefs], narrative: [] },
        { title: OP_CONSULT_SECTIONS[4], refs: [...coreRefs, ...allergyRefs], narrative: [] }
    ];

    const composition = compositionResource(input, date, profile, sections);
    // bdl-9: document bundles carry an identifier. Deterministic per
    // encounter and profile so re-exports of the same record agree.
    const bundle: Bundle = {
        resourceType: 'Bundle',
        identifier: {
            system: 'https://nalamdesk.app/fhir/document',
            value: `${profile}-${input.encounter.id}-${date}`
        },
        type: 'document',
        timestamp: date,
        entry: [
            { fullUrl: 'Composition/record', resource: composition },
            ...entries
        ]
    };
    return { bundle, warnings };
}

/** ABDM OPConsultRecord document bundle for one finished encounter. */
export function buildOpConsultRecord(input: EncounterExportInput, date?: string): ExportResult {
    const at = toFhirDateTime(date || input.encounter.date);
    const { bundle, warnings } = bundleFor(input, at, 'op-consult');
    return { bundle, warnings };
}

/** HL7 IPS patient-summary document bundle for one finished encounter. */
export function buildIpsDocument(input: EncounterExportInput, date?: string): ExportResult {
    const at = toFhirDateTime(date || input.encounter.date);
    const { bundle, warnings } = bundleFor(input, at, 'ips');
    return { bundle, warnings };
}
