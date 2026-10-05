/**
 * @vitest-environment jsdom
 */
import '@angular/compiler';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SetupComponent } from './setup.component';

vi.mock('jspdf', () => ({ jsPDF: vi.fn() }));

describe('SetupComponent recovery acknowledgement', () => {
    let component: SetupComponent;
    let authService: { login: ReturnType<typeof vi.fn>; acknowledgeRecoveryCode: ReturnType<typeof vi.fn> };
    let router: { navigate: ReturnType<typeof vi.fn> };

    beforeEach(() => {
        authService = {
            login: vi.fn().mockResolvedValue({ success: true }),
            acknowledgeRecoveryCode: vi.fn()
        };
        router = { navigate: vi.fn() };
        component = new SetupComponent(authService as any, router as any, { run: (fn: () => void) => fn() } as any);
        component.password = 'admin-password';
        component.recoveryCode = 'AAAA-BBBB-CCCC-DDDD';
    });

    it('stays on setup when recovery acknowledgement fails', async () => {
        authService.acknowledgeRecoveryCode.mockResolvedValue({ success: false });
        const dialog = { open: vi.fn().mockResolvedValue(undefined) };
        (component as any).dialogService = dialog;

        await component.goToDashboard();

        expect(router.navigate).not.toHaveBeenCalled();
        expect(dialog.open).toHaveBeenCalledWith(expect.objectContaining({
            title: 'Confirmation failed',
            type: 'error'
        }));
    });

    it('opens the dashboard only after acknowledgement succeeds', async () => {
        authService.acknowledgeRecoveryCode.mockResolvedValue({ success: true });

        await component.goToDashboard();

        expect(authService.acknowledgeRecoveryCode).toHaveBeenCalledWith('AAAA-BBBB-CCCC-DDDD');
        expect(router.navigate).toHaveBeenCalledWith(['/dashboard']);
    });
});

function externalBackupComponent(): SetupComponent {
    return new SetupComponent({} as any, {} as any, { run: (fn: () => void) => fn() } as any);
}

describe('SetupComponent external backup selection', () => {
    it('leaves setup unchanged when the sandboxed picker is cancelled', async () => {
        (window as any).electron = { backup: { selectRestoreBundle: vi.fn(async () => null) } };
        const value = externalBackupComponent();
        await value.selectExternalBackup();
        expect(value.hasBackups).toBe(false);
        expect(value.localBackups).toEqual([]);
    });

    it('adds an external recoverable bundle', async () => {
        (window as any).electron = { backup: { selectRestoreBundle: vi.fn(async () => ({
            path: '/external/clinic.ndbackup', name: 'clinic.ndbackup'
        })) } };
        const value = externalBackupComponent();
        await value.selectExternalBackup();
        expect(value.hasBackups).toBe(true);
        expect(value.localBackups[0]).toMatchObject({ name: 'clinic.ndbackup', recoverable: true });
    });

    it('labels a selected legacy DB as non-recoverable', async () => {
        (window as any).electron = { backup: { selectRestoreBundle: vi.fn(async () => ({
            path: '/external/old.db', name: 'old.db'
        })) } };
        const value = externalBackupComponent();
        await value.selectExternalBackup();
        expect(value.localBackups[0]).toMatchObject({ format: 'legacy-database-only', recoverable: false });
        expect(value.restoreError).toContain('legacy backup');
    });

    it('clears a legacy warning when a recoverable bundle is selected next', async () => {
        const selectRestoreBundle = vi.fn()
            .mockResolvedValueOnce({ path: '/external/old.db', name: 'old.db' })
            .mockResolvedValueOnce({ path: '/external/clinic.ndbackup', name: 'clinic.ndbackup' });
        (window as any).electron = { backup: { selectRestoreBundle } };
        const value = externalBackupComponent();
        await value.selectExternalBackup();
        expect(value.restoreError).toContain('legacy backup');
        await value.selectExternalBackup();
        expect(value.restoreError).toBe('');
    });
});

describe('SetupComponent practice profile', () => {
    it('defaults to India ABDM and passes the choice through setup', async () => {
        const setup = vi.fn().mockResolvedValue({ success: true, recoveryCode: 'RC' });
        const value = new SetupComponent({ setup } as any, { navigate: vi.fn() } as any, { run: (fn: () => void) => fn() } as any);
        expect(value.standardsMode).toBe('india_abdm');
        value.password = 'pw';
        value.clinicName = 'Clinic';
        value.doctorName = 'Doc';
        value.standardsMode = 'international';
        await value.finishSetup();
        expect(setup).toHaveBeenCalledWith(expect.objectContaining({
            clinicDetails: expect.objectContaining({ standards_mode: 'international' })
        }));
        expect(value.step).toBe(4);
    });
});

describe('SetupComponent recovery check', () => {
    const make = (auth: any = {}) => new SetupComponent(
        { setup: vi.fn(), ...auth } as any,
        { navigate: vi.fn() } as any,
        { run: (fn: () => void) => fn() } as any
    );

    it('detects existing backups on electron', async () => {
        (window as any).electron = {
            getRecoveryStatus: vi.fn(async () => ({
                hasBackups: true, isSetup: false,
                backups: [{ name: 'b1', path: '/b1' }]
            }))
        };
        const value = make();
        value.ngOnInit();
        await Promise.resolve();
        await new Promise((r) => setTimeout(r, 0));
        expect(value.hasBackups).toBe(true);
        expect(value.localBackups).toEqual([{ name: 'b1', path: '/b1' }]);
        delete (window as any).electron;
    });

    it('ignores backup status when already set up or absent', async () => {
        (window as any).electron = {
            getRecoveryStatus: vi.fn(async () => ({ hasBackups: true, isSetup: true, backups: [] }))
        };
        const value = make();
        await value.checkRecovery();
        expect(value.hasBackups).toBe(false);

        (window as any).electron = {
            getRecoveryStatus: vi.fn(async () => { throw new Error('ipc down'); })
        };
        await value.checkRecovery();
        delete (window as any).electron;
    });

    it('does nothing without the electron bridge', async () => {
        delete (window as any).electron;
        const value = make();
        await value.checkRecovery();
        expect(value.hasBackups).toBe(false);
    });
});

describe('SetupComponent local restore', () => {
    const make = () => {
        const value = new SetupComponent({} as any, {} as any, { run: (fn: () => void) => fn() } as any);
        (value as any).dialogService = { open: vi.fn(async () => true) };
        return value;
    };

    it('requires a recovery code before confirming', async () => {
        const value = make();
        value.restoreRecoveryCode = '';
        await value.restoreLocal('/b/x.ndbackup');
        expect(value.restoreError).toContain('Recovery Code');
    });

    it('restores with a confirmed code and clears it', async () => {
        (window as any).electron = { restoreSystemBackup: vi.fn(async () => ({ success: true })) };
        const value = make();
        value.restoreRecoveryCode = 'CODE';
        await value.restoreLocal('/b/x.ndbackup');
        expect((window as any).electron.restoreSystemBackup).toHaveBeenCalledWith({
            path: '/b/x.ndbackup', recoveryCode: 'CODE'
        });
        expect(value.restoreRecoveryCode).toBe('');
        expect(value.isRestoring).toBe(true);
        delete (window as any).electron;
    });

    it('aborts when the confirmation is declined', async () => {
        (window as any).electron = { restoreSystemBackup: vi.fn() };
        const value = make();
        (value as any).dialogService = { open: vi.fn(async () => false) };
        value.restoreRecoveryCode = 'CODE';
        await value.restoreLocal('/b/x.ndbackup');
        expect((window as any).electron.restoreSystemBackup).not.toHaveBeenCalled();
        delete (window as any).electron;
    });

    it('maps backend failure codes to user messages', async () => {
        (window as any).electron = {
            restoreSystemBackup: vi.fn(async () => ({ success: false, error: 'INVALID_RECOVERY_CODE' }))
        };
        const value = make();
        value.restoreRecoveryCode = 'CODE';
        await value.restoreLocal('/b/x.ndbackup');
        expect(value.restoreError).toContain('incorrect');
        expect(value.isRestoring).toBe(false);

        (window as any).electron = {
            restoreSystemBackup: vi.fn(async () => { throw new Error('LEGACY_DATABASE_ONLY_BACKUP'); })
        };
        value.restoreRecoveryCode = 'CODE';
        await value.restoreLocal('/b/x.ndbackup');
        expect(value.restoreError).toContain('missing recovery metadata');
        delete (window as any).electron;
    });
});

describe('SetupComponent setup failures and recovery PDF', () => {
    it('shows setup failure dialogs for backend and transport errors', async () => {
        const setup = vi.fn().mockResolvedValue({ success: false, error: 'weak pw' });
        const dialog = { open: vi.fn(async () => undefined) };
        const value = new SetupComponent({ setup } as any, { navigate: vi.fn() } as any,
            { run: (fn: () => void) => fn() } as any);
        (value as any).dialogService = dialog;
        await value.finishSetup();
        expect(value.step).toBe(1);
        expect(value.isSubmitting).toBe(false);
        expect(dialog.open).toHaveBeenCalledWith(expect.objectContaining({ title: 'Setup failed' }));

        setup.mockRejectedValueOnce(new Error('transport down'));
        await value.finishSetup();
        expect(dialog.open).toHaveBeenCalledTimes(2);
    });

    it('writes the recovery code to a PDF', async () => {
        const { jsPDF } = await import('jspdf');
        const save = vi.fn();
        const doc = {
            setFontSize: vi.fn(), setTextColor: vi.fn(), text: vi.fn(),
            setDrawColor: vi.fn(), setFillColor: vi.fn(), roundedRect: vi.fn(),
            setFont: vi.fn(), save
        };
        vi.mocked(jsPDF).mockImplementation(function (this: unknown) { return doc as any; });
        const value = new SetupComponent({} as any, {} as any, { run: (fn: () => void) => fn() } as any);
        value.recoveryCode = 'AAAA-BBBB-CCCC-DDDD';
        value.downloadRecoveryPDF();
        expect(doc.text).toHaveBeenCalledWith('AAAA-BBBB-CCCC-DDDD', 105, 68, { align: 'center' });
        expect(save).toHaveBeenCalledWith('nalamdesk-recovery-code.pdf');
    });

    it('falls back to login when auto-login fails after setup', async () => {
        const router = { navigate: vi.fn() };
        const value = new SetupComponent(
            { login: vi.fn(async () => ({ success: false })) } as any,
            router as any, { run: (fn: () => void) => fn() } as any);
        value.password = 'admin-password';
        await value.goToDashboard();
        expect(router.navigate).toHaveBeenCalledWith(['/login']);
    });

    it('reports acknowledgement throws after login', async () => {
        const dialog = { open: vi.fn(async () => undefined) };
        const value = new SetupComponent({
            login: vi.fn(async () => ({ success: true })),
            acknowledgeRecoveryCode: vi.fn(async () => { throw new Error('interrupted'); })
        } as any, { navigate: vi.fn() } as any, { run: (fn: () => void) => fn() } as any);
        (value as any).dialogService = dialog;
        value.password = 'admin-password';
        value.recoveryCode = 'AAAA-BBBB-CCCC-DDDD';
        await value.goToDashboard();
        expect(dialog.open).toHaveBeenCalledWith(expect.objectContaining({ title: 'Confirmation failed' }));
    });
});
