import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RuntimeService } from './runtime.service';

describe('RuntimeService', () => {
    let service: RuntimeService;

    beforeEach(() => {
        service = new RuntimeService();
        delete (globalThis as any).electron;
        vi.restoreAllMocks();
    });

    afterEach(() => {
        delete (globalThis as any).electron;
    });

    it('exposes desktop defaults before init', () => {
        expect(service.localIp).toBe('');
        expect(service.apiPort).toBe(3000);
        expect(service.isDev).toBe(false);
        expect(service.appName).toBe('NalamDesk');
        expect(service.lanAccessUrl).toBe('');
    });

    it('loads runtime info once and memoizes the promise', async () => {
        const getRuntimeInfo = vi.fn(async () => ({
            localIp: '192.168.1.10', apiPort: 3002, isDev: true, appName: 'NalamDesk Dev'
        }));
        (globalThis as any).electron = { utils: { getRuntimeInfo } };
        const first = service.init();
        const second = service.init();
        expect(second).toBe(first);
        await first;
        expect(getRuntimeInfo).toHaveBeenCalledTimes(1);
        expect(service.localIp).toBe('192.168.1.10');
        expect(service.apiPort).toBe(3002);
        expect(service.isDev).toBe(true);
        expect(service.appName).toBe('NalamDesk Dev');
        expect(service.lanAccessUrl).toBe('http://192.168.1.10:3002');
    });

    it('stays on defaults without an electron bridge', async () => {
        await service.init();
        expect(service.localIp).toBe('');
        expect(service.lanAccessUrl).toBe('');

        (globalThis as any).electron = {};
        await service.init();
    });

    it('tolerates runtime info failures', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        (globalThis as any).electron = {
            utils: { getRuntimeInfo: vi.fn(async () => { throw new Error('ipc down'); }) }
        };
        await service.init();
        expect(service.localIp).toBe('');
        expect(error).toHaveBeenCalledWith('[RuntimeService] Failed to load runtime info', expect.any(Error));
    });
});
