/**
 * Fixed sample visits for the FHIR serializer: the unit tests build from
 * them, and the CI FHIR check (scripts/fhir/write-samples.ts) validates the
 * bundles made from them against the NRCES profiles. No real patient data.
 */
import type { EncounterExportInput } from './serializer';

/** A full visit: complaints, diagnosis, vitals, prescriptions, history. */
export function sampleEncounter(): EncounterExportInput {
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

/** The smallest visit the desk can finish: no prescriptions, vitals or history. */
export function minimalEncounter(): EncounterExportInput {
    return {
        patient: { id: 2, name: 'Ravi Kumar', gender: 'Male', age: 51 },
        practitioner: { id: 11, name: 'Dr. Meena' },
        clinic: { name: 'Nalam Clinic' },
        encounter: { id: 8, date: '2026-09-20T10:00:00.000Z', symptoms: 'Follow-up' }
    };
}
