import { describe, expect, it, vi } from 'vitest';
import { bindUpdateIpc, createUpdateService, type UpdaterPort } from './updateService';

function mockUpdater(overrides: Partial<UpdaterPort> = {}): UpdaterPort {
    const listeners = new Map<string, Array<(...args: any[]) => void>>();
    return {
        autoDownload: true,
        autoInstallOnAppQuit: true,
        setFeedURL: vi.fn(),
        checkForUpdates: vi.fn(),
        downloadUpdate: vi.fn(),
        quitAndInstall: vi.fn(),
        on: vi.fn((event: string, listener: (...args: any[]) => void) => {
            const list = listeners.get(event) || [];
            list.push(listener);
            listeners.set(event, list);
        }),
        ...overrides
    };
}

function createService(updater: UpdaterPort, extra: Record<string, unknown> = {}) {
    const send = vi.fn();
    const openExternal = vi.fn();
    const service = createUpdateService({
        updater,
        isPackaged: true,
        env: { NALAMDESK_UPDATE_FEED_URL: 'https://updates.example.clinic/nalamdesk' },
        platform: 'win32',
        isAppImage: false,
        getVersion: () => '0.0.8',
        send,
        openExternal,
        ...extra
    } as any);
    return { service, send, openExternal, updater };
}

describe('DesktopUpdateService', () => {
    it('skips unpackaged / development builds', async () => {
        const updater = mockUpdater();
        const { service } = createService(updater, { isPackaged: false });
        const status = await service.check({ source: 'startup' });
        expect(status.state).toBe('skipped');
        expect(status.reason).toBe('unpackaged');
        expect(updater.checkForUpdates).not.toHaveBeenCalled();
    });

    it('reports an available update from a mocked feed', async () => {
        const updater = mockUpdater({
            checkForUpdates: vi.fn().mockResolvedValue({
                updateInfo: {
                    version: '0.0.9',
                    releaseNotes: 'Queue fix',
                    path: 'NalamDesk-Setup-0.0.9.exe'
                }
            })
        });
        const { service, send } = createService(updater);
        const status = await service.check({ source: 'startup' });
        expect(status.state).toBe('available');
        expect(status.currentVersion).toBe('0.0.8');
        expect(status.availableVersion).toBe('0.0.9');
        expect(status.releaseNotes).toBe('Queue fix');
        expect(status.canQuitAndInstall).toBe(true);
        expect(status.verifiedSignature).toBe(false);
        expect(status.integrityNote).not.toMatch(/verified signature|fully signed/i);
        expect(updater.setFeedURL).toHaveBeenCalledWith({
            provider: 'generic',
            url: 'https://updates.example.clinic/nalamdesk'
        });
        expect(updater.autoDownload).toBe(false);
        expect(send).toHaveBeenCalled();
    });

    it('reports up-to-date when the feed matches the running version', async () => {
        const updater = mockUpdater({
            checkForUpdates: vi.fn().mockResolvedValue({
                updateInfo: { version: '0.0.8' }
            })
        });
        const { service } = createService(updater);
        const status = await service.check({ source: 'manual' });
        expect(status.state).toBe('up-to-date');
        expect(status.source).toBe('manual');
    });

    it('maps a download failure to a plain error and leaves status usable', async () => {
        const updater = mockUpdater({
            checkForUpdates: vi.fn().mockResolvedValue({
                updateInfo: { version: '0.0.9', path: 'NalamDesk-Setup-0.0.9.exe' }
            }),
            downloadUpdate: vi.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND updates.example.clinic'))
        });
        const { service } = createService(updater);
        await service.check({ source: 'manual' });
        const status = await service.download();
        expect(status.state).toBe('error');
        expect(status.error).toMatch(/network/i);
        expect(service.getStatus().state).toBe('error');
        expect(updater.quitAndInstall).not.toHaveBeenCalled();
    });

    it('opens the download page on Linux .deb instead of quitAndInstall', async () => {
        const updater = mockUpdater({
            checkForUpdates: vi.fn().mockResolvedValue({
                updateInfo: { version: '0.0.9', path: 'nalamdesk-desktop_0.0.9_amd64.deb' }
            })
        });
        const { service, openExternal } = createService(updater, {
            platform: 'linux',
            isAppImage: false
        });
        const available = await service.check({ source: 'manual' });
        expect(available.applyMode).toBe('open-download-page');
        expect(available.canQuitAndInstall).toBe(false);
        await service.download();
        expect(openExternal).toHaveBeenCalled();
        expect(updater.downloadUpdate).not.toHaveBeenCalled();
        expect(updater.quitAndInstall).not.toHaveBeenCalled();
    });

    it('cancels an in-flight download and keeps the app usable', async () => {
        let finishDownload: (value?: unknown) => void = () => undefined;
        const updater = mockUpdater({
            checkForUpdates: vi.fn().mockResolvedValue({
                updateInfo: { version: '0.0.9', path: 'NalamDesk-Setup-0.0.9.exe' }
            }),
            downloadUpdate: vi.fn().mockImplementation(() => new Promise((resolve) => {
                finishDownload = resolve;
            }))
        });
        const { service } = createService(updater);
        await service.check({ source: 'manual' });
        const downloading = service.download();
        const cancelled = service.cancel();
        expect(cancelled.state).toBe('available');
        finishDownload();
        const after = await downloading;
        expect(after.state).toBe('available');
        expect(after.error).toBeUndefined();
    });

    it('binds updates IPC without touching the vault', async () => {
        const updater = mockUpdater({
            checkForUpdates: vi.fn().mockResolvedValue({ updateInfo: { version: '0.0.8' } })
        });
        const { service } = createService(updater);
        const handle = vi.fn();
        bindUpdateIpc({ handle } as any, service);
        expect(handle).toHaveBeenCalledWith('updates:check', expect.any(Function));
        expect(handle).toHaveBeenCalledWith('updates:download', expect.any(Function));
        expect(handle).toHaveBeenCalledWith('updates:install', expect.any(Function));
        expect(handle).toHaveBeenCalledWith('updates:cancel', expect.any(Function));
        expect(handle).toHaveBeenCalledWith('updates:status', expect.any(Function));
    });

    it('refuses download when the app is already up to date', async () => {
        const updater = mockUpdater({
            checkForUpdates: vi.fn().mockResolvedValue({ updateInfo: { version: '0.0.8' } })
        });
        const { service } = createService(updater);
        await service.check({ source: 'manual' });
        const status = await service.download();
        expect(status.state).toBe('error');
        expect(status.error).toMatch(/ready to download/i);
        expect(updater.downloadUpdate).not.toHaveBeenCalled();
    });

    it('does not quitAndInstall until an update has downloaded', async () => {
        const updater = mockUpdater({
            checkForUpdates: vi.fn().mockResolvedValue({
                updateInfo: { version: '0.0.9', path: 'NalamDesk-Setup-0.0.9.exe' }
            }),
            downloadUpdate: vi.fn().mockResolvedValue(undefined)
        });
        const { service } = createService(updater);
        await service.check({ source: 'manual' });
        await service.install();
        expect(updater.quitAndInstall).not.toHaveBeenCalled();
        await service.download();
        await service.install();
        expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true);
    });

    it('skips when no feed is configured and ignores updater events until a download starts', async () => {
        const updater = mockUpdater();
        const { service, send } = createService(updater, { env: { NALAMDESK_UPDATE_PROVIDER: 'generic' } });
        const skipped = await service.check({ source: 'startup' });
        expect(skipped.state).toBe('skipped');
        expect(skipped.reason).toBe('no-feed');
        const progress = (updater.on as any).mock.calls.find((call: any[]) => call[0] === 'download-progress')[1];
        const downloaded = (updater.on as any).mock.calls.find((call: any[]) => call[0] === 'update-downloaded')[1];
        const errored = (updater.on as any).mock.calls.find((call: any[]) => call[0] === 'error')[1];
        progress({ percent: 50 });
        downloaded();
        expect(service.getStatus().state).toBe('skipped');
        errored(new Error('getaddrinfo ENOTFOUND x'));
        expect(service.getStatus().state).toBe('error');
        expect(send).toHaveBeenCalled();
    });

    it('rejects an insecure HTTP artifact URL from the feed', async () => {
        const updater = mockUpdater({
            checkForUpdates: vi.fn().mockResolvedValue({
                updateInfo: { version: '0.0.9', files: [{ url: 'http://evil.example/nalamdesk.exe' }] }
            })
        });
        const { service } = createService(updater);
        const status = await service.check({ source: 'manual' });
        expect(status.state).toBe('error');
        expect(status.error).toMatch(/insecure HTTP/i);
    });
});
