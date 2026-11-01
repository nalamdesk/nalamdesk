// Join codes (#193): what an admin reads out to a computer joining a
// NalamDesk Server. A code carries two parts:
//
// - an 8-character one-time secret (40 bits) the server redeems once, within
//   minutes, under attempt limits;
// - the first 12 characters (60 bits) of the server certificate's SHA-256
//   fingerprint, so a client can pin a self-signed certificate on first
//   contact without trusting the network.
//
// Both parts use Crockford base32 so codes survive being read aloud or
// retyped: no I, L, O or U, and the decoder maps look-alikes back.
//
// Shared by the server and the clients; no Node-only imports.

export const JOIN_SECRET_LENGTH = 8;
export const JOIN_FINGERPRINT_LENGTH = 12;
const GROUP = 5;

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Crockford base32 of the bytes, most significant bit first, no padding. */
export function base32Encode(bytes: Uint8Array): string {
    let out = '';
    let buffer = 0;
    let bits = 0;
    for (const byte of bytes) {
        buffer = (buffer << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            out += ALPHABET[(buffer >>> (bits - 5)) & 31];
            bits -= 5;
        }
        buffer &= (1 << bits) - 1;
    }
    if (bits > 0) out += ALPHABET[(buffer << (5 - bits)) & 31];
    return out;
}

/** Upper-cases, drops separators and maps look-alike characters. */
export function normalizeJoinCode(input: string): string {
    return String(input ?? '')
        .toUpperCase()
        .replace(/[\s-]/g, '')
        .replace(/[IL]/g, '1')
        .replace(/O/g, '0');
}

function hexToBytes(hex: string): Uint8Array {
    const clean = hex.replace(/[^0-9a-fA-F]/g, '');
    const bytes = new Uint8Array(clean.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    return bytes;
}

/** The join-code form of a SHA-256 certificate fingerprint (hex, colons allowed). */
export function fingerprintPrefix(fingerprint256Hex: string): string {
    return base32Encode(hexToBytes(fingerprint256Hex)).slice(0, JOIN_FINGERPRINT_LENGTH);
}

/** Formats secret + fingerprint prefix as XXXXX-XXXXX-XXXXX-XXXXX. */
export function formatJoinCode(secret: string, fingerprint256Hex: string): string {
    const raw = normalizeJoinCode(secret) + fingerprintPrefix(fingerprint256Hex);
    const groups: string[] = [];
    for (let i = 0; i < raw.length; i += GROUP) groups.push(raw.slice(i, i + GROUP));
    return groups.join('-');
}

export interface ParsedJoinCode {
    secret: string;
    fingerprintPrefix: string;
}

/** Splits a typed code, or returns null when it is not a well-formed join code. */
export function parseJoinCode(input: string): ParsedJoinCode | null {
    const raw = normalizeJoinCode(input);
    if (raw.length !== JOIN_SECRET_LENGTH + JOIN_FINGERPRINT_LENGTH) return null;
    for (const ch of raw) if (!ALPHABET.includes(ch)) return null;
    return {
        secret: raw.slice(0, JOIN_SECRET_LENGTH),
        fingerprintPrefix: raw.slice(JOIN_SECRET_LENGTH)
    };
}

/** True when the certificate fingerprint the client saw matches the code. */
export function joinCodeMatchesFingerprint(input: string, fingerprint256Hex: string): boolean {
    const parsed = parseJoinCode(input);
    return !!parsed && parsed.fingerprintPrefix === fingerprintPrefix(fingerprint256Hex);
}

/**
 * Prefix carried when the server's certificate is not pinned (an operator
 * certificate or a TLS proxy): the client verifies it against system CAs.
 */
export const NO_PIN_PREFIX = '0'.repeat(JOIN_FINGERPRINT_LENGTH);

export function joinCodeIsPinned(input: string): boolean {
    const parsed = parseJoinCode(input);
    return !!parsed && parsed.fingerprintPrefix !== NO_PIN_PREFIX;
}
