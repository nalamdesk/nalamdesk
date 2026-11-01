import * as fs from 'fs';
import type { DeviceKeyStore } from '../../main/services/DeviceKeyStore';
import {
    KEY_FILE_PROVIDER,
    KeyFileStore,
    PASSPHRASE_MIN_LENGTH,
    PASSPHRASE_PROVIDER,
    PassphraseKeyStore
} from '../../main/services/HeadlessKeyStores';
import type { KeySlotSummary } from '../../main/services/SecurityService';
import { loadServerConfig, readSecretFromEnv, type ServerConfig } from './config';

/**
 * `nalamdesk-server` commands (ADR 0001, #192). Everything the CLI touches is
 * injected so the command logic is tested without a native SQLCipher build.
 */

export const ADMIN_PASSWORD_MIN_LENGTH = 12;

export interface CliIO {
    out(line: string): void;
    err(line: string): void;
    /** True when a person can answer prompts. */
    interactive: boolean;
    prompt(question: string, options?: { secret?: boolean }): Promise<string>;
    env: NodeJS.ProcessEnv;
}

/** The slice of SecurityService the CLI uses. */
export interface CliVault {
    isSetup(dataDir: string): { isSetup: boolean; vaultState: string };
    reconcileProvisioning(dbPath: string, dataDir: string): void;
    initializeDevice(dbPath: string, dataDir: string): Promise<unknown>;
    getDb(): any;
    closeDb(): void;
    listKeySlots(): KeySlotSummary[];
    addKeySlot(store: DeviceKeyStore, label?: string): KeySlotSummary;
    removeKeySlot(id: string): void;
    getPendingRecoveryCode(): string | null;
    acknowledgePendingRecoveryCode(code: string): void;
}

/** The slice of DatabaseService the CLI uses. */
export interface CliDatabase {
    setDb(db: any): void;
    migrate(options?: { skipBackup?: boolean }): Promise<void>;
    logAudit(action: string, table: string, recordId: number | null, userId: number | null, details: string): void;
}

export interface RunningServer {
    close(): Promise<void>;
}

export interface CliDeps {
    createVault(store: DeviceKeyStore): CliVault;
    createDatabase(): CliDatabase;
    provision(vault: CliVault, database: CliDatabase, adminPassword: string, clinic: Record<string, unknown>,
        config: ServerConfig): Promise<string>;
    startServer(vault: CliVault, database: CliDatabase, store: DeviceKeyStore, config: ServerConfig, io: CliIO): Promise<RunningServer>;
    /** Resolves when the process is asked to stop. */
    waitForShutdown(): Promise<void>;
}

interface ParsedArgs {
    positional: string[];
    flags: Map<string, string | true>;
}

export function parseArgs(argv: string[]): ParsedArgs {
    const positional: string[] = [];
    const flags = new Map<string, string | true>();
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg.startsWith('--')) {
            const eq = arg.indexOf('=');
            if (eq !== -1) {
                flags.set(arg.slice(2, eq), arg.slice(eq + 1));
            } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
                flags.set(arg.slice(2), argv[++i]);
            } else {
                flags.set(arg.slice(2), true);
            }
        } else {
            positional.push(arg);
        }
    }
    return { positional, flags };
}

function flagString(args: ParsedArgs, name: string): string | undefined {
    const value = args.flags.get(name);
    if (value === true) throw new Error(`--${name} needs a value.`);
    return value;
}

export const USAGE = `Usage: nalamdesk-server <command> [options]

Commands:
  init [--clinic-name <name>]    Create the encrypted vault and the admin account.
  start                          Unlock the vault and serve clients (default).
  status                         Show whether the vault is set up.
  key list                       List the ways this vault can be unlocked.
  key add --provider key-file [--key-file <path>] [--label <text>]
  key add --provider passphrase [--label <text>]
  key remove <slot-id>           Remove an unlock method.
  recovery confirm               Confirm you saved the recovery code.

Options:
  --config <file>                JSON config file (or NALAMDESK_CONFIG).

Environment:
  NALAMDESK_DATA_DIR, NALAMDESK_HOST, NALAMDESK_PORT, NALAMDESK_STATIC_PATH,
  NALAMDESK_KEY_PROVIDER (key-file | passphrase), NALAMDESK_KEY_FILE,
  NALAMDESK_PASSPHRASE_FILE or NALAMDESK_PASSPHRASE,
  NALAMDESK_ADMIN_PASSWORD_FILE or NALAMDESK_ADMIN_PASSWORD (init only).`;

async function askTwice(io: CliIO, label: string): Promise<string> {
    const first = await io.prompt(`${label}: `, { secret: true });
    const second = await io.prompt(`Repeat ${label.toLowerCase()}: `, { secret: true });
    if (first !== second) throw new Error(`The two ${label.toLowerCase()} entries do not match.`);
    return first;
}

async function readPassphrase(io: CliIO, confirm: boolean, envName = 'NALAMDESK_PASSPHRASE'): Promise<string> {
    const fromEnv = readSecretFromEnv(envName, io.env);
    if (fromEnv !== undefined) return fromEnv;
    if (!io.interactive) {
        throw new Error(`The vault uses a passphrase. Set ${envName}_FILE, or run this command in a terminal.`);
    }
    return confirm ? askTwice(io, 'Vault passphrase') : io.prompt('Vault passphrase: ', { secret: true });
}

/** Opens the configured key store. `create` makes a key file on first init. */
export async function openKeyStore(config: ServerConfig, io: CliIO, options: { create?: boolean } = {}): Promise<DeviceKeyStore> {
    const provider = config.keyProvider;
    if (provider.provider === KEY_FILE_PROVIDER) {
        if (options.create && !fs.existsSync(provider.keyPath)) {
            const store = KeyFileStore.create(provider.keyPath);
            io.out(`Created key file ${provider.keyPath}. Back it up separately from the database, and keep disk encryption on.`);
            return store;
        }
        const store = new KeyFileStore(provider.keyPath);
        const status = store.status();
        if (!status.available) throw new Error(status.message || 'The key file is not usable.');
        return store;
    }
    const passphrase = await readPassphrase(io, !!options.create);
    return new PassphraseKeyStore(passphrase);
}

async function unlock(config: ServerConfig, io: CliIO, deps: CliDeps): Promise<{ vault: CliVault; database: CliDatabase; store: DeviceKeyStore }> {
    const store = await openKeyStore(config, io);
    const vault = deps.createVault(store);
    vault.reconcileProvisioning(config.dbPath, config.dataDir);
    const state = vault.isSetup(config.dataDir);
    if (!state.isSetup) throw new Error('This server has no vault yet. Run `nalamdesk-server init` first.');
    try {
        await vault.initializeDevice(config.dbPath, config.dataDir);
    } catch (error: any) {
        if (error?.message === 'DEVICE_UNLOCK_FAILED') {
            throw new Error('DEVICE_UNLOCK_FAILED: this key provider does not open the vault. Check the key file or passphrase, or recover with the recovery code.');
        }
        throw error;
    }
    const database = deps.createDatabase();
    database.setDb(vault.getDb());
    await database.migrate();
    return { vault, database, store };
}

function printSlots(io: CliIO, slots: KeySlotSummary[]): void {
    for (const slot of slots) {
        const parts = [slot.id.padEnd(16), slot.provider.padEnd(14)];
        parts.push(slot.label ? `"${slot.label}"` : '');
        if (slot.unlockedWith) parts.push('(unlocked with this)');
        if (!slot.removable) parts.push('(required)');
        io.out(parts.filter(Boolean).join('  '));
    }
}

async function confirmRecovery(vault: CliVault, io: CliIO): Promise<boolean> {
    const pending = vault.getPendingRecoveryCode();
    if (!pending) return true;
    if (!io.interactive) return false;
    const typed = (await io.prompt('Type the recovery code to confirm you saved it: ')).trim().toUpperCase();
    try {
        vault.acknowledgePendingRecoveryCode(typed);
        io.out('Recovery code confirmed.');
        return true;
    } catch {
        io.err('That code does not match. Run `nalamdesk-server recovery confirm` to try again.');
        return false;
    }
}

async function cmdInit(args: ParsedArgs, config: ServerConfig, io: CliIO, deps: CliDeps): Promise<number> {
    fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    const probe = deps.createVault({ status: () => ({ available: true, provider: 'probe' }), protect: (v) => v, unprotect: (v) => v });
    probe.reconcileProvisioning(config.dbPath, config.dataDir);
    if (probe.isSetup(config.dataDir).isSetup) {
        io.err(`A vault already exists in ${config.dataDir}. Nothing was changed.`);
        return 1;
    }

    let adminPassword = readSecretFromEnv('NALAMDESK_ADMIN_PASSWORD', io.env);
    if (adminPassword === undefined) {
        if (!io.interactive) throw new Error('Set NALAMDESK_ADMIN_PASSWORD_FILE, or run init in a terminal.');
        adminPassword = await askTwice(io, 'Admin password');
    }
    if ([...adminPassword].length < ADMIN_PASSWORD_MIN_LENGTH) {
        throw new Error(`The admin password needs at least ${ADMIN_PASSWORD_MIN_LENGTH} characters on a server.`);
    }

    const store = await openKeyStore(config, io, { create: true });
    const vault = deps.createVault(store);
    const database = deps.createDatabase();
    const clinicName = flagString(args, 'clinic-name');
    const recoveryCode = await deps.provision(vault, database, adminPassword, clinicName ? { clinic_name: clinicName } : {}, config);
    database.logAudit('VAULT_INIT', 'vault', null, null, `Server vault created with ${store.status().provider}`);

    io.out('');
    io.out('NalamDesk Server is set up. Sign in as "admin" with the password you chose.');
    io.out('');
    io.out(`  Recovery code:  ${recoveryCode}`);
    io.out('');
    io.out('Store the recovery code somewhere safe and offline. It is the only way to open this');
    io.out('vault if the key file, passphrase or machine is lost. It will not be shown again.');
    const confirmed = await confirmRecovery(vault, io);
    if (!confirmed) {
        io.out('Run `nalamdesk-server recovery confirm` once the code is stored.');
    }
    vault.closeDb();
    return 0;
}

async function cmdStart(config: ServerConfig, io: CliIO, deps: CliDeps): Promise<number> {
    const { vault, database, store } = await unlock(config, io, deps);
    if (vault.getPendingRecoveryCode()) {
        io.err('Warning: the recovery code has not been confirmed. Run `nalamdesk-server recovery confirm`.');
    }
    const server = await deps.startServer(vault, database, store, config, io);
    io.out(`NalamDesk Server listening on ${config.host}:${config.port} (data: ${config.dataDir}).`);
    await deps.waitForShutdown();
    io.out('Shutting down...');
    await server.close();
    vault.closeDb();
    return 0;
}

async function cmdStatus(config: ServerConfig, io: CliIO, deps: CliDeps): Promise<number> {
    const probe = deps.createVault({ status: () => ({ available: true, provider: 'probe' }), protect: (v) => v, unprotect: (v) => v });
    // Roll back an interrupted init first, so status never reports a half-made vault.
    probe.reconcileProvisioning(config.dbPath, config.dataDir);
    const state = probe.isSetup(config.dataDir);
    io.out(`Data directory: ${config.dataDir}`);
    io.out(`Vault: ${state.isSetup ? 'set up' : 'not set up'}`);
    io.out(`Key provider: ${config.keyProvider.provider}`);
    io.out(`Listen: ${config.host}:${config.port}`);
    return 0;
}

async function cmdKey(args: ParsedArgs, config: ServerConfig, io: CliIO, deps: CliDeps): Promise<number> {
    const action = args.positional[1];
    if (!['list', 'add', 'remove'].includes(action ?? '')) {
        io.err('Usage: nalamdesk-server key list | key add --provider <key-file|passphrase> | key remove <slot-id>');
        return 2;
    }
    const { vault, database } = await unlock(config, io, deps);
    try {
        if (action === 'list') {
            printSlots(io, vault.listKeySlots());
            return 0;
        }
        if (action === 'add') {
            const provider = flagString(args, 'provider');
            const label = flagString(args, 'label');
            let store: DeviceKeyStore;
            if (provider === KEY_FILE_PROVIDER) {
                const keyPath = flagString(args, 'key-file');
                if (!keyPath) throw new Error('--key-file <path> is required: the new key file to create.');
                if (fs.existsSync(keyPath)) throw new Error(`${keyPath} already exists. Choose a new path.`);
                store = KeyFileStore.create(keyPath);
            } else if (provider === PASSPHRASE_PROVIDER) {
                const passphrase = await readPassphrase(io, true, 'NALAMDESK_NEW_PASSPHRASE');
                if ([...passphrase.normalize('NFKC')].length < PASSPHRASE_MIN_LENGTH) {
                    throw new Error(`Use at least ${PASSPHRASE_MIN_LENGTH} characters.`);
                }
                store = new PassphraseKeyStore(passphrase);
            } else {
                throw new Error('--provider must be key-file or passphrase.');
            }
            const slot = vault.addKeySlot(store, label);
            database.logAudit('KEY_SLOT_ADD', 'vault', null, null, `Added ${slot.provider} unlock method ${slot.id}`);
            io.out(`Added ${slot.provider} slot ${slot.id}.`);
            return 0;
        }
        const id = args.positional[2];
        if (!id) throw new Error('Name the slot to remove. See `nalamdesk-server key list`.');
        const removed = vault.listKeySlots().find((slot) => slot.id === id);
        vault.removeKeySlot(id);
        database.logAudit('KEY_SLOT_REMOVE', 'vault', null, null, `Removed ${removed?.provider ?? 'unknown'} unlock method ${id}`);
        io.out(`Removed slot ${id}.`);
        return 0;
    } finally {
        vault.closeDb();
    }
}

async function cmdRecovery(args: ParsedArgs, config: ServerConfig, io: CliIO, deps: CliDeps): Promise<number> {
    if (args.positional[1] !== 'confirm') {
        io.err('Usage: nalamdesk-server recovery confirm');
        return 2;
    }
    if (!io.interactive) throw new Error('Run `recovery confirm` in a terminal.');
    const { vault } = await unlock(config, io, deps);
    try {
        if (!vault.getPendingRecoveryCode()) {
            io.out('There is no recovery code waiting for confirmation.');
            return 0;
        }
        return (await confirmRecovery(vault, io)) ? 0 : 1;
    } finally {
        vault.closeDb();
    }
}

export async function runCli(argv: string[], io: CliIO, deps: CliDeps): Promise<number> {
    let args: ParsedArgs;
    try {
        args = parseArgs(argv);
    } catch (error: any) {
        io.err(error.message);
        return 2;
    }
    const command = args.positional[0] ?? 'start';
    if (command === 'help' || args.flags.has('help')) {
        io.out(USAGE);
        return 0;
    }
    try {
        const config = loadServerConfig({ env: io.env, configPath: flagString(args, 'config') });
        switch (command) {
            case 'init': return await cmdInit(args, config, io, deps);
            case 'start': return await cmdStart(config, io, deps);
            case 'status': return await cmdStatus(config, io, deps);
            case 'key': return await cmdKey(args, config, io, deps);
            case 'recovery': return await cmdRecovery(args, config, io, deps);
            default:
                io.err(`Unknown command "${command}".`);
                io.err(USAGE);
                return 2;
        }
    } catch (error: any) {
        io.err(`Error: ${error?.message ?? error}`);
        return 1;
    }
}
