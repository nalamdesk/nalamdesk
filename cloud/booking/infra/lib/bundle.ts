import { buildSync } from 'esbuild';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const booking = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Bundles api/src/server.ts into one CommonJS index.js, which the Web
 * Function runtime loads from the package root (as cloud/relay/infra/bundle.ts
 * does). Returns the directory to zip. Needs `npm ci` in cloud/booking/api.
 */
export function bundleApi(): string {
    const outDir = join(booking, 'infra', 'build', 'api');
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    buildSync({
        entryPoints: [join(booking, 'api', 'src', 'server.ts')],
        outfile: join(outDir, 'index.js'),
        bundle: true,
        platform: 'node',
        target: 'node24',
        format: 'cjs',
        minify: true,
        sourcemap: false,
        legalComments: 'none',
        logLevel: 'warning',
        nodePaths: [join(booking, 'api', 'node_modules')]
    });
    // Pin CommonJS so no surrounding package.json can make Node read it as ESM.
    writeFileSync(join(outDir, 'package.json'), '{"type":"commonjs"}\n');
    return outDir;
}
