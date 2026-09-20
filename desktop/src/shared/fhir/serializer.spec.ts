import { describe, it, expect } from 'vitest';
import {
    buildOpConsultRecord, buildIpsDocument,
    type EncounterExportInput
} from './serializer';

function fixture(): EncounterExportInput {
    return {
        patient: {
            id: 1, name: 'Asha Worker', mobile: '9876543210', age: 34,
            gender: 'Female', address: '12 Main Road', abhaAddress: 'asha@sbx'
        },
        practitioner: { id: 10, name: 'Dr. Smith', licenseNumber: 'MED-12345', specialty: 'General' },
        clinic: { name: 'Nalam Clinic', address: 'Chennai' },
        encounter: {
            id: 7, date: '2026-09-20T10:00:00.000Z', diagnosis: 'Acute pharyngitis',
            symptoms: 'Sore throat for 2 days', examinationNotes: 'Throat congested'
        },
        prescriptions: [
            { medicine: 'Amoxicillin 500mg', dosage: '500mg', route: 'Oral', frequency: '1-0-1', duration: '3 days', instruction: 'After Food' },
            { medicine: 'Paracetamol', frequency: 'SOS' }
        ],
        allergies: [
            { substance: 'Penicillin', criticality: 'high', severity: 'severe', reaction: 'Rash', status: 'active' },
            { substance: 'Dust', status: 'inactive' }
        ],
        conditions: [
            { name: 'Type 2 Diabetes', code: 'E11.9', status: 'active', onsetDate: '2020-01-01' }
        ],
        vitals: {
            systolic_bp: 120, diastolic_bp: 80, pulse: 72, temperature: 98.6,
            temperatureUnits: '°F', spo2: 98, weight: 62, weightUnits: 'kg', height: 160
        }
    };
}

describe('buildOpConsultRecord', () => {
    it('emits a document bundle with ordered sections', () => {
        const { bundle, warnings } = buildOpConsultRecord(fixture(), '2026-09-20T10:00:00.000Z');
        expect(bundle.resourceType).toBe('Bundle');
        expect(bundle.type).toBe('document');
        const composition: any = bundle.entry[0].resource;
        expect(composition.resourceType).toBe('Composition');
        expect(composition.title).toContain('OP Consultation');
        expect(composition.section.map((s: any) => s.title)).toEqual([
            'Chief Complaints', 'Observations', 'Diagnosis', 'Prescription', 'Advice'
        ]);
        expect(warnings.join(' ')).toContain('SOS');
    });

    it('carries practitioner provenance and patient identity', () => {
        const { bundle } = buildOpConsultRecord(fixture(), '2026-09-20T10:00:00.000Z');
        const practitioner: any = bundle.entry.find((e) => e.resource?.resourceType === 'Practitioner')?.resource;
        expect(JSON.stringify(practitioner)).toContain('MED-12345');
        const patient: any = bundle.entry.find((e) => e.resource?.resourceType === 'Patient')?.resource;
        expect(JSON.stringify(patient)).toContain('asha@sbx');
    });

    it('codes vitals with LOINC and prescriptions with structural timing', () => {
        const { bundle } = buildOpConsultRecord(fixture(), '2026-09-20T10:00:00.000Z');
        const observations: any[] = bundle.entry
            .filter((e) => e.resource?.resourceType === 'Observation')
            .map((e) => e.resource);
        const codes = observations.flatMap((o) => o.code?.coding?.map((c: any) => c.code) || []);
        expect(codes).toEqual(expect.arrayContaining(['8480-6', '8867-4', '8310-5', '2708-6', '29463-7']));
        const requests: any[] = bundle.entry
            .filter((e) => e.resource?.resourceType === 'MedicationRequest')
            .map((e) => e.resource);
        expect(requests).toHaveLength(2);
        expect(requests[0].dosageInstruction[0].timing.repeat).toMatchObject({ frequency: 2, periodUnit: 'd' });
        expect(requests[0].requester).toMatchObject({ reference: 'Practitioner/10' });
    });

    it('keeps unmapped frequencies as text with a warning instead of dropping', () => {
        const { bundle, warnings } = buildOpConsultRecord(fixture(), '2026-09-20T10:00:00.000Z');
        const requests: any[] = bundle.entry
            .filter((e) => e.resource?.resourceType === 'MedicationRequest')
            .map((e) => e.resource);
        const sos = requests.find((r) => r.medicationCodeableConcept?.text === 'Paracetamol');
        expect(sos.dosageInstruction[0].text).toBe('SOS');
        expect(warnings.join(' ')).toContain('SOS');
    });

    it('omits inactive allergies and blank lines without warnings', () => {
        const input = fixture();
        input.prescriptions = [{ medicine: '   ' }, { medicine: 'Cetirizine', frequency: '1-0-0' }];
        const { bundle, warnings } = buildOpConsultRecord(input, '2026-09-20T10:00:00.000Z');
        const allergies: any[] = bundle.entry
            .filter((e) => e.resource?.resourceType === 'AllergyIntolerance')
            .map((e) => e.resource);
        expect(allergies).toHaveLength(1);
        expect(allergies[0].code.text).toBe('Penicillin');
        expect(warnings).toHaveLength(0);
        const requests = bundle.entry.filter((e) => e.resource?.resourceType === 'MedicationRequest');
        expect(requests).toHaveLength(1);
    });
});

describe('buildIpsDocument', () => {
    it('emits a patient summary composition with the same clinical core', () => {
        const { bundle } = buildIpsDocument(fixture(), '2026-09-20T10:00:00.000Z');
        const composition: any = bundle.entry[0].resource;
        expect(composition.title).toContain('Patient Summary');
        expect(composition.type.coding[0].code).toBe('60591-5');
        const kinds = bundle.entry.map((e) => e.resource?.resourceType);
        expect(kinds).toEqual(expect.arrayContaining(
            ['Composition', 'Patient', 'Practitioner', 'Encounter', 'Condition', 'AllergyIntolerance', 'Observation', 'MedicationRequest']));
    });
});
