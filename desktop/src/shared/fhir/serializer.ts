/**
 * Dual clinical-record serializer: ABDM OPConsultRecord + HL7 IPS.
 *
 * Pure functions over an explicit input contract so main, renderer, and
 * tests share one implementation with no I/O. Partial exports are honest:
 * lines that fail the NRCeS gate are omitted from MedicationRequest entries
 * and reported in `warnings` instead of being silently dropped or invented.
 *
 * Every entry is addressed by a `urn:uuid` fullUrl and referenced by it, as
 * FHIR documents require. The UUIDs are derived from the encounter, so a
 * re-export of the same record reproduces the same bundle.
 *
 * OPConsultRecord bundles declare the NRCES ABDM profiles (ndhm.in) on every
 * resource; CI checks them with the HL7 validator
 * (.github/workflows/fhir-validation.yml).
 */

import type {
    AllergyIntolerance, Bundle, Composition, Condition, Dosage, Encounter, Identifier,
    MedicationRequest, Observation, Organization, Patient, Practitioner,
    Quantity, Resource
} from './r4';
import {
    ExportablePrescriptionLine, FREQUENCY_PATTERN, IPS_SECTIONS, NRCES_PROFILE, OP_CONSULT_SECTIONS,
    isExportableMedicationRequest
} from './nrces';
import { parseFrequency, durationEndDate } from '../clinical-timing';

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
    practitioner: { id: number | string; name: string; licenseNumber?: string; specialty?: string; registryId?: string };
    clinic: { name: string; address?: string; registryId?: string };
    encounter: {
        id: number | string;
        date?: string;
        diagnosis?: string;
        diagnosisType?: string;
        symptoms?: string;
        examinationNotes?: string;
        careContextRef?: string | null;
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
const UCUM = 'http://unitsofmeasure.org';
const SNOMED = 'http://snomed.info/sct';
const V2_ID_TYPE = 'http://terminology.hl7.org/CodeSystem/v2-0203';
const NDHM_ID_TYPE = 'https://nrces.in/ndhm/fhir/r4/CodeSystem/ndhm-identifier-type-code';

// Identifier types: [type code system, code, display].
const ID_TYPES = {
    MR: [V2_ID_TYPE, 'MR', 'Medical record number'],
    ABHA: [NDHM_ID_TYPE, 'ABHA', 'Ayushman Bharat Health Account (ABHA) ID'],
    MD: [V2_ID_TYPE, 'MD', 'Medical License number'],
    EI: [V2_ID_TYPE, 'EI', 'Employee number'],
    PRN: [V2_ID_TYPE, 'PRN', 'Provider number'],
    XX: [V2_ID_TYPE, 'XX', 'Organization identifier']
} as const;

/** A typed identifier, as every NRCES Patient, Practitioner and Organization needs. */
function typedId(kind: keyof typeof ID_TYPES, system: string, value: string): Identifier {
    const [typeSystem, code, display] = ID_TYPES[kind];
    return { type: { coding: [{ system: typeSystem, code, display }] }, system, value };
}

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
    // Normalize first (issue #52): typed Latin folds to canonical, so BID
    // exports coded timing instead of a free-text warning.
    const pattern = FREQUENCY_PATTERN[parseFrequency(line.frequency || '')];
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
    // Finite courses (KB-3) carry their validity window: a course whose end
    // date has passed exports as completed instead of living on as active.
    const courseEnd = durationEndDate(String(date).slice(0, 10), line.duration);
    if (courseEnd) {
        request.dispenseRequest = { validityPeriod: { start: String(date).slice(0, 10), end: courseEnd } };
        if (courseEnd < new Date().toISOString().slice(0, 10)) {
            request.status = 'completed';
        }
    }
    const supply = supplyDuration(line.duration);
    if (supply) {
        request.dispenseRequest = { ...request.dispenseRequest, expectedSupplyDuration: supply };
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
        code: condition.code
            ? { coding: [{ system: 'http://hl7.org/fhir/sid/icd-10', code: condition.code, display: condition.name }], text: condition.name }
            : { text: condition.name },
        subject: ref('Patient', patientId),
        onsetDateTime: condition.onsetDate || undefined
    };
}

// UCUM codes for the units the vitals form records.
const UCUM_CODES: Record<string, string> = {
    'mmHg': 'mm[Hg]', 'bpm': '/min', '°F': '[degF]', 'F': '[degF]', '°C': 'Cel', 'C': 'Cel',
    '%': '%', 'kg': 'kg', 'lb': '[lb_av]', 'lbs': '[lb_av]', 'cm': 'cm'
};

function ucum(value: number, unit: string): Quantity {
    const code = UCUM_CODES[unit];
    return code ? { value, unit, system: UCUM, code } : { value, unit };
}

function vitalObservations(vitals: ExportVitals | null | undefined, patientId: number | string, date: string): Observation[] {
    if (!vitals) return [];
    const out: Observation[] = [];
    const vital = (code: string, display: string): Omit<Observation, 'valueQuantity'> => ({
        resourceType: 'Observation',
        status: 'final',
        category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'vital-signs', display: 'Vital Signs' }] }],
        code: { coding: [{ system: LOINC, code, display }], text: display },
        subject: ref('Patient', patientId),
        effectiveDateTime: date
    });
    const push = (code: string, display: string, value: number | null | undefined, unit: string): void => {
        if (value == null || Number.isNaN(Number(value))) return;
        out.push({ ...vital(code, display), valueQuantity: ucum(Number(value), unit) });
    };
    // Blood pressure is one panel with systolic and diastolic components,
    // as the FHIR vital-signs profile requires.
    if (vitals.systolic_bp != null && vitals.diastolic_bp != null
        && !Number.isNaN(Number(vitals.systolic_bp)) && !Number.isNaN(Number(vitals.diastolic_bp))) {
        out.push({
            ...vital('85354-9', 'Blood pressure panel with all children optional'),
            component: [
                { code: { coding: [{ system: LOINC, code: '8480-6', display: 'Systolic blood pressure' }] }, valueQuantity: ucum(Number(vitals.systolic_bp), 'mmHg') },
                { code: { coding: [{ system: LOINC, code: '8462-4', display: 'Diastolic blood pressure' }] }, valueQuantity: ucum(Number(vitals.diastolic_bp), 'mmHg') }
            ]
        });
    }
    push('8867-4', 'Heart rate', vitals.pulse, 'bpm');
    push('8310-5', 'Body temperature', vitals.temperature, vitals.temperatureUnits || '°F');
    push('2708-6', 'Oxygen saturation in Arterial blood', vitals.spo2, '%');
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
    // The clinic's own record number always; the ABHA address when linked.
    const identifiers = [typedId('MR', 'https://nalamdesk.app/fhir/patient', String(input.patient.id))];
    if (input.patient.abhaAddress) {
        identifiers.push(typedId('ABHA', 'https://healthid.abdm.gov.in', input.patient.abhaAddress));
    }
    return {
        resourceType: 'Patient',
        identifier: identifiers,
        name: [{ text: input.patient.name }],
        telecom: input.patient.mobile ? [{ system: 'phone', value: input.patient.mobile }] : undefined,
        gender: genderFor(input.patient.gender),
        birthDate: input.patient.dob || undefined,
        address: input.patient.address ? [{ text: input.patient.address }] : undefined
    };
}

function practitionerResource(input: EncounterExportInput): Practitioner {
    // The HPR ID uses the system NRCES examples give for it. NRCES requires
    // one identifier, so the clinic's own user ID is the fallback.
    const identifiers: Identifier[] = [];
    if (input.practitioner.registryId) identifiers.push(typedId('MD', 'https://doctor.ndhm.gov.in', input.practitioner.registryId));
    if (input.practitioner.licenseNumber) identifiers.push(typedId('MD', 'https://indianmedicalcouncil.gov.in/license', input.practitioner.licenseNumber));
    if (identifiers.length === 0) identifiers.push(typedId('EI', 'https://nalamdesk.app/fhir/practitioner', String(input.practitioner.id)));
    return {
        resourceType: 'Practitioner',
        identifier: identifiers,
        name: [{ text: input.practitioner.name }]
    };
}

function organizationResource(input: EncounterExportInput): Organization {
    // The HFR ID uses the system NRCES examples give for it. Without one,
    // NRCES still requires an identifier, so the clinic's name stands in.
    const identifiers = input.clinic.registryId
        ? [typedId('PRN', 'https://facility.ndhm.gov.in', input.clinic.registryId)]
        : [typedId('XX', 'https://nalamdesk.app/fhir/facility', input.clinic.name || 'clinic')];
    return {
        resourceType: 'Organization',
        identifier: identifiers,
        name: input.clinic.name,
        address: input.clinic.address ? [{ text: input.clinic.address }] : undefined
    };
}

function encounterResource(input: EncounterExportInput, date: string): Encounter {
    return {
        resourceType: 'Encounter',
        identifier: input.encounter.careContextRef
            ? [{ system: 'https://nalamdesk.app/fhir/care-context', value: input.encounter.careContextRef }]
            : undefined,
        status: 'finished',
        class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB', display: 'ambulatory' },
        subject: ref('Patient', input.patient.id),
        participant: [{ individual: ref('Practitioner', input.practitioner.id) }],
        period: { start: date }
    };
}

function textNarrative(lines: string[]): { status: string; div: string } | undefined {
    const items = lines.map((line) => line.trim()).filter((line) => line);
    // An empty narrative breaks txt-2; a section with entries needs none.
    if (items.length === 0) return undefined;
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
        identifier: { system: 'https://nalamdesk.app/fhir/composition', value: `${profile}-${input.encounter.id}` },
        status: 'final',
        type: profile === 'ips'
            ? { coding: [{ system: 'http://loinc.org', code: '60591-5', display: 'Patient summary Document' }] }
            : { coding: [{ system: SNOMED, code: '371530004', display: 'Clinical consultation report' }], text: 'OP Consultation Record' },
        subject: ref('Patient', input.patient.id),
        encounter: ref('Encounter', input.encounter.id),
        date,
        author: [ref('Practitioner', input.practitioner.id)],
        title: profile === 'ips'
            ? `Patient Summary - ${input.patient.name}`
            : `OP Consultation - ${input.patient.name}`,
        custodian: { reference: 'Organization/clinic' },
        section: sections.map((section) => ({
            title: section.title,
            code: section.code ? { coding: [section.code] } : undefined,
            entry: section.refs.length > 0 ? section.refs.map((r) => ({ reference: r })) : undefined,
            text: textNarrative(section.narrative)
        }))
    };
}

// Deterministic, name-derived UUID (cyrb128 over the seed), so the same
// record always gets the same fullUrls. Pure JS: this runs in the renderer.
function stableUuid(seed: string): string {
    let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
    for (let i = 0; i < seed.length; i++) {
        const k = seed.charCodeAt(i);
        h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
        h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
        h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
        h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
    }
    h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
    h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
    h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
    h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
    h1 ^= h2 ^ h3 ^ h4; h2 ^= h1; h3 ^= h1; h4 ^= h1;
    const hex = [h1, h2, h3, h4].map((h) => (h >>> 0).toString(16).padStart(8, '0')).join('');
    // RFC 4122 layout: version nibble 4, variant bits 10.
    const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

// Points every `reference` that names an entry at that entry's urn:uuid.
function rewriteReferences(value: unknown, urls: Map<string, string>): void {
    if (Array.isArray(value)) {
        for (const item of value) rewriteReferences(item, urls);
        return;
    }
    if (!value || typeof value !== 'object') return;
    const record = value as { reference?: unknown };
    if (typeof record.reference === 'string') {
        const url = urls.get(record.reference);
        if (url) record.reference = url;
    }
    for (const child of Object.values(record)) rewriteReferences(child, urls);
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
    for (const observation of vitalObservations(input.vitals, input.patient.id, date)) {
        observationRefs.push(push(observation, `observation-${entries.length}`));
    }

    const prescriptionRefs: string[] = [];
    for (const line of input.prescriptions || []) {
        if (!line.medicine?.trim()) continue;
        const built = medicationRequest(line, input, date, warnings);
        if (!built) continue;
        if (!FREQUENCY_PATTERN[parseFrequency(line.frequency || '')] && line.frequency) {
            warnings.push(`Frequency kept as free text (no coded mapping): ${line.medicine} — ${line.frequency}`);
        }
        prescriptionRefs.push(push(built, `medicationrequest-${entries.length}`));
    }

    // IPS keeps its own LOINC-coded sections. OPConsultRecord uses the NRCES
    // section slices, each holding only the resource type that slice allows;
    // Patient, Practitioner and Encounter are reached from the Composition.
    const loincSection = (code: string, display: string) => ({
        system: 'http://loinc.org', code, display
    });
    const opSection = (index: number) => {
        const spec = OP_CONSULT_SECTIONS[index];
        return { title: spec.title, code: { system: SNOMED, code: spec.code, display: spec.display } };
    };
    const diagnosis = input.encounter.diagnosis
        ? [`Diagnosis: ${input.encounter.diagnosis}${input.encounter.diagnosisType ? ` (${input.encounter.diagnosisType})` : ''}`]
        : [];
    const sections: SectionPlan[] = profile === 'ips'
        ? [
            { title: IPS_SECTIONS[0].title, code: loincSection(IPS_SECTIONS[0].code, IPS_SECTIONS[0].title), refs: [...coreRefs, ...prescriptionRefs], narrative: [] },
            { title: IPS_SECTIONS[1].title, code: loincSection(IPS_SECTIONS[1].code, IPS_SECTIONS[1].title), refs: [...coreRefs, ...allergyRefs], narrative: [] },
            { title: IPS_SECTIONS[2].title, code: loincSection(IPS_SECTIONS[2].code, IPS_SECTIONS[2].title), refs: [...coreRefs, ...conditionRefs], narrative: diagnosis },
            { title: IPS_SECTIONS[3].title, code: loincSection(IPS_SECTIONS[3].code, IPS_SECTIONS[3].title), refs: [...coreRefs, ...observationRefs], narrative: [] }
        ]
        : [
            {
                ...opSection(0), refs: [],
                narrative: [
                    ...(input.encounter.symptoms ? [`Complaints: ${input.encounter.symptoms}`] : []),
                    ...diagnosis
                ]
            },
            {
                ...opSection(1), refs: observationRefs,
                narrative: input.encounter.examinationNotes ? [`Examination: ${input.encounter.examinationNotes}`] : []
            },
            { ...opSection(2), refs: allergyRefs, narrative: [] },
            { ...opSection(3), refs: conditionRefs, narrative: [] },
            { ...opSection(4), refs: prescriptionRefs, narrative: [] }
        ];
    // A Composition needs at least one section, and a section needs entries
    // or text: drop the empty ones, keeping chief complaints as the floor.
    let kept = sections.filter((section) => section.refs.length > 0 || section.narrative.some((line) => line.trim()));
    if (kept.length === 0) kept = [{ ...sections[0], narrative: ['No findings recorded.'] }];
    if (profile === 'ips') kept = sections;

    const composition = compositionResource(input, date, profile, kept);
    const all: Array<{ fullUrl: string; resource: Resource }> = [
        { fullUrl: 'Composition/record', resource: composition },
        ...entries
    ];
    // Absolute fullUrls, derived from the record so re-exports agree.
    const seed = `${profile}|${input.clinic.registryId || input.clinic.name}|${input.encounter.id}`;
    const urls = new Map(all.map((entry) => [entry.fullUrl, `urn:uuid:${stableUuid(`${seed}|${entry.fullUrl}`)}`]));
    for (const entry of all) rewriteReferences(entry.resource, urls);
    if (profile === 'op-consult') {
        for (const entry of all) {
            const name = NRCES_PROFILE[entry.resource.resourceType];
            if (name) entry.resource.meta = { profile: [name] };
        }
    }

    // bdl-9: document bundles carry an identifier. Deterministic per
    // encounter and profile so re-exports of the same record agree.
    const bundle: Bundle = {
        resourceType: 'Bundle',
        ...(profile === 'op-consult'
            ? { meta: { versionId: '1', lastUpdated: date, profile: [NRCES_PROFILE['Bundle'] as string] } }
            : {}),
        identifier: {
            system: 'https://nalamdesk.app/fhir/document',
            value: `${profile}-${input.encounter.id}-${date}`
        },
        type: 'document',
        timestamp: date,
        entry: all.map((entry) => ({ fullUrl: urls.get(entry.fullUrl), resource: entry.resource }))
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
