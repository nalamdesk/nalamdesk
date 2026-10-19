import * as crypto from 'node:crypto';

// Signed device requests (#154). Every call from a paired desktop carries
// these headers, and an Ed25519 signature over canonicalRequest(). The
// desktop's signer (desktop/src/main/cloud) must build the same string;
// test/vectors.json pins it for both sides.

export const SIGNING_LABEL = 'nalamdesk-req-v1';

export const SIGNATURE_HEADERS = {
    device: 'x-nd-device',
    timestamp: 'x-nd-timestamp',
    nonce: 'x-nd-nonce',
    signature: 'x-nd-signature'
} as const;

/**
 * Which service a request was signed for. CloudFront rewrites the Host
 * header on its way to a Web Function, so the audience is a fixed name
 * instead, and a request signed for one service fails at the other.
 */
export type Audience = 'relay' | 'booking';

export interface CanonicalFields {
    audience: Audience;
    method: string;
    /** URL path as sent, without the query string. */
    path: string;
    /** Raw query string as sent, without the leading `?`; empty if none. */
    query: string;
    /** Lower-case hex SHA-256 of the body bytes (of nothing, for no body). */
    bodySha256: string;
    /** Epoch milliseconds, as the decimal string sent in X-ND-Timestamp. */
    timestamp: string;
    nonce: string;
    /** X-HIP-ID header value, or empty. */
    hipId: string;
}

export function bodySha256(body: Uint8Array): string {
    return crypto.createHash('sha256').update(body).digest('hex');
}

export function canonicalRequest(fields: CanonicalFields): string {
    return [
        SIGNING_LABEL,
        fields.audience,
        fields.method.toUpperCase(),
        fields.query ? `${fields.path}?${fields.query}` : fields.path,
        fields.bodySha256,
        fields.timestamp,
        fields.nonce,
        fields.hipId
    ].join('\n');
}

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** Raw 32-byte Ed25519 public key (base64) to a KeyObject. */
export function ed25519PublicKey(rawBase64: string): crypto.KeyObject {
    const raw = Buffer.from(rawBase64, 'base64');
    if (raw.length !== 32) throw new Error('Ed25519 public key must be 32 bytes.');
    return crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

/** Raw 32-byte public key (base64) of an Ed25519 key pair. */
export function ed25519PublicKeyRaw(key: crypto.KeyObject): string {
    const publicKey = key.type === 'private' ? crypto.createPublicKey(key) : key;
    return publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
}

/** Ed25519 signature over the canonical string, base64url. */
export function signCanonical(privateKey: crypto.KeyObject, fields: CanonicalFields): string {
    return crypto.sign(null, Buffer.from(canonicalRequest(fields), 'utf8'), privateKey).toString('base64url');
}

export function verifyCanonical(publicKey: crypto.KeyObject, fields: CanonicalFields, signature: string): boolean {
    const bytes = Buffer.from(signature, 'base64url');
    if (bytes.length !== 64) return false;
    try {
        return crypto.verify(null, Buffer.from(canonicalRequest(fields), 'utf8'), publicKey, bytes);
    } catch {
        return false;
    }
}

/**
 * Headers for a signed request. Used by tests and as the reference for the
 * desktop signer.
 */
export function signRequest(input: {
    privateKey: crypto.KeyObject;
    deviceId: string;
    audience: Audience;
    method: string;
    path: string;
    query?: string;
    body?: Uint8Array;
    hipId?: string;
    nowMs: number;
    nonce?: string;
}): Record<string, string> {
    const timestamp = String(input.nowMs);
    const nonce = input.nonce ?? crypto.randomBytes(16).toString('base64url');
    const signature = signCanonical(input.privateKey, {
        audience: input.audience,
        method: input.method,
        path: input.path,
        query: input.query ?? '',
        bodySha256: bodySha256(input.body ?? new Uint8Array()),
        timestamp,
        nonce,
        hipId: input.hipId ?? ''
    });
    const headers: Record<string, string> = {
        [SIGNATURE_HEADERS.device]: input.deviceId,
        [SIGNATURE_HEADERS.timestamp]: timestamp,
        [SIGNATURE_HEADERS.nonce]: nonce,
        [SIGNATURE_HEADERS.signature]: signature
    };
    if (input.hipId) headers['x-hip-id'] = input.hipId;
    return headers;
}
