import { app, BrowserWindow, ipcMain, clipboard, shell, dialog } from 'electron';
import * as path from 'path';
import { autoUpdater } from 'electron-updater';
import log from 'electron-log';
import { bindUpdateIpc, createUpdateService, type UpdaterPort } from './updates/updateService';

import { preferLinuxGnomeLibsecret } from './linuxKeyring';
import { loadAppVersionInfo } from './appVersionInfo';
import { SessionService } from './services/SessionService';
import { BackupService } from './services/BackupService';
import { selectRestoreBundle } from './services/BackupFileSelection';
import { RestoreOperationGate } from './services/RestoreOperationGate';
import { runDriveRestore } from './services/DriveRestore';
import { requireExistingRestoreAuthorization } from './services/RestoreAuthorization';
import { CrashService } from './services/CrashService';
import { SecurityService } from './services/SecurityService';
import { ElectronSafeStorageDeviceKeyStore, isDeviceCryptoFailure } from './services/DeviceKeyStore';
import { AbdmSessionService } from './services/AbdmSessionService';
import { AbdmAbhaService } from './services/AbdmAbhaService';
import { DatabaseService } from './services/DatabaseService';
import { GoogleDriveService } from './services/GoogleDriveService';
import { CloudSyncService } from './services/CloudSyncService';
import { buildAuthenticatedLoginResult } from './services/AuthResult';
import { ProvisioningService } from './services/ProvisioningService';
import { CredentialRotationService } from './services/CredentialRotationService';
import { verifyPersistedActiveAdmin } from './services/AdminCredentialVerifier';
import { acknowledgeRecoveryCodeForActiveAdmin } from './services/RecoveryCodeAcknowledgement';
import { ApiServer } from '../server/app';
import { invokeDbMethod } from '../shared/ipc-db-args';
import {
    DEV_APP_NAME,
    getApiPort,
    getDatabasePath,
    getDevUiProxyUrl,
    getDevUserDataPath,
    isDevRuntime,
} from '../shared/runtime-config';

import { session } from 'electron';

// Linux: force gnome-libsecret before Chromium/OSCrypt picks basic_text.
preferLinuxGnomeLibsecret(app.commandLine);

// Dev isolation: separate userData dir and API port from installed NalamDesk (Mac/Windows).
const isDev = isDevRuntime(app.isPackaged);
if (isDev) {
    app.setName(DEV_APP_NAME);
    app.setPath('userData', getDevUserDataPath(app.getPath('appData')));
}

const userDataPath = app.getPath('userData');
const apiPort = getApiPort(app.isPackaged);

if (isDev) {
    console.log(`[Dev] Isolated from installed app — API :${apiPort}, data: ${userDataPath}`);
}

// Initialize Crash Service immediately to catch early errors
const crashService = new CrashService();

// Disable Hardware Acceleration to prevent input freezing/rendering glitches
app.disableHardwareAcceleration();

// Single Instance Lock (dev uses NalamDesk Dev identity — separate from installed app)
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
    console.log('[Main] Another instance is already running. Quitting...');
    app.quit();
} else {
    app.on('second-instance', () => {
        // Someone tried to run a second instance, we should focus our window.
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        }
    });

    // Proceed with App Initialization
    initializeApp();
}

let mainWindow: BrowserWindow | null = null;


// IPC Handlers for utilities
ipcMain.handle('utils:openExternal', async (_, url) => {
    await shell.openExternal(url);
});

function resolveLocalIp(): string {
    try {
        const os = require('os');
        const nets = os.networkInterfaces();
        for (const name of Object.keys(nets)) {
            for (const net of nets[name] || []) {
                if (net.family === 'IPv4' && !net.internal) {
                    return net.address;
                }
            }
        }
        return 'localhost';
    } catch (e) {
        console.error('[Main] resolveLocalIp error:', e);
        return 'localhost';
    }
}

ipcMain.handle('utils:getLocalIp', () => resolveLocalIp());

ipcMain.handle('utils:getRuntimeInfo', () => ({
    localIp: resolveLocalIp(),
    apiPort,
    isDev,
    appName: app.getName(),
}));

ipcMain.handle('app:getVersion', () => loadAppVersionInfo(app, isDev));

const updateService = createUpdateService({
        updater: autoUpdater as unknown as UpdaterPort,
    isPackaged: app.isPackaged,
    env: process.env,
    platform: process.platform,
    isAppImage: Boolean(process.env['APPIMAGE']),
    getVersion: () => app.getVersion(),
    send: (_channel, payload) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('updates:event', payload);
        }
    },
    openExternal: (url) => shell.openExternal(url)
});
bindUpdateIpc(ipcMain, updateService);
autoUpdater.logger = log;

// Services
const securityService = new SecurityService(new ElectronSafeStorageDeviceKeyStore());
const databaseService = new DatabaseService();
const abdmSessionService = new AbdmSessionService({
    getSettings: () => databaseService.getSettings(),
    getSecretProtected: () => databaseService.getAbdmSecretProtected(),
    saveSettingsPatch: (patch) => databaseService.saveSettings(patch),
    saveSecretProtected: (value) => databaseService.saveAbdmSecretProtected(value),
    keyStore: new ElectronSafeStorageDeviceKeyStore()
});
const abdmAbhaService = new AbdmAbhaService({
    getSessionToken: () => abdmSessionService.getSessionToken(),
    gatewayBaseUrl: () => abdmSessionService.gatewayBaseUrl()
});
const credentialRotationService = new CredentialRotationService();
const provisioningService = new ProvisioningService(securityService, databaseService);
const googleDriveService = new GoogleDriveService();
const cloudSyncService = new CloudSyncService(databaseService);

// Determine Static Path for ApiServer
const staticPath = isDev
    ? path.join(__dirname, '../../dist/nalamdesk/browser')
    : path.join(app.getAppPath(), 'dist/nalamdesk/browser');

// Ensure static path exists (crucial for Dev mode if not built)
const fs = require('fs');
if (!fs.existsSync(staticPath)) {
    console.log(`[Main] Creating missing static path: ${staticPath}`);
    fs.mkdirSync(staticPath, { recursive: true });
}

const apiServer = new ApiServer(
    databaseService,
    staticPath,
    isDev ? getDevUiProxyUrl() : undefined
);
const sessionService = new SessionService();
const backupService = new BackupService(databaseService, googleDriveService, securityService, userDataPath, {
    appVersion: app.getVersion(),
    // Restore validation must not reconfigure or close the live vault.
    createIsolatedSecurityService: () => new SecurityService(new ElectronSafeStorageDeviceKeyStore()),
    onRestoreCommitted: () => sessionService.clearSession()
});
const authorizedRestorePaths = new Set<string>();
const restoreOperationGate = new RestoreOperationGate();

// ... (cloud sync init logic)
// DB init happens via IPC. ApiServer will report 503 if DB not ready (guarded in handler).
// ... (cloud sync init logic)
console.log('[Main] Starting ApiServer...');
try {
    apiServer.start(apiPort); // Fire and forget (it logs its own success)
    console.log('[Main] ApiServer start command issued.');
} catch (e) {
    console.error('[Main] ApiServer failed to start immediately:', e);
}

// Removing global currentUser variable
// let currentUser: any = null; 

// ... (rest of window creation)

async function createWindow() {
    console.log('[Main] createWindow called');
    try {
        mainWindow = new BrowserWindow({
            width: 1280,
            height: 800,
            title: isDev ? `${DEV_APP_NAME} (API :${apiPort})` : 'NalamDesk',
            icon: isDev
                ? path.join(__dirname, '../../build/icon.png')
                : path.join(app.getAppPath(), 'build/icon.png'),
            show: !isDev,
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                preload: path.join(__dirname, 'preload.js'),
            },
        });

        if (isDev) {
            mainWindow.once('ready-to-show', () => {
                mainWindow?.showInactive();
            });
        }

        // Remove default menu bar completely
        mainWindow.setMenu(null);
        console.log('[Main] BrowserWindow created');

        if (isDev) {
            const devUiUrl = getDevUiProxyUrl();
            console.log(`[Main] Loading URL: ${devUiUrl}`);
            await mainWindow.loadURL(devUiUrl);
            mainWindow.webContents.openDevTools({ mode: 'right', activate: false });
            console.log('[Main] URL loaded');
        } else {
            console.log(`[Main] Loading File: ${path.join(staticPath, 'index.html')}`);
            await mainWindow.loadFile(path.join(staticPath, 'index.html'));
            console.log('[Main] File loaded');
        }
    } catch (e) {
        console.error('[Main] createWindow error:', e);
    }
}

function initializeApp() {
    app.whenReady().then(() => {
        console.log('[Main] app.whenReady fired');
        // 1. CSP (Content Security Policy)
        session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
            // Skip external origins
            try {
                const url = new URL(details.url);
                if (url.protocol !== 'file:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
                    return callback({});
                }
            } catch { return callback({}); }

            const devCSP = `default-src 'self' 'unsafe-inline' data:; script-src 'self' 'unsafe-eval' 'unsafe-inline'; connect-src 'self' http://localhost:${apiPort} https://www.googleapis.com https://accounts.google.com; img-src 'self' data: https://lh3.googleusercontent.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:;`;
            const prodCSP = "default-src 'self' 'unsafe-inline' data:; script-src 'self' 'unsafe-inline'; connect-src 'self' https://www.googleapis.com https://accounts.google.com; img-src 'self' data: https://lh3.googleusercontent.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:;";

            callback({
                responseHeaders: {
                    ...details.responseHeaders,
                    'Content-Security-Policy': [isDev ? devCSP : prodCSP],
                },
            });
        });

        // 2. Permission Handler (Deny by default)
        session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
            // Allowed permissions
            const allowedPermissions = ['media']; // e.g. for camera if needed later
            if (allowedPermissions.includes(permission)) {
                callback(true);
            } else {
                console.warn(`[Security] Denied permission request: ${permission}`);
                callback(false);
            }
        });

        // 3. Navigation Guard
        session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
            let urlObj: URL;
            try {
                urlObj = new URL(details.url);
            } catch {
                return callback({ cancel: true }); // Invalid URL
            }

            // Allow DevTools, File, and Localhost
            if (urlObj.protocol === 'devtools:' || urlObj.protocol === 'file:' || urlObj.hostname === 'localhost' || urlObj.hostname === '127.0.0.1') {
                return callback({ cancel: false });
            }

            // Allow specific Google hosts for OAuth and Fonts
            const trustedHosts = [
                'accounts.google.com',
                'www.googleapis.com',
                'fonts.googleapis.com',
                'fonts.gstatic.com'
            ];
            if (urlObj.protocol === 'https:' && trustedHosts.some(h => urlObj.hostname === h || urlObj.hostname.endsWith('.' + h))) {
                return callback({ cancel: false });
            }

            console.warn(`[Security] Blocked request: ${details.url}`);
            callback({ cancel: true });
        });

        createWindow();

        app.on('activate', () => {
            if (BrowserWindow.getAllWindows().length === 0) createWindow();
        });
    });
}

// Global Backup on Quit Logic
let isQuitting = false;
app.on('before-quit', async (e) => {
    if (isQuitting) return;

    e.preventDefault();
    console.log('[Main] App closing... Starting final backup.');

    // Optional: Notify user via window if visible
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('app:quitting', 'Backing up data...');
    }

    try {
        await backupService.performBackupOnQuit();
    } catch (err) {
        console.error('[Main] Final backup failed:', err);
    }

    isQuitting = true;
    app.quit();
});

// IPC Handlers
// IPC Handlers
ipcMain.handle('auth:checkSetup', () => {
    const userDataPath = app.getPath('userData');
    const dbName = process.env['NODE_ENV'] === 'test' ? 'nalamdesk-test.db' : 'nalamdesk.db';
    securityService.reconcileProvisioning(getDatabasePath(userDataPath, dbName), userDataPath);
    return securityService.isSetup(userDataPath);
});

ipcMain.handle('auth:setup', async (event, { password, clinicDetails, adminDetails }) => {
    try {
        console.log('[Auth] Starting Setup...');
        const userDataPath = app.getPath('userData');
        const dbName = process.env['NODE_ENV'] === 'test' ? 'nalamdesk-test.db' : 'nalamdesk.db';
        const dbPath = getDatabasePath(userDataPath, dbName);

        // One durable transaction covers vault creation, schema, clinic settings,
        // and the administrator credential. The password never wraps the DEK.
        const recoveryCode = await provisioningService.provision(
            password, clinicDetails, dbPath, userDataPath
        );
        credentialRotationService.setDb(securityService.getDb());
        credentialRotationService.reconcileInterruptedRotation();

        console.log('[Auth] Setup Complete.');
        return { success: true, recoveryCode };
    } catch (e: any) {
        console.error('[Auth] Setup failed:', e);
        return { success: false, error: e.message };
    }
});

ipcMain.handle('auth:recover', async (event, { recoveryCode }) => {
    try {
        console.log('[Auth] Starting Recovery...');
        const userDataPath = app.getPath('userData');
        const dbName = process.env['NODE_ENV'] === 'test' ? 'nalamdesk-test.db' : 'nalamdesk.db';
        const dbPath = getDatabasePath(userDataPath, dbName);

        // Recovery re-enrols this device. Account password recovery is a
        // separate workflow owned by issue #6.
        await securityService.recoverDevice(recoveryCode, userDataPath, dbPath);

        // 2. Set DB
        const db = securityService.getDb();
        databaseService.setDb(db);

        await databaseService.migrate();
        credentialRotationService.setDb(db);
        credentialRotationService.reconcileInterruptedRotation();
        return {
            success: true,
            pendingRecoveryCode: securityService.getPendingRecoveryCode() || undefined
        };
    } catch (e: any) {
        console.error('[Auth] Recovery failed:', e);
        return { success: false, error: e.message };
    }
});

ipcMain.handle('auth:regenerateRecoveryCode', async (event, { password }) => {
    try {
        const user = sessionService.getUser();
        if (!await verifyPersistedActiveAdmin(user, databaseService, password)) throw new Error('INVALID_CREDENTIALS');

        console.log('[Auth] Regenerating Recovery Code...');
        const recoveryCode = await securityService.regenerateRecoveryCode();
        return { success: true, recoveryCode };
    } catch (e: any) {
        console.error('[Auth] Regenerate Recovery Code failed:', e);
        return { success: false, error: e.message };
    }
});

ipcMain.handle('auth:rotateDeviceEnvelope', async (_event, { currentPassword }) => {
    try {
        const user = sessionService.getUser();
        if (!await verifyPersistedActiveAdmin(user, databaseService, currentPassword)) {
            throw new Error('INVALID_CREDENTIALS');
        }
        securityService.rotateDeviceEnvelope();
        return { success: true };
    } catch (e: any) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('auth:changeLoginPassword', async (_event, { currentPassword, newPassword }) => {
    try {
        const user = sessionService.getUser();
        if (!user) throw new Error('Unauthorized');
        await credentialRotationService.changeOwnPassword(user.id, currentPassword, newPassword);
        sessionService.setUser({ ...user, password_reset_required: 0 });
        return { success: true };
    } catch (e: any) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('auth:resetUserPassword', async (_event, { targetUserId, currentAdminPassword, temporaryPassword }) => {
    try {
        const user = sessionService.getUser();
        if (!user || user.role !== 'admin') throw new Error('Forbidden');
        await credentialRotationService.resetUserPassword(
            user.id, currentAdminPassword, targetUserId, temporaryPassword
        );
        return { success: true };
    } catch (e: any) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('auth:acknowledgeRecoveryCode', async (_event, { recoveryCode }) => {
    const user = sessionService.getUser();
    acknowledgeRecoveryCodeForActiveAdmin(user, databaseService, securityService, recoveryCode);
    return { success: true };
});

ipcMain.handle('clipboard:writeText', (event, text) => {
    clipboard.writeText(text);
    return true;
});

async function tryUnlockDatabase(legacySecret: string): Promise<{ error?: string; migrated?: boolean }> {
    if (securityService.getDb()) {
        const openDb = securityService.getDb();
        databaseService.setDb(openDb);
        credentialRotationService.setDb(openDb);
        credentialRotationService.reconcileInterruptedRotation();
        return {};
    }

    try {
        const userDataPath = app.getPath('userData');
        const dbName = process.env['NODE_ENV'] === 'test' ? 'nalamdesk-test.db' : 'nalamdesk.db';
        const dbPath = getDatabasePath(userDataPath, dbName);

        let result;
        try {
            result = await securityService.initializeDevice(dbPath, userDataPath);
        } catch (error: any) {
            if (error.message !== 'LEGACY_MIGRATION_REQUIRED') throw error;
            // The submitted password is used only for this one-time legacy
            // migration. It is not part of the v3 device unlock contract.
            result = await securityService.migrateLegacy(legacySecret, dbPath, userDataPath);
        }
        const db = securityService.getDb();
        databaseService.setDb(db);

        // Ensure schema is up to date (safe idempotent)
        await databaseService.migrate();
        credentialRotationService.setDb(db);
        credentialRotationService.reconcileInterruptedRotation();
        return { migrated: result.migrated };
    } catch (e: any) {
        if (e.message === 'NOT_SETUP') return { error: 'SETUP_REQUIRED' };
        if (e.message === 'INVALID_LEGACY_CREDENTIAL') return { error: 'INVALID_CREDENTIALS' };
        if (isDeviceCryptoFailure(e.message)) {
            return { error: 'RECOVERY_REQUIRED' };
        }
        if (e.message === 'VAULT_BINDING_MISMATCH') return { error: 'VAULT_BINDING_MISMATCH' };

        console.error('DB Init failed:', e);
        return { error: 'SYSTEM_ERROR' };
    }
}

function initializeServices(settings: any): void {
    try {
        if (settings?.drive_client_id && settings?.drive_client_secret) {
            googleDriveService.configureCredentials(settings.drive_client_id, settings.drive_client_secret);
        }
        if (settings?.drive_tokens) {
            googleDriveService.setCredentials(JSON.parse(settings.drive_tokens));
        }
        if (settings?.local_backup_path || settings?.drive_tokens) {
            backupService.initAutomatedBackup();
        }
    } catch (e) {
        console.error('Failed to configure services', e);
    }
}

async function handleAdminLogin(password: string): Promise<{ success: boolean; user?: any; error?: string } | null> {
    const user = await databaseService.getUserByUsername('admin');
    if (!user) return null;

    const argon2 = await import('argon2');
    if (!await argon2.verify(user.password, password)) return null;

    sessionService.setUser(user);
    initializeServices(databaseService.getSettings());
    return buildAuthenticatedLoginResult(sessionService.getUser()!, securityService);
}

function handleDb(channel: string, handler: (...args: any[]) => any) {
    ipcMain.handle(channel, async (...args) => databaseService.runWork(() => handler(...args)));
}

ipcMain.handle('auth:logout', () => {
    sessionService.clearSession();
});

handleDb('auth:login', async (event, credentials) => {
    try {
        const { username, password } = credentials;

        // 1. Initialize / Unlock DB
        const unlockResult = await tryUnlockDatabase(password);
        if (unlockResult.error) return { success: false, error: unlockResult.error };

        // 2. Check if DB is open
        const db = securityService.getDb();
        if (!db) {
            return username === 'admin'
                ? { success: false, error: 'INVALID_CREDENTIALS' }
                : { success: false, error: 'SYSTEM_LOCKED' };
        }

        databaseService.setDb(db);

        // 3. Admin fast path
        if (username === 'admin') {
            const adminResult = await handleAdminLogin(password);
            if (adminResult) {
                return adminResult;
            }
            // Fallthrough to standard validation if admin user missing from DB
        }

        // 4. Standard user validation
        console.log(`[Auth] Validating user: ${username}`);
        const result = await databaseService.validateUser(username, password);

        if (result.success && result.user) {
            sessionService.setUser(result.user);
            initializeServices(databaseService.getSettings());
            return buildAuthenticatedLoginResult(sessionService.getUser()!, securityService);
        }

        return { success: false, error: 'INVALID_CREDENTIALS' };

    } catch (error: any) {
        if (error?.message === 'RESTORE_IN_PROGRESS') throw error;
        console.error('Login failed:', error);
        return { success: false, error: 'UNKNOWN_ERROR' };
    }
});

// Dashboard / Stats
handleDb('db:getDashboardStats', () => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    return databaseService.getDashboardStats();
});

// Patients
handleDb('db:getPatients', (_, query) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    return databaseService.getPatients(query);
});
handleDb('db:getPatientById', (_, id) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    return databaseService.getPatientById(id);
});
handleDb('db:savePatient', (_, patient) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    // Basic RBAC check (doctors/receptionists) - simplified for now
    if (!['doctor', 'receptionist', 'admin'].includes(user.role)) throw new Error('Forbidden');
    return databaseService.savePatient(patient);
});
handleDb('db:deletePatient', (_, id) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    if (user.role !== 'admin') throw new Error('Forbidden');
    return databaseService.deletePatient(id);
});

// Visits
handleDb('db:getVisits', (_, patientId) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    return databaseService.getVisits(patientId);
});
handleDb('db:getAllVisits', (_, limit) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    return databaseService.getAllVisits(limit);
});
handleDb('db:saveVisit', (_, visit) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    if (!['doctor', 'admin'].includes(user.role)) throw new Error('Forbidden');
    return databaseService.saveVisit(visit);
});
handleDb('db:beginConsultation', (_, input) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    if (!['doctor', 'admin'].includes(user.role)) throw new Error('Forbidden');
    return databaseService.beginConsultation(input, user.id);
});
handleDb('db:getActiveConsultation', (_, patientId) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    if (!['doctor', 'admin'].includes(user.role)) throw new Error('Forbidden');
    return databaseService.getActiveConsultation(patientId, user.id);
});
handleDb('db:saveConsultationProgress', (_, input) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    if (!['doctor', 'admin'].includes(user.role)) throw new Error('Forbidden');
    return databaseService.saveConsultationProgress(input, user.id);
});
handleDb('db:completeConsultation', (_, input) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    if (!['doctor', 'admin'].includes(user.role)) throw new Error('Forbidden');
    return databaseService.completeConsultation(input, user.id);
});
handleDb('db:postponeConsultation', (_, input) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    if (!['doctor', 'admin'].includes(user.role)) throw new Error('Forbidden');
    return databaseService.postponeConsultation(input, user.id);
});
handleDb('db:resumeConsultation', (_, input) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    if (!['doctor', 'admin'].includes(user.role)) throw new Error('Forbidden');
    return databaseService.resumeConsultation(input, user.id);
});
handleDb('db:beginNextConsultation', (_, input) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    if (!['doctor', 'admin'].includes(user.role)) throw new Error('Forbidden');
    return databaseService.beginNextConsultation(input, user.id);
});
handleDb('db:deleteVisit', (_, id) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    if (user.role !== 'admin') throw new Error('Forbidden');
    return databaseService.deleteVisit(id);
});
handleDb('db:getVitals', (_, patientId) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    return databaseService.getVitals(patientId);
});
handleDb('db:saveVitals', (_, vitals) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    return databaseService.saveVitals(vitals, user.id);
});
handleDb('db:getEncounterVitals', (_, encounterId) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    return databaseService.getEncounterVitals(encounterId);
});
handleDb('db:getVitalsHistory', (_, patientId, visitId) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    return databaseService.getVitalsHistory(patientId, visitId);
});

// Allergies
handleDb('db:getAllergies', (_, patientId) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    return databaseService.getAllergies(patientId);
});
handleDb('db:saveAllergy', (_, allergy) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    if (!['doctor', 'admin'].includes(user.role)) throw new Error('Forbidden');
    return databaseService.saveAllergy(allergy, user.id);
});
handleDb('db:deleteAllergy', (_, id) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    if (!['doctor', 'admin'].includes(user.role)) throw new Error('Forbidden');
    return databaseService.deleteAllergy(id, user.id);
});

// Conditions
handleDb('db:getConditions', (_, patientId) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    return databaseService.getConditions(patientId);
});
handleDb('db:saveCondition', (_, condition) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    if (!['doctor', 'admin'].includes(user.role)) throw new Error('Forbidden');
    return databaseService.saveCondition(condition, user.id);
});
handleDb('db:deleteCondition', (_, id) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    if (!['doctor', 'admin'].includes(user.role)) throw new Error('Forbidden');
    return databaseService.deleteCondition(id, user.id);
});

// Medications
handleDb('db:getMedications', (_, patientId) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    return databaseService.getMedications(patientId);
});
handleDb('db:saveMedication', (_, medication) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    if (!['doctor', 'admin'].includes(user.role)) throw new Error('Forbidden');
    return databaseService.saveMedication(medication, user.id);
});
handleDb('db:deleteMedication', (_, id) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    if (!['doctor', 'admin'].includes(user.role)) throw new Error('Forbidden');
    return databaseService.deleteMedication(id, user.id);
});

// Safety Context
handleDb('db:getPatientSafetyContext', (_, patientId) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    return databaseService.getPatientSafetyContext(patientId);
});

// Users
handleDb('db:getUsers', () => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    if (user.role !== 'admin') throw new Error('Forbidden');
    return databaseService.getUsers();
});
handleDb('db:saveUser', (_, userData) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    if (user.role !== 'admin') throw new Error('Forbidden');
    return databaseService.saveUser(userData, user.id);
});
handleDb('db:deleteUser', (_, id) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    if (user.role !== 'admin') throw new Error('Forbidden');
    return databaseService.deleteUser(id);
});
handleDb('db:getDoctors', () => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    return databaseService.getDoctors();
});
handleDb('db:getAllRoles', () => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    return databaseService.getAllRoles();
})

// Settings
handleDb('db:getSettings', () => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    // if (user.role !== 'admin') throw new Error('Forbidden'); // Allow reading settings?
    return databaseService.getSettings();
});
handleDb('db:getPublicSettings', () => {
    // Public endpoint - no auth required (used for Login screen)
    return databaseService.getPublicSettings();
});
handleDb('db:saveSettings', async (_, settings) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    if (user.role !== 'admin') throw new Error('Forbidden');

    const result = databaseService.saveSettings(settings);

    // Update Backup Schedule if changed
    if (settings.backup_schedule) {
        backupService.updateSchedule('local', settings.backup_schedule);
    }
    if (settings.cloud_backup_schedule) {
        backupService.updateSchedule('cloud', settings.cloud_backup_schedule);
    }

    // Update Drive Credebtials if changed
    if (settings.drive_client_id && settings.drive_client_secret) {
        googleDriveService.configureCredentials(settings.drive_client_id, settings.drive_client_secret);
    }

    return result;
});

// ABDM gateway IPC handlers. Reads are open to any authenticated user (same
// posture as settings reads); writes and connectivity checks are admin-only.
// The plaintext secret never leaves the main process: readers only learn
// whether one is stored.
handleDb('db:abdmGetConfig', () => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    return {
        gateway_env: abdmSessionService.gatewayEnv(),
        client_id: abdmSessionService.hasClientId()
            ? databaseService.getSettings()?.abdm_client_id || ''
            : '',
        has_secret: abdmSessionService.hasStoredSecret(),
        mock: abdmSessionService.isMockMode(),
        hip_id: databaseService.getSettings()?.abdm_hip_id || '',
        counter_id: databaseService.getSettings()?.abdm_counter_id || '',
        hfr_id: databaseService.getSettings()?.abdm_hfr_id || '',
        hpr_id: databaseService.getSettings()?.abdm_hpr_id || ''
    };
});
handleDb('db:abdmSaveConfig', (_, config) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    if (user.role !== 'admin') throw new Error('Forbidden');
    const patch: Record<string, unknown> = {};
    if (config && typeof config['gateway_env'] === 'string'
        && ['sandbox', 'staging'].includes(config['gateway_env'] as string)) {
        patch['abdm_gateway_env'] = config['gateway_env'];
    }
    if (config && typeof config['client_id'] === 'string') {
        patch['abdm_client_id'] = (config['client_id'] as string).trim();
    }
    if (config && typeof config['hip_id'] === 'string') {
        patch['abdm_hip_id'] = (config['hip_id'] as string).trim();
    }
    if (config && typeof config['counter_id'] === 'string') {
        patch['abdm_counter_id'] = (config['counter_id'] as string).trim();
    }
    for (const key of ['hfr_id', 'hpr_id'] as const) {
        if (config && typeof config[key] === 'string') {
            const value = (config[key] as string).trim();
            if (value.length > 100) throw new Error('Registry IDs must be under 100 characters.');
            patch[`abdm_${key}`] = value;
        }
    }
    if (config && config['mock'] !== undefined) {
        patch['abdm_mock'] = config['mock'] ? 1 : 0;
    }
    const result = databaseService.saveSettings(patch);
    abdmSessionService.invalidate();
    abdmAbhaService.invalidateCert();
    return result;
});
handleDb('db:abdmSetSecret', (_, payload) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    if (user.role !== 'admin') throw new Error('Forbidden');
    const secret = payload && typeof payload.secret === 'string' ? payload.secret : '';
    return abdmSessionService.saveClientSecret(secret);
});
handleDb('db:abdmTestConnectivity', async () => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    if (user.role !== 'admin') throw new Error('Forbidden');
    return abdmSessionService.testConnectivity();
});

// ABDM health-ID IPC handlers. Front-desk roles only (doctor, receptionist,
// admin): verifying and linking a health ID is part of intake, same posture
// as saving a patient.
function requireAbdmDeskRole(user: any) {
    if (!user) throw new Error('Unauthorized');
    if (!['doctor', 'receptionist', 'admin'].includes(user.role)) throw new Error('Forbidden');
    return user;
}
handleDb('db:abdmAbhaRequestOtp', (_, payload) => {
    const user = requireAbdmDeskRole(sessionService.getUser());
    return abdmAbhaService.requestEnrollmentOtp(payload || {});
});
handleDb('db:abdmAbhaConfirmOtp', (_, payload) => {
    const user = requireAbdmDeskRole(sessionService.getUser());
    const args = payload || {};
    return abdmAbhaService.confirmEnrollmentOtp(args.txnId, args.otp);
});
handleDb('db:abdmAbhaLookup', (_, payload) => {
    const user = requireAbdmDeskRole(sessionService.getUser());
    const args = payload || {};
    return abdmAbhaService.lookupAddress(args.abhaAddress);
});
handleDb('db:abdmAbhaCard', (_, payload) => {
    const user = requireAbdmDeskRole(sessionService.getUser());
    const args = payload || {};
    return abdmAbhaService.getCard(args.abhaAddress);
});
handleDb('db:abdmLinkAbha', (_, payload) => {
    const user = requireAbdmDeskRole(sessionService.getUser());
    const args = payload || {};
    return databaseService.linkAbhaAddress(args.patientId, {
        abhaAddress: args.abhaAddress ?? null,
        abhaName: args.abhaName ?? null
    }, user.id);
});
handleDb('db:abdmGetShareTokens', () => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    return databaseService.getPendingShareTokens();
});
handleDb('db:abdmAcceptShareToken', (_, payload) => {
    const user = requireAbdmDeskRole(sessionService.getUser());
    const args = payload || {};
    return databaseService.acceptShareToken(args.tokenId ?? args.id, user.id);
});
handleDb('db:abdmAcceptShareTokenAndCheckIn', (_, payload) => {
    const user = requireAbdmDeskRole(sessionService.getUser());
    const args = payload || {};
    return databaseService.acceptShareTokenAndCheckIn(args.tokenId ?? args.id, user.id);
});
handleDb('db:findPatientByAbha', (_, payload) => {
    const user = requireAbdmDeskRole(sessionService.getUser());
    const args = payload || {};
    return databaseService.findPatientByAbhaAddress(args.abhaAddress);
});
handleDb('db:abdmSimulateShare', () => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    if (user.role !== 'admin') throw new Error('Forbidden');
    if (!abdmSessionService.isMockMode()) {
        throw new Error('Demo scans are only available while the mock gateway is active.');
    }
    const demo = Math.floor(1000 + Math.random() * 9000);
    return databaseService.receiveAbhaShare({
        name: 'Demo Patient',
        age: 34,
        gender: 'Female',
        mobile: '9876500000',
        abhaAddress: `demo.patient${demo}@sbx`,
        abhaName: 'Demo Patient'
    }, user.id);
});

// Queue IPC Handlers
handleDb('db:getQueue', () => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    return databaseService.getQueue();
});
handleDb('db:addToQueue', (_, data) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    return invokeDbMethod(databaseService, 'addToQueue', [data], user.id);
});
handleDb('db:updateQueueStatus', (_, data) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    return invokeDbMethod(databaseService, 'updateQueueStatus', [data], user.id);
});
handleDb('db:updateQueueStatusByPatientId', (_, data) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    return invokeDbMethod(databaseService, 'updateQueueStatusByPatientId', [data], user.id);
});
handleDb('db:removeFromQueue', (_, id) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    return invokeDbMethod(databaseService, 'removeFromQueue', [id], user.id);
});
handleDb('db:reassessQueueTriage', (_, data) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    return invokeDbMethod(databaseService, 'reassessQueueTriage', [data], user.id);
});
handleDb('db:getQueueTriageHistory', (_, queueId) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    return databaseService.getQueueTriageHistory(queueId);
});

// Audit IPC Handlers
handleDb('db:getAuditLogs', (_, limit) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    return databaseService.getAuditLogs(limit);
});

// Cloud IPC Handlers
// Cloud IPC Handlers
ipcMain.handle('cloud:getStatus', () => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    return cloudSyncService.getStatus();
});
ipcMain.handle('cloud:onboard', (_, { name, city }) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    if (user.role !== 'admin') throw new Error('Forbidden');
    return cloudSyncService.onboard(name, city);
});
ipcMain.handle('cloud:toggle', (_, enabled) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    if (user.role !== 'admin') throw new Error('Forbidden');
    return cloudSyncService.setEnabled(enabled);
});
ipcMain.handle('cloud:publishSlots', (_, slots, dates) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    if (user.role !== 'admin') throw new Error('Forbidden');
    return cloudSyncService.publishSlots(slots, dates);
});
ipcMain.handle('cloud:syncNow', async () => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    await cloudSyncService.poll();
    return { success: true };
});
ipcMain.handle('cloud:getPublishedSlots', (_, date) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    return cloudSyncService.getPublishedSlots(date);
});

// Appointment Request IPC
// Appointment Request IPC
handleDb('db:getAppointmentRequests', () => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    return databaseService.getAppointmentRequests();
});
handleDb('db:updateAppointmentRequestStatus', (_, { id, status }) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    return databaseService.updateAppointmentRequestStatus(id, status);
});

// Appointments (Bookings) IPC
// Appointments (Bookings) IPC
handleDb('db:getAppointments', (_, date) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    return databaseService.getAppointments(date);
});
handleDb('db:saveAppointment', (_, appt) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    return databaseService.saveAppointment(appt);
});

function requireCatalogSession(roles: string[]) {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    if (!roles.includes(user.role)) throw new Error('Forbidden');
    return user;
}

handleDb('db:searchConditions', (_, query, limit) => {
    requireCatalogSession(['doctor', 'admin']);
    return databaseService.searchConditions(query, limit);
});
handleDb('db:searchMedicines', (_, query, limit) => {
    requireCatalogSession(['doctor', 'admin']);
    return databaseService.searchMedicines(query, limit);
});
handleDb('db:createCondition', (_, input) => {
    requireCatalogSession(['doctor', 'admin']);
    return databaseService.createCondition(input);
});
handleDb('db:createMedicine', (_, input) => {
    requireCatalogSession(['doctor', 'admin']);
    return databaseService.createMedicine(input);
});
handleDb('db:getConditionMedPresets', (_, conditionId) => {
    requireCatalogSession(['doctor', 'admin']);
    return databaseService.getConditionMedPresets(conditionId);
});
handleDb('db:listConditions', (_, includeRetired) => {
    requireCatalogSession(['admin']);
    return databaseService.listConditions(includeRetired);
});
handleDb('db:listMedicines', (_, includeRetired) => {
    requireCatalogSession(['admin']);
    return databaseService.listMedicines(includeRetired);
});
handleDb('db:updateCondition', (_, input) => {
    requireCatalogSession(['admin']);
    return databaseService.updateCondition(input);
});
handleDb('db:updateMedicine', (_, input) => {
    requireCatalogSession(['admin']);
    return databaseService.updateMedicine(input);
});
handleDb('db:retireCondition', (_, id) => {
    requireCatalogSession(['admin']);
    return databaseService.retireCondition(id);
});
handleDb('db:retireMedicine', (_, id) => {
    requireCatalogSession(['admin']);
    return databaseService.retireMedicine(id);
});
handleDb('db:replaceConditionMedPresets', (_, input) => {
    requireCatalogSession(['admin']);
    return databaseService.replaceConditionMedPresets(input);
});

// Drive IPC Handlers
handleDb('drive:authenticate', async (_, { clientId, clientSecret }) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    if (!mainWindow) return { success: false, error: 'Main window not found' };
    try {
        // Configure credentials first
        googleDriveService.configureCredentials(clientId, clientSecret);

        await googleDriveService.authenticate(mainWindow, (state) => apiServer.waitForOAuthCallback(state));
        const tokens = googleDriveService.getCredentials();

        // Save everything to settings
        databaseService.saveSettings({
            drive_client_id: clientId,
            drive_client_secret: clientSecret,
            drive_tokens: JSON.stringify(tokens)
        });

        return { success: true };
    } catch (e: any) {
        if (e?.message === 'RESTORE_IN_PROGRESS') throw e;
        console.error('Drive auth failed', e);
        return { success: false, error: e.message || 'Authentication failed' };
    }
});

handleDb('drive:disconnect', async () => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    try {
        googleDriveService.setCredentials(null);
        databaseService.saveSettings({ drive_tokens: '' });
        return { success: true };
    } catch (e: any) {
        if (e?.message === 'RESTORE_IN_PROGRESS') throw e;
        console.error('Drive disconnect failed', e);
        return { success: false, error: e.message };
    }
});

ipcMain.handle('drive:isAuthenticated', () => {
    return googleDriveService.isAuthenticated();
});

ipcMain.handle('drive:backup', async () => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    try {
        const dbPath = securityService.getDbPath();
        if (!dbPath) throw new Error('DB not open');
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const fileName = `nalamdesk-backup-${timestamp}.db`;
        await googleDriveService.uploadFile(dbPath, fileName);
        return { success: true };
    } catch (e: any) {
        console.error('Backup failed', e);
        return { success: false, error: e.message };
    }
});

ipcMain.handle('drive:restore', async (_, fileId) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    try {
        return await runDriveRestore({
            gate: restoreOperationGate,
            dbService: databaseService,
            getDbPath: () => securityService.getDbPath(),
            closeDb: () => securityService.closeDb(),
            downloadFile: (id, destination) => googleDriveService.downloadFile(id, destination),
            fileId,
            onCommitted: () => { setTimeout(() => { app.relaunch(); app.exit(0); }, 1500); }
        });
    } catch (e: any) {
        if (e?.message === 'RESTORE_IN_PROGRESS') throw e;
        console.error('Restore failed', e.message); // e might be object
        return { success: false, error: String(e) };
    }
});

ipcMain.handle('drive:listBackups', async () => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    try {
        return await googleDriveService.listBackups();
    } catch (e) {
        return [];
    }
});

// Backup IPC
// Backup IPC
ipcMain.handle('backup:selectPath', async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory', 'createDirectory'],
        title: 'Select Backup Location',
        buttonLabel: 'Select Folder'
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
});

ipcMain.handle('backup:selectRestoreBundle', async () => {
    if (!mainWindow) return null;
    const selected = await selectRestoreBundle(() => dialog.showOpenDialog(mainWindow!, {
        properties: ['openFile'],
        title: 'Select NalamDesk Backup',
        buttonLabel: 'Select Backup',
        filters: [
            { name: 'NalamDesk recoverable backup', extensions: ['ndbackup'] },
            { name: 'Legacy database backup', extensions: ['db'] }
        ]
    }));
    if (selected) authorizedRestorePaths.add(path.resolve(selected.path));
    return selected;
});

ipcMain.handle('backup:useDefaultPath', async () => {
    const defaultPath = path.join(app.getPath('userData'), 'backups');
    // Ensure it exists?
    // backupService sets this in constructor, so we just return the path string
    // logic in frontend will save it to settings.
    return defaultPath;
});

ipcMain.handle('backup:runNow', async () => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    // Manual trigger for testing
    console.log('[Main] Manual backup triggered via IPC');
    await backupService.performBackup();
    return { success: true };
});

ipcMain.handle('backup:listSystemBackups', async () => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    return backupService.listSystemBackups();
});

ipcMain.handle('auth:getRecoveryStatus', async () => {
    const userDataPath = app.getPath('userData');
    const { isSetup, hasRecovery } = securityService.isSetup(userDataPath);

    // If not setup, check for backups
    let hasBackups = false;
    let backups: any[] = [];

    if (!isSetup) {
        backups = await backupService.listSystemBackups();
        for (const backup of backups) authorizedRestorePaths.add(path.resolve(backup.path));
        hasBackups = backups.length > 0;
    }

    return {
        isSetup,
        hasRecovery,
        hasBackups,
        backups
    };
});

ipcMain.handle('auth:restoreSystemBackup', async (_, request: {
    path: string; recoveryCode: string; currentAdminPassword?: string
}) => {
    try {
        if (!request || typeof request.path !== 'string' ||
            !authorizedRestorePaths.has(path.resolve(request.path))) throw new Error('BACKUP_PATH_NOT_AUTHORIZED');
        return await restoreOperationGate.run(async () => {
            const liveDbPath = getDatabasePath(userDataPath,
                process.env['NODE_ENV'] === 'test' ? 'nalamdesk-test.db' : 'nalamdesk.db');
            const hasDatabase = fs.existsSync(liveDbPath);
            const hasConfig = fs.existsSync(path.join(userDataPath, 'security.json'));
            await requireExistingRestoreAuthorization({
                hasDatabase,
                hasConfig,
                databaseOpen: !!securityService.getDb(),
                sessionUser: sessionService.getUser(),
                persistedAdmin: securityService.getDb()
                    ? await databaseService.getUserByUsername('admin')
                    : null,
                currentAdminPassword: request.currentAdminPassword
            });
            const result = await backupService.restoreLocalBackup(request.path, request.recoveryCode);
            // Keep the single-flight guard and authorized path until relaunch so
            // no second request can mutate the restored vault in this process.
            setTimeout(() => { app.relaunch(); app.exit(0); }, 500);
            return result;
        });
    } catch (e: any) {
        console.error('[Main] System Restore Failed:', e);
        return { success: false, error: e.message };
    }
});
