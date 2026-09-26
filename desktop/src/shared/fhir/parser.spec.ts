import { describe, it, expect } from 'vitest';
import { parseClinicalBundle } from './parser';

const FOREIGN_BUNDLE = {
    resourceType: 'Bundle',
    type: 'document',
    entry: [
        { resource: { resourceType: 'Composition', title: 'Discharge Summary — City Hospital' } },
        {
            resource: {
                resourceType: 'Condition',
                code: { coding: [{ system: 'http://snomed.info/sct', code: '38341003', display: 'Hypertensive disorder' }] },
                clinicalStatus: 'active'
            }
        },
        {
            resource: {
                resourceType: 'MedicationRequest',
                medicationCodeableConcept: { text: 'Amlodipine 5mg' },
                dosageInstruction: [{ text: '5mg, once daily' }],
                status: 'active'
            }
        },
        {
            resource: {
                resourceType: 'Observation',
                code: { coding: [{ system: 'http://loinc.org', code: '8480-6', display: 'Systolic blood pressure' }] },
                valueQuantity: { value: 150, unit: 'mmHg' }
            }
        },
        {
            resource: {
                resourceType: 'Observation',
                code: { text: 'COVID-19 screening' },
                valueCodeableConcept: { coding: [{ code: '260373001', display: 'Positive' }] }
            }
        },
        {
            resource: {
                resourceType: 'AllergyIntolerance',
                code: { text: 'Penicillin' },
                criticality: 'high'
            }
        },
        { resource: { resourceType: 'Procedure', code: { text: 'Appendectomy' } } },
        { resource: { notAType: true } },
        { resource: { resourceType: 'Condition', code: {} } }
    ]
};

describe('parseClinicalBundle (M3 inbound)', () => {
    it('parses a foreign document into the display model', () => {
        const parsed = parseClinicalBundle(JSON.stringify(FOREIGN_BUNDLE));
        expect(parsed.title).toBe('Discharge Summary — City Hospital');
        expect(parsed.diagnoses).toEqual([{ text: 'Hypertensive disorder', code: '38341003', status: 'active' }]);
        expect(parsed.medications).toEqual([{ name: 'Amlodipine 5mg', dosage: '5mg', frequency: 'once daily', status: 'active' }]);
        expect(parsed.observations).toEqual([
            { text: 'Systolic blood pressure', value: '150 mmHg' },
            { text: 'COVID-19 screening', value: 'Positive (260373001)' }
        ]);
        expect(parsed.allergies).toEqual([{ substance: 'Penicillin', criticality: 'high' }]);
    });

    it('degrades unknown and unreadable entries to warnings, never failures', () => {
        const parsed = parseClinicalBundle(FOREIGN_BUNDLE);
        expect(parsed.warnings).toContain('Skipped unsupported resource: Procedure.');
        expect(parsed.warnings).toContain('Skipped an entry without a resource type.');
        expect(parsed.warnings).toContain('Skipped a condition without a readable code.');
    });

    it('rejects non-bundles and invalid JSON', () => {
        expect(() => parseClinicalBundle('not-json')).toThrow('not valid JSON');
        expect(() => parseClinicalBundle({ resourceType: 'Patient' })).toThrow('no entries');
    });
});
