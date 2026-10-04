/**
 * Offline-readable prescription QR payload (issue #65).
 *
 * A trimmed, versioned schema -- not the full FHIR bundle, which busts
 * QR's ~3KB binary cap. Deflate + base64url keeps typical 2-4 line
 * prescriptions scannable; oversized payloads refuse loudly instead of
 * printing an unscannable code.
 */
import { deflateSync, inflateSync, strFromU8, strToU8 } from 'fflate';

/** Maximum deflated bytes we will encode (QR breaks past ~3KB). */
export const RX_QR_BYTE_LIMIT = 2800;

export interface RxQrLine {
    medicine: string;
    dosage?: string;
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
            l.medicine || '', l.dosage || '', l.frequency || '', l.duration || '', l.instruction || ''
        ])
    };
}

/** Encode a payload to a QR-safe string. Throws when over the byte cap. */
export function encodeRxQr(input: RxQrInput): string {
    const json = JSON.stringify(buildRxQrPayload(input));
    const bytes = deflateSync(strToU8(json));
    if (bytes.length > RX_QR_BYTE_LIMIT) {
        throw new Error(`Prescription too large for QR (${bytes.length} bytes).`);
    }
    let binary = '';
    for (const byte of bytes) binary += String.fromCodePoint(byte);
    let out = btoa(binary).replaceAll('+', '-').replaceAll('/', '_');
    while (out.endsWith('=')) out = out.slice(0, -1);
    return 'ND1.' + out;
}

/** Decode a QR string back to the payload (scanner side + tests). */
export function decodeRxQr(text: string): Record<string, unknown> {
    if (!text.startsWith('ND1.')) throw new Error('Not a NalamDesk prescription code.');
    const b64 = text.slice(4).replaceAll('-', '+').replaceAll('_', '/');
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.codePointAt(i) || 0;
    return JSON.parse(strFromU8(inflateSync(bytes)));
}
