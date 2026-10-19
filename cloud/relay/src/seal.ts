import * as crypto from 'node:crypto';

// Mailbox sealing: X25519 ECDH with a fresh ephemeral key per item,
// HKDF-SHA256, AES-256-GCM. Same primitives as the desktop's
// FideliusService, with its own HKDF label so a mailbox key can never be
// confused with a record-transfer key. The clinic ID and item type are bound
// in as associated data, so a blob moved to another clinic or relabelled
// fails to open.
const HKDF_INFO = Buffer.from('nalamdesk-mailbox-v1');
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

export interface SealedEnvelope {
    v: 1;
    epk: string;
    salt: string;
    iv: string;
    ct: string;
    tag: string;
}

function rawToPublicKey(rawBase64: string): crypto.KeyObject {
    const raw = Buffer.from(String(rawBase64 || ''), 'base64');
    if (raw.length !== 32) throw new Error('Sealing key must be a 32-byte X25519 public key.');
    return crypto.createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

function associatedData(clinicId: string, type: string): Buffer {
    return Buffer.from(`${HKDF_INFO.toString()}|${clinicId}|${type}`, 'utf8');
}

/** Seals bytes to a clinic's X25519 key. Returns base64 of the JSON envelope. */
export function seal(plaintext: Uint8Array, recipientPublicKey: string, clinicId: string, type: string): string {
    const peer = rawToPublicKey(recipientPublicKey);
    const ephemeral = crypto.generateKeyPairSync('x25519');
    const shared = crypto.diffieHellman({ publicKey: peer, privateKey: ephemeral.privateKey });
    const salt = crypto.randomBytes(16);
    const key = Buffer.from(crypto.hkdfSync('sha256', shared, salt, HKDF_INFO, 32));
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(associatedData(clinicId, type));
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    shared.fill(0);
    key.fill(0);
    const envelope: SealedEnvelope = {
        v: 1,
        epk: ephemeral.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64'),
        salt: salt.toString('base64'),
        iv: iv.toString('base64'),
        ct: ct.toString('base64'),
        tag: cipher.getAuthTag().toString('base64')
    };
    return Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64');
}

/**
 * Opens a sealed envelope with the clinic's private key. The relay never
 * calls this; it is the reference the desktop's mailbox reader must match.
 */
export function open(sealed: string, recipientPrivateKey: crypto.KeyObject, clinicId: string, type: string): Buffer {
    const envelope = JSON.parse(Buffer.from(sealed, 'base64').toString('utf8')) as SealedEnvelope;
    if (envelope.v !== 1) throw new Error('Unsupported envelope version.');
    const shared = crypto.diffieHellman({ publicKey: rawToPublicKey(envelope.epk), privateKey: recipientPrivateKey });
    const key = Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.from(envelope.salt, 'base64'), HKDF_INFO, 32));
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
    decipher.setAAD(associatedData(clinicId, type));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(envelope.ct, 'base64')), decipher.final()]);
}
