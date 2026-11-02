/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AppUpdateService } from './update.service';

describe('AppUpdateService', () => {
    let service: AppUpdateService;
    let updates: any;

    beforeEach(() => {
        updates = {
            check: vi.fn(),
            download: vi.fn(),
            install: vi.fn(),
            cancel: vi.fn(),
            onEvent: vi.fn().mockReturnValue(() => undefined)
        };
        (globalThis as any).electron = {
            updates,
            getAppVersion: vi.fn().mockResolvedValue({ packaged: true, version: '0.0.8' })
        };
        service = new AppUpdateService({ run: (fn: () => void) => fn() } as any);
    });

    afterEach(() => {
        delete (globalThis as any).electron;
    });

    it('opens Update now / Later when a newer feed version is available', async () => {
        updates.check.mockResolvedValue({
            state: 'available',
            currentVersion: '0.0.8',
            availableVersion: '0.0.9',
            verifiedSignature: false
        });
        const status = await service.check('startup');
        expect(status.availableVersion).toBe('0.0.9');
        expect(service.promptOpen()).toBe(true);
        expect(service.status().verifiedSignature).toBe(false);
        service.later();
        expect(service.promptOpen()).toBe(false);
        expect(service.status().state).toBe('available');
    });

    it('wires startup checks, events, cancel, and missing IPC', async () => {
        updates.check.mockResolvedValue({ state: 'available', source: 'startup', availableVersion: '0.0.9' });
        service.init();
        service.init();
        await Promise.resolve();
        await Promise.resolve();
        expect(updates.onEvent).toHaveBeenCalled();
        expect(updates.check).toHaveBeenCalledWith({ source: 'startup' });
        const listener = updates.onEvent.mock.calls[0][0];
        listener({ state: 'downloading', percent: 20 });
        expect(service.promptOpen()).toBe(true);
        updates.cancel.mockResolvedValue({ state: 'available' });
        await service.cancelDownload();
        expect(updates.cancel).toHaveBeenCalled();
        service.destroy();

        delete (globalThis as any).electron;
        const offline = new AppUpdateService({ run: (fn: () => void) => fn() } as any);
        await offline.check();
        await offline.updateNow();
        await offline.install();
        await offline.cancelDownload();
        offline.init();
        expect(offline.status().state).toBe('idle');
    });

    it('downloads then installs on Update now', async () => {
        updates.download.mockResolvedValue({ state: 'downloaded', canQuitAndInstall: true });
        updates.install.mockResolvedValue({ state: 'downloaded' });
        service.status.set({ state: 'available' });
        await service.updateNow();
        expect(updates.download).toHaveBeenCalled();
        expect(updates.install).toHaveBeenCalled();
    });

    it('installs a previously downloaded update', async () => {
        updates.install.mockResolvedValue({ state: 'downloaded', canQuitAndInstall: true });
        service.status.set({ state: 'downloaded' });
        await service.install();
        expect(updates.install).toHaveBeenCalled();
    });

    it('keeps the prompt for a failed launch check', async () => {
        updates.check.mockResolvedValue({
            state: 'error',
            source: 'startup',
            error: 'Could not reach the update feed. Check the network and try again.'
        });
        await service.check('startup');
        expect(service.promptOpen()).toBe(true);
        expect(service.status().error).toMatch(/network/i);
    });

    describe('in client mode (#211)', () => {
        let clientUpdates: any;

        beforeEach(() => {
            delete (globalThis as any).electron;
            clientUpdates = {
                check: vi.fn().mockResolvedValue({ state: 'available', source: 'startup', availableVersion: '0.0.9' }),
                download: vi.fn(),
                install: vi.fn(),
                cancel: vi.fn(),
                getStatus: vi.fn().mockResolvedValue({ state: 'idle', packaged: true }),
                onEvent: vi.fn().mockReturnValue(() => undefined)
            };
            (globalThis as any).nalamdeskClient = { updates: clientUpdates };
            service = new AppUpdateService({ run: (fn: () => void) => fn() } as any);
        });

        afterEach(() => {
            delete (globalThis as any).nalamdeskClient;
        });

        it('uses the client preload updater and checks at launch when packaged', async () => {
            expect(service.available).toBe(true);
            service.init();
            await vi.waitFor(() => expect(clientUpdates.check).toHaveBeenCalledWith({ source: 'startup' }));
            expect(clientUpdates.onEvent).toHaveBeenCalled();
            expect(service.promptOpen()).toBe(true);
        });

        it('skips the launch check in an unpackaged client', async () => {
            clientUpdates.getStatus.mockResolvedValue({ state: 'idle', packaged: false });
            service.init();
            await Promise.resolve();
            await Promise.resolve();
            expect(clientUpdates.check).not.toHaveBeenCalled();
        });

        it('has no updater in a browser', () => {
            delete (globalThis as any).nalamdeskClient;
            expect(service.available).toBe(false);
        });
    });
});
