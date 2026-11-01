import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { DeviceKeyStore } from '../../main/services/DeviceKeyStore';
import type { KeySlotSummary } from '../../main/services/SecurityService';
import { parseArgs, runCli, type CliDatabase, type CliDeps, type CliIO, type CliVault } from './cli';

/** A vault that records what the CLI asked of it; slots carry their store. */
class FakeVault implements CliVault {
    static state = { setup: false, slots: [] as { id: string; provider: string; label?: string; store: DeviceKeyStore }[], pending: null as string | null };
    unlockedWith: string | null = null;
    constructor(readonly store: DeviceKeyStore) { }
    isSetup() { return { isSetup: FakeVault.state.setup, vaultState: FakeVault.state.setup ? 'ready' : 'not-setup' }; }
    reconcileProvisioning() { }
    async initializeDevice() {
        const probe = Buffer.from('probe');
        for (const slot of FakeVault.state.slots) {
            try {
                if (slot.store.unprotect(this.store.protect(probe)).equals(probe) && slot.provider === this.store.status().provider) {
                    this.unlockedWith = slot.id;
                    return {};
                }
            } catch { /* next slot */ }
        }
        throw new Error('DEVICE_UNLOCK_FAILED');
    }
    getDb() { return { open: true }; }
    closeDb() { this.unlockedWith = null; }
    listKeySlots(): KeySlotSummary[] {
        return [
            ...FakeVault.state.slots.map((slot, index) => ({
                id: slot.id, provider: slot.provider, ...(slot.label ? { label: slot.label } : {}),
                kind: index === 0 ? 'primary' as const : 'slot' as const,
                removable: FakeVault.state.slots.length > 1, unlockedWith: slot.id === this.unlockedWith
            })),
            { id: 'recovery', provider: 'recovery-code', kind: 'recovery', removable: false, unlockedWith: false }
        ];
    }
    addKeySlot(store: DeviceKeyStore, label?: string) {
        const id = `slot${FakeVault.state.slots.length}`.padEnd(16, '0');
        FakeVault.state.slots.push({ id, provider: store.status().provider, label, store });
        return this.listKeySlots().find((slot) => slot.id === id)!;
    }
    removeKeySlot(id: string) {
        if (id === 'recovery') throw new Error('RECOVERY_SLOT_REQUIRED');
        FakeVault.state.slots = FakeVault.state.slots.filter((slot) => slot.id !== id);
    }
    getPendingRecoveryCode() { return FakeVault.state.pending; }
    acknowledgePendingRecoveryCode(code: string) {
        if (code !== FakeVault.state.pending) throw new Error('INVALID_RECOVERY_ACK');
        FakeVault.state.pending = null;
    }
}

function makeIo(env: NodeJS.ProcessEnv, answers: string[] = [], interactive = false) {
    const out: string[] = [];
    const err: string[] = [];
    const io: CliIO = {
        out: (line) => out.push(line),
        err: (line) => err.push(line),
        interactive,
        prompt: vi.fn(async () => {
            if (!answers.length) throw new Error('unexpected prompt');
            return answers.shift()!;
        }),
        env
    };
    return { io, out, err };
}

describe('nalamdesk-server CLI', () => {
    let directory: string;
    let env: NodeJS.ProcessEnv;
    let audits: string[];
    let started: { port: number; closed: boolean } | null;
    let deps: CliDeps;

    beforeEach(() => {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nalamdesk-cli-'));
        env = { NALAMDESK_DATA_DIR: path.join(directory, 'data'), NALAMDESK_PORT: '3999' };
        FakeVault.state = { setup: false, slots: [], pending: null };
        audits = [];
        started = null;
        const database = (): CliDatabase => ({
            setDb: () => { },
            migrate: async () => { },
            logAudit: (action, _t, _r, _u, details) => { audits.push(`${action}: ${details}`); }
        });
        deps = {
            createVault: (store) => new FakeVault(store),
            createDatabase: database,
            provision: async (vault) => {
                FakeVault.state.setup = true;
                FakeVault.state.slots.push({ id: 'primary', provider: (vault as FakeVault).store.status().provider, store: (vault as FakeVault).store });
                FakeVault.state.pending = 'AAAA-BBBB';
                return 'AAAA-BBBB';
            },
            importBackup: async (vault, _d, _backup, code) => {
                if (code !== 'RCVR-CODE') throw new Error('INVALID_RECOVERY_CODE');
                FakeVault.state.setup = true;
                FakeVault.state.slots.push({ id: 'primary', provider: (vault as FakeVault).store.status().provider, store: (vault as FakeVault).store });
            },
            startServer: async (_v, _d, _s, config) => {
                started = { port: config.port, closed: false };
                return { close: async () => { started!.closed = true; } };
            },
            waitForShutdown: async () => { }
        };
    });
    afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

    it('parses commands, flags and --flag=value', () => {
        const args = parseArgs(['key', 'add', '--provider', 'key-file', '--label=Rack 2', '--force']);
        expect(args.positional).toEqual(['key', 'add']);
        expect(Object.fromEntries(args.flags)).toEqual({ provider: 'key-file', label: 'Rack 2', force: true });
    });

    it('init creates a key file, provisions, prints the recovery code and audits', async () => {
        fs.writeFileSync(path.join(directory, 'pw'), 'a-strong-admin-password\n');
        const { io, out } = makeIo({ ...env, NALAMDESK_ADMIN_PASSWORD_FILE: path.join(directory, 'pw') });
        const provision = vi.spyOn(deps, 'provision');
        expect(await runCli(['init', '--clinic-name', 'Asha Clinic'], io, deps)).toBe(0);
        expect(fs.statSync(path.join(directory, 'data', 'vault.key')).size).toBe(32);
        expect(provision.mock.calls[0][2]).toBe('a-strong-admin-password');
        expect(provision.mock.calls[0][3]).toEqual({ clinic_name: 'Asha Clinic' });
        expect(out.join('\n')).toContain('Recovery code:  AAAA-BBBB');
        expect(out.join('\n')).toContain('recovery confirm');
        expect(audits).toEqual(['VAULT_INIT: Server vault created with key-file']);
        expect(FakeVault.state.pending).toBe('AAAA-BBBB');
    });

    it('init confirms the recovery code in a terminal', async () => {
        const { io } = makeIo(env, ['a-strong-admin-password', 'a-strong-admin-password', 'aaaa-bbbb'], true);
        expect(await runCli(['init'], io, deps)).toBe(0);
        expect(FakeVault.state.pending).toBeNull();
    });

    it('init refuses weak admin passwords, missing secrets without a terminal, and an existing vault', async () => {
        const weak = makeIo({ ...env, NALAMDESK_ADMIN_PASSWORD: 'short' });
        expect(await runCli(['init'], weak.io, deps)).toBe(1);
        expect(weak.err.join()).toMatch(/at least 12 characters/);

        const headless = makeIo(env);
        expect(await runCli(['init'], headless.io, deps)).toBe(1);
        expect(headless.err.join()).toMatch(/NALAMDESK_ADMIN_PASSWORD_FILE/);

        FakeVault.state.setup = true;
        const again = makeIo({ ...env, NALAMDESK_ADMIN_PASSWORD: 'a-strong-admin-password' });
        const provision = vi.spyOn(deps, 'provision');
        expect(await runCli(['init'], again.io, deps)).toBe(1);
        expect(again.err.join()).toMatch(/already exists/);
        expect(provision).not.toHaveBeenCalled();
    });

    it('import restores a desktop backup with the recovery code, onto the server key provider', async () => {
        const backup = path.join(directory, 'clinic.ndbackup');
        fs.writeFileSync(backup, 'bundle');
        const importBackup = vi.spyOn(deps, 'importBackup');
        const { io, out } = makeIo({ ...env, NALAMDESK_RECOVERY_CODE: ' rcvr-code ' });
        expect(await runCli(['import', backup], io, deps)).toBe(0);
        expect(importBackup.mock.calls[0][2]).toBe(backup);
        expect(importBackup.mock.calls[0][3]).toBe('RCVR-CODE');
        expect(fs.statSync(path.join(directory, 'data', 'vault.key')).size).toBe(32);
        expect(audits).toEqual(['VAULT_IMPORT: Imported desktop backup clinic.ndbackup; unlocks with key-file']);
        expect(out.join('\n')).toMatch(/same one the clinic already has/);

        // The imported vault now starts with the server's key file.
        expect(await runCli(['start'], makeIo(env).io, deps)).toBe(0);
        expect(started?.closed).toBe(true);
    });

    it('import shows and confirms a new recovery code when the backup needed one', async () => {
        const backup = path.join(directory, 'old.ndbackup');
        fs.writeFileSync(backup, 'bundle');
        deps.importBackup = async (vault) => {
            FakeVault.state.setup = true;
            FakeVault.state.slots.push({ id: 'primary', provider: 'key-file', store: (vault as FakeVault).store });
            FakeVault.state.pending = 'NEWC-ODEX';
        };
        const { io, out } = makeIo(env, ['RCVR-CODE', 'newc-odex'], true);
        expect(await runCli(['import', backup], io, deps)).toBe(0);
        expect(out.join('\n')).toContain('New recovery code:  NEWC-ODEX');
        expect(FakeVault.state.pending).toBeNull();
    });

    it('import refuses a wrong recovery code, a missing file, no code without a terminal, and an existing vault', async () => {
        const backup = path.join(directory, 'clinic.ndbackup');
        fs.writeFileSync(backup, 'bundle');
        const wrong = makeIo({ ...env, NALAMDESK_RECOVERY_CODE: 'NOPE-NOPE' });
        expect(await runCli(['import', backup], wrong.io, deps)).toBe(1);
        expect(wrong.err.join()).toMatch(/does not open this backup/);

        const missing = makeIo({ ...env, NALAMDESK_RECOVERY_CODE: 'RCVR-CODE' });
        expect(await runCli(['import', path.join(directory, 'nope.ndbackup')], missing.io, deps)).toBe(1);
        expect(missing.err.join()).toMatch(/does not exist/);

        const usage = makeIo(env);
        expect(await runCli(['import'], usage.io, deps)).toBe(2);

        const headless = makeIo(env);
        expect(await runCli(['import', backup], headless.io, deps)).toBe(1);
        expect(headless.err.join()).toMatch(/NALAMDESK_RECOVERY_CODE_FILE/);

        FakeVault.state.setup = true;
        const importBackup = vi.spyOn(deps, 'importBackup');
        const again = makeIo({ ...env, NALAMDESK_RECOVERY_CODE: 'RCVR-CODE' });
        expect(await runCli(['import', backup], again.io, deps)).toBe(1);
        expect(again.err.join()).toMatch(/already exists/);
        expect(importBackup).not.toHaveBeenCalled();
    });

    it('start unlocks, serves until shutdown, warns about an unconfirmed recovery code, then closes', async () => {
        await runCli(['init'], makeIo({ ...env, NALAMDESK_ADMIN_PASSWORD: 'a-strong-admin-password' }).io, deps);
        const { io, out, err } = makeIo(env);
        expect(await runCli([], io, deps)).toBe(0);
        expect(started).toEqual({ port: 3999, closed: true });
        expect(out.join('\n')).toContain('listening on 0.0.0.0:3999');
        expect(err.join('\n')).toMatch(/recovery code has not been confirmed/);
    });

    it('start explains a key that does not open the vault, and a missing vault', async () => {
        const missing = makeIo(env);
        fs.mkdirSync(path.join(directory, 'data'), { recursive: true });
        fs.writeFileSync(path.join(directory, 'data', 'vault.key'), Buffer.alloc(32), { mode: 0o600 });
        expect(await runCli(['start'], missing.io, deps)).toBe(1);
        expect(missing.err.join()).toMatch(/Run `nalamdesk-server init` first/);

        fs.rmSync(path.join(directory, 'data', 'vault.key'));
        await runCli(['init'], makeIo({ ...env, NALAMDESK_ADMIN_PASSWORD: 'a-strong-admin-password' }).io, deps);
        const wrong = makeIo({ ...env, NALAMDESK_KEY_PROVIDER: 'passphrase', NALAMDESK_PASSPHRASE: 'not the right one' });
        expect(await runCli(['start'], wrong.io, deps)).toBe(1);
        expect(wrong.err.join()).toMatch(/does not open the vault/);
        expect(started).toBeNull();
    });

    it('key add, list and remove manage slots and audit each change', async () => {
        await runCli(['init'], makeIo({ ...env, NALAMDESK_ADMIN_PASSWORD: 'a-strong-admin-password' }).io, deps);

        const add = makeIo({ ...env, NALAMDESK_NEW_PASSPHRASE: 'correct horse battery staple' });
        expect(await runCli(['key', 'add', '--provider', 'passphrase', '--label', 'Night shift'], add.io, deps)).toBe(0);
        const newKey = path.join(directory, 'second.key');
        expect(await runCli(['key', 'add', '--provider', 'key-file', '--key-file', newKey], makeIo(env).io, deps)).toBe(0);
        expect(fs.existsSync(newKey)).toBe(true);

        const viaPassphrase = makeIo({ ...env, NALAMDESK_KEY_PROVIDER: 'passphrase', NALAMDESK_PASSPHRASE: 'correct horse battery staple' });
        expect(await runCli(['key', 'list'], viaPassphrase.io, deps)).toBe(0);
        expect(viaPassphrase.out.join('\n')).toMatch(/passphrase\s+"Night shift"\s+\(unlocked with this\)/);

        const slotId = FakeVault.state.slots[1].id;
        expect(await runCli(['key', 'remove', slotId], makeIo(env).io, deps)).toBe(0);
        expect(FakeVault.state.slots.map((slot) => slot.id)).not.toContain(slotId);
        expect(audits.slice(1)).toEqual([
            `KEY_SLOT_ADD: Added passphrase unlock method ${slotId}`,
            expect.stringMatching(/^KEY_SLOT_ADD: Added key-file unlock method/),
            `KEY_SLOT_REMOVE: Removed passphrase unlock method ${slotId}`
        ]);
    });

    it('key add refuses an existing key file path, short passphrases and unknown providers', async () => {
        await runCli(['init'], makeIo({ ...env, NALAMDESK_ADMIN_PASSWORD: 'a-strong-admin-password' }).io, deps);
        const existing = path.join(directory, 'data', 'vault.key');
        const clash = makeIo(env);
        expect(await runCli(['key', 'add', '--provider', 'key-file', '--key-file', existing], clash.io, deps)).toBe(1);
        expect(clash.err.join()).toMatch(/already exists/);
        const short = makeIo({ ...env, NALAMDESK_NEW_PASSPHRASE: 'short' });
        expect(await runCli(['key', 'add', '--provider', 'passphrase'], short.io, deps)).toBe(1);
        const unknown = makeIo(env);
        expect(await runCli(['key', 'add', '--provider', 'hsm'], unknown.io, deps)).toBe(1);
        expect(unknown.err.join()).toMatch(/one of: key-file, passphrase, systemd-creds, tpm, dpapi, kms/);
        expect(FakeVault.state.slots).toHaveLength(1);
    });

    it('init and start with a KMS key command, and add a systemd credential slot', async () => {
        const kek = Buffer.alloc(32, 7).toString('hex');
        deps.keyExec = vi.fn((file: string, args: string[], input?: Buffer) => {
            if (file === 'kms-decrypt') return Buffer.from(`${kek}\n`);
            // systemd-creds: "encrypt" and "decrypt" are both the identity here.
            expect(file).toBe('systemd-creds');
            return Buffer.from(input!);
        });
        const kmsEnv = { ...env, NALAMDESK_KEY_PROVIDER: 'kms', NALAMDESK_KEY_COMMAND: 'kms-decrypt --key "alias/nalamdesk"' };
        expect(await runCli(['init'], makeIo({ ...kmsEnv, NALAMDESK_ADMIN_PASSWORD: 'a-strong-admin-password' }).io, deps)).toBe(0);
        expect(audits).toEqual(['VAULT_INIT: Server vault created with kms']);
        expect(await runCli(['start'], makeIo(kmsEnv).io, deps)).toBe(0);
        expect(started).toEqual({ port: 3999, closed: true });

        const credentialPath = path.join(directory, 'credstore', 'nd-key');
        const add = makeIo(kmsEnv);
        expect(await runCli(['key', 'add', '--provider', 'systemd-creds', '--credential-name', 'nd-key', '--credential-path', credentialPath], add.io, deps)).toBe(0);
        expect(add.out.join('\n')).toContain(`LoadCredentialEncrypted=nd-key:${credentialPath}`);
        expect(fs.statSync(credentialPath).size).toBe(32);

        // After a restart under systemd, the credential alone opens the vault.
        const credDir = path.join(directory, 'run');
        fs.mkdirSync(credDir);
        fs.copyFileSync(credentialPath, path.join(credDir, 'nd-key'));
        const viaCreds = makeIo({ ...env, NALAMDESK_KEY_PROVIDER: 'systemd-creds', NALAMDESK_CREDENTIAL_NAME: 'nd-key', CREDENTIALS_DIRECTORY: credDir });
        expect(await runCli(['key', 'list'], viaCreds.io, deps)).toBe(0);
        expect(viaCreds.out.join('\n')).toMatch(/systemd-creds\s+\(unlocked with this\)/);

        // key add never reuses the loaded credential: a TPM slot under the same name gets its own key.
        const tpmPath = path.join(directory, 'credstore', 'nd-key-tpm');
        const tpmAdd = makeIo({ ...env, NALAMDESK_KEY_PROVIDER: 'systemd-creds', NALAMDESK_CREDENTIAL_NAME: 'nd-key', CREDENTIALS_DIRECTORY: credDir });
        expect(await runCli(['key', 'add', '--provider', 'tpm', '--credential-name', 'nd-key', '--credential-path', tpmPath], tpmAdd.io, deps)).toBe(0);
        expect(tpmAdd.out.join('\n')).toContain('(sealed to this TPM)');
        expect(fs.readFileSync(tpmPath).equals(fs.readFileSync(credentialPath))).toBe(false);
    });

    it('init with systemd credentials writes the credential and names the unit line', async () => {
        deps.keyExec = (_file, _args, input) => Buffer.from(input!);
        const credentialPath = path.join(directory, 'credstore', 'nalamdesk-vault-key');
        const { io, out } = makeIo({ ...env, NALAMDESK_KEY_PROVIDER: 'tpm', NALAMDESK_CREDENTIAL_PATH: credentialPath, NALAMDESK_ADMIN_PASSWORD: 'a-strong-admin-password' });
        expect(await runCli(['init'], io, deps)).toBe(0);
        expect(out.join('\n')).toContain('(sealed to this TPM)');
        expect(out.join('\n')).toContain(`LoadCredentialEncrypted=nalamdesk-vault-key:${credentialPath}`);
        expect(FakeVault.state.slots[0].provider).toBe('tpm');
    });

    it('key add refuses DPAPI off Windows and a KMS slot without a command', async () => {
        await runCli(['init'], makeIo({ ...env, NALAMDESK_ADMIN_PASSWORD: 'a-strong-admin-password' }).io, deps);
        const dpapi = makeIo(env);
        expect(await runCli(['key', 'add', '--provider', 'dpapi', '--dpapi-blob', path.join(directory, 'k.dpapi')], dpapi.io, deps)).toBe(1);
        expect(dpapi.err.join()).toMatch(process.platform === 'win32' ? /DPAPI/ : /only available on Windows/);
        const kms = makeIo(env);
        expect(await runCli(['key', 'add', '--provider', 'kms'], kms.io, deps)).toBe(1);
        expect(kms.err.join()).toMatch(/--key-command/);
        expect(FakeVault.state.slots).toHaveLength(1);
    });

    it('status reconciles an interrupted init before reporting', async () => {
        const reconcile = vi.spyOn(FakeVault.prototype, 'reconcileProvisioning');
        const isSetup = vi.spyOn(FakeVault.prototype, 'isSetup');
        const { io, out } = makeIo(env);
        await runCli(['status'], io, deps);
        expect(reconcile).toHaveBeenCalledWith(path.join(directory, 'data', 'nalamdesk.db'), path.join(directory, 'data'));
        expect(reconcile.mock.invocationCallOrder[0]).toBeLessThan(isSetup.mock.invocationCallOrder[0]);
        expect(out.join('\n')).toContain('Data directory:');
        reconcile.mockRestore();
        isSetup.mockRestore();
    });

    it('prints usage for help and unknown commands', async () => {
        const help = makeIo(env);
        expect(await runCli(['help'], help.io, deps)).toBe(0);
        expect(help.out.join()).toContain('Usage: nalamdesk-server');
        const unknown = makeIo(env);
        expect(await runCli(['frobnicate'], unknown.io, deps)).toBe(2);
    });
});
