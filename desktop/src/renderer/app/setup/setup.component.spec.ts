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
