import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { DeviceKeyStore, DeviceKeyStoreStatus } from './DeviceKeyStore';

/**
 * Key providers for NalamDesk Server (ADR 0001), where no desktop keychain
 * exists. Each one wraps device-bound secrets (the vault DEK envelope, HIU and
 * Cloud keys) behind the same DeviceKeyStore boundary the desktop uses.
 */

export const KEY_FILE_PROVIDER = 'key-file';
export const PASSPHRASE_PROVIDER = 'passphrase';

const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

const KEY_FILE_MAGIC = Buffer.from('NDK1', 'ascii');
const KEY_FILE_AAD = Buffer.from('nalamdesk:key-file:v1', 'utf8');

const PASSPHRASE_MAGIC = Buffer.from('NDP1', 'ascii');
const PASSPHRASE_AAD = Buffer.from('nalamdesk:passphrase:v1', 'utf8');
const PASSPHRASE_SALT_LENGTH = 16;
/** scrypt cost as log2(N). 2^17 with r=8 needs 128 MiB and takes ~0.3s. */
export const PASSPHRASE_DEFAULT_LOG_N = 17;
const PASSPHRASE_MIN_LOG_N = 14;
const PASSPHRASE_MAX_LOG_N = 20;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
export const PASSPHRASE_MIN_LENGTH = 12;

function seal(key: Buffer, header: Buffer, aad: Buffer, value: Buffer): Buffer {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.concat([aad, header]));
    const ciphertext = Buffer.concat([cipher.update(value), cipher.final()]);
    return Buffer.concat([header, iv, cipher.getAuthTag(), ciphertext]);
}

function open(key: Buffer, header: Buffer, aad: Buffer, body: Buffer): Buffer {
    if (body.length < IV_LENGTH + TAG_LENGTH) throw new Error('INVALID_PROTECTED_PAYLOAD');
    const iv = body.subarray(0, IV_LENGTH);
    const tag = body.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const ciphertext = body.subarray(IV_LENGTH + TAG_LENGTH);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.concat([aad, header]));
    decipher.setAuthTag(tag);
    try {
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
        throw new Error('DEVICE_UNLOCK_FAILED: the protected value does not match this key.');
    }
}

export interface KeyFileStoreOptions {
    platform?: NodeJS.Platform;
}

/**
 * A random 256-bit key in a file only the service account can read, like the
 * Postgres data directory. Protects copied databases and backups; a stolen
 * whole disk needs disk encryption on top.
 */
export class KeyFileStore implements DeviceKeyStore {
    private readonly platform: NodeJS.Platform;

    constructor(private readonly keyPath: string, options: KeyFileStoreOptions = {}) {
        this.platform = options.platform ?? process.platform;
    }

    /** Creates a new key file. Refuses to overwrite one that exists. */
    static create(keyPath: string, options: KeyFileStoreOptions = {}): KeyFileStore {
        fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
        const fd = fs.openSync(keyPath, 'wx', 0o600);
        try {
            fs.writeFileSync(fd, crypto.randomBytes(KEY_LENGTH));
            fs.fsyncSync(fd);
        } finally {
            fs.closeSync(fd);
        }
        return new KeyFileStore(keyPath, options);
    }

    status(): DeviceKeyStoreStatus {
        const problem = this.problem();
        if (problem) {
            return { available: false, provider: KEY_FILE_PROVIDER, reason: 'ENCRYPTION_UNAVAILABLE', message: problem };
        }
        return { available: true, provider: KEY_FILE_PROVIDER };
    }

    protect(value: Buffer): Buffer {
        return seal(this.readKey(), KEY_FILE_MAGIC, KEY_FILE_AAD, value);
    }

    unprotect(value: Buffer): Buffer {
        if (value.length < KEY_FILE_MAGIC.length || !value.subarray(0, KEY_FILE_MAGIC.length).equals(KEY_FILE_MAGIC)) {
            throw new Error('INVALID_PROTECTED_PAYLOAD');
        }
        return open(this.readKey(), KEY_FILE_MAGIC, KEY_FILE_AAD, value.subarray(KEY_FILE_MAGIC.length));
    }

    private problem(): string | null {
        let stat: fs.Stats;
        try {
            stat = fs.statSync(this.keyPath);
        } catch {
            return `ENCRYPTION_UNAVAILABLE: key file not found at ${this.keyPath}.`;
        }
        if (!stat.isFile()) return `ENCRYPTION_UNAVAILABLE: ${this.keyPath} is not a regular file.`;
        if (stat.size !== KEY_LENGTH) return `ENCRYPTION_UNAVAILABLE: key file ${this.keyPath} is not a NalamDesk key.`;
        // POSIX only: Windows ACLs are not reflected in mode bits.
        if (this.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
            return `ENCRYPTION_UNAVAILABLE: key file ${this.keyPath} is readable by other users. Run chmod 600 on it.`;
        }
        return null;
    }

    private readKey(): Buffer {
        const problem = this.problem();
        if (problem) throw new Error(problem);
        const key = fs.readFileSync(this.keyPath);
        if (key.length !== KEY_LENGTH) throw new Error(`ENCRYPTION_UNAVAILABLE: key file ${this.keyPath} is not a NalamDesk key.`);
        return key;
    }
}

export interface PassphraseKeyStoreOptions {
    /** scrypt cost as log2(N) for new payloads. Tests lower it. */
    logN?: number;
}

/**
 * Derives the wrapping key from a passphrase an admin enters at every start.
 * Protects a stolen disk; the server stays locked until someone unlocks it.
 */
export class PassphraseKeyStore implements DeviceKeyStore {
    private readonly logN: number;
    private readonly derived = new Map<string, Buffer>();
    private passphrase: Buffer | null;

    constructor(passphrase: string, options: PassphraseKeyStoreOptions = {}) {
        if (typeof passphrase !== 'string' || passphrase.length < PASSPHRASE_MIN_LENGTH) {
            throw new Error(`PASSPHRASE_TOO_SHORT: use at least ${PASSPHRASE_MIN_LENGTH} characters.`);
        }
        const logN = options.logN ?? PASSPHRASE_DEFAULT_LOG_N;
        if (!Number.isInteger(logN) || logN < PASSPHRASE_MIN_LOG_N || logN > PASSPHRASE_MAX_LOG_N) {
            throw new Error('INVALID_PASSPHRASE_COST');
        }
        this.logN = logN;
        this.passphrase = Buffer.from(passphrase.normalize('NFKC'), 'utf8');
    }

    status(): DeviceKeyStoreStatus {
        if (!this.passphrase) {
            return { available: false, provider: PASSPHRASE_PROVIDER, reason: 'ENCRYPTION_UNAVAILABLE', message: 'ENCRYPTION_UNAVAILABLE: the passphrase was cleared.' };
        }
        return { available: true, provider: PASSPHRASE_PROVIDER };
    }

    protect(value: Buffer): Buffer {
        const salt = crypto.randomBytes(PASSPHRASE_SALT_LENGTH);
        const header = Buffer.concat([PASSPHRASE_MAGIC, Buffer.from([this.logN]), salt]);
        return seal(this.deriveKey(salt, this.logN), header, PASSPHRASE_AAD, value);
    }

    unprotect(value: Buffer): Buffer {
        const headerLength = PASSPHRASE_MAGIC.length + 1 + PASSPHRASE_SALT_LENGTH;
        if (value.length < headerLength || !value.subarray(0, PASSPHRASE_MAGIC.length).equals(PASSPHRASE_MAGIC)) {
            throw new Error('INVALID_PROTECTED_PAYLOAD');
        }
        const logN = value[PASSPHRASE_MAGIC.length];
        if (logN < PASSPHRASE_MIN_LOG_N || logN > PASSPHRASE_MAX_LOG_N) throw new Error('INVALID_PROTECTED_PAYLOAD');
        const header = value.subarray(0, headerLength);
        const salt = value.subarray(PASSPHRASE_MAGIC.length + 1, headerLength);
        return open(this.deriveKey(salt, logN), header, PASSPHRASE_AAD, value.subarray(headerLength));
    }

    /** Wipes the passphrase and derived keys from memory. */
    clear(): void {
        this.passphrase?.fill(0);
        this.passphrase = null;
        for (const key of this.derived.values()) key.fill(0);
        this.derived.clear();
    }

    private deriveKey(salt: Buffer, logN: number): Buffer {
        if (!this.passphrase) throw new Error('ENCRYPTION_UNAVAILABLE: the passphrase was cleared.');
        const cacheKey = `${logN}:${salt.toString('hex')}`;
        const cached = this.derived.get(cacheKey);
        if (cached) return cached;
        const N = 2 ** logN;
        const key = crypto.scryptSync(this.passphrase, salt, KEY_LENGTH, {
            N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 128 * N * SCRYPT_R * 2
        });
        this.derived.set(cacheKey, key);
        return key;
    }
}

export type HeadlessKeyProviderConfig =
    | { provider: typeof KEY_FILE_PROVIDER; keyPath: string }
    | { provider: typeof PASSPHRASE_PROVIDER; passphrase: string; logN?: number };

/** Builds the key store a headless server was configured with. */
export function createHeadlessKeyStore(config: HeadlessKeyProviderConfig): DeviceKeyStore {
    switch (config?.provider) {
        case KEY_FILE_PROVIDER:
            return new KeyFileStore(config.keyPath);
        case PASSPHRASE_PROVIDER:
            return new PassphraseKeyStore(config.passphrase, { logN: config.logN });
        default:
            throw new Error(`UNKNOWN_KEY_PROVIDER: ${(config as any)?.provider}`);
    }
}
