import * as fs from 'fs';
import * as path from 'path';
import type { DeviceKeyStore } from '../../main/services/DeviceKeyStore';
import {
    KEY_FILE_PROVIDER,
    KeyFileStore,
    PASSPHRASE_MIN_LENGTH,
    PASSPHRASE_PROVIDER,
    PassphraseKeyStore
} from '../../main/services/HeadlessKeyStores';
import {
    DEFAULT_CREDENTIAL_NAME,
    DEFAULT_CREDSTORE_DIR,
    DPAPI_PROVIDER,
    DpapiStore,
    KMS_PROVIDER,
    KeyCommandStore,
    SYSTEMD_CREDS_PROVIDER,
    SystemdCredsStore,
    TPM_PROVIDER,
    type KeyExec
} from '../../main/services/ExternalKeyStores';
import type { KeySlotSummary } from '../../main/services/SecurityService';
import { KEY_PROVIDERS, loadServerConfig, readSecretFromEnv, type KeyProviderConfig, type ServerConfig } from './config';

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
    /** Restores a desktop backup bundle into an empty data directory and unlocks it. */
    importBackup(vault: CliVault, database: CliDatabase, backupPath: string, recoveryCode: string,
        store: DeviceKeyStore, config: ServerConfig): Promise<void>;
    startServer(vault: CliVault, database: CliDatabase, store: DeviceKeyStore, config: ServerConfig, io: CliIO): Promise<RunningServer>;
    /** Resolves when the process is asked to stop. */
    waitForShutdown(): Promise<void>;
    /** Runs systemd-creds, PowerShell (DPAPI) and key commands. Tests replace it. */
    keyExec?: KeyExec;
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
  import <backup.ndbackup>       Move a single-PC clinic onto this server from its backup.
  key list                       List the ways this vault can be unlocked.
  key add --provider key-file --key-file <path> [--label <text>]
  key add --provider passphrase [--label <text>]
  key add --provider systemd-creds|tpm [--credential-name <name>] [--credential-path <path>]
  key add --provider dpapi --dpapi-blob <path>
  key add --provider kms --key-command <command>
  key remove <slot-id>           Remove an unlock method.
  recovery confirm               Confirm you saved the recovery code.

Options:
  --config <file>                JSON config file (or NALAMDESK_CONFIG).

Environment:
  NALAMDESK_DATA_DIR, NALAMDESK_HOST, NALAMDESK_PORT, NALAMDESK_STATIC_PATH,
  NALAMDESK_KEY_PROVIDER (key-file | passphrase | systemd-creds | tpm | dpapi | kms),
  NALAMDESK_KEY_FILE, NALAMDESK_PASSPHRASE_FILE or NALAMDESK_PASSPHRASE,
  NALAMDESK_CREDENTIAL_NAME, NALAMDESK_CREDENTIAL_PATH, NALAMDESK_DPAPI_BLOB,
  NALAMDESK_KEY_COMMAND,
  NALAMDESK_ADMIN_PASSWORD_FILE or NALAMDESK_ADMIN_PASSWORD (init only),
  NALAMDESK_RECOVERY_CODE_FILE or NALAMDESK_RECOVERY_CODE (import only).`;

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

function credentialUnitLine(name: string, credentialPath: string): string {
    return path.dirname(credentialPath) === DEFAULT_CREDSTORE_DIR && path.basename(credentialPath) === name
        ? `LoadCredentialEncrypted=${name}`
        : `LoadCredentialEncrypted=${name}:${credentialPath}`;
}

function assertAvailable(store: DeviceKeyStore): DeviceKeyStore {
    const status = store.status();
    if (!status.available) throw new Error(status.message || `The ${status.provider} key is not usable.`);
    return store;
}

/**
 * Builds a key store for a provider. `create` makes new key material (a key
 * file, an encrypted systemd credential, a DPAPI blob) when none exists yet.
 */
async function buildKeyStore(provider: KeyProviderConfig, io: CliIO, exec: KeyExec | undefined,
    options: { create: boolean; passphraseEnv: string; reuseLoaded?: boolean }): Promise<DeviceKeyStore> {
    switch (provider.provider) {
        case KEY_FILE_PROVIDER: {
            if (options.create && !fs.existsSync(provider.keyPath)) {
                const store = KeyFileStore.create(provider.keyPath);
                io.out(`Created key file ${provider.keyPath}. Back it up separately from the database, and keep disk encryption on.`);
                return store;
            }
            return assertAvailable(new KeyFileStore(provider.keyPath));
        }
        case PASSPHRASE_PROVIDER: {
            const passphrase = await readPassphrase(io, options.create, options.passphraseEnv);
            if (options.create && [...passphrase.normalize('NFKC')].length < PASSPHRASE_MIN_LENGTH) {
                throw new Error(`Use at least ${PASSPHRASE_MIN_LENGTH} characters.`);
            }
            return new PassphraseKeyStore(passphrase);
        }
        case SYSTEMD_CREDS_PROVIDER:
        case TPM_PROVIDER: {
            const tpm = provider.provider === TPM_PROVIDER;
            const loaded = new SystemdCredsStore({ name: provider.credentialName, tpm, env: io.env });
            if (!options.create) return assertAvailable(loaded);
            // init may adopt a credential the admin already loaded; key add always makes a new one.
            if (options.reuseLoaded && loaded.status().available) return loaded;
            const store = SystemdCredsStore.create({ name: provider.credentialName, tpm, env: io.env, outputPath: provider.credentialPath, exec });
            io.out(`Created encrypted credential ${provider.credentialPath}${tpm ? ' (sealed to this TPM)' : ''}.`);
            io.out(`Add \`${credentialUnitLine(provider.credentialName, provider.credentialPath)}\` to the nalamdesk-server service unit.`);
            return store;
        }
        case DPAPI_PROVIDER: {
            if (options.create && !fs.existsSync(provider.blobPath)) {
                const store = DpapiStore.create(provider.blobPath, { exec });
                io.out(`Created DPAPI key ${provider.blobPath}. Only this Windows account on this machine can open it.`);
                return store;
            }
            return assertAvailable(new DpapiStore(provider.blobPath, { exec }));
        }
        case KMS_PROVIDER:
            return assertAvailable(new KeyCommandStore(provider.command, { exec }));
    }
}

/** Opens the configured key store. `create` makes new key material on first init. */
export async function openKeyStore(config: ServerConfig, io: CliIO, options: { create?: boolean; exec?: KeyExec } = {}): Promise<DeviceKeyStore> {
    return buildKeyStore(config.keyProvider, io, options.exec, {
        create: !!options.create, passphraseEnv: 'NALAMDESK_PASSPHRASE', reuseLoaded: true
    });
}

/** The provider settings for `key add`, from flags. New key material is always created. */
async function newSlotProvider(args: ParsedArgs, io: CliIO): Promise<KeyProviderConfig> {
    const provider = flagString(args, 'provider');
    switch (provider) {
        case KEY_FILE_PROVIDER: {
            const keyPath = flagString(args, 'key-file');
            if (!keyPath) throw new Error('--key-file <path> is required: the new key file to create.');
            if (fs.existsSync(keyPath)) throw new Error(`${keyPath} already exists. Choose a new path.`);
            return { provider, keyPath: path.resolve(keyPath) };
        }
        case PASSPHRASE_PROVIDER:
            return { provider };
        case SYSTEMD_CREDS_PROVIDER:
        case TPM_PROVIDER: {
            const credentialName = flagString(args, 'credential-name') ?? DEFAULT_CREDENTIAL_NAME;
            const credentialPath = path.resolve(flagString(args, 'credential-path') ?? path.join(DEFAULT_CREDSTORE_DIR, credentialName));
            if (fs.existsSync(credentialPath)) throw new Error(`${credentialPath} already exists. Choose a new --credential-name or --credential-path.`);
            return { provider, credentialName, credentialPath };
        }
        case DPAPI_PROVIDER: {
            const blobPath = flagString(args, 'dpapi-blob');
            if (!blobPath) throw new Error('--dpapi-blob <path> is required: the new DPAPI key file to create.');
            if (fs.existsSync(blobPath)) throw new Error(`${blobPath} already exists. Choose a new path.`);
            return { provider, blobPath: path.resolve(blobPath) };
        }
        case KMS_PROVIDER: {
            const command = flagString(args, 'key-command') ?? io.env['NALAMDESK_NEW_KEY_COMMAND'];
            if (!command?.trim()) throw new Error('--key-command <command> is required: a command that prints the key.');
            return { provider, command };
        }
        default:
            throw new Error(`--provider must be one of: ${KEY_PROVIDERS.join(', ')}.`);
    }
}

async function unlock(config: ServerConfig, io: CliIO, deps: CliDeps): Promise<{ vault: CliVault; database: CliDatabase; store: DeviceKeyStore }> {
    const store = await openKeyStore(config, io, { exec: deps.keyExec });
    const vault = deps.createVault(store);
    vault.reconcileProvisioning(config.dbPath, config.dataDir);
    const state = vault.isSetup(config.dataDir);
    if (!state.isSetup) throw new Error('This server has no vault yet. Run `nalamdesk-server init` first.');
    try {
        await vault.initializeDevice(config.dbPath, config.dataDir);
    } catch (error: any) {
        if (error?.message === 'DEVICE_UNLOCK_FAILED') {
            throw new Error('DEVICE_UNLOCK_FAILED: this key provider does not open the vault. Check its key, or recover with the recovery code.');
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
    try {
        assertNoVault(config, deps);
    } catch (error: any) {
        io.err(error.message);
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

    const store = await openKeyStore(config, io, { create: true, exec: deps.keyExec });
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
    io.out('vault if its key or this machine is lost. It will not be shown again.');
    const confirmed = await confirmRecovery(vault, io);
    if (!confirmed) {
        io.out('Run `nalamdesk-server recovery confirm` once the code is stored.');
    }
    vault.closeDb();
    return 0;
}

/** Tells a missing file apart from one this account (the service user) cannot read. */
function assertReadable(file: string): void {
    try {
        fs.accessSync(file, fs.constants.R_OK);
    } catch (error: any) {
        if (error?.code === 'ENOENT') throw new Error(`${file} does not exist.`);
        throw new Error(`${file} is not readable by this account. Copy it to a folder the service user can read, such as /tmp, and make it readable.`);
    }
}

function assertNoVault(config: ServerConfig, deps: CliDeps): void {
    const probe = deps.createVault({ status: () => ({ available: true, provider: 'probe' }), protect: (v) => v, unprotect: (v) => v });
    probe.reconcileProvisioning(config.dbPath, config.dataDir);
    if (probe.isSetup(config.dataDir).isSetup) {
        throw new Error(`A vault already exists in ${config.dataDir}. Nothing was changed.`);
    }
}

async function cmdImport(args: ParsedArgs, config: ServerConfig, io: CliIO, deps: CliDeps): Promise<number> {
    const backupPath = args.positional[1];
    if (!backupPath) {
        io.err('Usage: nalamdesk-server import <backup.ndbackup>');
        return 2;
    }
    const resolvedBackup = path.resolve(backupPath);
    assertReadable(resolvedBackup);
    fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    assertNoVault(config, deps);

    let recoveryCode = readSecretFromEnv('NALAMDESK_RECOVERY_CODE', io.env);
    if (recoveryCode === undefined) {
        if (!io.interactive) throw new Error('Set NALAMDESK_RECOVERY_CODE_FILE, or run import in a terminal.');
        recoveryCode = await io.prompt('Recovery code of the clinic that made this backup: ', { secret: true });
    }
    recoveryCode = recoveryCode.trim().toUpperCase();
    if (!recoveryCode) throw new Error('The recovery code is required to open the backup.');

    const store = await openKeyStore(config, io, { create: true, exec: deps.keyExec });
    const vault = deps.createVault(store);
    const database = deps.createDatabase();
    try {
        await deps.importBackup(vault, database, resolvedBackup, recoveryCode, store, config);
    } catch (error: any) {
        if (error?.message === 'INVALID_RECOVERY_CODE') {
            throw new Error('INVALID_RECOVERY_CODE: that recovery code does not open this backup. Nothing was changed.');
        }
        if (error?.message === 'LEGACY_DATABASE_ONLY_BACKUP') {
            throw new Error('LEGACY_DATABASE_ONLY_BACKUP: this is an old database-only backup. Make a new backup from the desktop app (Settings, Backups) and import that.');
        }
        throw error;
    }
    try {
        database.setDb(vault.getDb());
        await database.migrate();
        database.logAudit('VAULT_IMPORT', 'vault', null, null,
            `Imported desktop backup ${path.basename(resolvedBackup)}; unlocks with ${store.status().provider}`);
        io.out(`Imported ${path.basename(resolvedBackup)} into ${config.dataDir}.`);
        io.out('Staff sign in with their existing accounts.');
        const freshCode = vault.getPendingRecoveryCode();
        if (freshCode) {
            // An old transition backup: the vault now has a new recovery code.
            io.out('');
            io.out(`  New recovery code:  ${freshCode}`);
            io.out('');
            io.out('This replaces the code you typed. Store it somewhere safe and offline. It will not be shown again.');
            const confirmed = await confirmRecovery(vault, io);
            if (!confirmed) io.out('Run `nalamdesk-server recovery confirm` once the new code is stored.');
        } else {
            io.out('The recovery code is the same one the clinic already has.');
        }
        io.out('Stop using the desktop copy for this clinic now, so records do not split between the two.');
    } finally {
        vault.closeDb();
    }
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
        io.err(`Usage: nalamdesk-server key list | key add --provider <${KEY_PROVIDERS.join('|')}> | key remove <slot-id>`);
        return 2;
    }
    const { vault, database } = await unlock(config, io, deps);
    try {
        if (action === 'list') {
            printSlots(io, vault.listKeySlots());
            return 0;
        }
        if (action === 'add') {
            const label = flagString(args, 'label');
            const provider = await newSlotProvider(args, io);
            const store = await buildKeyStore(provider, io, deps.keyExec, { create: true, passphraseEnv: 'NALAMDESK_NEW_PASSPHRASE' });
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
            case 'import': return await cmdImport(args, config, io, deps);
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
