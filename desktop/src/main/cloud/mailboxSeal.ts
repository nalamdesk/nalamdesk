import * as crypto from 'node:crypto';

// The mailbox envelope (#155): X25519 with a fresh ephemeral key per item,
// HKDF-SHA256 and AES-256-GCM. Matches `open()` in cloud/relay/src/seal.ts
// and the browser sealer in cloud/booking/web/src/lib/seal.ts.

const MAILBOX_LABEL = 'nalamdesk-mailbox-v1';
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

function rawToPublicKey(rawBase64: string): crypto.KeyObject {
    const raw = Buffer.from(String(rawBase64 || ''), 'base64');
    if (raw.length !== 32) throw new Error('Sealing key must be a 32-byte X25519 public key.');
    return crypto.createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

/**
 * Opens a mailbox envelope. The clinic ID and item type are bound as
 * associated data, so a moved or relabelled item fails.
 */
export function openSealed(sealed: string, privateKey: crypto.KeyObject, clinicId: string, type: string): Buffer {
    const envelope = JSON.parse(Buffer.from(sealed, 'base64').toString('utf8'));
    if (envelope?.v !== 1) throw new Error('Unsupported envelope version.');
    const shared = crypto.diffieHellman({ publicKey: rawToPublicKey(envelope.epk), privateKey });
    const key = Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.from(envelope.salt, 'base64'), Buffer.from(MAILBOX_LABEL), 32));
    shared.fill(0);
    try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
        decipher.setAAD(Buffer.from(`${MAILBOX_LABEL}|${clinicId}|${type}`, 'utf8'));
        decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
        return Buffer.concat([decipher.update(Buffer.from(envelope.ct, 'base64')), decipher.final()]);
    } finally {
        key.fill(0);
    }
}
