import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('loadDevelopmentEnv', () => {
    const cwd = process.cwd();
    let dir: string;

    afterEach(() => {
        process.chdir(cwd);
        fs.rmSync(dir, { recursive: true, force: true });
        delete process.env['NALAMDESK_NO_DOTENV'];
        delete process.env['ND_LOAD_ENV_PROBE'];
        vi.resetModules();
    });

    const inFolderWithEnvFiles = () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-env-'));
        fs.writeFileSync(path.join(dir, '.env.development'), 'ND_LOAD_ENV_PROBE=development\n');
        fs.writeFileSync(path.join(dir, '.env'), 'ND_LOAD_ENV_PROBE=dotenv\n');
        process.chdir(dir);
    };

    it('reads .env.development from the working directory in development', async () => {
        inFolderWithEnvFiles();
        const { loadDevelopmentEnv } = await import('./load-env');
        loadDevelopmentEnv();
        expect(process.env['ND_LOAD_ENV_PROBE']).toBe('development');
    });

    it('ignores .env files when an installed server sets NALAMDESK_NO_DOTENV=1', async () => {
        inFolderWithEnvFiles();
        process.env['NALAMDESK_NO_DOTENV'] = '1';
        const { loadDevelopmentEnv, loadWorkingDirEnv } = await import('./load-env');
        loadDevelopmentEnv();
        loadWorkingDirEnv();
        expect(process.env['ND_LOAD_ENV_PROBE']).toBeUndefined();
    });
});
