import { describe, expect, it } from 'vitest';
import * as path from 'path';
import { DEFAULT_CREDENTIAL_NAME, DEFAULT_CREDSTORE_DIR } from '../../main/services/ExternalKeyStores';
import { loadServerConfig, readConfigFile, readSecretFromEnv } from './config';

/**
 * The server config resolves every path with path.resolve and path.join, so
 * on Windows '/etc/nd/server.json' becomes 'D:\etc\nd\server.json'. The
 * expected paths are built the same way here, so the same test runs on every
 * runner: `at('etc', 'nd', 'server.json')` is the file the code will ask for.
 */
const at = (...parts: string[]) => path.resolve('/', ...parts);

const files = (map: Record<string, string>) => (file: string) => {
    if (!(file in map)) throw new Error(`ENOENT ${file}`);
    return map[file];
};

describe('loadServerConfig', () => {
    it('defaults to a key file in the data directory on the standard port', () => {
        const dataDir = at('srv', 'nd');
        const config = loadServerConfig({ env: { NALAMDESK_DATA_DIR: '/srv/nd' }, cwd: '/', defaultStaticPath: '/ui' });
        expect(config).toEqual({
            dataDir,
            dbPath: path.join(dataDir, 'nalamdesk.db'),
            host: '0.0.0.0',
            port: 3000,
            staticPath: '/ui',
            keyProvider: { provider: 'key-file', keyPath: path.join(dataDir, 'vault.key') },
            offsiteBackup: null
        });
    });

    describe('off-site backup target', () => {
        const base = { NALAMDESK_DATA_DIR: '/srv/nd' };

        it('reads a folder target from the environment or next to the config file', () => {
            const fromEnv = loadServerConfig({ env: { ...base, NALAMDESK_OFFSITE_TARGET: 'folder', NALAMDESK_OFFSITE_PATH: 'mnt/nas' }, cwd: '/' });
            expect(fromEnv.offsiteBackup).toEqual({ kind: 'folder', path: at('mnt', 'nas') });

            const readFile = files({ [at('etc', 'nd', 'server.json')]: JSON.stringify({ offsiteTarget: 'folder', offsitePath: '../../media/usb' }) });
            const fromFile = loadServerConfig({ env: base, configPath: '/etc/nd/server.json', readFile, cwd: '/' });
            expect(fromFile.offsiteBackup).toEqual({ kind: 'folder', path: at('media', 'usb') });
        });

        it('rejects a folder target without a path or inside the data directory', () => {
            expect(() => loadServerConfig({ env: { ...base, NALAMDESK_OFFSITE_TARGET: 'folder' }, cwd: '/' }))
                .toThrow('needs a path');
            expect(() => loadServerConfig({ env: { ...base, NALAMDESK_OFFSITE_TARGET: 'folder', NALAMDESK_OFFSITE_PATH: '/srv/nd/backups2' }, cwd: '/' }))
                .toThrow('outside the data directory');
        });

        it('reads an S3 target with the secret from a file only', () => {
            const readFile = files({
                [at('etc', 'nd', 'server.json')]: JSON.stringify({
                    offsiteTarget: 's3', offsiteS3Endpoint: 'https://s3.example.com', offsiteS3Bucket: 'clinic',
                    offsiteS3Prefix: '/nalamdesk', offsiteS3AccessKeyId: 'AKID'
                }),
                '/run/secrets/s3': 'top-secret\n'
            });
            const config = loadServerConfig({
                env: { ...base, NALAMDESK_OFFSITE_S3_SECRET_ACCESS_KEY_FILE: '/run/secrets/s3' },
                configPath: '/etc/nd/server.json', readFile, cwd: '/'
            });
            expect(config.offsiteBackup).toEqual({
                kind: 's3', endpoint: 'https://s3.example.com', bucket: 'clinic', region: 'us-east-1',
                prefix: 'nalamdesk/', accessKeyId: 'AKID', secretAccessKey: 'top-secret'
            });
        });

        it('refuses the S3 secret in the config file and incomplete or unsafe S3 settings', () => {
            const s3 = {
                ...base, NALAMDESK_OFFSITE_TARGET: 's3', NALAMDESK_OFFSITE_S3_ENDPOINT: 'https://s3.example.com',
                NALAMDESK_OFFSITE_S3_BUCKET: 'clinic', NALAMDESK_OFFSITE_S3_ACCESS_KEY_ID: 'AKID'
            };
            expect(() => loadServerConfig({ env: s3, cwd: '/' })).toThrow('NALAMDESK_OFFSITE_S3_SECRET_ACCESS_KEY');
            const withSecret = { ...s3, NALAMDESK_OFFSITE_S3_SECRET_ACCESS_KEY: 'shh' };
            expect(loadServerConfig({ env: withSecret, cwd: '/' }).offsiteBackup).toMatchObject({ kind: 's3', secretAccessKey: 'shh', prefix: '' });
            expect(() => loadServerConfig({ env: { ...withSecret, NALAMDESK_OFFSITE_S3_BUCKET: '' }, cwd: '/' })).toThrow('NALAMDESK_OFFSITE_S3_BUCKET');
            expect(() => loadServerConfig({ env: { ...withSecret, NALAMDESK_OFFSITE_S3_ENDPOINT: 'ftp://x' }, cwd: '/' })).toThrow('https://');
            expect(() => loadServerConfig({ env: { ...withSecret, NALAMDESK_OFFSITE_S3_ENDPOINT: 'not a url' }, cwd: '/' })).toThrow('not a valid');
            expect(() => loadServerConfig({ env: { ...withSecret, NALAMDESK_OFFSITE_S3_ENDPOINT: 'https://a:b@s3.example.com' }, cwd: '/' }))
                .toThrow('not in the endpoint URL');

            const readFile = files({ [at('etc', 'nd', 'server.json')]: JSON.stringify({ offsiteS3SecretAccessKey: 'x' }) });
            expect(() => loadServerConfig({ env: base, configPath: '/etc/nd/server.json', readFile, cwd: '/' })).toThrow('is a secret');
        });

        it('rejects an unknown target', () => {
            expect(() => loadServerConfig({ env: { ...base, NALAMDESK_OFFSITE_TARGET: 'ftp' }, cwd: '/' })).toThrow('unknown off-site target');
        });
    });

    it('reads a config file, resolving paths next to it, and lets the environment win', () => {
        const readFile = files({
            [at('etc', 'nalamdesk', 'server.json')]: JSON.stringify({ dataDir: 'data', port: 8443, keyFile: 'keys/vault.key', host: '127.0.0.1' })
        });
        const fromFile = loadServerConfig({ env: {}, configPath: '/etc/nalamdesk/server.json', readFile, cwd: '/' });
        expect(fromFile.dataDir).toBe(at('etc', 'nalamdesk', 'data'));
        expect(fromFile.port).toBe(8443);
        expect(fromFile.host).toBe('127.0.0.1');
        expect(fromFile.keyProvider).toEqual({ provider: 'key-file', keyPath: at('etc', 'nalamdesk', 'keys', 'vault.key') });

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
            provider: 'systemd-creds', credentialName: DEFAULT_CREDENTIAL_NAME,
            credentialPath: path.join(DEFAULT_CREDSTORE_DIR, DEFAULT_CREDENTIAL_NAME)
        });
        expect(load({ NALAMDESK_KEY_PROVIDER: 'tpm', NALAMDESK_CREDENTIAL_NAME: 'nd-key' })).toEqual({
            provider: 'tpm', credentialName: 'nd-key', credentialPath: path.join(DEFAULT_CREDSTORE_DIR, 'nd-key')
        });
    });

    it('configures DPAPI and KMS from the config file', () => {
        const readFile = files({
            [at('etc', 'nd', 'dpapi.json')]: JSON.stringify({ keyProvider: 'dpapi', dpapiBlob: 'keys/vault.dpapi' }),
            [at('etc', 'nd', 'kms.json')]: JSON.stringify({ keyProvider: 'kms', keyCommand: 'aws kms decrypt --query Plaintext' })
        });
        expect(load({}, readFile, '/etc/nd/dpapi.json')).toEqual({ provider: 'dpapi', blobPath: at('etc', 'nd', 'keys', 'vault.dpapi') });
        expect(load({ NALAMDESK_KEY_PROVIDER: 'dpapi' })).toEqual({ provider: 'dpapi', blobPath: path.join(at('srv', 'nd'), 'vault.dpapi') });
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
