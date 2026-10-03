
import { defineConfig } from '@playwright/test';

export default defineConfig({
    testDir: './e2e',
    timeout: 60000,
    retries: 0,
    workers: 1,
    reporter: 'html',
    globalSetup: './e2e/regression/global-setup.ts',
    webServer: {
        command: 'npx ng serve --host 127.0.0.1 --port 4200 --open=false',
        url: 'http://127.0.0.1:4200',
        reuseExistingServer: true,
        timeout: 240000,
    },
    use: {
        trace: 'on',
        baseURL: 'http://localhost:4200',
    },
});
