import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('electron', () => ({
    app: { isPackaged: false },
    shell: { openExternal: vi.fn(async () => undefined) },
    BrowserWindow: class { }
}));

import { shell } from 'electron';
import { GoogleDriveService } from './GoogleDriveService';

describe('GoogleDriveService', () => {
    let service: GoogleDriveService;

    beforeEach(() => {
        vi.clearAllMocks();
        service = new GoogleDriveService();
    });

    it('starts unauthenticated without credentials', () => {
        expect(service.isAuthenticated()).toBe(false);
        expect(service.getCredentials()).toBeNull();
    });

    it('skips client creation without both id and secret', () => {
        service.configureCredentials('', '');
        expect(service.isAuthenticated()).toBe(false);
        service.configureCredentials('id-only', '');
        expect(service.isAuthenticated()).toBe(false);
    });

    it('creates an oauth client when both id and secret are given', () => {
        service.configureCredentials('cid', 'csec');
        expect(service.isAuthenticated()).toBe(false);
        expect((service as any).oauth2Client).toBeTruthy();
        expect((service as any).drive).toBeTruthy();
    });

    it('stores tokens and forwards them to the oauth client', () => {
        service.configureCredentials('cid', 'csec');
        const setCredentials = vi.fn();
        (service as any).oauth2Client.setCredentials = setCredentials;
        service.setCredentials({ access_token: 'a' });
        expect(service.getCredentials()).toEqual({ access_token: 'a' });
        expect(setCredentials).toHaveBeenCalledWith({ access_token: 'a' });
        expect(service.isAuthenticated()).toBe(true);
    });

    it('refuses to authenticate without configuration', async () => {
        await expect(service.authenticate({} as any, async () => 'code'))
            .rejects.toThrow('not configured');
    });

    it('runs the oauth flow through the browser and back', async () => {
        service.configureCredentials('cid', 'csec');
        const client = (service as any).oauth2Client;
        client.generateAuthUrl = vi.fn(() => 'https://auth.example/');
        client.getToken = vi.fn(async () => ({ tokens: { access_token: 'tok' } }));
        const seen: string[] = [];
        const ok = await service.authenticate({} as any, async (state: string) => {
            seen.push(state);
            return 'auth-code';
        });
        expect(ok).toBe(true);
        expect(shell.openExternal).toHaveBeenCalledWith('https://auth.example/');
        expect(client.getToken).toHaveBeenCalledWith('auth-code');
        expect(service.getCredentials()).toEqual({ access_token: 'tok' });
        expect(seen[0]).toMatch(/^[0-9a-f]{64}$/);
    });

    it('requires authentication for file operations', async () => {
        await expect(service.uploadFile('/x.db', 'x')).rejects.toThrow('Not authenticated');
        await expect(service.listBackups()).rejects.toThrow('Not authenticated');
        await expect(service.downloadFile('id', '/dest')).rejects.toThrow('Not authenticated');
    });

    it('uploads through the backup folder, creating it when missing', async () => {
        const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nd-')), 'v.db');
        fs.writeFileSync(tmp, 'data');
        try {
            service.configureCredentials('cid', 'csec');
            (service as any).oauth2Client.getAccessToken = vi.fn(async () => ({}));
            const files = {
                list: vi.fn(async () => ({ data: { files: [] } })),
                create: vi.fn(async (args: any) => {
                    if (args.requestBody?.mimeType === 'application/vnd.google-apps.folder') {
                        return { data: { id: 'folder1' } };
                    }
                    return { data: { id: 'file9' } };
                })
            };
            (service as any).drive = { files };
            service.setCredentials({ access_token: 't' });
            const res = await service.uploadFile(tmp, 'v.db');
            expect(res).toEqual({ id: 'file9' });
            expect(files.create).toHaveBeenCalledWith(expect.objectContaining({
                requestBody: expect.objectContaining({ parents: ['folder1'] })
            }));
        } finally {
            // Let the lazily-opened read stream finish opening before cleanup.
            await new Promise((r) => setTimeout(r, 100));
            fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
        }
    });

    it('reuses an existing backup folder', async () => {
        const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nd-')), 'v.db');
        fs.writeFileSync(tmp, 'data');
        try {
            service.configureCredentials('cid', 'csec');
            (service as any).oauth2Client.getAccessToken = vi.fn(async () => ({}));
            const files = {
                list: vi.fn(async () => ({ data: { files: [{ id: 'existing' }] } })),
                create: vi.fn(async () => ({ data: { id: 'file9' } }))
            };
            (service as any).drive = { files };
            service.setCredentials({ access_token: 't' });
            await service.uploadFile(tmp, 'v.db');
            expect(files.create).not.toHaveBeenCalledWith(expect.objectContaining({
                requestBody: expect.objectContaining({ mimeType: 'application/vnd.google-apps.folder' })
            }));
        } finally {
            // Let the lazily-opened read stream finish opening before cleanup.
            await new Promise((r) => setTimeout(r, 100));
            fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
        }
    });

    it('lists backups newest-first and degrades to empty on errors', async () => {
        service.configureCredentials('cid', 'csec');
        const files = {
            list: vi.fn(async () => ({ data: { files: [{ id: 'a' }] } })),
            create: vi.fn(async () => ({ data: { id: 'folder1' } }))
        };
        (service as any).drive = { files };
        service.setCredentials({ access_token: 't' });
        expect(await service.listBackups()).toEqual([{ id: 'a' }]);
        expect(files.list).toHaveBeenLastCalledWith(expect.objectContaining({ orderBy: 'createdTime desc' }));

        files.list.mockRejectedValueOnce(new Error('api down'));
        expect(await service.listBackups()).toEqual([]);
    });

    it('downloads a backup stream to disk', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-'));
        const dest = path.join(dir, 'out.db');
        try {
            service.configureCredentials('cid', 'csec');
            const stream = Readable.from(['chunk1', 'chunk2']);
            (service as any).drive = {
                files: { get: vi.fn(async () => ({ data: stream })) }
            };
            service.setCredentials({ access_token: 't' });
            await service.downloadFile('file9', dest);
            expect(fs.readFileSync(dest, 'utf8')).toBe('chunk1chunk2');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('rejects failed downloads', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-'));
        try {
            service.configureCredentials('cid', 'csec');
            const stream = new Readable({ read() { this.destroy(new Error('stream broken')); } });
            (service as any).drive = {
                files: { get: vi.fn(async () => ({ data: stream })) }
            };
            service.setCredentials({ access_token: 't' });
            await expect(service.downloadFile('file9', path.join(dir, 'out.db')))
                .rejects.toThrow('stream broken');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
