import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

// The retired cloud sync authenticated every install with one secret baked
// into the app (#154). Anyone with a copy of the app had it. Paired devices
// sign with their own keys instead; this keeps the old scheme from coming back.
const FORBIDDEN = [['x-app', 'secret'].join('-'), ['APP', 'SECRET'].join('_'), ['nalam', 'build', 'secret'].join('_')];
const ROOT = path.join(__dirname, '../..');

function sources(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sources(full);
        return /\.(ts|js|mjs|html)$/.test(entry.name) ? [full] : [];
    });
}

describe('no shared app secret', () => {
    it('appears nowhere in the desktop sources', () => {
        const hits = sources(ROOT).flatMap((file) => {
            const text = fs.readFileSync(file, 'utf8');
            return FORBIDDEN.filter((word) => text.includes(word)).map((word) => `${path.relative(ROOT, file)}: ${word}`);
        });
        expect(hits).toEqual([]);
    });
});

// ABDM credentials live only on the relay (#160). Outside the migrations that
// created and then cleared them, nothing on the desktop reads or writes them.
const ABDM_CREDENTIALS = [['abdm', 'client', 'secret'].join('_'), ['abdm', 'client', 'id'].join('_'), ['x-callback', 'token'].join('-')];

describe('no ABDM credentials on the clinic computer', () => {
    it('appear nowhere in the desktop sources but the migrations', () => {
        const hits = sources(ROOT)
            .filter((file) => !/[\\/]schema[\\/]migrations\.ts$/.test(file) && !/\.spec\.ts$/.test(file))
            .flatMap((file) => {
                const text = fs.readFileSync(file, 'utf8');
                return ABDM_CREDENTIALS.filter((word) => text.includes(word)).map((word) => `${path.relative(ROOT, file)}: ${word}`);
            });
        expect(hits).toEqual([]);
    });
});
