/**
 * @vitest-environment jsdom
 */
import '@angular/compiler';
import { SettingsComponent } from './settings.component';

// Mock dependencies
vi.mock('@angular/core', async () => {
    const actual = await vi.importActual('@angular/core');
    return {
        ...actual as any,
        inject: vi.fn(),
    };
});
import { inject } from '@angular/core';
import { DataService } from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { Router } from '@angular/router';
import { AppUpdateService } from '../services/update.service';

// Mock Child Components
vi.mock('../shared/components/table/table.component', () => ({ SharedTableComponent: class { } }));
vi.mock('../shared/components/table/renderers/action-renderer.component', () => ({ ActionRendererComponent: class { } }));
vi.mock('../shared/components/date-picker/date-picker.component', () => ({ DatePickerComponent: class { } }));
vi.mock('./catalog-settings.component', () => ({ CatalogSettingsComponent: class { } }));

describe('SettingsComponent Validation', () => {
    let component: SettingsComponent;
    let mockNgZone: any;
    let mockAuth: any;
    let mockData: any;

    beforeEach(() => {
        // Mock inject to return dummies
        mockAuth = {
            getUser: vi.fn(() => ({ id: 1, username: 'admin', role: 'admin' })),
            changeLoginPassword: vi.fn(), resetUserPassword: vi.fn(), rotateDeviceEnvelope: vi.fn(),
            acknowledgeRecoveryCode: vi.fn()
        };
        mockData = { invoke: vi.fn() };
        vi.mocked(inject).mockImplementation((token) => {
            if (token === AuthService) return mockAuth;
            if (token === DataService) return mockData;
            return { navigate: vi.fn() };
        });

        mockNgZone = { run: vi.fn((fn) => fn()) };
        vi.stubGlobal('alert', vi.fn());
        component = new SettingsComponent(mockNgZone);
        component.isElectron = false;
        (component as any).profileService = {
            mode: () => 'india_abdm',
            load: vi.fn().mockResolvedValue(undefined),
            setMode: vi.fn().mockResolvedValue(undefined),
            exportLabel: () => 'ABDM NRCeS FHIR R4',
            identifierLabel: () => 'ABHA Number'
        };
    });

    it('switches the standards profile and toasts the result', async () => {
        const setMode = vi.fn().mockResolvedValue(undefined);
        const toast = { success: vi.fn() };
        (component as any).profileService.setMode = setMode;
        (component as any).toastService = toast;
        await component.setStandardsMode('international');
        expect(setMode).toHaveBeenCalledWith('international');
        expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('International'), 'Profile updated');
    });

    it('surfaces standards switch failures as dialogs', async () => {
        const dialogSpy = vi.fn(() => Promise.resolve(true));
        (component as any).dialogService = { open: dialogSpy };
        (component as any).profileService = { setMode: vi.fn().mockRejectedValue(new Error('db down')) };
        await component.setStandardsMode('international');
        expect(dialogSpy).toHaveBeenCalledWith(expect.objectContaining({ title: 'Profile failed' }));
    });

    it('should validate required fields', () => {
        const errors = component.validateUser({});
        expect(errors).toContain('Username must be at least 3 characters.');
        expect(errors).toContain('Full Name is required.');
        expect(errors).toContain('Role is required.');
    });

    it('should validate username length', () => {
        expect(component.validateUser({ username: 'ab' })).toContain('Username must be at least 3 characters.');
        expect(component.validateUser({ username: 'abc', name: 'Valid', role: 'doc', password: '123456' }).length).toBe(0);
    });

    it('should validate mobile', () => {
        expect(component.validateUser({ mobile: '123' })).toContain('Mobile number must be exactly 10 digits.');
        const valid = component.validateUser({ mobile: '9876543210' });
        const hasMobileErr = valid.some(e => e.includes('Mobile'));
        expect(hasMobileErr).toBe(false);
    });

    it('runs administrator self-change through the dedicated verified workflow and clears inputs', async () => {
        mockAuth.changeLoginPassword.mockResolvedValue({ success: true });
        component.currentLoginPassword = 'current-secret';
        component.newLoginPassword = 'replacement-secret';
        component.confirmLoginPassword = 'replacement-secret';
        component.showLoginPasswordModal = true;
        await component.changeLoginPassword();
        expect(mockAuth.changeLoginPassword).toHaveBeenCalledWith('current-secret', 'replacement-secret');
        expect(component.currentLoginPassword).toBe('');
        expect(component.newLoginPassword).toBe('');
        expect(component.showLoginPasswordModal).toBe(false);
    });

    it('runs staff reset through the separate admin-confirmed workflow', async () => {
        mockAuth.resetUserPassword.mockResolvedValue({ success: true });
        component.resetTarget = { id: 2, username: 'doctor' };
        component.resetAdminPassword = 'admin-secret';
        component.resetTemporaryPassword = 'temporary-secret';
        component.resetConfirmPassword = 'temporary-secret';
        await component.resetUserPassword();
        expect(mockAuth.resetUserPassword).toHaveBeenCalledWith(2, 'admin-secret', 'temporary-secret');
        expect(component.resetAdminPassword).toBe('');
        expect(component.resetTemporaryPassword).toBe('');
    });

    it('does not put a password field into an existing user edit model', () => {
        component.editUser({ id: 1, username: 'admin', role: 'admin', name: 'Administrator' });
        expect(Object.prototype.hasOwnProperty.call(component.editingUser, 'password')).toBe(false);
    });

    it('acknowledges the exact displayed recovery code only when Done is selected', async () => {
        mockAuth.acknowledgeRecoveryCode.mockResolvedValue(undefined);
        component.showRecoveryModal = true;
        component.newRecoveryCode = 'AAAA-BBBB-CCCC-DDDD';
        await component.closeRecoveryModal();
        expect(mockAuth.acknowledgeRecoveryCode).toHaveBeenCalledWith('AAAA-BBBB-CCCC-DDDD');
        expect(component.newRecoveryCode).toBeNull();
        expect(component.showRecoveryModal).toBe(false);
    });

    it('keeps an unacknowledged recovery code visible when confirmation fails', async () => {
        mockAuth.acknowledgeRecoveryCode.mockRejectedValue(new Error('interrupted'));
        component.showRecoveryModal = true;
        component.newRecoveryCode = 'AAAA-BBBB-CCCC-DDDD';
        await component.closeRecoveryModal();
        expect(component.newRecoveryCode).toBe('AAAA-BBBB-CCCC-DDDD');
        expect(component.showRecoveryModal).toBe(true);
    });

    it('selects a Welcome-style restore bundle through the existing picker IPC', async () => {
        component.isElectron = true;
        (window as any).electron = {
            backup: { selectRestoreBundle: vi.fn(async () => ({
                path: '/external/clinic.ndbackup', name: 'clinic.ndbackup'
            })) }
        };
        await component.selectRestoreBundle();
        expect(component.restoreBundle).toMatchObject({ name: 'clinic.ndbackup', path: '/external/clinic.ndbackup' });
        expect(component.restoreError).toBe('');
    });

    it('restores through restoreSystemBackup with recovery code and live-vault admin auth', async () => {
        component.isElectron = true;
        component.restoreBundle = { path: '/external/clinic.ndbackup', name: 'clinic.ndbackup' };
        component.restoreRecoveryCode = 'AAAA-BBBB-CCCC-DDDD';
        component.restoreAdminPassword = 'admin-secret';
        (component as any).dialogService = { open: vi.fn().mockResolvedValue(true) };
        const restoreSystemBackup = vi.fn(async () => ({ success: true, restartRequired: true }));
        (window as any).electron = { restoreSystemBackup };
        await component.restoreLocalBackup();
        expect(restoreSystemBackup).toHaveBeenCalledWith({
            path: '/external/clinic.ndbackup',
            recoveryCode: 'AAAA-BBBB-CCCC-DDDD',
            currentAdminPassword: 'admin-secret'
        });
        expect(component.restoreRecoveryCode).toBe('');
        expect(component.restoreAdminPassword).toBe('');
    });

    it('does not invent a second restore pipeline for a live vault', async () => {
        component.isElectron = true;
        component.restoreBundle = { path: '/external/clinic.ndbackup', name: 'clinic.ndbackup' };
        component.restoreRecoveryCode = 'CODE';
        component.restoreAdminPassword = 'secret';
        (component as any).dialogService = { open: vi.fn().mockResolvedValue(true) };
        const restoreSystemBackup = vi.fn(async () => ({ success: false, error: 'INVALID_ADMIN_CREDENTIAL' }));
        (window as any).electron = {
            restoreSystemBackup,
            drive: { restore: vi.fn() }
        };
        await component.restoreLocalBackup();
        expect(restoreSystemBackup).toHaveBeenCalled();
        expect((window as any).electron.drive.restore).not.toHaveBeenCalled();
        expect(component.restoreError).toContain('administrator password');
        expect(component.isRestoring).toBe(false);
    });

    it('requires a recovery code before calling restore IPC', async () => {
        component.isElectron = true;
        component.restoreBundle = { path: '/external/clinic.ndbackup', name: 'clinic.ndbackup' };
        component.restoreAdminPassword = 'secret';
        (window as any).electron = { restoreSystemBackup: vi.fn() };
        await component.restoreLocalBackup();
        expect((window as any).electron.restoreSystemBackup).not.toHaveBeenCalled();
        expect(component.restoreError).toContain('Recovery Code');
    });

    it('does not expose Welcome restore on non-Electron web sessions', async () => {
        component.isElectron = false;
        (window as any).electron = {
            backup: { selectRestoreBundle: vi.fn() },
            restoreSystemBackup: vi.fn()
        };
        await component.selectRestoreBundle();
        await component.restoreLocalBackup();
        expect((window as any).electron.backup.selectRestoreBundle).not.toHaveBeenCalled();
        expect((window as any).electron.restoreSystemBackup).not.toHaveBeenCalled();
    });

    it('displays packaged app.getVersion() instead of a hard-coded 0.0.0', async () => {
        expect(component.appVersion).toBe('');
        component.isElectron = true;
        (window as any).electron = {
            getAppVersion: vi.fn(async () => ({
                version: '0.0.8',
                display: '0.0.8 (abcdef1)',
                isDev: false,
                packaged: true,
                commit: 'abcdef123',
                buildId: '99'
            }))
        };
        await component.loadAppVersion();
        expect(component.appVersion).toBe('0.0.8 (abcdef1)');
        expect(component.appVersion).not.toBe('0.0.0');
        expect(component.appVersion).not.toBe('v0.0.0');
    });

    it('leaves the footer empty when version IPC is unavailable', async () => {
        component.isElectron = false;
        delete (window as any).electron;
        await component.loadAppVersion();
        expect(component.appVersion).toBe('');
    });

    it('falls back to the IPC version when display is missing', async () => {
        component.isElectron = true;
        (window as any).electron = { getAppVersion: vi.fn(async () => ({ version: '0.0.8' })) };
        await component.loadAppVersion();
        expect(component.appVersion).toBe('0.0.8');
        expect(component.appVersion).not.toBe('0.0.0');
        expect(component.appVersion).not.toBe('v0.0.0');
    });

    it('falls back to a blank footer when display and version are empty', async () => {
        component.isElectron = true;
        component.appVersion = 'stale';
        (window as any).electron = { getAppVersion: vi.fn(async () => ({ display: '', version: '' })) };
        await component.loadAppVersion();
        expect(component.appVersion).toBe('');
    });

    it('keeps a blank footer when packaged version IPC fails', async () => {
        const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        component.isElectron = true;
        (window as any).electron = {
            getAppVersion: vi.fn(async () => { throw new Error('IPC Error'); })
        };
        component.appVersion = '';
        await component.loadAppVersion();
        expect(component.appVersion).toBe('');
        expect(err).toHaveBeenCalled();
        err.mockRestore();
    });

    it('labels a development build from the version IPC', async () => {
        component.isElectron = true;
        (window as any).electron = {
            getAppVersion: vi.fn(async () => ({
                version: '0.0.8',
                display: '0.0.8 (development)',
                isDev: true,
                packaged: false,
                commit: null,
                buildId: null
            }))
        };
        await component.loadAppVersion();
        expect(component.appVersion).toContain('development');
        expect(component.appVersion).not.toBe('0.0.0');
        expect(component.appVersion).not.toBe('v0.0.0');
    });

    it('checks for updates from Settings on packaged Electron', async () => {
        const updates = { check: vi.fn().mockResolvedValue({ state: 'up-to-date' }) };
        vi.mocked(inject).mockImplementation((token) => {
            if (token === AuthService) return mockAuth;
            if (token === DataService) return mockData;
            if (token === AppUpdateService) return updates;
            return { navigate: vi.fn() };
        });
        component = new SettingsComponent(mockNgZone);
        component.isElectron = true;
        await component.checkForUpdates();
        expect(updates.check).toHaveBeenCalledWith('manual');
    });

    it('loads the ABDM config into the tab state', async () => {
        mockData.invoke.mockImplementation((method: string) => {
            if (method === 'abdmGetConfig') return Promise.resolve({
                gateway_env: 'staging', client_id: 'CID-1', has_secret: true, mock: false
            });
            return Promise.resolve(null);
        });

        await component.loadAbdmConfig();

        expect(component.abdmConfig).toMatchObject({
            gateway_env: 'staging', client_id: 'CID-1', has_secret: true, mock: false
        });
    });

    it('saves the secret without ever displaying it, then reloads config', async () => {
        mockData.invoke.mockImplementation((method: string) => {
            if (method === 'abdmSetSecret') return Promise.resolve({ stored: true });
            if (method === 'abdmGetConfig') return Promise.resolve({
                gateway_env: 'sandbox', client_id: '', has_secret: true, mock: true
            });
            return Promise.resolve(null);
        });
        component.abdmSecret = 'super-secret';

        await component.saveAbdmSecret();

        expect(mockData.invoke).toHaveBeenCalledWith('abdmSetSecret', { secret: 'super-secret' });
        expect(component.abdmSecret).toBe('');
        expect(component.abdmConfig.has_secret).toBe(true);
    });

    it('stores the connectivity test result for display', async () => {
        mockData.invoke.mockResolvedValue({ ok: true, mode: 'mock', detail: 'Mock gateway active.' });

        await component.testAbdm();

        expect(mockData.invoke).toHaveBeenCalledWith('abdmTestConnectivity');
        expect(component.abdmTest).toMatchObject({ ok: true, mode: 'mock' });
    });

    it('generates a scannable counter QR once facility identity exists', async () => {
        component.abdmConfig.hip_id = '';
        component.abdmConfig.counter_id = '';
        await component.generateQr();
        expect(component.qrDataUrl).toBeNull();

        component.abdmConfig.hip_id = 'HIP-1';
        component.abdmConfig.counter_id = 'Counter-1';
        await component.generateQr();
        expect(component.qrDataUrl?.startsWith('data:image/png')).toBe(true);
    });

    it('reports demo scan queueing for the receptionist to pick up', async () => {
        mockData.invoke.mockResolvedValue({ id: 2, token_no: 7 });

        await component.simulateShare();

        expect(mockData.invoke).toHaveBeenCalledWith('abdmSimulateShare');
        expect(component.abdmSimResult).toContain('Token #7');
    });

    it('sends the mock gateway choice with the config', async () => {
        mockData.invoke.mockResolvedValue(null);
        component.abdmConfig.gateway_env = 'staging';
        component.abdmConfig.client_id = 'CID';
        component.abdmConfig.mock = false;

        await component.saveAbdmConfig();

        expect(mockData.invoke).toHaveBeenCalledWith('abdmSaveConfig', expect.objectContaining({
            gateway_env: 'staging',
            client_id: 'CID',
            mock: false
        }));
    });

    it('sends registry identifiers with the config', async () => {
        mockData.invoke.mockResolvedValue(null);
        component.abdmConfig.hfr_id = 'HFR-1';
        component.abdmConfig.hpr_id = 'HPR-2';

        await component.saveAbdmConfig();

        expect(mockData.invoke).toHaveBeenCalledWith('abdmSaveConfig', expect.objectContaining({
            hfr_id: 'HFR-1',
            hpr_id: 'HPR-2'
        }));
    });

    it('loads and acknowledges inbox callbacks', async () => {
        mockData.invoke.mockImplementation((method: string) => {
            if (method === 'abdmGetInbox') {
                return Promise.resolve([{ id: 3, kind: 'consent-request', created_at: '2026-09-20 10:00:00' }]);
            }
            if (method === 'abdmAckInbox') return Promise.resolve({ status: 'handled' });
            return Promise.resolve(null);
        });

        await component.loadInbox();
        expect(component.inboxItems).toHaveLength(1);

        await component.ackInbox(3);
        expect(mockData.invoke).toHaveBeenCalledWith('abdmAckInbox', { id: 3 });
        expect(mockData.invoke).toHaveBeenCalledWith('abdmGetInbox');
    });

    it('sends a recipient key only when the field holds a new one', async () => {
        mockData.invoke.mockResolvedValue(null);
        component.abdmRecipientKey = '';
        component.abdmConfig.hip_endpoint = 'https://hip.example/push';

        await component.saveAbdmConfig();

        const payload = mockData.invoke.mock.calls
            .find((call: any[]) => call[0] === 'abdmSaveConfig')[1];
        expect(payload.hip_endpoint).toBe('https://hip.example/push');
        expect('recipient_key' in payload).toBe(false);

        component.abdmRecipientKey = 'QUJD';
        await component.saveAbdmConfig();
        const payload2 = mockData.invoke.mock.calls
            .filter((call: any[]) => call[0] === 'abdmSaveConfig')[1][1];
        expect(payload2.recipient_key).toBe('QUJD');
    });

    it('sends a callback password only when the field holds a new one', async () => {
        mockData.invoke.mockResolvedValue(null);
        component.abdmCallbackSecret = '';

        await component.saveAbdmConfig();

        const payload = mockData.invoke.mock.calls
            .find((call: any[]) => call[0] === 'abdmSaveConfig')[1];
        expect('callback_secret' in payload).toBe(false);

        component.abdmCallbackSecret = 'a-very-long-shared-secret';
        await component.saveAbdmConfig();
        const payload2 = mockData.invoke.mock.calls
            .filter((call: any[]) => call[0] === 'abdmSaveConfig')[1][1];
        expect(payload2.callback_secret).toBe('a-very-long-shared-secret');
    });

    it('manages per-user overrides through the admin IPC', async () => {        mockData.invoke.mockImplementation((method: string) => {
            if (method === 'getUserOverrides') return Promise.resolve([{ action: 'updateQueueStatus', effect: 'allow' }]);
            if (method === 'saveUserOverride') return Promise.resolve({ id: 1 });
            return Promise.resolve(null);
        });
        await component.openPermissions({ id: 5, name: 'Nancy', role: 'nurse' });
        expect(component.permissionTarget.id).toBe(5);
        expect(component.permissionOverrides).toHaveLength(1);

        component.permissionForm = { action: 'updateQueueStatus', effect: 'allow', reason: 'Covers Tuesdays' };
        await component.addPermissionOverride();
        expect(mockData.invoke).toHaveBeenCalledWith('saveUserOverride', expect.objectContaining({
            userId: 5, action: 'updateQueueStatus', effect: 'allow'
        }));
        expect(component.permissionForm.reason).toBe('');

        component.permissionForm = { action: '', effect: 'allow', reason: '' };
        await component.addPermissionOverride();
        expect(mockData.invoke).not.toHaveBeenCalledWith('saveUserOverride', expect.objectContaining({ action: '' }));

        await component.removePermissionOverride('updateQueueStatus');
        expect(mockData.invoke).toHaveBeenCalledWith('deleteUserOverride', { userId: 5, action: 'updateQueueStatus' });
        component.closePermissions();
        expect(component.permissionTarget).toBeNull();
    });

    it('manages custom roles from templates', async () => {
        (component as any).dialogService = { open: (...args: any[]) => Promise.resolve(true) };
        mockData.invoke.mockImplementation((method: string) => {
            if (method === 'getAllRoles') return Promise.resolve([
                { name: 'admin', permissions: [] },
                { name: 'billing-clerk', permissions: ['getDashboardStats'] }
            ]);
            return Promise.resolve(null);
        });
        await component.openRoles();
        expect(component.roles).toHaveLength(2);
        expect(component.availableRoleNames).toContain('billing-clerk');
        expect(component.isBuiltinRole('admin')).toBe(true);
        expect(component.isBuiltinRole('billing-clerk')).toBe(false);

        component.startNewRole();
        component.applyRoleTemplate('Front Desk');
        expect(component.editingRole?.permissions).toContain('addToQueue');
        expect(component.editingRole?.permissions).not.toContain('savePatient');
        component.toggleRolePermission('addToQueue');
        expect(component.editingRole?.permissions).not.toContain('addToQueue');

        // Handler-gated clinical mutations stay out of the custom-role picker.
        const pickable = component.pickableCatalog.flatMap((g: any) => g.methods);
        expect(pickable).not.toContain('saveVisit');
        expect(pickable).not.toContain('saveAllergy');
        expect(pickable).toContain('addToQueue');

        component.editingRole = { name: 'billing-clerk', isNew: false, permissions: ['getDashboardStats'] };
        await component.saveRole();
        expect(mockData.invoke).toHaveBeenCalledWith('saveRole', expect.objectContaining({
            name: 'billing-clerk', permissions: ['getDashboardStats']
        }));
        expect(component.editingRole).toBeNull();

        await component.deleteRoleUI('billing-clerk');
        expect(mockData.invoke).toHaveBeenCalledWith('deleteRole', 'billing-clerk');
    });
    it('drives the row Permissions affordance through the grid params', () => {
        const actionsCol = (component as any).userColumnDefs.find((c: any) => c.headerName === 'Actions');
        const params = actionsCol.cellRendererParams;
        const editSpy = vi.spyOn(component, 'editUser').mockImplementation(() => undefined);
        const deleteSpy = vi.spyOn(component, 'deleteUser').mockImplementation(() => Promise.resolve());
        params.onEdit({ id: 9 });
        params.onDelete({ id: 9 });
        expect(editSpy).toHaveBeenCalledWith({ id: 9 });
        expect(deleteSpy).toHaveBeenCalledWith(9);
        expect(params.canDelete({ username: 'admin' })).toBe(false);
        expect(params.canDelete({ username: 'nurse-1' })).toBe(true);
        editSpy.mockRestore();
        deleteSpy.mockRestore();
    });

    it('deactivates instead of deleting, with Deactivate copy', async () => {
        const dialogSpy = vi.fn(() => Promise.resolve(true));
        (component as any).dialogService = { open: dialogSpy };
        mockData.invoke.mockResolvedValue({ changes: 1 });

        await component.deleteUser(9);
        expect(dialogSpy).toHaveBeenCalledWith(expect.objectContaining({ title: 'Deactivate user?' }));
        expect(mockData.invoke).toHaveBeenCalledWith('deleteUser', 9);
    });

    it('purges clean users and surfaces the dependency readout when blocked', async () => {
        const dialogSpy = vi.fn(() => Promise.resolve(true));
        (component as any).dialogService = { open: dialogSpy };
        mockData.invoke.mockImplementation((method: string) => {
            if (method === 'purgeUser') return Promise.resolve({ changes: 1 });
            return Promise.resolve([]);
        });

        await component.purgeUser(9);
        expect(mockData.invoke).toHaveBeenCalledWith('purgeUser', 9);

        mockData.invoke.mockRejectedValue(new Error('Cannot purge: still attributed to 3 visit(s). Deactivate instead.'));
        await component.purgeUser(10);
        expect(dialogSpy).toHaveBeenCalledWith(expect.objectContaining({
            title: 'Cannot purge',
            message: expect.stringContaining('3 visit(s)')
        }));
    });

    it('skips purge when the confirm is dismissed', async () => {
        const dialogSpy = vi.fn(() => Promise.resolve(false));
        (component as any).dialogService = { open: dialogSpy };
        mockData.invoke.mockClear();
        await component.purgeUser(9);
        expect(mockData.invoke).not.toHaveBeenCalledWith('purgeUser', expect.anything());
    });

    it('drives purge through the grid params with deactivate copy', () => {
        const actionsCol = (component as any).userColumnDefs.find((c: any) => c.headerName === 'Actions');
        const params = actionsCol.cellRendererParams;
        expect(params.deleteTitle).toBe('Deactivate');
        const purgeSpy = vi.spyOn(component, 'purgeUser').mockImplementation(() => Promise.resolve());
        params.onPurge({ id: 11 });
        expect(purgeSpy).toHaveBeenCalledWith(11);
        expect(params.canPurge({ username: 'admin' })).toBe(false);
        expect(params.canPurge({ username: 'nurse-1' })).toBe(true);
        purgeSpy.mockRestore();
    });

    it('opens the Permissions surface from grid params', async () => {
        mockData.invoke.mockImplementation((method: string) => {
            if (method === 'getUserOverrides') return Promise.resolve([]);
            return Promise.resolve(null);
        });
        const actionsCol = (component as any).userColumnDefs.find((c: any) => c.headerName === 'Actions');
        await actionsCol.cellRendererParams.onPermissions({ id: 7, name: 'Dot', role: 'doctor' });
        expect(component.permissionTarget.id).toBe(7);
        expect(component.permissionOverrides).toEqual([]);
        component.closePermissions();
    });

    it('covers role manager helpers, guards, and failure paths', async () => {
        const dialogSpy = vi.fn(() => Promise.resolve(false));
        (component as any).dialogService = { open: dialogSpy };
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        component.roles = [];
        component.users = [];
        expect(component.availableRoleNames).toEqual(['admin', 'doctor', 'nurse', 'receptionist']);
        expect(component.userCountFor('nurse')).toBe(0);
        expect(component.isPickableAction('saveVisit')).toBe(false);
        expect(component.isPickableAction('addToQueue')).toBe(true);

        mockData.invoke.mockImplementation((method: string) => {
            if (method === 'getUsers') return Promise.resolve([{ id: 2, role: 'nurse' }]);
            if (method === 'getAllRoles') return Promise.resolve([{ name: 'nurse', permissions: [] }]);
            return Promise.resolve(null);
        });
        component.ngOnInit();
        await vi.waitFor(() => expect(component.roles).toHaveLength(1));
        expect(component.userCountFor('nurse')).toBe(1);

        component.editRole({ name: 'nurse', permissions: ['getQueue'] });
        expect(component.editingRole).toMatchObject({ name: 'nurse', isNew: false });
        component.applyRoleTemplate('No such template');
        expect(component.editingRole?.permissions).toEqual([]);
        component.toggleRolePermission('getQueue');
        expect(component.editingRole?.permissions).toEqual(['getQueue']);
        component.editingRole = null;
        component.toggleRolePermission('getQueue');
        component.applyRoleTemplate('Front Desk');
        component.closeRoles();
        expect(component.showRolesModal).toBe(false);

        component.editingRole = { name: '   ', isNew: true, permissions: [] };
        mockData.invoke.mockClear();
        await component.saveRole();
        expect(mockData.invoke).not.toHaveBeenCalledWith('saveRole', expect.anything());

        mockData.invoke.mockRejectedValue(new Error('db down'));
        component.editingRole = { name: 'x-ray', isNew: true, permissions: [] };
        await component.saveRole();
        expect(dialogSpy).toHaveBeenCalledWith(expect.objectContaining({ title: 'Save failed' }));
        await component.loadRoles();
        expect(errorSpy).toHaveBeenCalled();

        mockData.invoke.mockClear();
        await component.deleteRoleUI('nurse');
        expect(mockData.invoke).not.toHaveBeenCalledWith('deleteRole', expect.anything());
        dialogSpy.mockResolvedValue(true);
        mockData.invoke.mockRejectedValue(new Error('db down'));
        await component.deleteRoleUI('nurse');
        expect(dialogSpy).toHaveBeenCalledWith(expect.objectContaining({ title: 'Delete failed' }));

        component.selectedUsers = [];
        await component.deleteSelectedUsers();

        component.selectedUsers = [{ id: 11 }, { id: 12 }];
        mockData.invoke.mockResolvedValue({ changes: 1 });
        dialogSpy.mockResolvedValue(true);
        await component.deleteSelectedUsers();
        expect(mockData.invoke).toHaveBeenCalledWith('deleteUser', 11);
        expect(mockData.invoke).toHaveBeenCalledWith('deleteUser', 12);
        expect(component.selectedUsers).toEqual([]);
        errorSpy.mockRestore();
    });

    it('surfaces override load and mutation failures as dialogs', async () => {
        const dialogSpy = vi.fn(() => Promise.resolve(true));
        (component as any).dialogService = { open: dialogSpy };
        mockData.invoke.mockRejectedValue(new Error('db down'));
        component.permissionTarget = { id: 5, name: 'Nancy', role: 'nurse' };
        await component.loadPermissionOverrides();
        expect(component.loadingPermissions).toBe(false);
        expect(dialogSpy).toHaveBeenCalledWith(expect.objectContaining({ title: 'Load failed', type: 'error' }));

        component.permissionForm = { action: 'updateQueueStatus', effect: 'allow', reason: 'Covers Tuesdays' };
        await component.addPermissionOverride();
        expect(dialogSpy).toHaveBeenCalledWith(expect.objectContaining({ title: 'Save failed', type: 'error' }));

        await component.removePermissionOverride('updateQueueStatus');
        expect(dialogSpy).toHaveBeenCalledWith(expect.objectContaining({ title: 'Remove failed', type: 'error' }));

        component.permissionTarget = null;
        mockData.invoke.mockClear();
        await component.loadPermissionOverrides();
        await component.removePermissionOverride('updateQueueStatus');
        expect(mockData.invoke).not.toHaveBeenCalledWith('deleteUserOverride', expect.anything());
    });

    describe('local backup health', () => {
        const healthy = {
            enabled: true, schedule: '13:00', destination: '/data/backups', writable: true,
            freeBytes: 2_000_000_000, lastBackupAt: new Date().toISOString(),
            lastBackupName: 'nalamdesk-auto-backup-x.ndbackup', backupAgeHours: 3,
            lastErrorAt: null, lastError: null, nextRunAt: new Date().toISOString(), missed: false
        };

        beforeEach(() => {
            component.isElectron = true;
            (window as any).electron = { backup: {} };
        });

        it('loads health on electron and derives status', async () => {
            (window as any).electron.backup.getLocalBackupHealth = vi.fn(async () => healthy);
            await component.loadBackupHealth();
            expect(component.backupHealth.schedule).toBe('13:00');
            expect(component.backupHealthStatus).toBe('healthy');
            expect(component.backupHealthLoading).toBe(false);

            component.backupHealth = { ...healthy, writable: false };
            expect(component.backupHealthStatus).toBe('error');
            component.backupHealth = { ...healthy, lastErrorAt: new Date().toISOString(), lastBackupAt: null };
            expect(component.backupHealthStatus).toBe('error');
            component.backupHealth = { ...healthy, missed: true };
            expect(component.backupHealthStatus).toBe('attention');
            component.backupHealth = null;
            expect(component.backupHealthStatus).toBe('attention');
        });

        it('tolerates health load failures', async () => {
            (window as any).electron.backup.getLocalBackupHealth = vi.fn(async () => { throw new Error('ipc down'); });
            await component.loadBackupHealth();
            expect(component.backupHealth).toBeNull();
            expect(component.backupHealthLoading).toBe(false);

            component.isElectron = false;
            await component.loadBackupHealth();
        });

        it('compares failure and backup timestamps as instants, not strings', () => {
            const base = {
                enabled: true, schedule: '13:00', destination: '/data', writable: true,
                freeBytes: 1, backupAgeHours: 1, nextRunAt: null, missed: false
            };
            // Same instant in SQLite vs ISO format must NOT read as an error.
            component.backupHealth = {
                ...base,
                lastBackupAt: '2026-03-10T12:00:00.000Z',
                lastBackupName: 'x.ndbackup',
                lastErrorAt: '2026-03-10 12:00:00', lastError: 'old failure'
            };
            expect(component.backupHealthStatus).toBe('healthy');
            // A genuinely newer failure still surfaces.
            component.backupHealth = {
                ...base, lastBackupAt: '2026-03-10T12:00:00.000Z',
                lastBackupName: 'x.ndbackup',
                lastErrorAt: '2026-03-10 13:00:00', lastError: 'new failure'
            };
            expect(component.backupHealthStatus).toBe('error');
        });

        it('runs a local backup now and refreshes health', async () => {
            const runNow = vi.fn(async () => undefined);
            const toast = { success: vi.fn() };
            (window as any).electron.backup = {
                runNow,
                getLocalBackupHealth: vi.fn(async () => healthy)
            };
            (component as any).toastService = toast;
            await component.runLocalBackupNow();
            expect(runNow).toHaveBeenCalled();
            expect(toast.success).toHaveBeenCalledWith('Local backup finished.', 'Backup Complete');
            expect(component.backupHealth.schedule).toBe('13:00');

            runNow.mockRejectedValueOnce(new Error('disk full'));
            (component as any).dialogService = { open: vi.fn(async () => true) };
            await component.runLocalBackupNow();
            expect((component as any).dialogService.open).toHaveBeenCalledWith(
                expect.objectContaining({ title: 'Backup failed' }));
        });

        it('formats free-space bytes for display', () => {
            expect(component.formatBytes(null)).toBe('Unknown');
            expect(component.formatBytes(512)).toBe('512 B');
            expect(component.formatBytes(2_000_000_000)).toBe('1.9 GB');
        });
    });
});
