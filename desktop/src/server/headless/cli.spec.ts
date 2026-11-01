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
    let backupCalls: { created: string[]; restored: Array<[string, string]>; restoreError: Error | null };

    beforeEach(() => {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nalamdesk-cli-'));
        env = { NALAMDESK_DATA_DIR: path.join(directory, 'data'), NALAMDESK_PORT: '3999' };
        FakeVault.state = { setup: false, slots: [], pending: null };
        audits = [];
        started = null;
        backupCalls = { created: [], restored: [], restoreError: null };
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
            startServer: async (_v, _d, _s, config) => {
                started = { port: config.port, closed: false };
                return { close: async () => { started!.closed = true; } };
            },
            createBackups: () => ({
                createBackupBundle: async (destination) => {
                    backupCalls.created.push(destination);
                    return destination;
                },
                restoreLocalBackup: async (bundle, code) => {
                    if (backupCalls.restoreError) throw backupCalls.restoreError;
                    backupCalls.restored.push([bundle, code]);
                    return { preRestoreSnapshot: '/snap.ndbackup' };
                }
            }),
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
        expect(await runCli(['key', 'add', '--provider', 'tpm'], unknown.io, deps)).toBe(1);
        expect(unknown.err.join()).toMatch(/key-file or passphrase/);
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
    async function initVault() {
        const { io } = makeIo({ ...env, NALAMDESK_ADMIN_PASSWORD: 'a-strong-admin-password' });
        expect(await runCli(['init'], io, deps)).toBe(0);
        audits = [];
    }

    it('backup writes a bundle under the data directory by default and audits it', async () => {
        await initVault();
        const { io, out } = makeIo(env);
        expect(await runCli(['backup'], io, deps)).toBe(0);
        expect(backupCalls.created).toHaveLength(1);
        expect(backupCalls.created[0]).toMatch(/data[\\/]backups[\\/]nalamdesk-manual-backup-.*\.ndbackup$/);
        expect(out.join('\n')).toContain('recovery code');
        expect(audits[0]).toMatch(/^BACKUP_LOCAL: /);
    });

    it('backup honours --out and refuses to overwrite a file', async () => {
        await initVault();
        const target = path.join(directory, 'nightly.ndbackup');
        expect(await runCli(['backup', '--out', target], makeIo(env).io, deps)).toBe(0);
        expect(backupCalls.created).toEqual([target]);
        fs.writeFileSync(target, 'x');
        const clash = makeIo(env);
        expect(await runCli(['backup', '--out', target], clash.io, deps)).toBe(1);
        expect(clash.err.join()).toMatch(/already exists/);
    });

    it('restore replaces an existing vault with the recovery code from the environment', async () => {
        await initVault();
        const bundle = path.join(directory, 'clinic.ndbackup');
        fs.writeFileSync(bundle, 'bundle');
        const { io, out } = makeIo({ ...env, NALAMDESK_RECOVERY_CODE: ' cccc-dddd\n' });
        expect(await runCli(['restore', bundle], io, deps)).toBe(0);
        expect(backupCalls.restored).toEqual([[bundle, 'CCCC-DDDD']]);
        const printed = out.join('\n');
        expect(printed).toContain('/snap.ndbackup');
        expect(printed).toContain('key add');
        expect(audits[0]).toMatch(/^BACKUP_RESTORE: /);
    });

    it('restore onto an empty data directory creates the key file first', async () => {
        const bundle = path.join(directory, 'clinic.ndbackup');
        fs.writeFileSync(bundle, 'bundle');
        const { io } = makeIo(env, ['eeee-ffff'], true);
        expect(await runCli(['restore', bundle], io, deps)).toBe(0);
        expect(fs.existsSync(path.join(directory, 'data', 'vault.key'))).toBe(true);
        expect(backupCalls.restored).toEqual([[bundle, 'EEEE-FFFF']]);
    });

    it('restore checks its input, the recovery code and a running server', async () => {
        expect(await runCli(['restore'], makeIo(env).io, deps)).toBe(2);
        const missing = makeIo(env);
        expect(await runCli(['restore', path.join(directory, 'nope')], missing.io, deps)).toBe(1);
        expect(missing.err.join()).toMatch(/does not exist/);

        const bundle = path.join(directory, 'clinic.ndbackup');
        fs.writeFileSync(bundle, 'bundle');
        const headless = makeIo(env);
        expect(await runCli(['restore', bundle], headless.io, deps)).toBe(1);
        expect(headless.err.join()).toMatch(/NALAMDESK_RECOVERY_CODE_FILE/);

        backupCalls.restoreError = new Error('INVALID_RECOVERY_CODE');
        const wrong = makeIo({ ...env, NALAMDESK_RECOVERY_CODE: 'x' });
        expect(await runCli(['restore', bundle], wrong.io, deps)).toBe(1);
        expect(wrong.err.join()).toMatch(/does not open this backup/);

        fs.mkdirSync(path.join(directory, 'data'), { recursive: true });
        fs.writeFileSync(path.join(directory, 'data', 'server.pid'), String(process.ppid));
        const running = makeIo({ ...env, NALAMDESK_RECOVERY_CODE: 'x' });
        expect(await runCli(['restore', bundle], running.io, deps)).toBe(1);
        expect(running.err.join()).toMatch(/Stop the server/);
    });

    it('start holds a run lock while serving and refuses a second server', async () => {
        await initVault();
        const lock = path.join(directory, 'data', 'server.pid');
        deps.waitForShutdown = async () => {
            expect(fs.readFileSync(lock, 'utf8')).toBe(String(process.pid));
        };
        expect(await runCli(['start'], makeIo(env).io, deps)).toBe(0);
        expect(fs.existsSync(lock)).toBe(false);

        fs.writeFileSync(lock, String(process.ppid));
        const second = makeIo(env);
        expect(await runCli(['start'], second.io, deps)).toBe(1);
        expect(second.err.join()).toMatch(/already running/);

        fs.writeFileSync(lock, '999999999');
        expect(await runCli(['start'], makeIo(env).io, deps)).toBe(0);
    });
});
