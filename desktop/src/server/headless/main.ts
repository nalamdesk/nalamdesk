import * as readline from 'readline';
import { DatabaseService } from '../../main/services/DatabaseService';
import { ProvisioningService } from '../../main/services/ProvisioningService';
import { SecurityService } from '../../main/services/SecurityService';
import * as path from 'path';
import { BackupService, NO_UPLOADER } from '../../main/services/BackupService';
import type { DeviceKeyStore } from '../../main/services/DeviceKeyStore';
import { buildIdentityPath, readBuildIdentityFile } from '../../main/appVersionInfo';
import { getCloudServiceUrl } from '../../shared/runtime-config';
import { ApiServer } from '../app';
import { CLINIC_EVENT_TOPICS, createClinicServices } from '../runtime/clinicServices';
import { backupScheduleFollower, createBackupMethods, createCloudMethods } from '../runtime/clinicMethods';
import { ServerAuthStore } from '../auth-store';
import { buildNetworkOptions, issueJoinCode } from '../network';
import { describeServingState, pinOptions, readServingState, servingStateFrom, writeServingState } from './serving-state';
import { runCli, type CliDeps, type CliIO } from './cli';
import type { ServerConfig } from './config';
import { createOffsiteTarget } from './offsite';

// Vault files, backups and logs are readable by the service account only.
if (process.platform !== 'win32') process.umask(0o077);

function prompt(question: string, options: { secret?: boolean } = {}): Promise<string> {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
        if (options.secret) {
            // Echo nothing while a secret is typed.
            (rl as any)._writeToOutput = (text: string) => {
                if (text.includes(question)) process.stdout.write(question);
            };
        }
        rl.question(question, (answer) => {
            rl.close();
            if (options.secret) process.stdout.write('\n');
            resolve(answer);
        });
    });
}

const io: CliIO = {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    interactive: !!process.stdin.isTTY && !!process.stdout.isTTY,
    prompt,
    env: process.env
};

// dist/server/server/headless → the package root, where releases stamp build-identity.json.
const packageRoot = path.join(__dirname, '..', '..', '..', '..');
const buildIdentity = readBuildIdentityFile(buildIdentityPath(packageRoot));
const appVersion = buildIdentity?.version ?? process.env['npm_package_version'] ?? 'unknown';

function createBackups(vault: SecurityService, database: DatabaseService, store: DeviceKeyStore, config: ServerConfig): BackupService {
    // Backups live in the data directory, with an optional off-site copy (#216).
    return new BackupService(database, NO_UPLOADER, vault, config.dataDir, {
        appVersion,
        offsite: config.offsiteBackup ? createOffsiteTarget(config.offsiteBackup) : null,
        // Restore validation must not reconfigure or close the live vault.
        createIsolatedSecurityService: () => new SecurityService(store),
        onRestoreCommitted: () => undefined
    });
}

const deps: CliDeps = {
    createVault: (store) => new SecurityService(store),
    createDatabase: () => new DatabaseService() as any,
    provision: (vault, database, adminPassword, clinic, config) =>
        new ProvisioningService(vault as any, database as any).provision(adminPassword, clinic, config.dbPath, config.dataDir),
    createBackups: (vault, database, store, config) =>
        createBackups(vault as unknown as SecurityService, database as unknown as DatabaseService, store, config),
    async importBackup(vault, database, backupPath, recoveryCode, store, config) {
        // Nothing is signed in yet, so the restore has no sessions to end.
        await createBackups(vault as unknown as SecurityService, database as unknown as DatabaseService, store, config)
            .restoreLocalBackup(backupPath, recoveryCode);
    },
    async startServer(vault, database, store, config, io) {
        const db = database as unknown as DatabaseService;
        const network = buildNetworkOptions({ dataDir: config.dataDir, env: process.env });
        // Cloud pairing, the mailbox, ABDM and scheduled backups run here (#196).
        let api: ApiServer | null = null;
        const services = createClinicServices({
            db,
            keyStore: store,
            appVersion,
            baseUrl: (audience) => getCloudServiceUrl(audience, buildIdentity),
            // Clients refetch through the API when a topic changes.
            notify: (event) => api?.events.publish(CLINIC_EVENT_TOPICS[event])
        });
        const backups = createBackups(vault as unknown as SecurityService, db, store, config);
        const server = new ApiServer(db, config.staticPath, undefined, services, network);
        api = server;
        server.registerServiceMethods(
            { ...createCloudMethods(db, services), ...createBackupMethods(backups) },
            backupScheduleFollower(backups)
        );
        backups.initAutomatedBackup();
        services.start();
        await server.start(config.port, config.host);
        // join-code reads this, so codes pin what clients will actually see.
        writeServingState(config.dataDir, servingStateFrom(network));
        if (network.behindProxy) {
            io.out('Serving plain HTTP for a TLS reverse proxy (NALAMDESK_TLS=proxy).');
        } else if (network.tls?.selfSigned) {
            io.out(`Serving HTTPS with a self-signed certificate (SHA-256 ${network.tls.fingerprint256}). Join codes pin it.`);
        } else {
            io.out('Serving HTTPS with the configured certificate.');
        }
        return {
            close: async () => {
                services.stop();
                backups.stopSchedules();
                await server.close();
            }
        };
    },
    createDeviceAdmin(database, config) {
        const store = new ServerAuthStore(() => (database as any).rawDb());
        return {
            issueJoinCode: (input) => {
                // Pin what the running service serves, not what this shell's environment would build.
                const serving = readServingState(config.dataDir);
                if (!serving) {
                    throw new Error('Start the server once with `nalamdesk-server start`, so the join code can pin the certificate it serves.');
                }
                return { ...issueJoinCode(store, pinOptions(serving), { createdBy: null, ...input }), pin: describeServingState(serving) };
            },
            listDevices: () => store.listDevices(),
            revokeDevice: (id) => store.revokeDevice(id, null)
        };
    },
    waitForShutdown: () => new Promise<void>((resolve) => {
        process.once('SIGINT', () => resolve());
        process.once('SIGTERM', () => resolve());
    })
};

runCli(process.argv.slice(2), io, deps).then(
    (code) => process.exit(code),
    (error) => {
        io.err(`Error: ${error?.message ?? error}`);
        process.exit(1);
    }
);
