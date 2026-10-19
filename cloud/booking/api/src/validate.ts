// Input checks for the public and clinic routes. Patient fields never reach
// these: the browser sends only a sealed envelope, which is checked for shape
// and size, never opened.

/** Crockford base32, 12 characters (60 bits). The browser picks it so it can be sealed inside the request. */
export const BOOKING_REF = /^[0-9A-HJKMNP-TV-Z]{12}$/;
export const CLINIC_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
/** Lowercase hex SHA-256 of the normalised phone number, computed in the browser. */
export const PHONE_DIGEST = /^[0-9a-f]{64}$/;

export const LIMITS = {
    sealedChars: 8 * 1024,
    ciphertextBytes: 4 * 1024,
    bookBodyBytes: 12 * 1024,
    clinicBodyBytes: 64 * 1024,
    textField: 80,
    publishDays: 14,
    slotsPerDay: 96
};

function base64Bytes(value: unknown): number {
    if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return -1;
    return Buffer.from(value, 'base64').length;
}

/**
 * The mailbox envelope from cloud/relay/src/seal.ts, base64 of
 * `{v, epk, salt, iv, ct, tag}`. Only lengths are checked.
 */
export function isSealedEnvelope(sealed: unknown): sealed is string {
    if (typeof sealed !== 'string' || sealed.length === 0 || sealed.length > LIMITS.sealedChars) return false;
    let envelope: Record<string, unknown>;
    try {
        envelope = JSON.parse(Buffer.from(sealed, 'base64').toString('utf8'));
    } catch {
        return false;
    }
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return false;
    if (envelope.v !== 1) return false;
    const ct = base64Bytes(envelope.ct);
    return base64Bytes(envelope.epk) === 32
        && base64Bytes(envelope.salt) === 16
        && base64Bytes(envelope.iv) === 12
        && base64Bytes(envelope.tag) === 16
        && ct > 0 && ct <= LIMITS.ciphertextBytes;
}

export function isX25519PublicKey(value: unknown): value is string {
    return base64Bytes(value) === 32;
}

export function isCalendarDate(value: unknown): value is string {
    if (typeof value !== 'string' || !DATE.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function cleanText(value: unknown, max = LIMITS.textField): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.replace(/\s+/g, ' ').trim();
    return trimmed.length > 0 && trimmed.length <= max ? trimmed : null;
}

export function slotIdOf(date: string, time: string): string {
    return `${date}T${time}`;
}

export function addDays(date: string, days: number): string {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
}
