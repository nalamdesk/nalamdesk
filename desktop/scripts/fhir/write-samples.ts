/**
 * Writes the FHIR bundles NalamDesk sends to ABDM, built from fixed sample
 * encounters, so the HL7 validator can check them against the NRCES ABDM
 * profiles in CI (.github/workflows/fhir-validation.yml).
 *
 *   npx tsx scripts/fhir/write-samples.ts <out dir>
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildOpConsultRecord, type EncounterExportInput } from '../../src/shared/fhir/serializer';

const AT = '2026-09-20T10:00:00.000Z';

const full: EncounterExportInput = {
    patient: {
        id: 1, name: 'Asha Worker', mobile: '9876543210', age: 34,
        gender: 'Female', address: '12 Main Road', abhaAddress: 'asha@sbx'
    },
    practitioner: { id: 10, name: 'Dr. Smith', licenseNumber: 'MED-12345', specialty: 'General', registryId: '71-1234-5678-9012' },
    clinic: { name: 'Nalam Clinic', address: 'Chennai', registryId: 'IN3310000001' },
    encounter: {
        id: 7, date: AT, diagnosis: 'Acute pharyngitis', diagnosisType: 'Provisional',
        symptoms: 'Sore throat for 2 days', examinationNotes: 'Throat congested', careContextRef: 'visit-7'
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

// The smallest visit the desk can finish: no prescriptions, vitals or history.
const minimal: EncounterExportInput = {
    patient: { id: 2, name: 'Ravi Kumar', gender: 'Male', age: 51 },
    practitioner: { id: 11, name: 'Dr. Meena' },
    clinic: { name: 'Nalam Clinic' },
    encounter: { id: 8, date: AT, symptoms: 'Follow-up' }
};

const out = process.argv[2];
if (!out) {
    process.stderr.write('usage: write-samples.ts <out dir>\n');
    process.exit(2);
}
mkdirSync(out, { recursive: true });
for (const [name, input] of Object.entries({ full, minimal })) {
    const { bundle } = buildOpConsultRecord(input, AT);
    writeFileSync(join(out, `op-consult-${name}.json`), `${JSON.stringify(bundle, null, 2)}\n`);
}
process.stdout.write(`Wrote 2 OPConsultRecord bundles to ${out}\n`);
