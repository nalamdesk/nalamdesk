/**
 * Clinical timing parser (issue #52).
 *
 * Bidirectional bridge between Indian shorthand (`1-0-1`, `SOS`) and
 * Latin SIG (`BID`, `PRN`). Parsing is loss-tolerant: known inputs fold
 * to one canonical form, unknown text passes through unchanged so a
 * schedule is never lost (Zero-Roadblock).
 */

/** Canonical schedule values stored in visits and presets. */
export const CANONICAL_FREQUENCIES = [
    '1-0-1', '1-1-1', '1-0-0', '0-0-1', '0-1-0', 'SOS', 'STAT'
] as const;

export type CanonicalFrequency = (typeof CANONICAL_FREQUENCIES)[number];

/** Every accepted spelling per canonical form (Latin, variants, shorthand). */
const FREQUENCY_ALIASES: Record<string, string[]> = {
    '1-0-1': ['1-0-1', 'BID', 'BD', 'TWICE DAILY', 'TWICE A DAY', '1-0-1 (BID)', 'BID (1-0-1)'],
    '1-1-1': ['1-1-1', 'TID', 'THRICE DAILY', 'THREE TIMES DAILY', '1-1-1 (TID)', 'TID (1-1-1)'],
    '1-0-0': ['1-0-0', 'OD', 'QD', 'ONCE DAILY', 'ONCE A DAY', '1-0-0 (OD)', 'OD (1-0-0)'],
    '0-0-1': ['0-0-1', 'HS', 'QHS', 'AT BEDTIME', 'NIGHT ONLY', '0-0-1 (HS)', 'HS (0-0-1)'],
    '0-1-0': ['0-1-0', 'AFTERNOON', 'MIDDAY', '0-1-0 (AFTERNOON)'],
    'SOS': ['SOS', 'PRN', 'AS NEEDED', 'WHEN REQUIRED', 'SOS (PRN)', 'PRN (SOS)'],
    'STAT': ['STAT', 'IMMEDIATE', 'AT ONCE', 'NOW']
};

const ALIAS_TO_CANONICAL: Map<string, string> = new Map();
for (const [canonical, aliases] of Object.entries(FREQUENCY_ALIASES)) {
    for (const alias of aliases) ALIAS_TO_CANONICAL.set(alias, canonical);
}

/** Normalize typed input to the canonical form. Unknown text passes through. */
export function parseFrequency(raw: unknown): string {
    const text = String(raw || '').trim().replace(/\s+/g, ' ').toUpperCase();
    if (!text) return '';
    return ALIAS_TO_CANONICAL.get(text) || String(raw).trim();
}

/** True when the input resolves to a known schedule. */
export function isKnownFrequency(raw: unknown): boolean {
    const text = String(raw || '').trim().replace(/\s+/g, ' ').toUpperCase();
    return text !== '' && ALIAS_TO_CANONICAL.has(text);
}

/** Latin label for a canonical form (International lens). */
const FREQUENCY_LATIN: Record<string, string> = {
    '1-0-1': 'BID',
    '1-1-1': 'TID',
    '1-0-0': 'OD',
    '0-0-1': 'HS',
    '0-1-0': 'QD (afternoon)',
    'SOS': 'PRN',
    'STAT': 'STAT'
};

export function frequencyLatin(canonical: string): string {
    return FREQUENCY_LATIN[String(canonical || '').trim()] || String(canonical || '').trim();
}

/** All accepted spellings (for placeholders, hints, and tests). */
export function acceptedFrequencySpellings(): string[] {
    return [...ALIAS_TO_CANONICAL.keys()];
}
