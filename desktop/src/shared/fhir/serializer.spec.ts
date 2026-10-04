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
            { medicine: 'Paracetamol', dosage: '500mg', route: 'Oral', frequency: 'SOS', duration: '3 days' }
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
        expect(codes).toEqual(expect.arrayContaining(['8480-6', '8462-4', '8867-4', '8310-5', '2708-6', '29463-7', '8302-2']));
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
        expect(sos.dosageInstruction[0].text).toContain('SOS');
        expect(warnings.join(' ')).toContain('SOS');
    });

    it('codes typed Latin schedules through the parser', () => {
        const input = fixture();
        input.prescriptions = [
            { medicine: 'Amoxicillin', dosage: '500mg', route: 'Oral', frequency: 'BID', duration: '3 days' },
            { medicine: 'Cetirizine', dosage: '10mg', route: 'Oral', frequency: 'prn', duration: '5 days' }
        ];
        const { bundle, warnings } = buildOpConsultRecord(input, '2026-09-20T10:00:00.000Z');
        const requests: any[] = bundle.entry
            .filter((e) => e.resource?.resourceType === 'MedicationRequest')
            .map((e) => e.resource);
        const bid = requests.find((r) => r.medicationCodeableConcept?.text === 'Amoxicillin');
        expect(bid.dosageInstruction[0].timing.repeat).toMatchObject({ frequency: 2, periodUnit: 'd' });
        expect(warnings.join(' ')).not.toContain('BID');
    });

    it('omits inactive allergies and blank lines without warnings', () => {
        const input = fixture();
        input.prescriptions = [
            { medicine: '   ' },
            { medicine: 'Cetirizine', dosage: '10mg', route: 'Oral', frequency: '1-0-0', duration: '5 days' }
        ];
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

    it('omits incomplete prescription lines with the missing fields named', () => {
        const input = fixture();
        input.prescriptions = [
            { medicine: 'Cetirizine' },
            { medicine: 'Cetirizine', dosage: '10mg', route: 'Oral', frequency: '1-0-0', duration: '5 days' }
        ];
        const { bundle, warnings } = buildOpConsultRecord(input, '2026-09-20T10:00:00.000Z');
        const requests = bundle.entry.filter((e) => e.resource?.resourceType === 'MedicationRequest');
        expect(requests).toHaveLength(1);
        expect(warnings.join(' ')).toContain('dosage, route, frequency, duration');
    });

    it('carries reaction severity on allergy resources', () => {
        const { bundle } = buildOpConsultRecord(fixture(), '2026-09-20T10:00:00.000Z');
        const allergy: any = bundle.entry
            .find((e) => e.resource?.resourceType === 'AllergyIntolerance')?.resource;
        expect(allergy.reaction[0].severity).toBe('severe');
        expect(allergy.reaction[0].manifestation[0].text).toBe('Rash');
    });

    it('keeps every entry paired with its own reference', () => {
        const { bundle } = buildOpConsultRecord(fixture(), '2026-09-20T10:00:00.000Z');
        const byUrl = new Map(bundle.entry.map((e) => [e.fullUrl, e.resource?.resourceType]));
        expect(byUrl.get('Composition/record')).toBe('Composition');
        for (const [url, kind] of byUrl) {
            if (url === 'Composition/record') continue;
            expect(url.startsWith(`${kind}/`)).toBe(true);
        }
    });

    it('gives each section its own entries plus the findings narrative', () => {
        const { bundle } = buildOpConsultRecord(fixture(), '2026-09-20T10:00:00.000Z');
        const composition: any = bundle.entry[0].resource;
        const byTitle = new Map(composition.section.map((s: any) => [s.title, s]));
        // Every section entry must resolve to a real bundle entry.
        const known = new Set(bundle.entry.map((e) => e.fullUrl));
        for (const section of composition.section) {
            for (const entry of section.entry) {
                expect(known.has(entry.reference)).toBe(true);
            }
        }
        const prescription = byTitle.get('Prescription');
        const rxRefs = prescription.entry.map((e: any) => e.reference);
        expect(rxRefs.some((r: string) => r.startsWith('MedicationRequest/'))).toBe(true);
        expect(rxRefs.some((r: string) => r.startsWith('Patient/'))).toBe(true);
        const diagnosis = byTitle.get('Diagnosis');
        expect(diagnosis.text.div).toContain('Acute pharyngitis');
        const complaints = byTitle.get('Chief Complaints');
        expect(complaints.text.div).toContain('Sore throat');
    });

    it('defaults all timestamps to the encounter date', () => {
        const input = fixture();
        const { bundle } = buildOpConsultRecord(input);
        const composition: any = bundle.entry[0].resource;
        expect(composition.date).toBe(input.encounter.date);
        const request: any = bundle.entry
            .find((e) => e.resource?.resourceType === 'MedicationRequest')?.resource;
        expect(request.authoredOn).toBe(input.encounter.date);
    });

    it('normalizes database timestamps to FHIR dateTime', () => {
        const input = fixture();
        input.encounter.date = '2026-09-18 10:00:00';
        const { bundle } = buildOpConsultRecord(input);
        const composition: any = bundle.entry[0].resource;
        expect(composition.date).toBe('2026-09-18T10:00:00.000Z');
        const encounter: any = bundle.entry
            .find((e) => e.resource?.resourceType === 'Encounter')?.resource;
        expect(encounter.period.start).toBe('2026-09-18T10:00:00.000Z');
    });

    it('escapes clinical text inside namespace-qualified narrative', () => {
        const input = fixture();
        input.encounter.symptoms = 'nausea & vomiting <severe>';
        const { bundle } = buildOpConsultRecord(input, '2026-09-20T10:00:00.000Z');
        const composition: any = bundle.entry[0].resource;
        const complaints = composition.section.find((s: any) => s.title === 'Chief Complaints');
        expect(complaints.text.div).toContain('xmlns="http://www.w3.org/1999/xhtml"');
        expect(complaints.text.div).toContain('nausea &amp; vomiting &lt;severe&gt;');
        expect(complaints.text.div).not.toContain('<severe>');
    });

    it('parses durations into real quantities', () => {
        const { bundle } = buildOpConsultRecord(fixture(), '2026-09-20T10:00:00.000Z');
        const request: any = bundle.entry
            .find((e) => e.resource?.resourceType === 'MedicationRequest')?.resource;
        expect(request.dispenseRequest.expectedSupplyDuration).toMatchObject({ value: 3, unit: 'days' });
    });

    it('keeps unparseable durations as text instead of losing them', () => {
        const input = fixture();
        input.prescriptions = [
            { medicine: 'Amoxicillin 500mg', dosage: '500mg', route: 'Oral', frequency: '1-0-1', duration: 'until review' }
        ];
        const { bundle, warnings } = buildOpConsultRecord(input, '2026-09-20T10:00:00.000Z');
        const request: any = bundle.entry
            .find((e) => e.resource?.resourceType === 'MedicationRequest')?.resource;
        expect(request.dispenseRequest).toBeUndefined();
        expect(request.dosageInstruction[0].text).toContain('for until review');
        expect(warnings.join(' ')).toContain('until review');
    });

    it('preserves nonterminal condition statuses', () => {
        const input = fixture();
        input.conditions = [{ name: 'Asthma', status: 'remission' }];
        const { bundle } = buildOpConsultRecord(input, '2026-09-20T10:00:00.000Z');
        const condition: any = bundle.entry
            .find((e) => e.resource?.resourceType === 'Condition')?.resource;
        expect(condition.clinicalStatus.coding[0].code).toBe('remission');
    });

    it('preserves timezone offsets instead of shifting them to UTC midnight math', () => {
        const input = fixture();
        input.encounter.date = '2026-09-20T10:00:00+05:30';
        const { bundle } = buildOpConsultRecord(input);
        const composition: any = bundle.entry[0].resource;
        expect(composition.date).toBe('2026-09-20T04:30:00.000Z');
    });

    it('maps Other gender to other, not unknown', () => {
        const input = fixture();
        input.patient.gender = 'Other';
        const { bundle } = buildOpConsultRecord(input, '2026-09-20T10:00:00.000Z');
        const patient: any = bundle.entry
            .find((e) => e.resource?.resourceType === 'Patient')?.resource;
        expect(patient.gender).toBe('other');
    });

    it('identifies document bundles deterministically', () => {
        const { bundle } = buildOpConsultRecord(fixture(), '2026-09-20T10:00:00.000Z');
        expect(bundle.identifier?.system).toBeTruthy();
        expect(bundle.identifier?.value).toContain('op-consult-7');
    });

    it('carries registry identifiers when configured', () => {
        const input = fixture();
        input.clinic.registryId = 'HFR-12345';
        input.practitioner.registryId = 'HPR-67890';
        const { bundle } = buildOpConsultRecord(input, '2026-09-20T10:00:00.000Z');
        const organization: any = bundle.entry
            .find((e) => e.resource?.resourceType === 'Organization')?.resource;
        expect(organization.identifier).toEqual(
            expect.arrayContaining([expect.objectContaining({ value: 'HFR-12345' })]));
        const practitioner: any = bundle.entry
            .find((e) => e.resource?.resourceType === 'Practitioner')?.resource;
        expect(practitioner.identifier).toEqual(
            expect.arrayContaining([expect.objectContaining({ value: 'HPR-67890' })]));
    });

    it('omits registry identifiers when unconfigured', () => {
        const { bundle } = buildOpConsultRecord(fixture(), '2026-09-20T10:00:00.000Z');
        const organization: any = bundle.entry
            .find((e) => e.resource?.resourceType === 'Organization')?.resource;
        expect(organization.identifier).toBeUndefined();
    });

    it('identifies the encounter with its care context reference', () => {
        const input = fixture();
        (input.encounter as any).careContextRef = 'OP-2026-0042';
        const { bundle } = buildOpConsultRecord(input, '2026-09-20T10:00:00.000Z');
        const encounter: any = bundle.entry
            .find((e) => e.resource?.resourceType === 'Encounter')?.resource;
        expect(encounter.identifier).toEqual(
            expect.arrayContaining([expect.objectContaining({ value: 'OP-2026-0042' })]));
    });

    it('builds coded IPS sections instead of the OPConsult layout', () => {
        const { bundle } = buildIpsDocument(fixture(), '2026-09-20T10:00:00.000Z');
        const composition: any = bundle.entry[0].resource;
        const byTitle = new Map(composition.section.map((s: any) => [s.title, s]));
        expect([...byTitle.keys()]).toEqual([
            'Medication Summary', 'Allergies and Intolerances', 'Active Problems', 'Results'
        ]);
        expect(byTitle.get('Medication Summary').code.coding[0].code).toBe('10160-0');
        expect(byTitle.get('Allergies and Intolerances').code.coding[0].code).toBe('48765-2');
        const meds = byTitle.get('Medication Summary');
        expect(meds.entry.every((e: any) => e.reference.startsWith('MedicationRequest/') || e.reference.startsWith('Patient/') || e.reference.startsWith('Practitioner/') || e.reference.startsWith('Encounter/'))).toBe(true);
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
