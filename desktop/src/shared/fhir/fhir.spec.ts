import { describe, it, expect, expectTypeOf } from 'vitest';
import type {
    Bundle, Composition, Patient, Practitioner, Encounter, Medication,
    MedicationRequest, AllergyIntolerance, Observation, Condition,
    ResourceType
} from './r4';
import {
    PRESCRIPTION_MUST_SUPPORT, FREQUENCY_PATTERN, OP_CONSULT_SECTIONS,
    isExportableMedicationRequest
} from './nrces';

describe('FHIR R4 structural types', () => {
    it('pins resource type literals', () => {
        expectTypeOf<ResourceType>().toMatchTypeOf<'Bundle' | 'Patient'>();
        const patient: Patient = { resourceType: 'Patient' };
        expect(patient.resourceType).toBe('Patient');
    });

    it('requires Composition date, title, and authors', () => {
        const composition: Composition = {
            resourceType: 'Composition',
            status: 'final',
            type: {},
            date: '2026-09-20',
            author: [{ reference: 'Practitioner/10' }],
            title: 'OP Consultation Record'
        };
        expect(composition.author).toHaveLength(1);
    });

    it('requires MedicationRequest subject while keeping clinical detail optional', () => {
        const request: MedicationRequest = {
            resourceType: 'MedicationRequest',
            status: 'active',
            intent: 'order',
            subject: { reference: 'Patient/1' }
        };
        expect(request.subject.reference).toBe('Patient/1');
        expect(request.dosageInstruction).toBeUndefined();
    });

    it('models the clinical resources the export needs', () => {
        const allergy: AllergyIntolerance = {
            resourceType: 'AllergyIntolerance',
            criticality: 'high',
            patient: { reference: 'Patient/1' }
        };
        const observation: Observation = {
            resourceType: 'Observation',
            status: 'final',
            code: { coding: [{ system: 'http://loinc.org', code: '8310-5' }] }
        };
        const condition: Condition = {
            resourceType: 'Condition',
            subject: { reference: 'Patient/1' }
        };
        const encounter: Encounter = {
            resourceType: 'Encounter',
            status: 'finished',
            subject: { reference: 'Patient/1' }
        };
        const medication: Medication = { resourceType: 'Medication' };
        const practitioner: Practitioner = { resourceType: 'Practitioner' };
        const bundle: Bundle = { resourceType: 'Bundle', type: 'document', entry: [] };
        expect([allergy, observation, condition, encounter, medication, practitioner, bundle])
            .toHaveLength(7);
    });
});

describe('NRCeS prescription profile', () => {
    it('declares the must-support fields the export gate enforces', () => {
        expect([...PRESCRIPTION_MUST_SUPPORT]).toEqual(
            expect.arrayContaining(['medication', 'requester', 'authoredOn']));
    });

    it('maps Indian frequency shorthand to structural timing', () => {
        expect(FREQUENCY_PATTERN['1-0-1']).toEqual({ frequency: 2, period: 1, periodUnit: 'd' });
        expect(FREQUENCY_PATTERN['1-1-1'].frequency).toBe(3);
        expect(FREQUENCY_PATTERN['SOS']).toBeUndefined();
    });

    it('orders OPConsultRecord sections deterministically', () => {
        expect([...OP_CONSULT_SECTIONS]).toEqual([
            'Chief Complaints', 'Observations', 'Diagnosis', 'Prescription', 'Advice'
        ]);
    });

    it('gates export on subject, requester, authored date, medication, and dosage', () => {
        const base: MedicationRequest = {
            resourceType: 'MedicationRequest',
            status: 'active',
            intent: 'order',
            subject: { reference: 'Patient/1' },
            requester: { reference: 'Practitioner/10' },
            authoredOn: '2026-09-20',
            medicationCodeableConcept: { text: 'Metformin 500mg' },
            dosageInstruction: [{ text: '1-0-1' }]
        };
        expect(isExportableMedicationRequest(base)).toBe(true);
        expect(isExportableMedicationRequest({ ...base, subject: {} })).toBe(false);
        expect(isExportableMedicationRequest({ ...base, requester: {} })).toBe(false);
        expect(isExportableMedicationRequest({ ...base, authoredOn: undefined })).toBe(false);
        expect(isExportableMedicationRequest({
            ...base, medicationCodeableConcept: undefined
        })).toBe(false);
        expect(isExportableMedicationRequest({ ...base, dosageInstruction: [] })).toBe(false);
    });
});
