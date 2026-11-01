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
import { createClinicServices } from '../runtime/clinicServices';
import { backupScheduleFollower, createBackupMethods, createCloudMethods } from '../runtime/clinicMethods';
import { runCli, type CliDeps, type CliIO } from './cli';
import type { ServerConfig } from './config';

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
    // Backups live in the data directory; operators copy them off the machine.
    return new BackupService(database, NO_UPLOADER, vault, config.dataDir, {
        appVersion,
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
    async startServer(vault, database, store, config) {
        const db = database as unknown as DatabaseService;
        // Cloud pairing, the mailbox, ABDM and scheduled backups run here (#196).
        const services = createClinicServices({
            db,
            keyStore: store,
            appVersion,
            baseUrl: (audience) => getCloudServiceUrl(audience, buildIdentity)
        });
        const backups = createBackups(vault as unknown as SecurityService, db, store, config);
        const api = new ApiServer(db, config.staticPath, undefined, services);
        api.registerServiceMethods(
            { ...createCloudMethods(db, services), ...createBackupMethods(backups) },
            backupScheduleFollower(backups)
        );
        backups.initAutomatedBackup();
        services.start();
        await api.start(config.port, config.host);
        return {
            close: async () => {
                services.stop();
                backups.stopSchedules();
                await api.close();
            }
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
