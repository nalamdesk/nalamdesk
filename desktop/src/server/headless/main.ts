import * as readline from 'readline';
import { DatabaseService } from '../../main/services/DatabaseService';
import { ProvisioningService } from '../../main/services/ProvisioningService';
import { SecurityService } from '../../main/services/SecurityService';
import { ApiServer } from '../app';
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
    async startServer(_vault, database, store, config) {
        const api = new ApiServer(
            database as unknown as DatabaseService,
            config.staticPath,
            undefined,
            createServerAbdmServices(database as unknown as DatabaseService, store)
        );
        await api.start(config.port, config.host);
        return { close: () => api.close() };
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
