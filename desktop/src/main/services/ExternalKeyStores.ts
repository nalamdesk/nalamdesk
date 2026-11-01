import * as childProcess from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { DeviceKeyStore, DeviceKeyStoreStatus } from './DeviceKeyStore';

/**
 * Key providers backed by something outside NalamDesk (ADR 0001): systemd
 * credentials (host key and/or TPM2), Windows DPAPI, and a KMS reached through
 * a key command. Each yields a 256-bit key-encryption key (KEK) that seals the
 * vault envelope with AES-256-GCM, so the KEK never lands on disk in the clear.
 */

export const SYSTEMD_CREDS_PROVIDER = 'systemd-creds';
export const TPM_PROVIDER = 'tpm';
export const DPAPI_PROVIDER = 'dpapi';
export const KMS_PROVIDER = 'kms';

export const DEFAULT_CREDENTIAL_NAME = 'nalamdesk-vault-key';
export const DEFAULT_CREDSTORE_DIR = '/etc/credstore.encrypted';

const KEK_LENGTH = 32;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const COMMAND_TIMEOUT_MS = 30_000;
const CREDENTIAL_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

/** Runs a program without a shell. Returns stdout; throws on a non-zero exit. */
export type KeyExec = (file: string, args: string[], input?: Buffer) => Buffer;

export const defaultKeyExec: KeyExec = (file, args, input) => childProcess.execFileSync(file, args, {
    input,
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
});

function commandError(what: string, error: any): Error {
    const stderr = Buffer.isBuffer(error?.stderr) ? error.stderr.toString('utf8').trim() : '';
    const detail = stderr || error?.message || String(error);
    return new Error(`ENCRYPTION_UNAVAILABLE: ${what} failed: ${detail.split('\n')[0]}`);
}

/**
 * Seals values with a KEK fetched once from a backend and cached in memory.
 * Payload: magic(4) | iv(12) | tag(16) | ciphertext, with the magic in the AAD.
 */
abstract class KekKeyStore implements DeviceKeyStore {
    private kek: Buffer | null;

    protected constructor(
        private readonly provider: string,
        private readonly magic: Buffer,
        private readonly aad: Buffer,
        kek?: Buffer
    ) {
        this.kek = kek ? Buffer.from(kek) : null;
    }

    /** Why the KEK cannot be loaded, without loading it; null when it may work. */
    protected abstract problem(): string | null;
    /** Fetches the KEK from the backend. */
    protected abstract loadKek(): Buffer;

    status(): DeviceKeyStoreStatus {
        const problem = this.kek ? null : this.problem();
        if (problem) return { available: false, provider: this.provider, reason: 'ENCRYPTION_UNAVAILABLE', message: problem };
        return { available: true, provider: this.provider };
    }

    protect(value: Buffer): Buffer {
        const iv = crypto.randomBytes(IV_LENGTH);
        const cipher = crypto.createCipheriv('aes-256-gcm', this.key(), iv);
        cipher.setAAD(Buffer.concat([this.aad, this.magic]));
        const ciphertext = Buffer.concat([cipher.update(value), cipher.final()]);
        return Buffer.concat([this.magic, iv, cipher.getAuthTag(), ciphertext]);
    }

    unprotect(value: Buffer): Buffer {
        const header = this.magic.length;
        if (value.length < header + IV_LENGTH + TAG_LENGTH || !value.subarray(0, header).equals(this.magic)) {
            throw new Error('INVALID_PROTECTED_PAYLOAD');
        }
        const iv = value.subarray(header, header + IV_LENGTH);
        const tag = value.subarray(header + IV_LENGTH, header + IV_LENGTH + TAG_LENGTH);
        const decipher = crypto.createDecipheriv('aes-256-gcm', this.key(), iv);
        decipher.setAAD(Buffer.concat([this.aad, this.magic]));
        decipher.setAuthTag(tag);
        try {
            return Buffer.concat([decipher.update(value.subarray(header + IV_LENGTH + TAG_LENGTH)), decipher.final()]);
        } catch {
            throw new Error('DEVICE_UNLOCK_FAILED: the protected value does not match this key.');
        }
    }

    /** Wipes the cached KEK. The next use fetches it again. */
    clear(): void {
        this.kek?.fill(0);
        this.kek = null;
    }

    private key(): Buffer {
        if (this.kek) return this.kek;
        const problem = this.problem();
        if (problem) throw new Error(problem);
        const kek = this.loadKek();
        if (kek.length !== KEK_LENGTH) {
            kek.fill(0);
            throw new Error(`ENCRYPTION_UNAVAILABLE: the ${this.provider} key is not ${KEK_LENGTH} bytes.`);
        }
        this.kek = kek;
        return kek;
    }
}

function writeNewFile(filePath: string, data: Buffer): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const fd = fs.openSync(filePath, 'wx', 0o600);
    let written = false;
    try {
        fs.writeFileSync(fd, data);
        fs.fsyncSync(fd);
        written = true;
    } finally {
        fs.closeSync(fd);
        if (!written) fs.rmSync(filePath, { force: true });
    }
}

/* ------------------------------------------------------------------ */
/* systemd credentials (host key, TPM2, or both)                       */
/* ------------------------------------------------------------------ */

export type SystemdCredsKeyMode = 'auto' | 'host' | 'tpm2' | 'host+tpm2';

export interface SystemdCredsOptions {
    /** Credential name, as in LoadCredentialEncrypted=<name>. */
    name?: string;
    /** TPM-only binding: the provider is reported as `tpm`. */
    tpm?: boolean;
    env?: NodeJS.ProcessEnv;
    /** A KEK already in memory, from create(). */
    kek?: Buffer;
}

export interface SystemdCredsCreateOptions extends SystemdCredsOptions {
    /** Where the encrypted credential goes. Default /etc/credstore.encrypted/<name>. */
    outputPath?: string;
    exec?: KeyExec;
}

/**
 * Reads the KEK that systemd decrypted into $CREDENTIALS_DIRECTORY at service
 * start (LoadCredentialEncrypted=). systemd binds the credential to the host
 * key and/or the TPM2 chip, so a copied disk or credential cannot open it.
 */
export class SystemdCredsStore extends KekKeyStore {
    readonly name: string;
    private readonly env: NodeJS.ProcessEnv;

    constructor(options: SystemdCredsOptions = {}) {
        const tpm = !!options.tpm;
        super(
            tpm ? TPM_PROVIDER : SYSTEMD_CREDS_PROVIDER,
            Buffer.from(tpm ? 'NDT1' : 'NDS1', 'ascii'),
            Buffer.from(tpm ? 'nalamdesk:tpm:v1' : 'nalamdesk:systemd-creds:v1', 'utf8'),
            options.kek
        );
        this.name = options.name ?? DEFAULT_CREDENTIAL_NAME;
        if (!CREDENTIAL_NAME.test(this.name)) throw new Error('CONFIG_INVALID: credential names use letters, digits, ".", "_" and "-".');
        this.env = options.env ?? process.env;
    }

    /**
     * Generates a KEK, encrypts it with `systemd-creds encrypt`, decrypts it
     * again to prove the round trip, and returns a store holding the KEK. The
     * service reads it from $CREDENTIALS_DIRECTORY after the next restart.
     */
    static create(options: SystemdCredsCreateOptions = {}): SystemdCredsStore {
        const name = options.name ?? DEFAULT_CREDENTIAL_NAME;
        if (!CREDENTIAL_NAME.test(name)) throw new Error('CONFIG_INVALID: credential names use letters, digits, ".", "_" and "-".');
        const outputPath = options.outputPath ?? path.join(DEFAULT_CREDSTORE_DIR, name);
        if (fs.existsSync(outputPath)) throw new Error(`${outputPath} already exists. Choose a new credential name or path.`);
        const exec = options.exec ?? defaultKeyExec;
        const withKey: SystemdCredsKeyMode = options.tpm ? 'tpm2' : 'auto';
        const kek = crypto.randomBytes(KEK_LENGTH);
        let sealed: Buffer;
        try {
            sealed = exec('systemd-creds', ['encrypt', `--name=${name}`, `--with-key=${withKey}`, '-', '-'], kek);
        } catch (error) {
            kek.fill(0);
            throw commandError('systemd-creds encrypt', error);
        }
        let roundTrip: Buffer;
        try {
            roundTrip = exec('systemd-creds', ['decrypt', `--name=${name}`, '-', '-'], sealed);
        } catch (error) {
            kek.fill(0);
            throw commandError('systemd-creds decrypt', error);
        }
        if (roundTrip.length !== KEK_LENGTH || !crypto.timingSafeEqual(roundTrip, kek)) {
            kek.fill(0);
            throw new Error('ENCRYPTION_UNAVAILABLE: systemd-creds did not return the key it encrypted.');
        }
        roundTrip.fill(0);
        writeNewFile(outputPath, sealed);
        const store = new SystemdCredsStore({ ...options, name, kek });
        kek.fill(0);
        return store;
    }

    protected problem(): string | null {
        const dir = this.env['CREDENTIALS_DIRECTORY'];
        if (!dir) {
            return `ENCRYPTION_UNAVAILABLE: CREDENTIALS_DIRECTORY is not set. Run the server under systemd with LoadCredentialEncrypted=${this.name}.`;
        }
        if (!fs.existsSync(path.join(dir, this.name))) {
            return `ENCRYPTION_UNAVAILABLE: credential ${this.name} was not loaded. Add LoadCredentialEncrypted=${this.name} to the service unit.`;
        }
        return null;
    }

    protected loadKek(): Buffer {
        return fs.readFileSync(path.join(this.env['CREDENTIALS_DIRECTORY']!, this.name));
    }
}

/* ------------------------------------------------------------------ */
/* Windows DPAPI                                                       */
/* ------------------------------------------------------------------ */

const DPAPI_ENTROPY = 'nalamdesk:dpapi:v1';

function dpapiScript(operation: 'Protect' | 'Unprotect'): string {
    return [
        '$ErrorActionPreference = "Stop"',
        'Add-Type -AssemblyName System.Security',
        '$data = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())',
        `$entropy = [Text.Encoding]::UTF8.GetBytes("${DPAPI_ENTROPY}")`,
        `$out = [Security.Cryptography.ProtectedData]::${operation}($data, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)`,
        '[Console]::Out.Write([Convert]::ToBase64String($out))'
    ].join('; ');
}

function runDpapi(exec: KeyExec, operation: 'Protect' | 'Unprotect', value: Buffer): Buffer {
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', dpapiScript(operation)];
    let stdout: Buffer;
    try {
        stdout = exec('powershell.exe', args, Buffer.from(value.toString('base64'), 'ascii'));
    } catch (error) {
        throw commandError(`DPAPI ${operation.toLowerCase()}`, error);
    }
    return Buffer.from(stdout.toString('ascii').trim(), 'base64');
}

export interface DpapiOptions {
    platform?: NodeJS.Platform;
    exec?: KeyExec;
    kek?: Buffer;
}

/**
 * A KEK wrapped by Windows DPAPI for the service account (CurrentUser scope),
 * stored in a blob file. Only that account on that machine can unwrap it.
 */
export class DpapiStore extends KekKeyStore {
    private readonly platform: NodeJS.Platform;
    private readonly exec: KeyExec;

    constructor(private readonly blobPath: string, options: DpapiOptions = {}) {
        super(DPAPI_PROVIDER, Buffer.from('NDW1', 'ascii'), Buffer.from('nalamdesk:dpapi:v1', 'utf8'), options.kek);
        this.platform = options.platform ?? process.platform;
        this.exec = options.exec ?? defaultKeyExec;
    }

    /** Generates a KEK, wraps it with DPAPI, checks the round trip and writes the blob. */
    static create(blobPath: string, options: DpapiOptions = {}): DpapiStore {
        const platform = options.platform ?? process.platform;
        if (platform !== 'win32') throw new Error('ENCRYPTION_UNAVAILABLE: DPAPI is only available on Windows.');
        if (fs.existsSync(blobPath)) throw new Error(`${blobPath} already exists. Choose a new path.`);
        const exec = options.exec ?? defaultKeyExec;
        const kek = crypto.randomBytes(KEK_LENGTH);
        try {
            const blob = runDpapi(exec, 'Protect', kek);
            const roundTrip = runDpapi(exec, 'Unprotect', blob);
            const same = roundTrip.length === KEK_LENGTH && crypto.timingSafeEqual(roundTrip, kek);
            roundTrip.fill(0);
            if (!same) throw new Error('ENCRYPTION_UNAVAILABLE: DPAPI did not return the key it protected.');
            writeNewFile(blobPath, blob);
            return new DpapiStore(blobPath, { ...options, kek });
        } finally {
            kek.fill(0);
        }
    }

    protected problem(): string | null {
        if (this.platform !== 'win32') return 'ENCRYPTION_UNAVAILABLE: DPAPI is only available on Windows.';
        if (!fs.existsSync(this.blobPath)) return `ENCRYPTION_UNAVAILABLE: DPAPI key blob not found at ${this.blobPath}.`;
        return null;
    }

    protected loadKek(): Buffer {
        return runDpapi(this.exec, 'Unprotect', fs.readFileSync(this.blobPath));
    }
}

/* ------------------------------------------------------------------ */
/* KMS through a key command                                           */
/* ------------------------------------------------------------------ */

/**
 * Splits a command line into argv without a shell: whitespace separates,
 * single or double quotes group, a backslash escapes the next character
 * outside single quotes.
 */
export function splitCommand(command: string): string[] {
    const args: string[] = [];
    let current = '';
    let inArg = false;
    let quote: '"' | "'" | null = null;
    for (let i = 0; i < command.length; i++) {
        const ch = command[i];
        if (quote) {
            if (ch === quote) quote = null;
            else if (ch === '\\' && quote === '"' && i + 1 < command.length) current += command[++i];
            else current += ch;
        } else if (ch === '"' || ch === "'") {
            quote = ch;
            inArg = true;
        } else if (ch === '\\' && i + 1 < command.length) {
            current += command[++i];
            inArg = true;
        } else if (/\s/.test(ch)) {
            if (inArg) args.push(current);
            current = '';
            inArg = false;
        } else {
            current += ch;
            inArg = true;
        }
    }
    if (quote) throw new Error('CONFIG_INVALID: the key command has an unclosed quote.');
    if (inArg) args.push(current);
    return args;
}

/** Accepts 32 raw bytes, 64 hex characters or base64 of 32 bytes. */
export function parseKeyOutput(stdout: Buffer): Buffer {
    if (stdout.length === KEK_LENGTH) return Buffer.from(stdout);
    const text = stdout.toString('utf8').trim();
    if (/^[0-9a-fA-F]{64}$/.test(text)) return Buffer.from(text, 'hex');
    if (/^[A-Za-z0-9+/]{43}=$/.test(text)) return Buffer.from(text, 'base64');
    throw new Error('ENCRYPTION_UNAVAILABLE: the key command must print a 32-byte key as raw bytes, hex or base64.');
}

export interface KeyCommandOptions {
    exec?: KeyExec;
}

/**
 * Runs an admin-supplied command that prints the KEK, such as a KMS decrypt
 * of a wrapped data key (`aws kms decrypt`, `gcloud kms decrypt`, Vault
 * transit). The plaintext KEK lives only in this process's memory.
 */
export class KeyCommandStore extends KekKeyStore {
    private readonly argv: string[];
    private readonly exec: KeyExec;

    constructor(command: string, options: KeyCommandOptions = {}) {
        super(KMS_PROVIDER, Buffer.from('NDM1', 'ascii'), Buffer.from('nalamdesk:kms:v1', 'utf8'));
        this.argv = splitCommand(command ?? '');
        this.exec = options.exec ?? defaultKeyExec;
    }

    protected problem(): string | null {
        return this.argv.length ? null : 'ENCRYPTION_UNAVAILABLE: no key command is configured. Set NALAMDESK_KEY_COMMAND.';
    }

    protected loadKek(): Buffer {
        let stdout: Buffer;
        try {
            stdout = this.exec(this.argv[0], this.argv.slice(1));
        } catch (error) {
            throw commandError('the key command', error);
        }
        try {
            return parseKeyOutput(stdout);
        } finally {
            stdout.fill(0);
        }
    }
}
