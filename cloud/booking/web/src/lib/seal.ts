// Seals booking details to the clinic's X25519 key in the browser, in the
// mailbox format of cloud/relay/src/seal.ts: a fresh ephemeral key per
// request, HKDF-SHA256 with the `nalamdesk-mailbox-v1` label, AES-256-GCM,
// and `nalamdesk-mailbox-v1|<clinic ID>|booking-request` as associated data.
// Only the clinic's desktop can open it; NalamDesk's servers cannot.
//
// WebCrypto X25519 is used where the browser has it (Chrome 133+, Firefox
// 130+, Safari 17+). Older browsers fall back to @noble/curves for the key
// agreement only; HKDF and AES-GCM always run in WebCrypto.
import { x25519 } from '@noble/curves/ed25519.js';

const LABEL = 'nalamdesk-mailbox-v1';
export const BOOKING_ITEM_TYPE = 'booking-request';

export interface SealedEnvelope {
    v: 1;
    epk: string;
    salt: string;
    iv: string;
    ct: string;
    tag: string;
}

const encoder = new TextEncoder();

export function toBase64(bytes: Uint8Array): string {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
}

export function fromBase64(value: string): Uint8Array {
    const binary = atob(value);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
}

interface KeyAgreement {
    ephemeralPublic: Uint8Array;
    shared: Uint8Array;
}

async function webCryptoAgreement(subtle: SubtleCrypto, peerRaw: Uint8Array): Promise<KeyAgreement> {
    const peer = await subtle.importKey('raw', peerRaw as BufferSource, { name: 'X25519' }, false, []);
    const ephemeral = (await subtle.generateKey({ name: 'X25519' }, true, ['deriveBits'])) as CryptoKeyPair;
    const shared = new Uint8Array(await subtle.deriveBits({ name: 'X25519', public: peer }, ephemeral.privateKey, 256));
    const ephemeralPublic = new Uint8Array(await subtle.exportKey('raw', ephemeral.publicKey));
    return { ephemeralPublic, shared };
}

function nobleAgreement(peerRaw: Uint8Array): KeyAgreement {
    const secret = x25519.utils.randomSecretKey();
    try {
        return { ephemeralPublic: x25519.getPublicKey(secret), shared: x25519.getSharedSecret(secret, peerRaw) };
    } finally {
        secret.fill(0);
    }
}

let webCryptoX25519: boolean | undefined;

/** Whether this browser does X25519 in WebCrypto; cached after the first probe. */
export async function hasWebCryptoX25519(subtle: SubtleCrypto = crypto.subtle): Promise<boolean> {
    if (webCryptoX25519 !== undefined) return webCryptoX25519;
    try {
        await subtle.generateKey({ name: 'X25519' }, false, ['deriveBits']);
        webCryptoX25519 = true;
    } catch {
        webCryptoX25519 = false;
    }
    return webCryptoX25519;
}

export interface SealOptions {
    /** Force the @noble/curves path; tests use it to cover old browsers. */
    forceFallback?: boolean;
}

/** Seals `plaintext` to the clinic. Returns base64 of the JSON envelope. */
export async function seal(plaintext: Uint8Array, clinicPublicKey: string, clinicId: string, options: SealOptions = {}): Promise<string> {
    const subtle = crypto.subtle;
    const peerRaw = fromBase64(clinicPublicKey);
    if (peerRaw.length !== 32) throw new Error('The clinic key is not a 32-byte X25519 public key.');

    const useWebCrypto = !options.forceFallback && (await hasWebCryptoX25519(subtle));
    const { ephemeralPublic, shared } = useWebCrypto ? await webCryptoAgreement(subtle, peerRaw) : nobleAgreement(peerRaw);

    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ikm = await subtle.importKey('raw', shared as BufferSource, 'HKDF', false, ['deriveKey']);
    shared.fill(0);
    const key = await subtle.deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt, info: encoder.encode(LABEL) },
        ikm,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt']
    );
    const sealed = new Uint8Array(await subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: encoder.encode(`${LABEL}|${clinicId}|${BOOKING_ITEM_TYPE}`), tagLength: 128 },
        key,
        plaintext as BufferSource
    ));
    const envelope: SealedEnvelope = {
        v: 1,
        epk: toBase64(ephemeralPublic),
        salt: toBase64(salt),
        iv: toBase64(iv),
        ct: toBase64(sealed.subarray(0, sealed.length - 16)),
        tag: toBase64(sealed.subarray(sealed.length - 16))
    };
    return toBase64(encoder.encode(JSON.stringify(envelope)));
}
