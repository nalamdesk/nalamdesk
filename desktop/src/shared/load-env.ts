import * as dotenv from 'dotenv';
import * as fs from 'node:fs';
import * as path from 'node:path';

let loaded = false;

/** Load repo-root `.env.development` then optional `.env.local` overrides. Idempotent. */
export function loadDevelopmentEnv(): void {
    if (loaded) {
        return;
    }
    loaded = true;
    if (dotenvDisabled()) {
        return;
    }

    const envPaths = resolveEnvFilePaths();
    for (let i = 0; i < envPaths.length; i++) {
        dotenv.config({ path: envPaths[i], override: i > 0 });
    }
}

/**
 * Installed NalamDesk Server packages set NALAMDESK_NO_DOTENV=1, so a `.env`
 * in whatever folder the service or an operator's shell starts in can never
 * change the server's configuration.
 */
export function dotenvDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return env['NALAMDESK_NO_DOTENV'] === '1';
}

/** `.env` in the working directory, unless NALAMDESK_NO_DOTENV=1. */
export function loadWorkingDirEnv(): void {
    if (!dotenvDisabled()) dotenv.config();
}

function resolveEnvFilePaths(): string[] {
    const found: string[] = [];
    const roots = collectSearchRoots();

    for (const root of roots) {
        const devEnv = path.join(root, '.env.development');
        if (fs.existsSync(devEnv)) {
            found.push(devEnv);
            const localEnv = path.join(root, '.env.local');
            if (fs.existsSync(localEnv)) {
                found.push(localEnv);
            }
            return found;
        }
    }

    return found;
}

function collectSearchRoots(): string[] {
    const roots: string[] = [];
    const seen = new Set<string>();

    const addRoot = (candidate: string) => {
        const resolved = path.resolve(candidate);
        if (seen.has(resolved)) {
            return;
        }
        seen.add(resolved);
        roots.push(resolved);
    };

    addRoot(process.cwd());
    addRoot(path.join(process.cwd(), '..'));
    addRoot(path.join(process.cwd(), '../..'));

    // Compiled: desktop/dist/shared → repo root is ../../..
    addRoot(path.join(__dirname, '../../..'));

    return roots;
}
