/**
 * Flexible patient identifier systems (issue #55).
 *
 * Charts carry identifiers from several numbering authorities at once:
 * the clinic MRN, India's ABHA number / ABHA address, insurance member
 * ids, and free-form others. Validation lives here (shared main +
 * renderer) so both sides reject the same malformed values.
 */

/** Identifier systems the app knows how to validate. */
export const IDENTIFIER_SYSTEMS = [
    'mrn',
    'abha-number',
    'abha-address',
    'insurance',
    'other'
] as const;

export type IdentifierSystem = (typeof IDENTIFIER_SYSTEMS)[number];

export function isIdentifierSystem(value: unknown): value is IdentifierSystem {
    return typeof value === 'string'
        && (IDENTIFIER_SYSTEMS as readonly string[]).includes(value);
}

/**
 * Canonical ABHA number form: 14 digits grouped XX-XXXX-XXXX-XXXX.
 * Accepts bare digits, spaces, or hyphens on input.
 */
export function normalizeAbhaNumber(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const digits = raw.replace(/\D/g, '');
    if (digits.length !== 14) return null;
    return `${digits.slice(0, 2)}-${digits.slice(2, 6)}-${digits.slice(6, 10)}-${digits.slice(10)}`;
}

/** Luhn-10 check over a digit string. */
export function luhnCheck(digits: string): boolean {
    let sum = 0;
    let double = false;
    for (let i = digits.length - 1; i >= 0; i--) {
        let d = digits.charCodeAt(i) - 48;
        if (d < 0 || d > 9) return false;
        if (double) {
            d *= 2;
            if (d > 9) d -= 9;
        }
        sum += d;
        double = !double;
    }
    return digits.length > 0 && sum % 10 === 0;
}

/**
 * Validate an ABHA number: shape plus Luhn checksum.
 * Returns the canonical form, or throws with a human-readable reason.
 */
export function validateAbhaNumber(raw: unknown): string {
    const canonical = normalizeAbhaNumber(raw);
    if (!canonical) {
        throw new Error('ABHA number must be 14 digits (XX-XXXX-XXXX-XXXX).');
    }
    if (!luhnCheck(canonical.replace(/\D/g, ''))) {
        throw new Error('ABHA number checksum is invalid.');
    }
    return canonical;
}

/** ABHA address shape: local-part@abdm (case-insensitive). */
export function isAbhaAddressShape(value: unknown): boolean {
    return typeof value === 'string'
        && /^[a-z0-9._-]{3,}@abdm$/i.test(value.trim());
}

/**
 * Validate one identifier row before it touches the database.
 * Returns the canonical value to store.
 */
export function validateIdentifier(system: unknown, value: unknown): string {
    if (!isIdentifierSystem(system)) {
        throw new Error(`Unknown identifier system: ${String(system)}.`);
    }
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text) throw new Error('Identifier value is required.');
    if (system === 'abha-number') return validateAbhaNumber(text);
    if (system === 'abha-address') {
        if (!isAbhaAddressShape(text)) {
            throw new Error('ABHA address must look like name@abdm.');
        }
        return text.toLowerCase();
    }
    if (system === 'mrn') {
        if (!/^[A-Za-z0-9]+-\d{4,}$/.test(text)) {
            throw new Error('MRN must look like ND-100001 (prefix, hyphen, digits).');
        }
        return text;
    }
    if (text.length > 64) throw new Error('Identifier value is too long.');
    return text;
}
