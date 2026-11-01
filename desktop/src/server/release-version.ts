import * as fs from 'node:fs';
import * as path from 'node:path';

let cached: string | null = null;

/** The NalamDesk release this server was built from (one number for server and app). */
export function serverReleaseVersion(): string {
    if (cached) return cached;
    let dir = __dirname;
    for (let i = 0; i < 6; i++) {
        try {
            const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
            if (pkg?.name === 'nalamdesk-desktop' && typeof pkg.version === 'string') {
                cached = pkg.version;
                return pkg.version;
            }
        } catch { /* keep looking upward */ }
        dir = path.dirname(dir);
    }
    cached = process.env['npm_package_version'] || 'unknown';
    return cached;
}
