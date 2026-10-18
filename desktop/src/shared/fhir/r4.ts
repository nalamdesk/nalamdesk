/**
 * Minimal FHIR R4 structural types for NalamDesk's ABDM interchange work.
 *
 * Scope: only the resources the OPConsultRecord / IPS export needs, with the
 * fields we actually populate. Cardinalities follow R4; required elements
 * are non-optional in the types, everything else is optional. Fields outside
 * this scope are intentionally absent rather than `any`-typed — extend the
 * interfaces (and their specs) when a new surface needs them.
 *
 * Sources: HL7 FHIR R4 (hl7.org/fhir/R4), ABDM Health Data Management Policy
 * NRCeS prescription guidance. Profile-specific constraints live in nrces.ts.
 */

export type ResourceType =
    | 'Bundle'
    | 'Composition'
    | 'Patient'
    | 'Practitioner'
    | 'PractitionerRole'
    | 'Organization'
    | 'Encounter'
    | 'Medication'
    | 'MedicationRequest'
    | 'AllergyIntolerance'
    | 'Observation'
    | 'Condition';

export interface Coding {
    system?: string;
    code?: string;
    display?: string;
}

export interface CodeableConcept {
    coding?: Coding[];
    text?: string;
}

export interface Reference {
    reference?: string;
    display?: string;
}

export interface Identifier {
    system?: string;
    value?: string;
}

export interface HumanName {
    text?: string;
    family?: string;
    given?: string[];
}

export interface Address {
    text?: string;
    line?: string[];
    city?: string;
    state?: string;
    postalCode?: string;
    country?: string;
}

export interface ContactPoint {
    system?: 'phone' | 'email' | string;
    value?: string;
}

export interface Quantity {
    value?: number;
    unit?: string;
    system?: string;
    code?: string;
}

export interface Period {
    start?: string;
    end?: string;
}

export interface Annotation {
    text?: string;
}

export interface Resource {
    resourceType: ResourceType;
    id?: string;
}

export interface BundleEntry {
    fullUrl?: string;
    resource?: Resource;
}

export interface Bundle extends Resource {
    resourceType: 'Bundle';
    identifier?: Identifier;
    type: 'document' | 'collection' | string;
    timestamp?: string;
    entry: BundleEntry[];
}

export interface CompositionSection {
    title?: string;
    code?: CodeableConcept;
    entry?: Reference[];
    text?: { status: string; div: string };
}

export interface Composition extends Resource {
    resourceType: 'Composition';
    status: 'final' | 'preliminary' | 'amended' | string;
    type: CodeableConcept;
    subject?: Reference;
    encounter?: Reference;
    date: string;
    author: Reference[];
    title: string;
    section?: CompositionSection[];
}

export interface Patient extends Resource {
    resourceType: 'Patient';
    identifier?: Identifier[];
    name?: HumanName[];
    telecom?: ContactPoint[];
    gender?: 'male' | 'female' | 'other' | 'unknown';
    birthDate?: string;
    address?: Address[];
}

export interface Practitioner extends Resource {
    resourceType: 'Practitioner';
    identifier?: Identifier[];
    name?: HumanName[];
}

export interface PractitionerRole extends Resource {
    resourceType: 'PractitionerRole';
    practitioner?: Reference;
    organization?: Reference;
    code?: CodeableConcept[];
}

export interface Organization extends Resource {
    resourceType: 'Organization';
    identifier?: Identifier[];
    name?: string;
    address?: Address[];
}

export interface Encounter extends Resource {
    resourceType: 'Encounter';
    identifier?: Identifier[];
    status: 'finished' | 'in-progress' | 'planned' | string;
    subject?: Reference;
    participant?: Array<{ individual?: Reference }>;
    period?: Period;
}

export interface Medication extends Resource {
    resourceType: 'Medication';
    code?: CodeableConcept;
}

export interface DosageDoseAndRate {
    doseQuantity?: Quantity;
}

export interface TimingRepeat {
    frequency?: number;
    period?: number;
    periodUnit?: 'd' | 'h' | string;
    when?: string[];
}

export interface Dosage {
    text?: string;
    route?: CodeableConcept;
    method?: CodeableConcept;
    doseAndRate?: DosageDoseAndRate[];
    timing?: { repeat?: TimingRepeat };
}

export interface DispenseRequest {
    quantity?: Quantity;
    expectedSupplyDuration?: Quantity;
    numberOfRepeatsAllowed?: number;
}

export interface MedicationRequest extends Resource {
    resourceType: 'MedicationRequest';
    status: 'active' | 'completed' | 'cancelled' | 'draft' | string;
    intent: 'order' | 'plan' | string;
    medicationCodeableConcept?: CodeableConcept;
    medicationReference?: Reference;
    subject: Reference;
    requester?: Reference;
    authoredOn?: string;
    validityPeriod?: Period;
    dosageInstruction?: Dosage[];
    dispenseRequest?: DispenseRequest;
    note?: Annotation[];
}

export interface AllergyIntolerance extends Resource {
    resourceType: 'AllergyIntolerance';
    clinicalStatus?: CodeableConcept;
    type?: 'allergy' | 'intolerance';
    category?: string[];
    criticality?: 'low' | 'high' | 'unable-to-assess';
    code?: CodeableConcept;
    patient: Reference;
    onsetDateTime?: string;
    reaction?: Array<{
        manifestation?: CodeableConcept[];
        severity?: 'mild' | 'moderate' | 'severe';
    }>;
}

export interface Observation extends Resource {
    resourceType: 'Observation';
    status: 'final' | 'amended' | 'entered-in-error' | string;
    code: CodeableConcept;
    subject?: Reference;
    encounter?: Reference;
    effectiveDateTime?: string;
    valueQuantity?: Quantity;
    interpretation?: CodeableConcept[];
}

export interface Condition extends Resource {
    resourceType: 'Condition';
    clinicalStatus?: CodeableConcept;
    code?: CodeableConcept;
    subject: Reference;
    onsetDateTime?: string;
}
