/**
 * Practice Standards Profile (issue #51).
 *
 * One canonical record, two lenses. Storage never branches: vitals stay in
 * the units they were captured in, frequencies stay canonical, and this
 * module converts at display time. Export and print follow the clinic-wide
 * setting; an individual doctor may prefer the other input shorthand.
 */

export const STANDARDS_MODES = ['india_abdm', 'international'] as const;

export type StandardsMode = (typeof STANDARDS_MODES)[number];

export function isStandardsMode(value: unknown): value is StandardsMode {
    return value === 'india_abdm' || value === 'international';
}

/** Display temperature for a stored Celsius value. */
export function displayTemperature(celsius: number, mode: StandardsMode): { value: number; unit: string } {
    if (mode === 'international') {
        return { value: Math.round(celsius * 10) / 10, unit: '°C' };
    }
    return { value: Math.round((celsius * 9 / 5 + 32) * 10) / 10, unit: '°F' };
}

/** Canonical Celsius from a display-temperature entry. */
export function parseTemperature(value: number, unit: string): number {
    const unitNorm = String(unit || '').replace('°', '').trim().toUpperCase();
    if (unitNorm === 'F') return (value - 32) * 5 / 9;
    return value;
}

/** Display weight for stored kilograms. International clinics may use lb. */
export function displayWeight(kg: number, mode: StandardsMode, imperial = false): { value: number; unit: string } {
    if (mode === 'international' && imperial) {
        return { value: Math.round(kg * 2.20462 * 10) / 10, unit: 'lbs' };
    }
    return { value: Math.round(kg * 10) / 10, unit: 'kg' };
}

/** Canonical kilograms from a display-weight entry. */
export function parseWeight(value: number, unit: string): number {
    if (String(unit || '').trim().toLowerCase() === 'lbs') return value / 2.20462;
    return value;
}

/**
 * Frequency display per mode. Canonical values are the Indian shorthand
 * (`1-0-1`, `SOS`); International mode renders the Latin equivalent.
 * Unknown values pass through unchanged -- never lose a schedule.
 */
const FREQUENCY_LATIN: Record<string, string> = {
    '1-0-1': 'BID',
    '1-1-1': 'TID',
    '1-0-0': 'OD',
    '0-0-1': 'HS',
    '0-1-0': 'QD (afternoon)',
    'SOS': 'PRN',
    'STAT': 'STAT'
};

export function displayFrequency(canonical: string, mode: StandardsMode): string {
    const value = String(canonical || '').trim();
    if (mode === 'international') return FREQUENCY_LATIN[value] || value;
    return value;
}

/** Identity prompt order per mode: ABHA-first vs MRN-first. */
export function primaryIdentifierLabel(mode: StandardsMode): string {
    return mode === 'international' ? 'MRN / National ID' : 'ABHA Number';
}

/** Export target per mode. */
export function exportTarget(mode: StandardsMode): string {
    return mode === 'international' ? 'HL7 IPS' : 'ABDM NRCeS FHIR R4';
}
