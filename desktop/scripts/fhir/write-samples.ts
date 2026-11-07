/**
 * Writes the FHIR bundles NalamDesk sends to ABDM, built from the fixed
 * sample visits, to desktop/build/fhir-samples, so the HL7 validator can
 * check them against the NRCES ABDM profiles in CI
 * (.github/workflows/fhir-validation.yml).
 *
 *   npx tsx scripts/fhir/write-samples.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildOpConsultRecord } from '../../src/shared/fhir/serializer';
import { minimalEncounter, sampleEncounter } from '../../src/shared/fhir/sample-encounters';

const AT = '2026-09-20T10:00:00.000Z';
const OUT = join(__dirname, '..', '..', 'build', 'fhir-samples');

// The full visit as a registered facility sends it: HFR, HPR and care context.
const registered = sampleEncounter();
registered.clinic.registryId = 'IN3310000001';
registered.practitioner.registryId = '71-1234-5678-9012';
registered.encounter.diagnosisType = 'Provisional';
registered.encounter.careContextRef = 'visit-7';

const samples = { full: sampleEncounter(), registered, minimal: minimalEncounter() };
mkdirSync(OUT, { recursive: true });
for (const [name, input] of Object.entries(samples)) {
    writeFileSync(join(OUT, `op-consult-${name}.json`), `${JSON.stringify(buildOpConsultRecord(input, AT).bundle, null, 2)}\n`);
}
process.stdout.write(`Wrote ${Object.keys(samples).length} OPConsultRecord bundles to ${OUT}\n`);
