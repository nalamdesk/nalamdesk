import * as fs from 'fs';
import * as path from 'path';
import { KEY_FILE_PROVIDER, PASSPHRASE_PROVIDER } from '../../main/services/HeadlessKeyStores';
import {
    DEFAULT_CREDENTIAL_NAME, DEFAULT_CREDSTORE_DIR, DPAPI_PROVIDER, KMS_PROVIDER, SYSTEMD_CREDS_PROVIDER, TPM_PROVIDER
} from '../../main/services/ExternalKeyStores';
import { PROD_API_PORT } from '../../shared/runtime-config';

/**
 * NalamDesk Server configuration (ADR 0001). One optional JSON file, then
 * environment variables, which win. Secrets (passphrases, admin passwords)
 * never come from the JSON file: only from a file path or the environment.
 */
export interface ServerConfig {
    dataDir: string;
    dbPath: string;
    host: string;
    port: number;
    staticPath: string;
    keyProvider: KeyProviderConfig;
}

export type KeyProviderConfig =
    | { provider: typeof KEY_FILE_PROVIDER; keyPath: string }
    | { provider: typeof PASSPHRASE_PROVIDER }
    /** credentialPath is where `init` writes a new encrypted credential. */
    | { provider: typeof SYSTEMD_CREDS_PROVIDER | typeof TPM_PROVIDER; credentialName: string; credentialPath: string }
    | { provider: typeof DPAPI_PROVIDER; blobPath: string }
    | { provider: typeof KMS_PROVIDER; command: string };

export const KEY_PROVIDERS = [
    KEY_FILE_PROVIDER, PASSPHRASE_PROVIDER, SYSTEMD_CREDS_PROVIDER, TPM_PROVIDER, DPAPI_PROVIDER, KMS_PROVIDER
] as const;

export interface ConfigFile {
    dataDir?: string;
    host?: string;
    port?: number;
    staticPath?: string;
    keyProvider?: string;
    keyFile?: string;
    credentialName?: string;
    credentialPath?: string;
    dpapiBlob?: string;
    keyCommand?: string;
}

export const DEFAULT_DATA_DIR = process.platform === 'win32'
    ? path.join(process.env['ProgramData'] || 'C:\\ProgramData', 'NalamDesk', 'server')
    : '/var/lib/nalamdesk';

const CONFIG_KEYS = new Set([
    'dataDir', 'host', 'port', 'staticPath', 'keyProvider', 'keyFile', 'credentialName', 'credentialPath', 'dpapiBlob', 'keyCommand'
]);
const SECRET_KEYS = /pass(word|phrase)?|secret|token/i;

export interface LoadConfigOptions {
    env?: NodeJS.ProcessEnv;
    configPath?: string;
    cwd?: string;
    defaultStaticPath?: string;
    readFile?: (file: string) => string;
}

export function readConfigFile(file: string, readFile: (file: string) => string = (f) => fs.readFileSync(f, 'utf8')): ConfigFile {
    let parsed: unknown;
    try {
        parsed = JSON.parse(readFile(file));
    } catch (error: any) {
        throw new Error(`CONFIG_INVALID: could not read ${file}: ${error?.message ?? error}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`CONFIG_INVALID: ${file} must hold a JSON object.`);
    }
    for (const key of Object.keys(parsed)) {
        if (SECRET_KEYS.test(key)) {
            throw new Error(`CONFIG_INVALID: ${key} is a secret. Pass it through a file path or the environment, not the config file.`);
        }
        if (!CONFIG_KEYS.has(key)) throw new Error(`CONFIG_INVALID: unknown setting "${key}" in ${file}.`);
    }
    return parsed as ConfigFile;
}

function parsePortValue(value: unknown, source: string): number {
    const port = typeof value === 'number' ? value : Number(String(value).trim());
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`CONFIG_INVALID: ${source} must be a port between 1 and 65535.`);
    }
    return port;
}

export function loadServerConfig(options: LoadConfigOptions = {}): ServerConfig {
    const env = options.env ?? process.env;
    const cwd = options.cwd ?? process.cwd();
    const configPath = options.configPath ?? env['NALAMDESK_CONFIG'];
    const file: ConfigFile = configPath ? readConfigFile(path.resolve(cwd, configPath), options.readFile) : {};
    const baseDir = configPath ? path.dirname(path.resolve(cwd, configPath)) : cwd;
    const resolve = (value: string) => path.resolve(baseDir, value);

    const dataDir = env['NALAMDESK_DATA_DIR']
        ? path.resolve(cwd, env['NALAMDESK_DATA_DIR'])
        : file.dataDir ? resolve(file.dataDir) : DEFAULT_DATA_DIR;

    const host = env['NALAMDESK_HOST'] || file.host || '0.0.0.0';
    const port = env['NALAMDESK_PORT'] !== undefined && env['NALAMDESK_PORT'] !== ''
        ? parsePortValue(env['NALAMDESK_PORT'], 'NALAMDESK_PORT')
        : file.port !== undefined ? parsePortValue(file.port, 'port') : PROD_API_PORT;

    const staticPath = env['NALAMDESK_STATIC_PATH']
        ? path.resolve(cwd, env['NALAMDESK_STATIC_PATH'])
        : file.staticPath ? resolve(file.staticPath)
            : options.defaultStaticPath ?? path.join(__dirname, '..', '..', '..', 'nalamdesk', 'browser');

    const providerName = env['NALAMDESK_KEY_PROVIDER'] || file.keyProvider || KEY_FILE_PROVIDER;
    const keyProvider = resolveKeyProvider(providerName, { env, file, cwd, dataDir, resolve });

    return {
        dataDir,
        dbPath: path.join(dataDir, 'nalamdesk.db'),
        host,
        port,
        staticPath,
        keyProvider
    };
}

interface ProviderContext {
    env: NodeJS.ProcessEnv;
    file: ConfigFile;
    cwd: string;
    dataDir: string;
    resolve: (value: string) => string;
}

function resolveKeyProvider(providerName: string, { env, file, cwd, dataDir, resolve }: ProviderContext): KeyProviderConfig {
    /** An environment path wins over a config-file path (resolved next to the file), then the default. */
    const pathSetting = (envName: string, fileValue: string | undefined, fallback: string) =>
        env[envName] ? path.resolve(cwd, env[envName]!) : fileValue ? resolve(fileValue) : fallback;

    switch (providerName) {
        case KEY_FILE_PROVIDER:
            return { provider: KEY_FILE_PROVIDER, keyPath: pathSetting('NALAMDESK_KEY_FILE', file.keyFile, path.join(dataDir, 'vault.key')) };
        case PASSPHRASE_PROVIDER:
            return { provider: PASSPHRASE_PROVIDER };
        case SYSTEMD_CREDS_PROVIDER:
        case TPM_PROVIDER: {
            const credentialName = env['NALAMDESK_CREDENTIAL_NAME'] || file.credentialName || DEFAULT_CREDENTIAL_NAME;
            const credentialPath = pathSetting('NALAMDESK_CREDENTIAL_PATH', file.credentialPath, path.join(DEFAULT_CREDSTORE_DIR, credentialName));
            return { provider: providerName, credentialName, credentialPath };
        }
        case DPAPI_PROVIDER:
            return { provider: DPAPI_PROVIDER, blobPath: pathSetting('NALAMDESK_DPAPI_BLOB', file.dpapiBlob, path.join(dataDir, 'vault.dpapi')) };
        case KMS_PROVIDER: {
            const command = env['NALAMDESK_KEY_COMMAND'] || file.keyCommand;
            if (!command?.trim()) throw new Error('CONFIG_INVALID: the kms provider needs a key command. Set NALAMDESK_KEY_COMMAND or keyCommand.');
            return { provider: KMS_PROVIDER, command };
        }
        default:
            throw new Error(`CONFIG_INVALID: unknown key provider "${providerName}". Use one of: ${KEY_PROVIDERS.join(', ')}.`);
    }
}

/**
 * Reads a secret from `<NAME>_FILE` (preferred, works with Docker and systemd
 * credentials) or `<NAME>`. Trailing newlines from files are dropped.
 */
export function readSecretFromEnv(
    name: string,
    env: NodeJS.ProcessEnv = process.env,
    readFile: (file: string) => string = (f) => fs.readFileSync(f, 'utf8')
): string | undefined {
    const filePath = env[`${name}_FILE`];
    if (filePath) return readFile(filePath).replace(/\r?\n$/, '');
    const value = env[name];
    return value === undefined || value === '' ? undefined : value;
}
