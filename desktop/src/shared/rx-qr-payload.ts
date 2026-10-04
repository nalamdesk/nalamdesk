/**
 * Offline-readable prescription QR payload (issue #65).
 *
 * A trimmed, versioned schema -- not the full FHIR bundle, which busts
 * QR's ~3KB binary cap. Deflate + base64url keeps typical 2-4 line
 * prescriptions scannable; oversized payloads refuse loudly instead of
 * printing an unscannable code.
 */
import { deflateSync, inflateSync, strFromU8, strToU8 } from 'fflate';

/** Maximum inflated bytes accepted on decode (zip-bomb guard). */
export const RX_QR_INFLATE_LIMIT = 65536;

/** Maximum encoded characters we will render: fits QR byte mode at EC
 *  level M (~2331 bytes) with headroom for reliable phone scanning. */
export const RX_QR_CHAR_LIMIT = 2000;

export interface RxQrLine {
    medicine: string;
    dosage?: string;
    route?: string;
    frequency?: string;
    duration?: string;
    instruction?: string;
}

export interface RxQrInput {
    patient: { name?: string; age?: number | string; gender?: string };
    doctor: { name?: string; license_number?: string };
    date?: string;
    diagnosis?: string;
    lines: RxQrLine[];
}

/** Compact array-form payload: short keys, positional lines. */
export function buildRxQrPayload(input: RxQrInput): Record<string, unknown> {
    return {
        app: 'ND-Rx',
        v: 1,
        p: [input.patient?.name || '', input.patient?.age ?? '', input.patient?.gender || ''],
        d: [input.doctor?.name || '', input.doctor?.license_number || ''],
        dt: (input.date || '').slice(0, 10),
        dx: input.diagnosis || '',
        rx: (input.lines || []).map((l) => [
            l.medicine || '', l.dosage || '', l.route || '', l.frequency || '', l.duration || '', l.instruction || ''
        ])
    };
}

/** Encode a payload to a QR-safe string. Throws when over the char cap. */
export function encodeRxQr(input: RxQrInput): string {
    const json = JSON.stringify(buildRxQrPayload(input));
    const bytes = deflateSync(strToU8(json));
    let binary = '';
    for (const byte of bytes) binary += String.fromCodePoint(byte);
    let out = btoa(binary).replaceAll('+', '-').replaceAll('/', '_');
    while (out.endsWith('=')) out = out.slice(0, -1);
    const encoded = 'ND1.' + out;
    // Cap the final text, not the deflated bytes: base64url adds ~33%,
    // so a byte cap would still overflow the QR symbol.
    if (encoded.length > RX_QR_CHAR_LIMIT) {
        throw new Error(`Prescription too large for QR (${encoded.length} chars).`);
    }
    return encoded;
}

/** Decode a QR string back to the payload (scanner side + tests).
 *
 *  Trust model: this payload is a convenience copy, NOT an authenticated
 *  credential. Anyone can forge an ND1 code, so scanners must cross-check
 *  against the printed prescription and the doctor's signature -- exactly
 *  as with paper today. Authenticating prescriptions (signatures, PKI)
 *  is deferred to the ABDM signed-bundle work, where key infrastructure
 *  exists to verify against.
 */
export function decodeRxQr(text: string): Record<string, unknown> {
    if (!text.startsWith('ND1.')) throw new Error('Not a NalamDesk prescription code.');
    let b64 = text.slice(4).replaceAll('-', '+').replaceAll('_', '/');
    // Strict decoders reject unpadded input: restore the stripped '='.
    while (b64.length % 4 !== 0) b64 += '=';
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.codePointAt(i) || 0;
    const inflated = inflateSync(bytes);
    if (inflated.length > RX_QR_INFLATE_LIMIT) {
        throw new Error('QR payload expands beyond the accepted limit.');
    }
    return JSON.parse(strFromU8(inflated));
}
