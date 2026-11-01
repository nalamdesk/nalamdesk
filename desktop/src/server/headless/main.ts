import * as readline from 'readline';
import { DatabaseService } from '../../main/services/DatabaseService';
import { ProvisioningService } from '../../main/services/ProvisioningService';
import { SecurityService } from '../../main/services/SecurityService';
import { ApiServer } from '../app';
import { ServerAuthStore } from '../auth-store';
import { buildNetworkOptions, issueJoinCode } from '../network';
import { createServerAbdmServices } from './abdm';
import { runCli, type CliDeps, type CliIO } from './cli';

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

const deps: CliDeps = {
    createVault: (store) => new SecurityService(store),
    createDatabase: () => new DatabaseService() as any,
    provision: (vault, database, adminPassword, clinic, config) =>
        new ProvisioningService(vault as any, database as any).provision(adminPassword, clinic, config.dbPath, config.dataDir),
    async startServer(_vault, database, store, config, io) {
        const network = buildNetworkOptions({ dataDir: config.dataDir, env: process.env });
        const api = new ApiServer(
            database as unknown as DatabaseService,
            config.staticPath,
            undefined,
            createServerAbdmServices(database as unknown as DatabaseService, store),
            network
        );
        await api.start(config.port, config.host);
        if (network.behindProxy) {
            io.out('Serving plain HTTP for a TLS reverse proxy (NALAMDESK_TLS=proxy).');
        } else if (network.tls?.selfSigned) {
            io.out(`Serving HTTPS with a self-signed certificate (SHA-256 ${network.tls.fingerprint256}). Join codes pin it.`);
        } else {
            io.out('Serving HTTPS with the configured certificate.');
        }
        return { close: () => api.close() };
    },
    createDeviceAdmin(database, config, env) {
        const store = new ServerAuthStore(() => (database as any).rawDb());
        return {
            // Load TLS the same way `start` does, so the code pins the certificate clients will see.
            issueJoinCode: (input) => issueJoinCode(store, buildNetworkOptions({ dataDir: config.dataDir, env }), { createdBy: null, ...input }),
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
