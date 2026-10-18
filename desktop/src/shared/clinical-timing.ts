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

/**
 * Parses a free-text course duration into whole days (KB-3). Known finite
 * courses (`3 days`, `1 week`, `2 weeks`, `1 month`, `3-4 days` -> 4,
 * single-dose orders -> 1) return a day count; chronic/open-ended text
 * (`until review`, `long term`, `sos`, empty) returns null so callers keep
 * the course open instead of inventing an end date.
 */
export function parseDurationDays(raw: unknown): number | null {
    const text = String(raw || '').trim().replace(/\s+/g, ' ').toLowerCase();
    if (!text) return null;
    // Single-dose orders complete the same day.
    if (/^(single dose|single-dose|one time|once|stat|now)$/.test(text)) return 1;
    // Open-ended courses never expire on their own.
    if (/until review|till review|chronic|long term|continue|ongoing|lifetime|sos|prn|as needed|when required/.test(text)) return null;
    // Ranges (`3-4 days`) resolve to the upper bound: a course is over when
    // the longest stated run ends, never before. A unit is required so
    // schedules like `1-0-1` are never misread as durations.
    const range = /(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*(d|day|days|w|week|weeks|m|month|months)/.exec(text);
    if (range) {
        const days = durationToDays(Number(range[2]), range[3]);
        return days == null ? null : Math.max(1, Math.round(days));
    }
    const match = /(\d+(?:\.\d+)?)\s*(d|day|days|w|week|weeks|m|month|months)?/.exec(text);
    if (!match || !match[2]) return null;
    const days = durationToDays(Number(match[1]), match[2]);
    return days == null ? null : Math.max(1, Math.round(days));
}

function durationToDays(value: number, unit: string): number | null {
    if (!Number.isFinite(value) || value <= 0) return null;
    switch (unit) {
        case 'd': case 'day': case 'days': return value;
        case 'w': case 'week': case 'weeks': return value * 7;
        case 'm': case 'month': case 'months': return value * 30;
        default: return null;
    }
}

/**
 * Course end as YYYY-MM-DD for a start date plus a duration line (KB-3).
 * Returns null for open-ended durations or unparseable starts, so callers
 * leave the course open instead of inventing an end.
 */
export function durationEndDate(startISO: unknown, durationText: unknown): string | null {
    const days = parseDurationDays(durationText);
    if (days == null) return null;
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(startISO || ''));
    if (!match) return null;
    const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
}
