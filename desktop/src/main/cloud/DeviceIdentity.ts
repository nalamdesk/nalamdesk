import * as crypto from 'node:crypto';
import type { DeviceKeyStore } from '../services/DeviceKeyStore';

// This install's cloud identity (#154): an Ed25519 key that signs every
// request, and an X25519 key that patients' browsers and the relay seal
// mailbox items to. Both private keys are wrapped by the OS keychain
// (DeviceKeyStore) before they reach the database, so a copied database or
// a backup restored on another computer cannot sign or open anything; that
// computer pairs again.

export type CloudDeviceState = 'requested' | 'paired' | 'revoked';

/** The single `cloud_device` row. */
export interface CloudDeviceRow {
    state: CloudDeviceState;
    hfr_id: string;
    request_id: string | null;
    request_expires_at: number | null;
    device_id: string | null;
    clinic_id: string | null;
    data_push_url: string | null;
    label: string;
    signing_public: string;
    signing_private_protected: string;
    signing_created_at: number;
    /** Set only while a key rotation is being confirmed with the relay. */
    previous_signing_public: string | null;
    previous_signing_private_protected: string | null;
    sealing_public: string;
    sealing_private_protected: string;
    paired_at: number | null;
    revoked_reason: string | null;
    updated_at: number;
}

export interface CloudDeviceStore {
    getCloudDevice(): CloudDeviceRow | null;
    saveCloudDevice(row: CloudDeviceRow): void;
    clearCloudDevice(): void;
}

export interface KeyPair {
    /** Raw 32-byte public key, base64. */
    publicKey: string;
    privateKey: crypto.KeyObject;
}

export function rawPublicKey(key: crypto.KeyObject): string {
    const publicKey = key.type === 'private' ? crypto.createPublicKey(key) : key;
    return publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
}

export function newSigningKey(): KeyPair {
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    return { publicKey: rawPublicKey(privateKey), privateKey };
}

export function newSealingKey(): KeyPair {
    const { privateKey } = crypto.generateKeyPairSync('x25519');
    return { publicKey: rawPublicKey(privateKey), privateKey };
}

function assertAvailable(keyStore: DeviceKeyStore): void {
    const status = keyStore.status();
    if (!status.available) {
        throw new Error(`${status.reason || 'ENCRYPTION_UNAVAILABLE'}: ${status.message || 'OS-backed encryption is not available.'}`);
    }
}

export function protectPrivateKey(keyStore: DeviceKeyStore, key: crypto.KeyObject): string {
    assertAvailable(keyStore);
    const der = key.export({ type: 'pkcs8', format: 'der' });
    try {
        return keyStore.protect(der).toString('base64');
    } finally {
        der.fill(0);
    }
}

export function unprotectPrivateKey(keyStore: DeviceKeyStore, wrapped: string, expectedPublic: string): crypto.KeyObject {
    assertAvailable(keyStore);
    const der = keyStore.unprotect(Buffer.from(wrapped, 'base64'));
    try {
        const key = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
        if (rawPublicKey(key) !== expectedPublic) throw new Error('DEVICE_KEY_MISMATCH');
        return key;
    } finally {
        der.fill(0);
    }
}

/** Short, stable label for a signing key; matches keyFingerprint() on the relay, which staff see. */
export function keyFingerprint(publicKeyRaw: string): string {
    const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    const digest = crypto.createHash('sha256').update(Buffer.from(publicKeyRaw, 'base64')).digest();
    let out = '';
    for (let i = 0; i < 8; i++) out += alphabet[digest[i]! % 32];
    return `${out.slice(0, 4)}-${out.slice(4)}`;
}
