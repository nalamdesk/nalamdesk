// Pure helpers for a booking request: the reference, phone handling and the
// payload that gets sealed. Nothing here talks to the network.

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const REF_PATTERN = /^[0-9A-HJKMNP-TV-Z]{12}$/;

/**
 * A 12-character reference (60 random bits). The browser picks it so it can
 * be sealed inside the request, letting the desktop match the request to its
 * status record without the server reading either.
 */
export function newReference(random: (bytes: Uint8Array) => Uint8Array = (b) => crypto.getRandomValues(b)): string {
    const bytes = random(new Uint8Array(12));
    let out = '';
    for (const byte of bytes) out += CROCKFORD[byte & 31];
    return out;
}

/** `7K3P9QXA2B4M` -> `7K3P-9QXA-2B4M`, for reading aloud over the phone. */
export function formatReference(ref: string): string {
    return ref.replace(/(.{4})(?=.)/g, '$1-');
}

/** Accepts what people paste: lowercase, dashes, spaces, and look-alike letters. */
export function parseReference(input: string): string | null {
    const ref = input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
    return REF_PATTERN.test(ref) ? ref : null;
}

/** Digits only, with an Indian +91 or trunk 0 dropped. Null unless 10 to 15 digits remain. */
export function normalisePhone(input: string): string | null {
    let digits = input.replace(/\D/g, '');
    if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
    else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
    return digits.length >= 10 && digits.length <= 15 ? digits : null;
}

const toHex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');

/**
 * SHA-256 of the normalised number, used only to enforce "two open requests
 * per phone per clinic". The server keys it with its own secret before
 * storing it, and never sees the number itself.
 */
export async function phoneDigest(normalisedPhone: string): Promise<string> {
    return toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`nalamdesk-booking-phone-v1|${normalisedPhone}`)));
}

export async function sha256Hex(text: string): Promise<string> {
    return toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

/** What the clinic's desktop reads after opening the envelope. Version 1. */
export interface BookingPayload {
    v: 1;
    ref: string;
    clinicId: string;
    slotId: string | null;
    slot: { date: string; time: string } | null;
    name: string;
    phone: string;
    reason: string;
    sentAt: string;
}

export const NAME_MAX = 80;
export const REASON_MAX = 300;
