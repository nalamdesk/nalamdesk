import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    DpapiStore, KeyCommandStore, SystemdCredsStore, parseKeyOutput, splitCommand,
    type KeyExec
} from './ExternalKeyStores';

/** A stand-in for systemd-creds and DPAPI: "encrypts" by prefixing and reversing. */
const fakeSeal = (value: Buffer) => Buffer.concat([Buffer.from('SEALED:'), Buffer.from(value).reverse()]);
const fakeOpen = (value: Buffer) => {
    if (!value.subarray(0, 7).equals(Buffer.from('SEALED:'))) throw Object.assign(new Error('fail'), { stderr: Buffer.from('Failed to decrypt\n') });
    return Buffer.from(value.subarray(7)).reverse();
};

const systemdExec: KeyExec = (file, args, input) => {
    expect(file).toBe('systemd-creds');
    return args[0] === 'encrypt' ? fakeSeal(input!) : fakeOpen(input!);
};

const dpapiExec: KeyExec = (file, args, input) => {
    expect(file).toBe('powershell.exe');
    const value = Buffer.from(input!.toString('ascii'), 'base64');
    const script = args[args.length - 1];
    const out = script.includes('::Protect(') ? fakeSeal(value) : fakeOpen(value);
    return Buffer.from(out.toString('base64'), 'ascii');
};

describe('external key providers', () => {
    let directory: string;
    beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nalamdesk-ext-')); });
    afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

    describe('SystemdCredsStore', () => {
        it('creates an encrypted credential, then opens values once systemd loads it', () => {
            const outputPath = path.join(directory, 'credstore', 'nalamdesk-vault-key');
            const exec = vi.fn(systemdExec);
            const created = SystemdCredsStore.create({ outputPath, exec });
            expect(exec.mock.calls[0][1]).toEqual(['encrypt', '--name=nalamdesk-vault-key', '--with-key=auto', '-', '-']);
            if (process.platform !== 'win32') expect(fs.statSync(outputPath).mode & 0o777).toBe(0o600);
            const sealed = created.protect(Buffer.from('dek'));
            expect(created.status()).toEqual({ available: true, provider: 'systemd-creds' });

            // After a restart systemd decrypts the credential into CREDENTIALS_DIRECTORY.
            const credDir = path.join(directory, 'run');
            fs.mkdirSync(credDir);
            fs.writeFileSync(path.join(credDir, 'nalamdesk-vault-key'), fakeOpen(fs.readFileSync(outputPath)));
            const loaded = new SystemdCredsStore({ env: { CREDENTIALS_DIRECTORY: credDir } });
            expect(loaded.unprotect(sealed).toString()).toBe('dek');
        });

        it('binds tpm mode to tpm2 and keeps its payloads apart from host-key ones', () => {
            const exec = vi.fn(systemdExec);
            const tpm = SystemdCredsStore.create({ tpm: true, outputPath: path.join(directory, 'tpm'), exec });
            expect(exec.mock.calls[0][1]).toContain('--with-key=tpm2');
            expect(tpm.status().provider).toBe('tpm');
            const host = SystemdCredsStore.create({ outputPath: path.join(directory, 'host'), exec });
            expect(() => host.unprotect(tpm.protect(Buffer.from('x')))).toThrow('INVALID_PROTECTED_PAYLOAD');
        });

        it('explains a missing credential and refuses bad names, existing files and failed round trips', () => {
            expect(new SystemdCredsStore({ env: {} }).status().message).toMatch(/CREDENTIALS_DIRECTORY is not set/);
            expect(new SystemdCredsStore({ env: { CREDENTIALS_DIRECTORY: directory } }).status().message)
                .toMatch(/LoadCredentialEncrypted=nalamdesk-vault-key/);
            expect(() => new SystemdCredsStore({ name: '../etc/passwd' })).toThrow(/credential names/);

            fs.writeFileSync(path.join(directory, 'taken'), 'x');
            expect(() => SystemdCredsStore.create({ outputPath: path.join(directory, 'taken'), exec: systemdExec })).toThrow(/already exists/);

            const failing: KeyExec = () => { throw Object.assign(new Error('exit 1'), { stderr: Buffer.from('No TPM2 device found.\n') }); };
            expect(() => SystemdCredsStore.create({ outputPath: path.join(directory, 'a'), exec: failing }))
                .toThrow('ENCRYPTION_UNAVAILABLE: systemd-creds encrypt failed: No TPM2 device found.');

            const lying: KeyExec = (_f, args, input) => args[0] === 'encrypt' ? fakeSeal(input!) : crypto.randomBytes(32);
            expect(() => SystemdCredsStore.create({ outputPath: path.join(directory, 'b'), exec: lying })).toThrow(/did not return the key/);
            expect(fs.existsSync(path.join(directory, 'b'))).toBe(false);
        });

        it('rejects a loaded credential of the wrong size', () => {
            fs.writeFileSync(path.join(directory, 'nalamdesk-vault-key'), 'short');
            const store = new SystemdCredsStore({ env: { CREDENTIALS_DIRECTORY: directory } });
            expect(() => store.protect(Buffer.from('x'))).toThrow(/not 32 bytes/);
        });
    });

    describe('DpapiStore', () => {
        it('wraps a key with DPAPI and unwraps it in a later process', () => {
            const blobPath = path.join(directory, 'vault.dpapi');
            const created = DpapiStore.create(blobPath, { platform: 'win32', exec: dpapiExec });
            const sealed = created.protect(Buffer.from('dek'));
            const exec = vi.fn(dpapiExec);
            const later = new DpapiStore(blobPath, { platform: 'win32', exec });
            expect(later.status()).toEqual({ available: true, provider: 'dpapi' });
            expect(later.unprotect(sealed).toString()).toBe('dek');
            later.unprotect(sealed);
            expect(exec).toHaveBeenCalledTimes(1);
            later.clear();
            later.unprotect(sealed);
            expect(exec).toHaveBeenCalledTimes(2);
        });

        it('is Windows only and needs its blob', () => {
            expect(() => DpapiStore.create(path.join(directory, 'x'), { platform: 'linux', exec: dpapiExec })).toThrow(/only available on Windows/);
            expect(new DpapiStore(path.join(directory, 'x'), { platform: 'linux' }).status().available).toBe(false);
            expect(new DpapiStore(path.join(directory, 'x'), { platform: 'win32' }).status().message).toMatch(/blob not found/);
        });
    });

    describe('KeyCommandStore', () => {
        it('runs the command without a shell and accepts base64, hex or raw keys', () => {
            const key = crypto.randomBytes(32);
            const exec = vi.fn<KeyExec>(() => Buffer.from(`${key.toString('base64')}\n`));
            const store = new KeyCommandStore(`aws kms decrypt --ciphertext-blob "fileb:///etc/nalamdesk/key.enc" --query Plaintext --output text`, { exec });
            const sealed = store.protect(Buffer.from('dek'));
            expect(exec.mock.calls[0]).toEqual(['aws', ['kms', 'decrypt', '--ciphertext-blob', 'fileb:///etc/nalamdesk/key.enc', '--query', 'Plaintext', '--output', 'text']]);
            const viaHex = new KeyCommandStore('vault-key', { exec: () => Buffer.from(key.toString('hex')) });
            expect(viaHex.unprotect(sealed).toString()).toBe('dek');
            const viaRaw = new KeyCommandStore('vault-key', { exec: () => Buffer.from(key) });
            expect(viaRaw.unprotect(sealed).toString()).toBe('dek');
            expect(() => new KeyCommandStore('k', { exec: () => crypto.randomBytes(32) }).unprotect(sealed)).toThrow(/DEVICE_UNLOCK_FAILED/);
        });

        it('reports a missing command, failures and malformed output', () => {
            expect(new KeyCommandStore('  ').status().message).toMatch(/NALAMDESK_KEY_COMMAND/);
            const failing = new KeyCommandStore('kms', { exec: () => { throw Object.assign(new Error('x'), { stderr: Buffer.from('AccessDenied\n') }); } });
            expect(() => failing.protect(Buffer.from('x'))).toThrow('ENCRYPTION_UNAVAILABLE: the key command failed: AccessDenied');
            expect(() => parseKeyOutput(Buffer.from('not a key'))).toThrow(/32-byte key/);
        });

        it('splits command lines with quotes and escapes', () => {
            expect(splitCommand(`a 'b c' "d \\"e\\"" f\\ g ''`)).toEqual(['a', 'b c', 'd "e"', 'f g', '']);
            expect(() => splitCommand(`a "b`)).toThrow(/unclosed quote/);
        });
    });
});
