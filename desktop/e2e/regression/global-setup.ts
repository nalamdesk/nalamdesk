/**
 * Playwright global setup: guarantees the app under test is built locally
 * before any Electron window launches.
 *
 * - Builds the Electron main process (`npm run build:main` -> dist/main/main.js)
 *   when the artifact is missing.
 * - The renderer is served by the `webServer` entry in playwright.config.ts
 *   (`ng serve` on 127.0.0.1:4200), i.e. also built/run locally.
 */
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';

async function globalSetup(): Promise<void> {
    const projectRoot = join(__dirname, '../..');
    const mainEntry = join(projectRoot, 'dist/main/main.js');
    if (!existsSync(mainEntry)) {
        console.log('[regression:nightly] dist/main/main.js missing — running `npm run build:main`...');
        execSync('npm run build:main', { cwd: projectRoot, stdio: 'inherit' });
    } else {
        console.log('[regression:nightly] dist/main/main.js present, skipping main build.');
    }
    if (!existsSync(join(projectRoot, 'node_modules/.bin/electron'))) {
        throw new Error('Electron binary missing. Run `npm ci` in desktop/ first.');
    }
}

export default globalSetup;
