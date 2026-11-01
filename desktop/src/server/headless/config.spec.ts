import { describe, expect, it } from 'vitest';
import * as path from 'path';
import { loadServerConfig, readConfigFile, readSecretFromEnv } from './config';

const files = (map: Record<string, string>) => (file: string) => {
    if (!(file in map)) throw new Error(`ENOENT ${file}`);
    return map[file];
};

describe('loadServerConfig', () => {
    it('defaults to a key file in the data directory on the standard port', () => {
        const config = loadServerConfig({ env: { NALAMDESK_DATA_DIR: '/srv/nd' }, cwd: '/', defaultStaticPath: '/ui' });
        expect(config).toEqual({
            dataDir: '/srv/nd',
            dbPath: path.join('/srv/nd', 'nalamdesk.db'),
            host: '0.0.0.0',
            port: 3000,
            staticPath: '/ui',
            keyProvider: { provider: 'key-file', keyPath: path.join('/srv/nd', 'vault.key') }
        });
    });

    it('reads a config file, resolving paths next to it, and lets the environment win', () => {
        const readFile = files({
            '/etc/nalamdesk/server.json': JSON.stringify({ dataDir: 'data', port: 8443, keyFile: 'keys/vault.key', host: '127.0.0.1' })
        });
        const fromFile = loadServerConfig({ env: {}, configPath: '/etc/nalamdesk/server.json', readFile, cwd: '/' });
        expect(fromFile.dataDir).toBe('/etc/nalamdesk/data');
        expect(fromFile.port).toBe(8443);
        expect(fromFile.host).toBe('127.0.0.1');
        expect(fromFile.keyProvider).toEqual({ provider: 'key-file', keyPath: '/etc/nalamdesk/keys/vault.key' });

        const overridden = loadServerConfig({
            env: { NALAMDESK_CONFIG: '/etc/nalamdesk/server.json', NALAMDESK_PORT: '9000', NALAMDESK_KEY_PROVIDER: 'passphrase' },
            readFile, cwd: '/'
        });
        expect(overridden.port).toBe(9000);
        expect(overridden.keyProvider).toEqual({ provider: 'passphrase' });
    });

    it('rejects secrets, unknown settings, bad ports and unsupported providers', () => {
        const readFile = files({
            '/a.json': JSON.stringify({ passphrase: 'x' }),
            '/b.json': JSON.stringify({ adminPassword: 'x' }),
            '/c.json': JSON.stringify({ dataDri: '/x' }),
            '/d.json': '[1]',
            '/e.json': '{not json'
        });
        expect(() => readConfigFile('/a.json', readFile)).toThrow(/is a secret/);
        expect(() => readConfigFile('/b.json', readFile)).toThrow(/is a secret/);
        expect(() => readConfigFile('/c.json', readFile)).toThrow(/unknown setting "dataDri"/);
        expect(() => readConfigFile('/d.json', readFile)).toThrow(/JSON object/);
        expect(() => readConfigFile('/e.json', readFile)).toThrow(/could not read/);
        expect(() => loadServerConfig({ env: { NALAMDESK_PORT: '70000' } })).toThrow(/port between/);
        expect(() => loadServerConfig({ env: { NALAMDESK_KEY_PROVIDER: 'hsm' } })).toThrow(/unknown key provider "hsm"/);
        expect(() => loadServerConfig({ env: { NALAMDESK_KEY_PROVIDER: 'kms' } })).toThrow(/needs a key command/);
    });
});

describe('external key providers', () => {
    const load = (env: NodeJS.ProcessEnv, readFile?: (file: string) => string, configPath?: string) =>
        loadServerConfig({ env: { NALAMDESK_DATA_DIR: '/srv/nd', ...env }, cwd: '/', defaultStaticPath: '/ui', readFile, configPath }).keyProvider;

    it('configures systemd credentials and TPM with a default credential name and store', () => {
        expect(load({ NALAMDESK_KEY_PROVIDER: 'systemd-creds' })).toEqual({
            provider: 'systemd-creds', credentialName: 'nalamdesk-vault-key', credentialPath: '/etc/credstore.encrypted/nalamdesk-vault-key'
        });
        expect(load({ NALAMDESK_KEY_PROVIDER: 'tpm', NALAMDESK_CREDENTIAL_NAME: 'nd-key' })).toEqual({
            provider: 'tpm', credentialName: 'nd-key', credentialPath: '/etc/credstore.encrypted/nd-key'
        });
    });

    it('configures DPAPI and KMS from the config file', () => {
        const readFile = files({
            '/etc/nd/dpapi.json': JSON.stringify({ keyProvider: 'dpapi', dpapiBlob: 'keys/vault.dpapi' }),
            '/etc/nd/kms.json': JSON.stringify({ keyProvider: 'kms', keyCommand: 'aws kms decrypt --query Plaintext' })
        });
        expect(load({}, readFile, '/etc/nd/dpapi.json')).toEqual({ provider: 'dpapi', blobPath: '/etc/nd/keys/vault.dpapi' });
        expect(load({ NALAMDESK_KEY_PROVIDER: 'dpapi' })).toEqual({ provider: 'dpapi', blobPath: path.join('/srv/nd', 'vault.dpapi') });
        expect(load({}, readFile, '/etc/nd/kms.json')).toEqual({ provider: 'kms', command: 'aws kms decrypt --query Plaintext' });
        expect(load({ NALAMDESK_KEY_COMMAND: 'vault-key' }, readFile, '/etc/nd/kms.json')).toEqual({ provider: 'kms', command: 'vault-key' });
    });
});

describe('readSecretFromEnv', () => {
    it('prefers the _FILE variant and drops one trailing newline', () => {
        const readFile = files({ '/run/secrets/pw': 'from-file\n' });
        expect(readSecretFromEnv('PW', { PW_FILE: '/run/secrets/pw', PW: 'from-env' }, readFile)).toBe('from-file');
        expect(readSecretFromEnv('PW', { PW: 'from-env' }, readFile)).toBe('from-env');
        expect(readSecretFromEnv('PW', { PW: '' }, readFile)).toBeUndefined();
    });
});
