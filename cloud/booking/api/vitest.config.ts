import { defineConfig } from 'vitest/config';

// cloud/shared is a file: link holding TypeScript sources: keep its imports
// resolving from this package's node_modules and transform it inline.
export default defineConfig({
    resolve: { preserveSymlinks: true },
    test: {
        include: ['test/**/*.spec.ts'],
        environment: 'node',
        server: { deps: { inline: ['@nalamdesk/cloud-shared'] } }
    }
});
