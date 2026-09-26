/**
 * Inbound FHIR parsing (M3 HIU): outside bundles become a display view model
 * for the External Records tab. Deliberately tolerant — foreign senders use
 * profiles and code systems we do not know, so every resource degrades to
 * display text and unknown shapes become warnings, never failures.
 */

export interface ParsedDiagnosis {
    text: string;
    code?: string;
    status?: string;
}

export interface ParsedMedication {
    name: string;
    dosage?: string;
    frequency?: string;
    status?: string;
}

export interface ParsedObservation {
    text: string;
    value?: string;
}

export interface ParsedAllergy {
    substance: string;
    criticality?: string;
}

export interface ParsedExternalRecord {
    title: string;
    diagnoses: ParsedDiagnosis[];
    medications: ParsedMedication[];
    observations: ParsedObservation[];
    allergies: ParsedAllergy[];
    warnings: string[];
}

function codeText(code: any): { text: string; code?: string } {
    if (!code) return { text: '' };
    if (typeof code.text === 'string' && code.text.trim()) {
        const coding = Array.isArray(code.coding) ? code.coding[0] : null;
        return {
            text: code.text.trim(),
            code: coding?.code ? String(coding.code) : undefined
        };
    }
    const coding = Array.isArray(code.coding) ? code.coding.find((c: any) => c?.display) || code.coding[0] : null;
    if (coding) {
        return {
            text: String(coding.display || coding.code || '').trim(),
            code: coding.code ? String(coding.code) : undefined
        };
    }
    return { text: '' };
}

function dosageText(dosage: any): { dosage?: string; frequency?: string } {
    if (!dosage || typeof dosage !== 'object') return {};
    const out: { dosage?: string; frequency?: string } = {};
    if (typeof dosage.text === 'string' && dosage.text.trim()) {
        const parts = dosage.text.split(',').map((s: string) => s.trim()).filter(Boolean);
        out.dosage = parts[0] || undefined;
        out.frequency = parts.slice(1).join(', ') || undefined;
        return out;
    }
    const rate = dosage.doseAndRate?.[0]?.doseQuantity;
    if (rate?.value != null) out.dosage = `${rate.value}${rate.unit ? ` ${rate.unit}` : ''}`;
    if (typeof dosage.timing?.code?.text === 'string' && dosage.timing.code.text.trim()) {
        out.frequency = dosage.timing.code.text.trim();
    }
    return out;
}

function observationValue(resource: any): string {
    const q = resource?.valueQuantity;
    if (q && q.value != null) return `${q.value}${q.unit ? ` ${q.unit}` : ''}`;
    if (resource?.valueCodeableConcept) {
        const { text, code } = codeText(resource.valueCodeableConcept);
        if (text) return code ? `${text} (${code})` : text;
    }
    for (const key of ['valueString', 'valueDateTime']) {
        const value = resource?.[key];
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
}

/** Parses one clinical document Bundle into the External Records view model. */
export function parseClinicalBundle(input: string | unknown): ParsedExternalRecord {
    const empty: ParsedExternalRecord = {
        title: 'Outside record', diagnoses: [], medications: [],
        observations: [], allergies: [], warnings: []
    };
    let bundle: any;
    if (typeof input === 'string') {
        try {
            bundle = JSON.parse(input);
        } catch {
            throw new Error('Record bundle is not valid JSON.');
        }
    } else {
        bundle = input;
    }
    if (!bundle || typeof bundle !== 'object' || !Array.isArray(bundle.entry)) {
        throw new Error('Record bundle has no entries.');
    }
    const parsed: ParsedExternalRecord = { ...empty, warnings: [] };
    for (const entry of bundle.entry) {
        const resource = entry?.resource;
        if (!resource || typeof resource.resourceType !== 'string') {
            parsed.warnings.push('Skipped an entry without a resource type.');
            continue;
        }
        try {
            switch (resource.resourceType) {
                case 'Composition': {
                    if (typeof resource.title === 'string' && resource.title.trim()) {
                        parsed.title = resource.title.trim();
                    }
                    break;
                }
                case 'Condition': {
                    const { text, code } = codeText(resource.code);
                    if (!text) {
                        parsed.warnings.push('Skipped a condition without a readable code.');
                        break;
                    }
                    parsed.diagnoses.push({
                        text,
                        code,
                        status: typeof resource.clinicalStatus === 'string'
                            ? resource.clinicalStatus
                            : resource.clinicalStatus?.coding?.[0]?.code
                    });
                    break;
                }
                case 'MedicationRequest': {
                    const med = codeText(resource.medicationCodeableConcept);
                    const name = med.text || (typeof resource.medicationReference?.display === 'string'
                        ? resource.medicationReference.display.trim() : '');
                    if (!name) {
                        parsed.warnings.push('Skipped a prescription without a readable medicine.');
                        break;
                    }
                    parsed.medications.push({
                        name,
                        ...dosageText(resource.dosageInstruction?.[0]),
                        status: typeof resource.status === 'string' ? resource.status : undefined
                    });
                    break;
                }
                case 'Observation': {
                    const { text } = codeText(resource.code);
                    if (!text && !observationValue(resource)) {
                        parsed.warnings.push('Skipped an observation without readable content.');
                        break;
                    }
                    parsed.observations.push({ text: text || 'Observation', value: observationValue(resource) || undefined });
                    break;
                }
                case 'AllergyIntolerance': {
                    const { text } = codeText(resource.code);
                    if (!text) {
                        parsed.warnings.push('Skipped an allergy without a readable substance.');
                        break;
                    }
                    parsed.allergies.push({
                        substance: text,
                        criticality: typeof resource.criticality === 'string' ? resource.criticality : undefined
                    });
                    break;
                }
                default:
                    parsed.warnings.push(`Skipped unsupported resource: ${resource.resourceType}.`);
            }
        } catch {
            parsed.warnings.push(`Skipped an unreadable ${resource.resourceType} entry.`);
        }
    }
    return parsed;
}
