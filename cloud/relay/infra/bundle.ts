import { buildSync } from 'esbuild';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Bundles src/server.ts into one CommonJS index.js, which the Web Function
 * runtime loads from the package root. Returns the directory to zip.
 */
export function bundleRelay(): string {
    const outDir = join(root, 'build', 'relay');
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    buildSync({
        entryPoints: [join(root, 'src', 'server.ts')],
        outfile: join(outDir, 'index.js'),
        bundle: true,
        platform: 'node',
        target: 'node24',
        format: 'cjs',
        minify: true,
        sourcemap: false,
        legalComments: 'none',
        logLevel: 'warning'
    });
    // Pin CommonJS so no surrounding package.json can make Node read it as ESM.
    writeFileSync(join(outDir, 'package.json'), '{"type":"commonjs"}\n');
    return outDir;
}
