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
            'Chief complaints', 'Physical examination', 'Allergies', 'Medical history', 'Medications'
        ]);
        expect(composition.type.coding[0]).toMatchObject({ system: 'http://snomed.info/sct', code: '371530004' });
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
        expect(codes).toEqual(expect.arrayContaining(['85354-9', '8867-4', '8310-5', '2708-6', '29463-7', '8302-2']));
        const bp = observations.find((o) => o.code.coding[0].code === '85354-9');
        expect(bp.component.map((c: any) => [c.code.coding[0].code, c.valueQuantity.value, c.valueQuantity.code]))
            .toEqual([['8480-6', 120, 'mm[Hg]'], ['8462-4', 80, 'mm[Hg]']]);
        const pulse = observations.find((o) => o.code.coding[0].code === '8867-4');
        expect(pulse).toMatchObject({
            category: [{ coding: [{ code: 'vital-signs' }] }],
            effectiveDateTime: '2026-09-20T10:00:00.000Z',
            valueQuantity: { value: 72, system: 'http://unitsofmeasure.org', code: '/min' }
        });
        const requests: any[] = bundle.entry
            .filter((e) => e.resource?.resourceType === 'MedicationRequest')
            .map((e) => e.resource);
        expect(requests).toHaveLength(2);
        expect(requests[0].dosageInstruction[0].timing.repeat).toMatchObject({ frequency: 2, periodUnit: 'd' });
        const practitionerUrl = bundle.entry.find((e) => e.resource?.resourceType === 'Practitioner')?.fullUrl;
        expect(requests[0].requester).toMatchObject({ reference: practitionerUrl });
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

    it('addresses every entry by a stable urn:uuid that all references use', () => {
        const { bundle } = buildOpConsultRecord(fixture(), '2026-09-20T10:00:00.000Z');
        const urls = bundle.entry.map((e) => e.fullUrl as string);
        expect(urls.every((u) => /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(u))).toBe(true);
        expect(new Set(urls).size).toBe(urls.length);
        expect(bundle.entry[0].resource?.resourceType).toBe('Composition');
        const references = JSON.stringify(bundle).match(/"reference":"[^"]*"/g) || [];
        expect(references.length).toBeGreaterThan(0);
        for (const ref of references) expect(urls).toContain(ref.slice(13, -1));
        // Same record, same addresses.
        const again = buildOpConsultRecord(fixture(), '2026-09-20T10:00:00.000Z').bundle;
        expect(again.entry.map((e) => e.fullUrl)).toEqual(urls);
    });

    it('declares the NRCES profiles on the bundle and every resource', () => {
        const { bundle } = buildOpConsultRecord(fixture(), '2026-09-20T10:00:00.000Z');
        const nrces = 'https://nrces.in/ndhm/fhir/r4/StructureDefinition/';
        expect(bundle.meta).toMatchObject({ versionId: '1', profile: [`${nrces}DocumentBundle`] });
        const profiles = bundle.entry.map((e) => [e.resource?.resourceType, (e.resource as any).meta?.profile?.[0]]);
        expect(profiles).toEqual(expect.arrayContaining([
            ['Composition', `${nrces}OPConsultRecord`],
            ['Patient', `${nrces}Patient`],
            ['Observation', `${nrces}ObservationVitalSigns`],
            ['MedicationRequest', `${nrces}MedicationRequest`]
        ]));
        expect(profiles.every(([, profile]) => typeof profile === 'string')).toBe(true);
    });

    it('gives each section its own entries plus the findings narrative', () => {
        const { bundle } = buildOpConsultRecord(fixture(), '2026-09-20T10:00:00.000Z');
        const composition: any = bundle.entry[0].resource;
        const byTitle = new Map(composition.section.map((s: any) => [s.title, s]));
        // Every section entry must resolve to a real bundle entry.
        const known = new Set(bundle.entry.map((e) => e.fullUrl));
        const kindOf = new Map(bundle.entry.map((e) => [e.fullUrl, e.resource?.resourceType]));
        for (const section of composition.section) {
            for (const entry of section.entry || []) {
                expect(known.has(entry.reference)).toBe(true);
            }
        }
        // Each NRCES slice holds only the resource type it allows.
        const kinds = (title: string) => [...new Set((byTitle.get(title) as any).entry.map((e: any) => kindOf.get(e.reference)))];
        expect(kinds('Medications')).toEqual(['MedicationRequest']);
        expect(kinds('Physical examination')).toEqual(['Observation']);
        expect(kinds('Allergies')).toEqual(['AllergyIntolerance']);
        expect(kinds('Medical history')).toEqual(['Condition']);
        const complaints: any = byTitle.get('Chief complaints');
        expect(complaints.entry).toBeUndefined();
        expect(complaints.text.div).toContain('Sore throat');
        expect(complaints.text.div).toContain('Acute pharyngitis');
        expect((byTitle.get('Physical examination') as any).text.div).toContain('Throat congested');
    });

    it('drops empty sections and keeps chief complaints when nothing was recorded', () => {
        const input = fixture();
        input.prescriptions = [];
        input.allergies = [];
        input.conditions = [];
        input.vitals = null;
        input.encounter = { id: 7, date: '2026-09-20T10:00:00.000Z' };
        const { bundle } = buildOpConsultRecord(input, '2026-09-20T10:00:00.000Z');
        const composition: any = bundle.entry[0].resource;
        expect(composition.section).toHaveLength(1);
        expect(composition.section[0].title).toBe('Chief complaints');
        expect(composition.section[0].text.div).toContain('No findings recorded.');
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
        const complaints = composition.section.find((s: any) => s.title === 'Chief complaints');
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

    it('exports the validity window for finite courses', () => {
        const input = fixture();
        input.prescriptions = [
            { medicine: 'Amoxicillin 500mg', dosage: '500mg', route: 'Oral', frequency: '1-0-1', duration: '1 month' }
        ];
        const today = new Date().toISOString();
        const start = today.slice(0, 10);
        const expected = new Date(Date.UTC(Number(start.slice(0, 4)), Number(start.slice(5, 7)) - 1, Number(start.slice(8, 10))));
        expected.setUTCDate(expected.getUTCDate() + 30);
        const { bundle } = buildOpConsultRecord(input, today);
        const request: any = bundle.entry
            .find((e) => e.resource?.resourceType === 'MedicationRequest')?.resource;
        expect(request.dispenseRequest.validityPeriod).toMatchObject({ start, end: expected.toISOString().slice(0, 10) });
        expect(request.validityPeriod).toBeUndefined();
        expect(request.status).toBe('active');
    });

    it('exports long-finished courses as completed instead of active', () => {
        const input = fixture();
        input.prescriptions = [
            { medicine: 'Amoxicillin 500mg', dosage: '500mg', route: 'Oral', frequency: '1-0-1', duration: '3 days' }
        ];
        const { bundle } = buildOpConsultRecord(input, '2020-01-01T10:00:00.000Z');
        const request: any = bundle.entry
            .find((e) => e.resource?.resourceType === 'MedicationRequest')?.resource;
        expect(request.dispenseRequest.validityPeriod).toMatchObject({ start: '2020-01-01', end: '2020-01-04' });
        expect(request.status).toBe('completed');
    });

    it('leaves open-ended courses active with no validity window', () => {
        const input = fixture();
        input.prescriptions = [
            { medicine: 'Amoxicillin 500mg', dosage: '500mg', route: 'Oral', frequency: '1-0-1', duration: 'until review' }
        ];
        const { bundle } = buildOpConsultRecord(input, '2026-09-20T10:00:00.000Z');
        const request: any = bundle.entry
            .find((e) => e.resource?.resourceType === 'MedicationRequest')?.resource;
        expect(request.dispenseRequest?.validityPeriod).toBeUndefined();
        expect(request.status).toBe('active');
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

    it('falls back to local identifiers when registry IDs are unconfigured', () => {
        const input = fixture();
        delete (input.practitioner as any).licenseNumber;
        const { bundle } = buildOpConsultRecord(input, '2026-09-20T10:00:00.000Z');
        const find = (kind: string): any => bundle.entry.find((e) => e.resource?.resourceType === kind)?.resource;
        expect(find('Organization').identifier).toEqual([expect.objectContaining({ system: 'https://nalamdesk.app/fhir/facility', value: 'Nalam Clinic' })]);
        expect(find('Practitioner').identifier).toEqual([expect.objectContaining({ system: 'https://nalamdesk.app/fhir/practitioner', value: '10' })]);
        // Every identifier is typed, as the NRCES profiles require.
        for (const kind of ['Organization', 'Practitioner', 'Patient']) {
            for (const id of find(kind).identifier) expect(id.type.coding[0].code).toBeTruthy();
        }
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
        const kindOf = new Map(bundle.entry.map((e) => [e.fullUrl, e.resource?.resourceType]));
        expect(meds.entry.every((e: any) => ['MedicationRequest', 'Patient', 'Practitioner', 'Encounter'].includes(kindOf.get(e.reference) as string))).toBe(true);
        expect(meds.entry.some((e: any) => kindOf.get(e.reference) === 'MedicationRequest')).toBe(true);
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
