import { describe, it, expect, vi, beforeEach } from 'vitest';
import { app, dialog } from 'electron';
import { CrashService } from './CrashService';

// Mock Electron
vi.mock('electron', () => ({
    app: {
        getPath: vi.fn().mockReturnValue('/mock/home'),
        getVersion: vi.fn().mockReturnValue('1.0.0'),
        relaunch: vi.fn(),
        exit: vi.fn(),
        isReady: vi.fn().mockReturnValue(true),
        on: vi.fn() // For process listeners
    },
    dialog: {
        showMessageBox: vi.fn().mockResolvedValue({ response: 0 }),
        showSaveDialog: vi.fn().mockResolvedValue({ filePath: '/mock/save/report.json' })
    }
}));

// Mock electron-log
vi.mock('electron-log', () => ({
    default: {
        error: vi.fn(),
        transports: {
            file: {
                getFile: vi.fn().mockReturnValue({ path: '/mock/log.log' })
            }
        }
    }
}));

// Mock FS
vi.mock('fs', () => ({
    writeFileSync: vi.fn()
}));

describe('CrashService', () => {
    let service: CrashService;
    let processOnSpy: any;

    beforeEach(() => {
        vi.clearAllMocks();
        // Spy on process.on to capture handlers if we wanted to trigger them
        processOnSpy = vi.spyOn(process, 'on');
        service = new CrashService();
    });

    it('should register error handlers on instantiation', () => {
        expect(processOnSpy).toHaveBeenCalledWith('uncaughtException', expect.any(Function));
        expect(processOnSpy).toHaveBeenCalledWith('unhandledRejection', expect.any(Function));
    });

    // It's hard to test the private handleCrash method without using 'any' casting or exporting it.
    // For now, checking instantiation covers basic "it compiles and hooks up" logic.
    // To properly test the flow, we'd need to emit the events.

    it('should use sanitize PII from home directory', () => {
        // Access private method via casting to test logic
        const sanitized = (service as any).sanitize('/mock/home/documents/secret.txt');
        expect(sanitized).toBe('$HOME/documents/secret.txt');
    });

    // A crash before the app is ready used to throw from the dialog module,
    // and that throw became another unhandled rejection: the handler called
    // itself for ever and the app never finished starting.
    describe('a crash before the app is ready', () => {
        let handler: (reason: any) => void;

        beforeEach(() => {
            const call = processOnSpy.mock.calls.find((c: any[]) => c[0] === 'unhandledRejection');
            handler = call![1];
            (app.isReady as any).mockReturnValue(false);
        });

        it('does not open a dialog', async () => {
            handler(new Error('boom'));
            await new Promise((resolve) => setImmediate(resolve));
            expect(dialog.showMessageBox).not.toHaveBeenCalled();
        });

        it('does not call itself again', async () => {
            handler(new Error('boom'));
            await new Promise((resolve) => setImmediate(resolve));
            expect((app.isReady as any).mock.calls.length).toBe(1);
        });
    });

    it('does not start a second dialog while one is open', async () => {
        const call = processOnSpy.mock.calls.find((c: any[]) => c[0] === 'unhandledRejection');
        const handler = call![1];
        (app.isReady as any).mockReturnValue(true);
        (dialog.showMessageBox as any).mockImplementation(() => new Promise(() => { /* stays open */ }));

        handler(new Error('boom'));
        handler(new Error('boom again'));
        await new Promise((resolve) => setImmediate(resolve));

        expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
    });
});
