import { afterEach, describe, expect, it, vi } from 'vitest';

const failure = vi.hoisted(() => ({ fsync: false }));

vi.mock('fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('fs')>();
    return {
        ...actual,
        fsyncSync: (fd: number) => {
            if (failure.fsync) throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
            return actual.fsyncSync(fd);
        }
    };
});

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { KeyFileStore } from './HeadlessKeyStores';

describe('KeyFileStore.create write failure', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nalamdesk-keyfile-fail-'));
    afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

    it('removes a partially written key file so create() can be retried', () => {
        const keyPath = path.join(directory, 'vault.key');
        failure.fsync = true;
        try {
            expect(() => KeyFileStore.create(keyPath)).toThrow('EIO');
        } finally {
            failure.fsync = false;
        }
        expect(fs.existsSync(keyPath)).toBe(false);
        expect(KeyFileStore.create(keyPath).status()).toMatchObject({ available: true });
    });
});
