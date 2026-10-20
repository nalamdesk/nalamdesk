import * as crypto from 'node:crypto';

// Signed device requests (#154), desktop side. Must build the same string as
// canonicalRequest() in cloud/shared/src/signing.ts; both are tested against
// cloud/shared/test/vectors.json.

export const SIGNING_LABEL = 'nalamdesk-req-v1';

/** Which cloud service a request is for; a signature for one fails at the other. */
export type Audience = 'relay' | 'booking';

export interface SignInput {
    privateKey: crypto.KeyObject;
    deviceId: string;
    audience: Audience;
    method: string;
    /** URL path without the query string. */
    path: string;
    /** Raw query string without the leading `?`. */
    query?: string;
    body?: Uint8Array;
    hipId?: string;
    nowMs: number;
    nonce?: string;
}

export function bodySha256(body: Uint8Array): string {
    return crypto.createHash('sha256').update(body).digest('hex');
}

export function canonicalRequest(fields: {
    audience: Audience; method: string; path: string; query: string; bodySha256: string; timestamp: string; nonce: string; hipId: string;
}): string {
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

/** The X-ND-* headers (and X-HIP-ID, when given) for one request. */
export function signedHeaders(input: SignInput): Record<string, string> {
    const timestamp = String(Math.round(input.nowMs));
    const nonce = input.nonce ?? crypto.randomBytes(16).toString('base64url');
    const canonical = canonicalRequest({
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
        'x-nd-device': input.deviceId,
        'x-nd-timestamp': timestamp,
        'x-nd-nonce': nonce,
        'x-nd-signature': crypto.sign(null, Buffer.from(canonical, 'utf8'), input.privateKey).toString('base64url')
    };
    if (input.hipId) headers['x-hip-id'] = input.hipId;
    return headers;
}

// ---- Pairing messages; must match pairingMessages in cloud/relay/src/pairing.ts ----

export const pairingMessages = {
    request: (m: { hfrId: string; signingPublicKey: string; sealingPublicKey: string; label: string; appVersion: string; timestamp: string }) =>
        ['nalamdesk-pair-request-v1', m.hfrId, m.signingPublicKey, m.sealingPublicKey, m.label, m.appVersion, m.timestamp].join('|'),
    cancel: (m: { hfrId: string; timestamp: string }) => ['nalamdesk-pair-cancel-v1', m.hfrId, m.timestamp].join('|'),
    activate: (m: { hfrId: string; code: string; signingPublicKey: string; sealingPublicKey: string; timestamp: string }) =>
        ['nalamdesk-pair-activate-v1', m.hfrId, m.code, m.signingPublicKey, m.sealingPublicKey, m.timestamp].join('|'),
    rotate: (m: { deviceId: string; oldKey: string; newKey: string }) => ['nalamdesk-rotate-v1', m.deviceId, m.oldKey, m.newKey].join('|')
};

export function signMessage(privateKey: crypto.KeyObject, message: string): string {
    return crypto.sign(null, Buffer.from(message, 'utf8'), privateKey).toString('base64url');
}

/** Code as staff read it (`ab12-cd34`) to the 8 characters the relay hashes. */
export function normalizePairingCode(code: string): string {
    return String(code || '').toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
}
