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

    it('loads the relay connection into the tab state', async () => {
        mockData.invoke.mockImplementation((method: string) => {
            if (method === 'abdmGetConfig') return Promise.resolve({
                mock: false, forced_mock: false, paired: true, paired_hfr_id: 'IN2710000123'
            });
            return Promise.resolve(null);
        });

        await component.loadAbdmConfig();

        expect(component.abdmConfig).toMatchObject({
            mock: false, forced_mock: false, paired: true, paired_hfr_id: 'IN2710000123', hip_id: ''
        });
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

    it('forces the mock only when an admin ticks it, never because the computer is unpaired', async () => {
        mockData.invoke.mockResolvedValue(null);
        component.abdmConfig.mock = true;
        component.abdmConfig.forced_mock = false;

        await component.saveAbdmConfig();
        expect(mockData.invoke).toHaveBeenCalledWith('abdmSaveConfig', expect.objectContaining({ mock: false }));
        expect(mockData.invoke.mock.calls[0][1]).not.toHaveProperty('client_id');

        component.abdmConfig.forced_mock = true;
        await component.saveAbdmConfig();
        const saves = mockData.invoke.mock.calls.filter((call: any[]) => call[0] === 'abdmSaveConfig');
        expect(saves[1][1]).toMatchObject({ mock: true });
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

    describe('extended module coverage', () => {
        let mockDialog: any;
        let mockToast: any;

        const flush = () => new Promise<void>((r) => setTimeout(r, 0));
        const setElectron = (api: any) => {
            (window as any).electron = api;
            component.isElectron = true;
        };
        const invokeImpl = (map: Record<string, any>) => {
            mockData.invoke.mockImplementation((endpoint: string, ...args: any[]) => {
                const v = map[endpoint];
                return Promise.resolve(typeof v === 'function' ? v(...args) : v);
            });
        };

        beforeEach(() => {
            mockDialog = { open: vi.fn(async () => true) };
            mockToast = { success: vi.fn(), error: vi.fn() };
            (component as any).dialogService = mockDialog;
            (component as any).toastService = mockToast;
            mockData.invoke.mockReset().mockResolvedValue(undefined);
            mockAuth.regenerateRecoveryCode = vi.fn();
            delete (window as any).electron;
            component.isElectron = false;
        });

        describe('filters and tabs', () => {
            it('filters staff by role and restores the full list', () => {
                component.users = [
                    { id: 1, role: 'doctor' },
                    { id: 2, role: 'nurse' },
                    { id: 3, role: 'Doctor' }
                ];
                component.setFilter('Doctor');
                expect(component.filteredUsers).toHaveLength(2);
                component.setFilter('all');
                expect(component.filteredUsers).toHaveLength(3);
                component.setFilter('nurse');
                expect(component.filteredUsers.map((u: any) => u.id)).toEqual([2]);
            });

            it('loads audit logs when switching to the audit tab', async () => {
                invokeImpl({ getAuditLogs: [{ id: 1 }] });
                component.switchTab('audit');
                await flush();
                expect(mockData.invoke).toHaveBeenCalledWith('getAuditLogs', 100);
                expect(component.auditLogs).toEqual([{ id: 1 }]);
            });

            it('loads ABDM config and inbox on the abdm tab and nothing extra elsewhere', async () => {
                invokeImpl({ abdmGetConfig: null, abdmGetInbox: [] });
                component.switchTab('abdm');
                await flush();
                expect(mockData.invoke).toHaveBeenCalledWith('abdmGetConfig');
                expect(mockData.invoke).toHaveBeenCalledWith('abdmGetInbox');
                expect(component.inboxItems).toEqual([]);

                mockData.invoke.mockClear();
                component.switchTab('users');
                expect(mockData.invoke).not.toHaveBeenCalled();
            });

            it('tolerates audit load failures', async () => {
                mockData.invoke.mockRejectedValueOnce(new Error('db down'));
                await component.loadAuditLogs();
                expect(component.auditLogs).toEqual([]);
            });
        });

        describe('settings persistence', () => {
            it('loads clinic settings into the form', async () => {
                invokeImpl({
                    getSettings: {
                        clinic_name: 'Test Clinic', drive_client_id: 'cid',
                        drive_client_secret: 'csec', local_backup_path: '/b',
                        backup_schedule: '09:00', cloud_backup_schedule: '10:00'
                    }
                });
                await component.loadSettings();
                expect(component.settings.clinic_name).toBe('Test Clinic');
                expect(component.settings.backup_schedule).toBe('09:00');
            });

            it('tolerates settings load failures', async () => {
                mockData.invoke.mockRejectedValueOnce(new Error('db down'));
                await component.loadSettings();
            });

            it('saves settings and flags the save', async () => {
                invokeImpl({ saveSettings: true });
                await component.saveSettings();
                expect(mockData.invoke).toHaveBeenCalledWith('saveSettings', component.settings);
                expect(component.settingsSaved).toBe(true);
            });

            it('shows a dialog when saving fails', async () => {
                mockData.invoke.mockRejectedValueOnce(new Error('disk gone'));
                await component.saveSettings();
                expect(mockDialog.open).toHaveBeenCalledWith(expect.objectContaining({ title: 'Save failed' }));
            });

            it('picks a backup path and auto-saves', async () => {
                setElectron({ backup: { selectPath: vi.fn(async () => '/picked'), getLocalBackupHealth: vi.fn(async () => null) } });
                invokeImpl({ saveSettings: true });
                await component.selectBackupPath();
                expect(component.settings.local_backup_path).toBe('/picked');
                expect(mockData.invoke).toHaveBeenCalledWith('saveSettings', component.settings);
            });

            it('ignores a cancelled backup path picker', async () => {
                setElectron({ backup: { selectPath: vi.fn(async () => null) } });
                await component.selectBackupPath();
                expect(mockData.invoke).not.toHaveBeenCalledWith('saveSettings', expect.anything());
            });

            it('resets to the default backup path and auto-saves', async () => {
                setElectron({ backup: { useDefaultPath: vi.fn(async () => '/default'), getLocalBackupHealth: vi.fn(async () => null) } });
                invokeImpl({ saveSettings: true });
                await component.useDefaultBackupPath();
                expect(component.settings.local_backup_path).toBe('/default');
            });

            it('does nothing for backup paths outside electron', async () => {
                await component.selectBackupPath();
                await component.useDefaultBackupPath();
                expect(mockData.invoke).not.toHaveBeenCalled();
            });
        });

        describe('app version and updates', () => {
            it('loads the packaged version on electron', async () => {
                setElectron({ getAppVersion: vi.fn(async () => ({ display: '0.0.8 (development)' })) });
                await component.loadAppVersion();
                expect(component.appVersion).toBe('0.0.8 (development)');
            });

            it('tolerates version load failures', async () => {
                setElectron({ getAppVersion: vi.fn(async () => { throw new Error('ipc down'); }) });
                await component.loadAppVersion();
                expect(component.appVersion).toBe('');
            });

            it('checks updates through the update service when available', async () => {
                component.isElectron = true;
                (component as any).updates = { check: vi.fn(async () => undefined) };
                await component.checkForUpdates();
                expect((component as any).updates.check).toHaveBeenCalledWith('manual');
                expect(component.updateBusy).toBe(false);
            });

            it('falls back to electron IPC without the service', async () => {
                component.isElectron = true;
                (component as any).updates = undefined;
                const check = vi.fn(async () => undefined);
                setElectron({ updates: { check } });
                await component.checkForUpdates();
                expect(check).toHaveBeenCalledWith({ source: 'manual' });
            });

            it('skips concurrent or non-electron update checks', async () => {
                component.isElectron = true;
                component.updateBusy = true;
                await component.checkForUpdates();
                component.updateBusy = false;
                component.isElectron = false;
                await component.checkForUpdates();
            });
        });

        describe('user management', () => {
            it('loads users and applies the active filter', async () => {
                component.staffFilter = 'doctor';
                invokeImpl({ getUsers: [{ id: 1, role: 'doctor' }, { id: 2, role: 'nurse' }] });
                await component.loadUsers();
                expect(component.users).toHaveLength(2);
                expect(component.filteredUsers.map((u: any) => u.id)).toEqual([1]);
            });

            it('tolerates user load failures', async () => {
                mockData.invoke.mockRejectedValueOnce(new Error('db down'));
                await component.loadUsers();
            });

            it('saves a valid new user and clears the form', async () => {
                component.editingUser = { username: 'newdoc', name: 'New Doc', role: 'doctor', password: '123456', license_number: 'MED-1' };
                invokeImpl({ saveUser: { id: 9 }, getUsers: [] });
                await component.saveUser();
                expect(mockData.invoke).toHaveBeenCalledWith('saveUser', expect.objectContaining({ username: 'newdoc' }));
                expect(component.editingUser).toBeNull();
            });

            it('requires a license number for new doctor accounts', async () => {
                component.editingUser = { username: 'nolic', name: 'No Lic', role: 'doctor', password: '123456' };
                await component.saveUser();
                expect(mockDialog.open).toHaveBeenCalledWith(expect.objectContaining({ title: 'Check user details' }));
                expect(mockData.invoke).not.toHaveBeenCalledWith('saveUser', expect.anything());
            });

            it('asks existing license-less doctors to backfill instead of blocking deactivation', async () => {
                component.editingUser = { id: 7, username: 'legacy', name: 'Legacy', role: 'doctor', active: 1 };
                await component.saveUser();
                expect(mockDialog.open).toHaveBeenCalledWith(expect.objectContaining({ title: 'Check user details' }));
                component.editingUser = { id: 7, username: 'legacy', name: 'Legacy', role: 'doctor', active: 0 };
                invokeImpl({ saveUser: { id: 7 }, getUsers: [] });
                await component.saveUser();
                expect(mockData.invoke).toHaveBeenCalledWith('saveUser', expect.objectContaining({ id: 7 }));
            });

            it('warns instead of saving an invalid user', async () => {
                component.editingUser = { username: 'ab' };
                await component.saveUser();
                expect(mockDialog.open).toHaveBeenCalledWith(expect.objectContaining({ title: 'Check user details' }));
                expect(mockData.invoke).not.toHaveBeenCalledWith('saveUser', expect.anything());
            });

            it('reports duplicate usernames distinctly', async () => {
                component.editingUser = { username: 'dup', name: 'Dup', role: 'nurse', password: '123456' };
                mockData.invoke.mockRejectedValueOnce(new Error('UNIQUE constraint failed: users.username'));
                await component.saveUser();
                expect(mockDialog.open).toHaveBeenCalledWith(expect.objectContaining({ title: 'Username taken' }));
                expect(component.editingUser).not.toBeNull();
            });

            it('reports other save failures generically', async () => {
                component.editingUser = { username: 'xone', name: 'X One', role: 'nurse', password: '123456' };
                mockData.invoke.mockRejectedValueOnce(new Error('locked'));
                await component.saveUser();
                expect(mockDialog.open).toHaveBeenCalledWith(expect.objectContaining({ title: 'Save failed' }));
            });

            it('deactivates a user after confirmation', async () => {
                invokeImpl({ deleteUser: true, getUsers: [] });
                await component.deleteUser(4);
                expect(mockDialog.open).toHaveBeenCalledWith(expect.objectContaining({ title: 'Deactivate user?' }));
                expect(mockData.invoke).toHaveBeenCalledWith('deleteUser', 4);
            });

            it('keeps the user when deactivation is cancelled', async () => {
                mockDialog.open.mockResolvedValueOnce(false);
                await component.deleteUser(4);
                expect(mockData.invoke).not.toHaveBeenCalledWith('deleteUser', expect.anything());
            });

            it('purges a user after confirmation and reports blocks', async () => {
                invokeImpl({ purgeUser: true, getUsers: [] });
                await component.purgeUser(5);
                expect(mockData.invoke).toHaveBeenCalledWith('purgeUser', 5);

                mockData.invoke.mockRejectedValueOnce(new Error('attributed'));
                await component.purgeUser(6);
                expect(mockDialog.open).toHaveBeenCalledWith(expect.objectContaining({ title: 'Cannot purge' }));
            });

            it('deactivates selected users sequentially', async () => {
                component.selectedUsers = [{ id: 1 }, { id: 2 }];
                invokeImpl({ deleteUser: true, getUsers: [] });
                await component.deleteSelectedUsers();
                expect(mockData.invoke).toHaveBeenCalledWith('deleteUser', 1);
                expect(mockData.invoke).toHaveBeenCalledWith('deleteUser', 2);
                expect(component.selectedUsers).toEqual([]);
            });

            it('does nothing for an empty selection', async () => {
                component.selectedUsers = [];
                await component.deleteSelectedUsers();
                expect(mockData.invoke).not.toHaveBeenCalled();
            });

            it('rotates the device envelope with the current password', async () => {
                mockAuth.rotateDeviceEnvelope.mockResolvedValue({ success: true });
                component.currentDevicePassword = 'device-secret';
                component.showDeviceRotationModal = true;
                await component.rotateDeviceEnvelope();
                expect(mockAuth.rotateDeviceEnvelope).toHaveBeenCalledWith('device-secret');
                expect(component.showDeviceRotationModal).toBe(false);
                expect(component.currentDevicePassword).toBe('');
            });

            it('does nothing to rotate without a password', async () => {
                component.currentDevicePassword = '';
                await component.rotateDeviceEnvelope();
                expect(mockAuth.rotateDeviceEnvelope).not.toHaveBeenCalled();
            });
        });

        describe('roles', () => {
            it('opens, closes, and reloads the role list', async () => {
                invokeImpl({ getAllRoles: [{ name: 'billing', permissions: [] }] });
                await component.openRoles();
                expect(component.showRolesModal).toBe(true);
                expect(component.roles).toHaveLength(1);
                component.closeRoles();
                expect(component.showRolesModal).toBe(false);
                expect(component.editingRole).toBeNull();
            });

            it('tolerates role load failures', async () => {
                mockData.invoke.mockRejectedValueOnce(new Error('db down'));
                await component.loadRoles();
            });

            it('starts and edits role drafts', () => {
                component.startNewRole();
                expect(component.editingRole).toEqual({ name: '', isNew: true, permissions: [] });
                component.editRole({ name: 'billing', permissions: ['getQueue'] });
                expect(component.editingRole).toEqual({ name: 'billing', isNew: false, permissions: ['getQueue'] });
            });

            it('applies templates and toggles permissions', () => {
                component.startNewRole();
                component.applyRoleTemplate('Front Desk');
                expect(component.editingRole!.permissions.length).toBeGreaterThan(0);
                component.applyRoleTemplate('No Such Template');
                expect(component.editingRole!.permissions).toEqual([]);

                component.toggleRolePermission('getQueue');
                expect(component.editingRole!.permissions).toEqual(['getQueue']);
                component.toggleRolePermission('getQueue');
                expect(component.editingRole!.permissions).toEqual([]);

                component.editingRole = null;
                component.toggleRolePermission('getQueue');
                component.applyRoleTemplate('Front Desk');
            });

            it('saves a named role and reloads', async () => {
                component.editingRole = { name: ' billing ', isNew: true, permissions: ['getQueue'] };
                invokeImpl({ saveRole: true, getAllRoles: [] });
                await component.saveRole();
                expect(mockData.invoke).toHaveBeenCalledWith('saveRole', { name: 'billing', permissions: ['getQueue'] });
                expect(component.editingRole).toBeNull();
            });

            it('refuses to save unnamed roles and reports save failures', async () => {
                component.editingRole = { name: '   ', isNew: true, permissions: [] };
                await component.saveRole();
                expect(mockData.invoke).not.toHaveBeenCalled();

                component.editingRole = { name: 'x', isNew: true, permissions: [] };
                mockData.invoke.mockRejectedValueOnce(new Error('taken'));
                await component.saveRole();
                expect(mockDialog.open).toHaveBeenCalledWith(expect.objectContaining({ title: 'Save failed' }));
            });

            it('deletes roles after confirmation', async () => {
                invokeImpl({ deleteRole: true, getAllRoles: [] });
                await component.deleteRoleUI('billing');
                expect(mockData.invoke).toHaveBeenCalledWith('deleteRole', 'billing');

                mockDialog.open.mockResolvedValueOnce(false);
                await component.deleteRoleUI('billing');
                const deletes = mockData.invoke.mock.calls.filter((c: any[]) => c[0] === 'deleteRole');
                expect(deletes).toHaveLength(1);
            });

            it('classifies roles and counts holders', () => {
                expect(component.isBuiltinRole('Admin')).toBe(true);
                expect(component.isBuiltinRole('billing')).toBe(false);
                component.roles = [];
                expect(component.availableRoleNames).toEqual(['admin', 'doctor', 'nurse', 'receptionist']);
                component.roles = [{ name: 'billing' }, { name: null }];
                expect(component.availableRoleNames).toEqual(['billing']);
                component.users = [{ role: 'doctor' }, { role: 'Doctor' }, { role: 'nurse' }];
                expect(component.userCountFor('DOCTOR')).toBe(2);
                expect(component.userCountFor('receptionist')).toBe(0);
            });

            it('filters the method catalog to delegatable actions', () => {
                expect(component.isPickableAction('getQueue')).toBe(true);
                expect(component.isPickableAction('savePatient')).toBe(false);
                for (const group of component.pickableCatalog) {
                    expect(group.methods.length).toBeGreaterThan(0);
                    expect(group.methods).not.toContain('savePatient');
                }
                expect(component.DELEGATEABLE_ACTIONS).toContain('getQueue');
            });
        });

        describe('permission overrides', () => {
            it('opens, loads, and closes the override panel', async () => {
                invokeImpl({ getUserOverrides: [{ action: 'getQueue', effect: 'allow' }] });
                await component.openPermissions({ id: 7 });
                expect(component.permissionTarget).toEqual({ id: 7 });
                expect(component.permissionOverrides).toHaveLength(1);
                component.closePermissions();
                expect(component.permissionTarget).toBeNull();
                expect(component.permissionOverrides).toEqual([]);
            });

            it('tolerates override load failures', async () => {
                component.permissionTarget = { id: 7 };
                mockData.invoke.mockRejectedValueOnce(new Error('db down'));
                await component.loadPermissionOverrides();
                expect(component.loadingPermissions).toBe(false);
            });

            it('saves an override with a reason and reloads', async () => {
                component.permissionTarget = { id: 7 };
                component.permissionForm = { action: 'getQueue', effect: 'deny', reason: '  covers tuesdays ' };
                invokeImpl({ saveUserOverride: { id: 1 }, getUserOverrides: [] });
                await component.addPermissionOverride();
                expect(mockData.invoke).toHaveBeenCalledWith('saveUserOverride', {
                    userId: 7, action: 'getQueue', effect: 'deny', reason: 'covers tuesdays'
                });
                expect(component.permissionForm.action).toBe('');
            });

            it('requires target, action, and reason before saving', async () => {
                component.permissionTarget = null;
                await component.addPermissionOverride();
                component.permissionTarget = { id: 7 };
                component.permissionForm = { action: '', effect: 'allow', reason: '' };
                await component.addPermissionOverride();
                component.permissionForm = { action: 'getQueue', effect: 'allow', reason: '   ' };
                await component.addPermissionOverride();
                expect(mockData.invoke).not.toHaveBeenCalled();
            });

            it('removes an override and reloads', async () => {
                component.permissionTarget = { id: 7 };
                invokeImpl({ deleteUserOverride: true, getUserOverrides: [] });
                await component.removePermissionOverride('getQueue');
                expect(mockData.invoke).toHaveBeenCalledWith('deleteUserOverride', { userId: 7, action: 'getQueue' });

                component.permissionTarget = null;
                await component.removePermissionOverride('getQueue');
            });
        });

        describe('ABDM gateway', () => {
            it('loads config and clears key fields', async () => {
                invokeImpl({
                    abdmGetConfig: {
                        mock: false, paired: true, paired_hfr_id: 'IN2710000123',
                        hip_id: 'H1', counter_id: 'C1', hfr_id: 'F', hpr_id: 'P',
                        hip_endpoint: 'https://x', has_recipient_key: true
                    }
                });
                component.abdmRecipientKey = 'stale';
                await component.loadAbdmConfig();
                expect(component.abdmConfig.paired_hfr_id).toBe('IN2710000123');
                expect(component.abdmConfig.forced_mock).toBe(false);
                expect(component.abdmRecipientKey).toBe('');
            });

            it('saves config with new secrets only when provided', async () => {
                component.abdmConfig = { mock: true, forced_mock: false } as any;
                component.abdmRecipientKey = '  newkey ';
                invokeImpl({ abdmSaveConfig: true, abdmGetConfig: null });
                await component.saveAbdmConfig();
                expect(mockData.invoke).toHaveBeenCalledWith('abdmSaveConfig', expect.objectContaining({
                    recipient_key: 'newkey'
                }));
                expect(component.abdmBusy).toBe(false);
            });

            it('tests connectivity and reports failures', async () => {
                invokeImpl({ abdmTestConnectivity: { ok: true, mode: 'live', detail: 'up' } });
                await component.testAbdm();
                expect(component.abdmTest).toEqual({ ok: true, mode: 'live', detail: 'up' });

                mockData.invoke.mockRejectedValueOnce(new Error('offline'));
                await component.testAbdm();
                expect(component.abdmTest).toEqual({ ok: false, mode: 'error', detail: 'offline' });
            });

            it('builds a QR payload when facility ids exist', async () => {
                component.abdmConfig = { hip_id: ' H1 ', counter_id: ' C1 ' } as any;
                await component.generateQr();
                expect(component.qrDataUrl).toMatch(/^data:image/);

                component.abdmConfig = { hip_id: '', counter_id: '' } as any;
                await component.generateQr();
                expect(component.qrDataUrl).toBeNull();
            });

            it('queues a demo share token and reports errors', async () => {
                invokeImpl({ abdmSimulateShare: { token_no: 42 } });
                await component.simulateShare();
                expect(component.abdmSimResult).toContain('Token #42');

                mockData.invoke.mockRejectedValueOnce(new Error('nope'));
                await component.simulateShare();
                expect(component.abdmSimResult).toBe('nope');
            });

            it('loads and acknowledges inbox items', async () => {
                invokeImpl({ abdmGetInbox: [{ id: 3 }], abdmAckInbox: true });
                await component.loadInbox();
                expect(component.inboxItems).toEqual([{ id: 3 }]);
                await component.ackInbox(3);
                expect(mockData.invoke).toHaveBeenCalledWith('abdmAckInbox', { id: 3 });
            });
        });

        describe('recovery codes', () => {
            it('regenerates a recovery code after password confirm', async () => {
                mockAuth.regenerateRecoveryCode.mockResolvedValue({ success: true, recoveryCode: 'NEW-CODE' });
                component.confirmPassword = 'admin-secret';
                await component.generateRecoveryCode();
                expect(mockAuth.regenerateRecoveryCode).toHaveBeenCalledWith('admin-secret');
                expect(component.newRecoveryCode).toBe('NEW-CODE');
                expect(component.confirmPassword).toBe('');
            });

            it('does nothing without a password and surfaces backend failures', async () => {
                await component.generateRecoveryCode();
                expect(mockAuth.regenerateRecoveryCode).not.toHaveBeenCalled();

                mockAuth.regenerateRecoveryCode.mockResolvedValue({ success: false, error: 'denied' });
                component.confirmPassword = 'wrong';
                await component.generateRecoveryCode();
                expect(mockDialog.open).toHaveBeenCalledWith(expect.objectContaining({ title: 'Rotation failed' }));

                mockAuth.regenerateRecoveryCode.mockRejectedValueOnce(new Error('ipc down'));
                component.confirmPassword = 'wrong';
                await component.generateRecoveryCode();
                expect(component.confirmPassword).toBe('');
            });

            it('copies the code through the electron bridge', async () => {
                const writeText = vi.fn(async () => undefined);
                (window as any).electron = { clipboard: { writeText } };
                component.newRecoveryCode = 'AAAA-BBBB-CCCC-DDDD';
                component.isCopied = false;
                await component.copyRecoveryCode();
                expect(writeText).toHaveBeenCalledWith('AAAA-BBBB-CCCC-DDDD');
                expect(component.isCopied).toBe(true);
                component.newRecoveryCode = null;
                await component.copyRecoveryCode();
            });
        });

        describe('drive backups', () => {
            const driveApi = () => {
                const api = {
                    authenticate: vi.fn(),
                    disconnect: vi.fn(async () => undefined),
                    listBackups: vi.fn(async () => []),
                    backup: vi.fn(),
                    restore: vi.fn(),
                    isAuthenticated: vi.fn(async () => false)
                };
                setElectron({ drive: api });
                return api;
            };

            it('connects with stored credentials and lists backups', async () => {
                const api = driveApi();
                api.authenticate.mockResolvedValue({ success: true });
                api.listBackups.mockResolvedValue([{ id: 'b1' }]);
                component.settings.drive_client_id = 'cid';
                await component.connectDrive();
                expect(api.authenticate).toHaveBeenCalledWith({ clientId: 'cid', clientSecret: component.settings.drive_client_secret });
                expect(component.success).toBe(true);
                await flush();
                expect(component.backups).toEqual([{ id: 'b1' }]);
            });

            it('reports failed and throwing connections distinctly', async () => {
                const api = driveApi();
                api.authenticate.mockResolvedValue({ success: false, error: 'bad secret' });
                await component.connectDrive();
                expect(component.success).toBe(false);
                expect(component.message).toBe('bad secret');

                api.authenticate.mockRejectedValueOnce(new Error('network down'));
                await component.connectDrive();
                expect(component.message).toBe('network down');
            });

            it('disconnects after confirmation only', async () => {
                const api = driveApi();
                await component.disconnectDrive();
                expect(api.disconnect).toHaveBeenCalled();
                expect(component.backups).toEqual([]);

                mockDialog.open.mockResolvedValueOnce(false);
                await component.disconnectDrive();
                expect(api.disconnect).toHaveBeenCalledTimes(1);
            });

            it('runs drive backups and surfaces failures', async () => {
                const api = driveApi();
                api.backup.mockResolvedValue({ success: true });
                api.listBackups.mockResolvedValue([{ id: 'b1' }]);
                await component.backupNow();
                await flush();
                expect(component.backups).toEqual([{ id: 'b1' }]);

                api.backup.mockResolvedValueOnce({ success: false, error: 'quota' });
                await component.backupNow();
                expect(mockDialog.open).toHaveBeenCalledWith(expect.objectContaining({ title: 'Backup failed' }));
            });

            it('restores a backup after confirmation', async () => {
                const api = driveApi();
                api.restore.mockResolvedValue({ success: true, restartRequired: true });
                await component.restore('b1');
                expect(api.restore).toHaveBeenCalledWith('b1');
                expect(mockToast.success).toHaveBeenCalledWith(
                    'The application will now restart.', 'Restore Successful');

                mockDialog.open.mockResolvedValueOnce(false);
                await component.restore('b2');
                expect(api.restore).toHaveBeenCalledTimes(1);
            });

            it('reports failed and throwing restores', async () => {
                const api = driveApi();
                api.restore.mockResolvedValue({ success: false, error: 'gone' });
                await component.restore('b9');
                expect(mockDialog.open).toHaveBeenCalledWith(expect.objectContaining({ title: 'Restore failed' }));

                api.restore.mockRejectedValueOnce(new Error('crashed'));
                await component.restore('b9');
                expect(component.isBackupLoading).toBe(false);
            });

            it('selects restore bundles and flags legacy files', async () => {
                setElectron({ backup: { selectRestoreBundle: vi.fn(async () => ({ path: '/x/y.ndbackup', name: 'y.ndbackup' })) } });
                await component.selectRestoreBundle();
                expect(component.restoreBundle).toEqual({ path: '/x/y.ndbackup', name: 'y.ndbackup' });
                expect(component.restoreError).toBe('');

                setElectron({ backup: { selectRestoreBundle: vi.fn(async () => ({ path: '/x/y.db', name: 'y.DB' })) } });
                await component.selectRestoreBundle();
                expect(component.restoreError).toContain('cannot recover a live vault');
            });

            it('restores a local bundle through the guarded IPC', async () => {
                const restoreSystemBackup = vi.fn(async () => ({ success: true }));
                setElectron({ restoreSystemBackup });
                component.restoreBundle = { path: '/x/y.ndbackup', name: 'y.ndbackup' };
                component.restoreRecoveryCode = 'CODE';
                component.restoreAdminPassword = 'pw';
                await component.restoreLocalBackup();
                expect(restoreSystemBackup).toHaveBeenCalledWith({
                    path: '/x/y.ndbackup', recoveryCode: 'CODE', currentAdminPassword: 'pw'
                });
                expect(component.isRestoring).toBe(true);
            });

            it('validates restore inputs before touching IPC', async () => {
                setElectron({ restoreSystemBackup: vi.fn() });
                component.isElectron = false;
                await component.restoreLocalBackup();
                component.isElectron = true;

                component.restoreBundle = { path: '/x/y.db', name: 'y.db' };
                await component.restoreLocalBackup();
                expect(component.restoreError).toContain('missing recovery metadata');

                component.restoreBundle = { path: '/x/y.ndbackup', name: 'y.ndbackup' };
                component.restoreRecoveryCode = '';
                component.restoreAdminPassword = 'pw';
                await component.restoreLocalBackup();
                expect(component.restoreError).toContain('Recovery Code');

                component.restoreRecoveryCode = 'CODE';
                component.restoreAdminPassword = '';
                await component.restoreLocalBackup();
                expect(component.restoreError).toContain('administrator password');
                expect((window as any).electron.restoreSystemBackup).not.toHaveBeenCalled();
            });

            it('maps restore failure codes to user messages', async () => {
                const restoreSystemBackup = vi.fn(async () => ({ success: false }));
                setElectron({ restoreSystemBackup });
                component.restoreBundle = { path: '/x/y.ndbackup', name: 'y.ndbackup' };
                component.restoreRecoveryCode = 'CODE';
                component.restoreAdminPassword = 'pw';

                restoreSystemBackup.mockRejectedValueOnce(new Error('INVALID_RECOVERY_CODE'));
                await component.restoreLocalBackup();
                expect(component.restoreError).toContain('Recovery Code is incorrect');

                restoreSystemBackup.mockRejectedValueOnce(new Error('INVALID_ADMIN_CREDENTIAL'));
                await component.restoreLocalBackup();
                expect(component.restoreError).toContain('administrator password is incorrect');
                expect(component.isRestoring).toBe(false);
            });

            it('checks drive status and refreshes when authenticated', async () => {
                const api = driveApi();
                api.isAuthenticated.mockResolvedValue(true);
                api.listBackups.mockResolvedValue([{ id: 'b1' }]);
                await component.checkDriveStatus();
                expect(component.success).toBe(true);
                await flush();
                expect(component.backups).toEqual([{ id: 'b1' }]);

                api.isAuthenticated.mockResolvedValue(false);
                await component.checkDriveStatus();
            });
        });

        describe('external links', () => {
            it('opens the Drive console and setup guide', async () => {
                const openExternal = vi.fn(async () => undefined);
                setElectron({ utils: { openExternal } });
                const event = { preventDefault: vi.fn() } as any;
                await component.openDriveConsole(event);
                await component.openSetupGuide(event);
                expect(event.preventDefault).toHaveBeenCalledTimes(2);
                expect(openExternal).toHaveBeenCalledTimes(2);
            });
        });

        describe('table renderers', () => {
            it('formats audit time and action badges', () => {
                const [time, actor, action] = component.auditColumnDefs as any[];
                expect(time.valueFormatter({ value: null })).toBe('-');
                expect(time.valueFormatter({ value: '2026-01-02T03:04:05.000Z' })).toMatch(/\d+\/\d+\/\d+/);
                expect(actor.cellRenderer({ value: 'Dr A' })).toContain('Dr A');
                expect(actor.cellRenderer({ value: '' })).toContain('Unknown');
                expect(action.cellRenderer({ value: 'UPDATE x' })).toContain('text-blue-600');
                expect(action.cellRenderer({ value: 'INSERT x' })).toContain('text-green-600');
                expect(action.cellRenderer({ value: 'DELETE x' })).toContain('text-red-600');
                expect(action.cellRenderer({ value: 'other' })).toContain('text-gray-600');
            });

            it('renders employee, role, and contact cells', () => {
                component.currentUser = { id: 1 };
                const [employee, role, contact] = component.userColumnDefs as any[];
                expect(employee.cellRenderer({ data: null })).toBe('');
                const me = employee.cellRenderer({ data: { id: 1, name: 'amy', username: 'amy', role: 'admin' } });
                expect(me).toContain('YOU');
                expect(me).toContain('bg-purple-100');
                expect(role.cellRenderer({ value: '' })).toBe('-');
                expect(role.cellRenderer({ value: 'doctor', data: {} })).toContain('bg-green-100');
                expect(role.cellRenderer({ value: 'nurse', data: { designation: 'Sr' } })).toContain('Sr');
                expect(contact.valueGetter({ data: null })).toBe('');
                expect(contact.valueGetter({ data: { email: 'a@b.c' } })).toBe('a@b.c');
                expect(contact.valueGetter({ data: {} })).toBe('No contact info');
                expect(contact.cellRenderer({ data: null })).toBe('');
                expect(contact.cellRenderer({ data: { mobile: '999', email: 'a@b.c' } })).toContain('999');
                expect(contact.cellRenderer({ data: {} })).toContain('No contact info');
            });
        });

        describe('lifecycle', () => {
            it('loads admin surfaces on init for admins', async () => {
                setElectron({
                    drive: { listBackups: vi.fn(async () => []), isAuthenticated: vi.fn(async () => false) },
                    cloud: { getStatus: vi.fn(async () => ({ enabled: false, clinicId: null })) },
                    backup: { getLocalBackupHealth: vi.fn(async () => null) },
                    getAppVersion: vi.fn(async () => ({ display: 'v' }))
                });
                invokeImpl({ getSettings: {}, getUsers: [], getAllRoles: [] });
                component.ngOnInit();
                await flush();
                expect(mockData.invoke).toHaveBeenCalledWith('getUsers');
                expect(mockData.invoke).toHaveBeenCalledWith('getAllRoles');
                expect(component.currentUser?.username).toBe('admin');
            });

            it('skips admin surfaces for non-admin roles', async () => {
                mockAuth.getUser.mockReturnValue({ id: 2, username: 'doc', role: 'doctor' });
                component.ngOnInit();
                await flush();
                expect(mockData.invoke).not.toHaveBeenCalledWith('getUsers');
                expect(mockData.invoke).not.toHaveBeenCalledWith('getAllRoles');
            });
        });

        describe('remaining branches', () => {
            it('opens the password, reset, rotation, and recovery modals', () => {
                component.openLoginPasswordModal();
                expect(component.showLoginPasswordModal).toBe(true);
                expect(component.currentLoginPassword).toBe('');

                component.openUserResetModal({ id: 3 });
                expect(component.resetTarget).toEqual({ id: 3 });
                expect(component.showUserResetModal).toBe(true);

                component.openDeviceRotationModal();
                expect(component.showDeviceRotationModal).toBe(true);

                component.openRecoveryModal();
                expect(component.showRecoveryModal).toBe(true);
                expect(component.newRecoveryCode).toBeNull();
            });

            it('hides the recovery modal when there is no code to confirm', async () => {
                component.newRecoveryCode = null;
                component.showRecoveryModal = true;
                await component.closeRecoveryModal();
                expect(component.showRecoveryModal).toBe(false);
                expect(mockAuth.acknowledgeRecoveryCode).not.toHaveBeenCalled();
            });

            it('renders every role badge branch', () => {
                const [, role] = component.userColumnDefs as any[];
                expect(role.cellRenderer({ value: 'admin', data: {} })).toContain('bg-purple-100');
                expect(role.cellRenderer({ value: 'receptionist', data: {} })).toContain('bg-blue-100');
                expect(role.cellRenderer({ value: 'coder', data: {} })).toContain('bg-gray-100');
            });

            it('formats date columns and empty values', () => {
                const defs = component.userColumnDefs as any[];
                const dob = defs.find((d: any) => d.headerName === 'DOB');
                const joined = defs.find((d: any) => d.headerName === 'Joined');
                expect(dob.valueFormatter({ value: null })).toBe('-');
                expect(dob.valueFormatter({ value: '2020-05-06T00:00:00.000Z' })).toMatch(/\d{4}|\d+\/\d+\/\d+/);
                expect(joined.valueFormatter({ value: null })).toBe('-');
            });

            it('wires action-cell callbacks with admin guards', async () => {
                const defs = component.userColumnDefs as any[];
                const actions = defs.find((d: any) => d.headerName === 'Actions').cellRendererParams;
                expect(actions.canDelete({ username: 'admin' })).toBe(false);
                expect(actions.canDelete({ username: 'doc' })).toBe(true);
                expect(actions.canPurge({ username: 'admin' })).toBe(false);

                actions.onEdit({ id: 1, username: 'doc', role: 'nurse', name: 'Doc' });
                expect(component.editingUser).toMatchObject({ id: 1 });

                invokeImpl({ deleteUser: true, getUsers: [] });
                await actions.onDelete({ id: 2 });
                expect(mockData.invoke).toHaveBeenCalledWith('deleteUser', 2);

                invokeImpl({ purgeUser: true, getUsers: [] });
                await actions.onPurge({ id: 3 });
                expect(mockData.invoke).toHaveBeenCalledWith('purgeUser', 3);

                invokeImpl({ getUserOverrides: [] });
                await actions.onPermissions({ id: 4 });
                expect(component.permissionTarget).toEqual({ id: 4 });
            });

            it('guards busy ABDM saves and reports failures', async () => {
                component.abdmBusy = true;
                await component.saveAbdmConfig();
                expect(mockData.invoke).not.toHaveBeenCalled();
                component.abdmBusy = false;

                component.abdmConfig = { mock: true, forced_mock: false } as any;
                mockData.invoke.mockRejectedValueOnce(new Error('down'));
                await component.saveAbdmConfig();
                expect(component.abdmBusy).toBe(false);
            });

            it('tolerates synchronous inbox failures', async () => {
                mockData.invoke.mockImplementationOnce(() => { throw new Error('sync boom'); });
                await component.loadInbox();
                expect(component.inboxItems).toEqual([]);
            });

            it('reports batch deactivation failures', async () => {
                component.selectedUsers = [{ id: 1 }];
                mockData.invoke.mockRejectedValueOnce(new Error('locked'));
                await component.deleteSelectedUsers();
                expect(mockDialog.open).toHaveBeenCalledWith(expect.objectContaining({ title: 'Deactivate failed' }));
            });

            it('copies through the web clipboard without electron', async () => {
                delete (window as any).electron;
                const writeText = vi.fn(async () => undefined);
                (navigator as any).clipboard = { writeText };
                component.newRecoveryCode = 'CODE';
                await component.copyRecoveryCode();
                expect(writeText).toHaveBeenCalledWith('CODE');
                delete (navigator as any).clipboard;
            });

            it('tolerates restore-bundle picker failures', async () => {
                setElectron({
                    backup: {
                        selectRestoreBundle: vi.fn(() => { throw new Error('no dialog'); })
                    }
                });
                await component.selectRestoreBundle();
                expect(component.restoreError).toBe('no dialog');
            });

            it('skips a local backup while one is already running', async () => {
                component.isElectron = true;
                component.isBackupLoading = true;
                (window as any).electron = { backup: { runNow: vi.fn() } };
                await component.runLocalBackupNow();
                expect((window as any).electron.backup.runNow).not.toHaveBeenCalled();
            });

            it('reports update-check failures', async () => {
                component.isElectron = true;
                (component as any).updates = { check: vi.fn(async () => { throw new Error('no net'); }) };
                await component.checkForUpdates();
                expect(component.updateBusy).toBe(false);
            });
        });
    });
});
