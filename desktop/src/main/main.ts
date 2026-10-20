import { app, BrowserWindow, ipcMain, clipboard, shell, dialog } from 'electron';
import * as path from 'path';
import { CronJob } from 'cron';
import { autoUpdater } from 'electron-updater';
import log from 'electron-log';
import { bindUpdateIpc, createUpdateService, type UpdaterPort } from './updates/updateService';

import { preferLinuxGnomeLibsecret } from './linuxKeyring';
import { buildIdentityPath, loadAppVersionInfo, readBuildIdentityFile, readPackageVersion } from './appVersionInfo';
import { SessionService } from './services/SessionService';
import { BackupService } from './services/BackupService';
import { selectRestoreBundle } from './services/BackupFileSelection';
import { RestoreOperationGate } from './services/RestoreOperationGate';
import { runDriveRestore } from './services/DriveRestore';
import { requireExistingRestoreAuthorization } from './services/RestoreAuthorization';
import { CrashService } from './services/CrashService';
import { SecurityService } from './services/SecurityService';
import { ElectronSafeStorageDeviceKeyStore, isDeviceCryptoFailure } from './services/DeviceKeyStore';
import { AbdmSessionService, isAbdmGatewayEnv } from './services/AbdmSessionService';
import { AbdmAbhaService } from './services/AbdmAbhaService';
import { HiuService } from './services/HiuService';
import { FideliusService, parseKeyMaterial } from './services/FideliusService';
import { DatabaseService } from './services/DatabaseService';
import { GoogleDriveService } from './services/GoogleDriveService';
import { CloudLink } from './cloud/CloudLink';
import { BookingError } from './booking/BookingInboxService';
import { getCloudServiceUrl } from '../shared/runtime-config';
import { buildAuthenticatedLoginResult } from './services/AuthResult';
import { ProvisioningService } from './services/ProvisioningService';
import { CredentialRotationService } from './services/CredentialRotationService';
import { verifyPersistedActiveAdmin } from './services/AdminCredentialVerifier';
import { acknowledgeRecoveryCodeForActiveAdmin } from './services/RecoveryCodeAcknowledgement';
import { ApiServer } from '../server/app';
import { invokeDbMethod } from '../shared/ipc-db-args';
import { parseClinicalBundle } from '../shared/fhir/parser';
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
    // E2E regression isolation: an explicit env dir wins over the shared
    // dev dir, so each Playwright worker gets a transient nalamdesk-test.db.
    // Never honored in packaged builds (branch is dev-only by construction).
    const e2eUserDataDir = process.env['NALAMDESK_E2E_USER_DATA'];
    app.setPath('userData', e2eUserDataDir || getDevUserDataPath(app.getPath('appData')));
    // Unpacked Linux runs have no bundled version metadata, so
    // app.getVersion() resolves to "0.0" and electron-updater throws at first
    // access — killing main before any window opens (macOS reads the bundle
    // instead, which is why this only bites Linux dev/CI). Pin the package
    // version early; user-facing display stays with loadAppVersionInfo().
    if (process.platform === 'linux') {
        const devVersion = readPackageVersion(path.join(__dirname, '..', '..'));
        // setVersion exists at runtime (Electron 40) but is missing from the
        // shipped .d.ts, hence the cast rather than a @ts-ignore.
        if (devVersion) (app as unknown as { setVersion(version: string): void }).setVersion(devVersion);
    }
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
    gatewayBaseUrl: () => abdmSessionService.gatewayBaseUrl(),
    abhaBaseUrl: () => abdmSessionService.abhaBaseUrl()
});
const hiuService = new HiuService({
    getSettings: () => databaseService.getSettings(),
    getHiuPrivateProtected: () => databaseService.getHiuPrivateProtected(),
    saveHiuPrivateProtected: (value) => databaseService.saveHiuPrivateProtected(value),
    saveSettingsPatch: (patch) => databaseService.saveSettings(patch),
    saveHiuKeypair: (publicKey, protectedPrivate) => databaseService.saveHiuKeypair(publicKey, protectedPrivate),
    keyStore: new ElectronSafeStorageDeviceKeyStore(),
    store: {
        createConsentRequest: (input, actingUserId) => databaseService.createConsentRequest(input, actingUserId),
        getConsentById: (id) => databaseService.getConsentById(id),
        getConsentByRequestId: (requestId) => databaseService.getConsentByRequestId(requestId),
        updateConsentStatus: (id, status, handle, actingUserId) =>
            databaseService.updateConsentStatus(id, status, handle, actingUserId),
        storeFetchedRecord: (input, actingUserId) => databaseService.storeFetchedRecord(input, actingUserId),
        getPendingInbox: () => databaseService.getPendingInbox()
    },
    session: {
        getSessionToken: () => abdmSessionService.getSessionToken(),
        gatewayBaseUrl: () => abdmSessionService.gatewayBaseUrl()
    }
});
const fideliusService = new FideliusService();
const credentialRotationService = new CredentialRotationService();
const provisioningService = new ProvisioningService(securityService, databaseService);
const googleDriveService = new GoogleDriveService();
// NalamDesk Cloud (#154, #155): pairing, signed requests, the mailbox and its doorbell.
const stampedIdentity = readBuildIdentityFile(buildIdentityPath(app.getAppPath()));
const notifyRenderer = (channel: string, payload: unknown) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
};
const cloudLink: CloudLink = new CloudLink({
    store: databaseService,
    keyStore: new ElectronSafeStorageDeviceKeyStore(),
    appVersion: app.getVersion(),
    baseUrl: (audience) => getCloudServiceUrl(audience, stampedIdentity),
    onNewRequests: (count) => notifyRenderer('cloud:newRequests', { count }),
    onPairingChange: (status) => notifyRenderer('cloud:pairingChanged', status),
    onMailboxChange: () => notifyRenderer('cloud:pairingChanged', cloudStatus()),
    // A restore drains cloud work before replacing the database, and refuses it after.
    runWork: (work) => databaseService.runWork(work)
});

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
    onRestoreCommitted: () => {
        cloudLink.stop();
        sessionService.clearSession();
    }
});
const authorizedRestorePaths = new Set<string>();
const restoreOperationGate = new RestoreOperationGate();

// ... (cloud sync init logic)
// DB init happens via IPC. ApiServer will report 503 if DB not ready (guarded in handler).
// ... (cloud sync init logic)
console.log('[Main] Starting ApiServer...');
try {
    void apiServer.start(apiPort); // Fire and forget (it logs its own success)
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
    void app.whenReady().then(() => {
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

        void createWindow();

        app.on('activate', () => {
            if (BrowserWindow.getAllWindows().length === 0) void createWindow();
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
        // HIU cache retention: sweep expired outside records at startup and
        // once daily (03:00 local). Reads sweep first too, so the 30-day
        // rule holds even if the scheduler never fires.
        try {
            databaseService.expireFetchedRecords();
            databaseService.sweepExpiredMedications();
        } catch (e) {
            console.error('[HIU] Startup retention sweep failed:', e);
        }
        try {
            const retentionJob = new CronJob('0 3 * * *', () => {
                try {
                    databaseService.expireFetchedRecords();
                    databaseService.sweepExpiredMedications();
                } catch (e) {
                    console.error('[HIU] Scheduled retention sweep failed:', e);
                }
            });
            retentionJob.start();
        } catch (e) {
            console.error('[HIU] Could not schedule retention sweep:', e);
        }
        cloudLink.start();
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

import { AccessPolicy } from './services/AccessPolicy';

function handleDb(channel: string, handler: (...args: any[]) => any) {
    ipcMain.handle(channel, async (...args) => databaseService.runWork(() => handler(...args)));
}

/**
 * Fine-grained gate for db:* channels (M3-RBAC follow-up, issue #10).
 * Every data channel resolves through the Cedar policy set compiled from
 * the roles baseline plus per-user overrides; default deny. Only two
 * carve-outs: the public login-screen read, and getSettings, which splits
 * admin-full vs sanitized-desk inside its own handler below.
 */
const DB_PUBLIC_METHODS = new Set(['getPublicSettings']);
// Handlers that split admin-full vs desk-safe responses internally.
const DB_SPLIT_METHODS = new Set(['getSettings']);

let accessPolicy: AccessPolicy | null = null;

function getAccessPolicy(): AccessPolicy {
    if (!accessPolicy) {
        accessPolicy = new AccessPolicy({
            getRoles: () => databaseService.getAllRoles(),
            getAllOverrides: () => databaseService.getAllOverrides()
        });
    }
    return accessPolicy;
}

/** Rebuild after role/override mutations (called by those handlers). */
function refreshAccessPolicy(): void {
    try {
        getAccessPolicy().rebuild();
    } catch (e) {
        console.error('[Access] Policy rebuild failed:', e);
    }
}

function requirePermission(user: any, method: string, context?: Record<string, unknown>) {
    if (!user) throw new Error('Unauthorized');
    // Preserved admin bypass (matches the server path): admins hold every
    // method by role, and per-user forbids are desk-role tooling.
    if (user.role === 'admin') return user;
    const decision = getAccessPolicy().isAuthorized({
        user: { id: user.id, role: user.role },
        action: method,
        context
    });
    if (!decision.allow) {
        console.warn(`[Access] Denied ${user.role}#${user.id} -> ${method} (${decision.reasons.join(',')})`);
        throw new Error('Forbidden');
    }
    return user;
}

function handleGuardedDb(channel: string, handler: (...args: any[]) => any) {
    const method = channel.startsWith('db:') ? channel.slice(3) : channel;
    ipcMain.handle(channel, async (...args) => databaseService.runWork(async () => {
        try {
            if (!DB_PUBLIC_METHODS.has(method) && !DB_SPLIT_METHODS.has(method)) {
                requirePermission(sessionService.getUser(), method);
            }
            // Awaited: async handlers reject inside this try, so their
            // Forbidden/Unauthorized denials are audited, not just sync ones.
            return await handler(...args);
        } catch (e: any) {
            // Authorization denials are security events: actor, role, method.
            // Never the payload (it may carry PII or secrets).
            if (e?.message === 'Forbidden' || e?.message === 'Unauthorized') {
                const denied = sessionService.getUser();
                try {
                    databaseService.auditDenial({ user: denied, method, channel: 'ipc' });
                } catch { /* audit must not mask the denial */ }
            }
            throw e;
        }
    }));
}

ipcMain.handle('auth:logout', () => {
    try {
        const user = sessionService.getUser();
        if (user) databaseService.auditLogout({ user });
    } catch { /* audit is best-effort on the logout path */ }
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

        // Authentication audit: who attempted, what role, what outcome.
        // Usernames only — passwords and hashes never enter the audit trail.
        const auditLogin = (ok: boolean, name: string, user: any) => {
            try {
                databaseService.auditLoginAttempt({ username: name, ok, user });
            } catch { /* audit is best-effort on the login path */ }
        };

        // 3. Admin fast path
        if (username === 'admin') {
            const adminResult = await handleAdminLogin(password);
            if (adminResult) {
                const user = sessionService.getUser();
                auditLogin(true, username, user);
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
            auditLogin(true, username, result.user);
            return buildAuthenticatedLoginResult(sessionService.getUser()!, securityService);
        }

        auditLogin(false, username, null);
        return { success: false, error: 'INVALID_CREDENTIALS' };

    } catch (error: any) {
        if (error?.message === 'RESTORE_IN_PROGRESS') throw error;
        console.error('Login failed:', error);
        return { success: false, error: 'UNKNOWN_ERROR' };
    }
});

// Dashboard / Stats
handleGuardedDb('db:getDashboardStats', () => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    return databaseService.getDashboardStats();
});

// Patients
handleGuardedDb('db:getPatients', (_, query, includeArchived) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    return databaseService.getPatients(query, includeArchived === true);
});
handleGuardedDb('db:findDuplicateCandidates', (_, input) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    return databaseService.findDuplicateCandidates(input || {});
});
handleGuardedDb('db:previewPatientMerge', (_, input) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    if (!['doctor', 'admin'].includes(user.role)) throw new Error('Forbidden');
    const args = input || {};
    return databaseService.previewPatientMerge(args);
});
handleGuardedDb('db:mergePatients', (_, input) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    if (!['doctor', 'admin'].includes(user.role)) throw new Error('Forbidden');
    return databaseService.mergePatients(input || {}, user.id);
});
handleGuardedDb('db:unmergePatients', (_, input) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    if (!['doctor', 'admin'].includes(user.role)) throw new Error('Forbidden');
    const args = typeof input === 'number' ? { duplicateId: input } : input || {};
    return databaseService.unmergePatients(args.duplicateId, user.id);
});
// Billing ledger (Option B: desk + clinical mutation; M4 claims build on it).
handleGuardedDb('db:getInvoice', (_, id) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    if (!['doctor', 'receptionist', 'admin'].includes(user.role)) throw new Error('Forbidden');
    const invoiceId = Number(id);
    if (!Number.isInteger(invoiceId) || invoiceId <= 0) throw new Error('Valid invoice id is required.');
    return databaseService.getInvoice(invoiceId);
});
handleGuardedDb('db:getVisitInvoices', (_, visitId) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    if (!['doctor', 'receptionist', 'admin'].includes(user.role)) throw new Error('Forbidden');
    const vid = Number(visitId);
    if (!Number.isInteger(vid) || vid <= 0) throw new Error('Valid visit id is required.');
    return databaseService.getVisitInvoices(vid);
});
handleGuardedDb('db:createInvoice', (_, input) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    if (!['doctor', 'receptionist', 'admin'].includes(user.role)) throw new Error('Forbidden');
    return databaseService.createInvoice(input || {}, user.id);
});
handleGuardedDb('db:recordPayment', (_, input) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    if (!['doctor', 'receptionist', 'admin'].includes(user.role)) throw new Error('Forbidden');
    return databaseService.recordPayment(input || {}, user.id);
});
handleGuardedDb('db:refundPayment', (_, input) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    if (!['doctor', 'receptionist', 'admin'].includes(user.role)) throw new Error('Forbidden');
    return databaseService.refundPayment(input || {}, user.id);
});
handleGuardedDb('db:voidInvoice', (_, input) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    if (!['doctor', 'receptionist', 'admin'].includes(user.role)) throw new Error('Forbidden');
    const args = input || {};
    return databaseService.voidInvoice(args.invoiceId ?? args.id, args.reason, user.id);
});
handleGuardedDb('db:getDailyClose', (_, date) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    if (!['doctor', 'receptionist', 'admin'].includes(user.role)) throw new Error('Forbidden');
    const day = typeof date === 'string' ? date : (date as any)?.date;
    if (day) return databaseService.getDailyClose(day);
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    return databaseService.getDailyClose(today);
});
handleGuardedDb('db:getPatientById', (_, id) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    return databaseService.getPatientById(id);
});
handleGuardedDb('db:savePatient', (_, patient) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    // Basic RBAC check (doctors/receptionists) - simplified for now
    if (!['doctor', 'receptionist', 'admin'].includes(user.role)) throw new Error('Forbidden');
    return databaseService.savePatient(patient);
});
handleGuardedDb('db:deletePatient', (_, id) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    if (user.role !== 'admin') throw new Error('Forbidden');
    return databaseService.deletePatient(id);
});

// Visits
handleGuardedDb('db:getVisits', (_, patientId) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    return databaseService.getVisits(patientId);
});
handleGuardedDb('db:getAllVisits', (_, limit) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    return databaseService.getAllVisits(limit);
});
handleGuardedDb('db:saveVisit', (_, visit) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    if (!['doctor', 'admin'].includes(user.role)) throw new Error('Forbidden');
    return databaseService.saveVisit(visit);
});
handleGuardedDb('db:beginConsultation', (_, input) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    if (!['doctor', 'admin'].includes(user.role)) throw new Error('Forbidden');
    return databaseService.beginConsultation(input, user.id);
});
handleGuardedDb('db:getActiveConsultation', (_, patientId) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    if (!['doctor', 'admin'].includes(user.role)) throw new Error('Forbidden');
    return databaseService.getActiveConsultation(patientId, user.id);
});
handleGuardedDb('db:saveConsultationProgress', (_, input) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    if (!['doctor', 'admin'].includes(user.role)) throw new Error('Forbidden');
    return databaseService.saveConsultationProgress(input, user.id);
});
handleGuardedDb('db:completeConsultation', (_, input) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    if (!['doctor', 'admin'].includes(user.role)) throw new Error('Forbidden');
    return databaseService.completeConsultation(input, user.id);
});
handleGuardedDb('db:postponeConsultation', (_, input) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    if (!['doctor', 'admin'].includes(user.role)) throw new Error('Forbidden');
    return databaseService.postponeConsultation(input, user.id);
});
handleGuardedDb('db:resumeConsultation', (_, input) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    if (!['doctor', 'admin'].includes(user.role)) throw new Error('Forbidden');
    return databaseService.resumeConsultation(input, user.id);
});
handleGuardedDb('db:beginNextConsultation', (_, input) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    if (!['doctor', 'admin'].includes(user.role)) throw new Error('Forbidden');
    return databaseService.beginNextConsultation(input, user.id);
});
handleGuardedDb('db:deleteVisit', (_, id) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    if (user.role !== 'admin') throw new Error('Forbidden');
    return databaseService.deleteVisit(id);
});
// Record lifecycle (issue #14): archive instead of erase, entered-in-error
// instead of clinical deletes, purge only with dependency checks.
handleGuardedDb('db:archivePatient', (_, input) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    if (!['doctor', 'receptionist', 'admin'].includes(user.role)) throw new Error('Forbidden');
    const args = input || {};
    // Accept both { id } and { patientId } shapes from current callers.
    const id = args.id ?? args.patientId ?? input;
    return databaseService.archivePatient(id, args.reason, user.id);
});
handleGuardedDb('db:unarchivePatient', (_, id) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    if (!['doctor', 'receptionist', 'admin'].includes(user.role)) throw new Error('Forbidden');
    return databaseService.unarchivePatient(Number(id), user.id);
});
handleGuardedDb('db:getArchivedPatients', () => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    if (!['doctor', 'receptionist', 'admin'].includes(user.role)) throw new Error('Forbidden');
    return databaseService.getArchivedPatients();
});
// Flexible identifiers (issue #55): desk roles read and curate them at
// intake; nurses hold no identifier grants, like queue removal.
handleGuardedDb('db:getIdentifiers', (_, patientId) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    if (!['doctor', 'receptionist', 'admin'].includes(user.role)) throw new Error('Forbidden');
    return invokeDbMethod(databaseService, 'getIdentifiers', [patientId], user.id);
});
handleGuardedDb('db:saveIdentifier', (_, input) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    if (!['doctor', 'receptionist', 'admin'].includes(user.role)) throw new Error('Forbidden');
    return invokeDbMethod(databaseService, 'saveIdentifier', [input], user.id);
});
handleGuardedDb('db:deleteIdentifier', (_, id) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    if (!['doctor', 'receptionist', 'admin'].includes(user.role)) throw new Error('Forbidden');
    return invokeDbMethod(databaseService, 'deleteIdentifier', [id], user.id);
});
handleGuardedDb('db:markVisitEnteredInError', (_, input) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    if (!['doctor', 'admin'].includes(user.role)) throw new Error('Forbidden');
    const args = input || {};
    const id = args.id ?? args.visitId ?? input;
    return databaseService.markVisitEnteredInError(id, args.reason, user.id);
});
handleGuardedDb('db:purgeUser', (_, id) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    if (user.role !== 'admin') throw new Error('Forbidden');
    return databaseService.purgeUser(Number(id), user.id);
});
handleGuardedDb('db:getVitals', (_, patientId) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    return databaseService.getVitals(patientId);
});
handleGuardedDb('db:saveVitals', (_, vitals) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    return databaseService.saveVitals(vitals, user.id);
});
handleGuardedDb('db:getEncounterVitals', (_, encounterId) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    return databaseService.getEncounterVitals(encounterId);
});
handleGuardedDb('db:getVitalsHistory', (_, patientId, visitId) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    return databaseService.getVitalsHistory(patientId, visitId);
});

// Allergies
handleGuardedDb('db:getAllergies', (_, patientId) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    return databaseService.getAllergies(patientId);
});
handleGuardedDb('db:saveAllergy', (_, allergy) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    if (!['doctor', 'admin'].includes(user.role)) throw new Error('Forbidden');
    return databaseService.saveAllergy(allergy, user.id);
});
handleGuardedDb('db:deleteAllergy', (_, input) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    if (!['doctor', 'admin'].includes(user.role)) throw new Error('Forbidden');
    const args = (input != null && typeof input === 'object') ? input : { id: input };
    return databaseService.deleteAllergy(args.id, user.id, args.reason || '');
});

// Conditions
handleGuardedDb('db:getConditions', (_, patientId) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    return databaseService.getConditions(patientId);
});
handleGuardedDb('db:saveCondition', (_, condition) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    if (!['doctor', 'admin'].includes(user.role)) throw new Error('Forbidden');
    return databaseService.saveCondition(condition, user.id);
});
handleGuardedDb('db:deleteCondition', (_, input) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    if (!['doctor', 'admin'].includes(user.role)) throw new Error('Forbidden');
    const args = (input != null && typeof input === 'object') ? input : { id: input };
    return databaseService.deleteCondition(args.id, user.id, args.reason || '');
});

// Medications
handleGuardedDb('db:getMedications', (_, patientId) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    return databaseService.getMedications(patientId);
});
handleGuardedDb('db:saveMedication', (_, medication) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    if (!['doctor', 'admin'].includes(user.role)) throw new Error('Forbidden');
    return databaseService.saveMedication(medication, user.id);
});
handleGuardedDb('db:deleteMedication', (_, input) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    if (!['doctor', 'admin'].includes(user.role)) throw new Error('Forbidden');
    const args = (input != null && typeof input === 'object') ? input : { id: input };
    return databaseService.deleteMedication(args.id, user.id, args.reason || '');
});

// Safety Context
handleGuardedDb('db:getPatientSafetyContext', (_, patientId) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    return databaseService.getPatientSafetyContext(patientId);
});

// Users
handleGuardedDb('db:getUsers', () => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    if (user.role !== 'admin') throw new Error('Forbidden');
    return databaseService.getUsers();
});
handleGuardedDb('db:saveUser', (_, userData) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    if (user.role !== 'admin') throw new Error('Forbidden');
    return databaseService.saveUser(userData, user.id);
});
handleGuardedDb('db:deleteUser', (_, id) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    if (user.role !== 'admin') throw new Error('Forbidden');
    return databaseService.deleteUser(id, user.id);
});
handleGuardedDb('db:saveRole', (_, input) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    if (user.role !== 'admin') throw new Error('Forbidden');
    const args = input || {};
    const result = databaseService.saveRole(args.name, Array.isArray(args.permissions) ? args.permissions : [], user.id);
    refreshAccessPolicy();
    return result;
});
handleGuardedDb('db:deleteRole', (_, input) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    if (user.role !== 'admin') throw new Error('Forbidden');
    const args = typeof input === 'string' ? { name: input } : input || {};
    const result = databaseService.deleteRole(args.name, user.id);
    refreshAccessPolicy();
    return result;
});
// Demo seed data (first-run onboarding): admin-only. No policy refresh:
// grants are untouched, only clinic rows change.
handleGuardedDb('db:getDemoSeedState', () => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    if (user.role !== 'admin') throw new Error('Forbidden');
    return databaseService.getDemoSeedState();
});
handleGuardedDb('db:seedDemoData', () => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    if (user.role !== 'admin') throw new Error('Forbidden');
    return databaseService.seedDemoData(user.id);
});
handleGuardedDb('db:clearDemoData', () => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    if (user.role !== 'admin') throw new Error('Forbidden');
    return databaseService.clearDemoData(user.id);
});
// Per-user permission overrides: admin-only. Every mutation rebuilds the
// compiled policy set so the next check sees it.
handleGuardedDb('db:getUserOverrides', (_, userId) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    if (user.role !== 'admin') throw new Error('Forbidden');
    return databaseService.getUserOverrides(Number(userId));
});
handleGuardedDb('db:saveUserOverride', (_, input) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    if (user.role !== 'admin') throw new Error('Forbidden');
    const row = databaseService.setUserOverride(input || {}, user.id);
    refreshAccessPolicy();
    return row;
});
handleGuardedDb('db:deleteUserOverride', (_, input) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    if (user.role !== 'admin') throw new Error('Forbidden');
    const args = input || {};
    const result = databaseService.deleteUserOverride(Number(args.userId), args.action, user.id);
    refreshAccessPolicy();
    return result;
});
handleGuardedDb('db:getDoctors', () => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    return databaseService.getDoctors();
});
handleGuardedDb('db:getAllRoles', () => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    return databaseService.getAllRoles();
})

// Settings
handleDb('db:getSettings', () => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    if (user.role === 'admin') return databaseService.getSettings();
    return databaseService.getSanitizedSettings();
});
handleDb('db:getPublicSettings', () => {
    // Public endpoint - no auth required (used for Login screen)
    return databaseService.getPublicSettings();
});
handleGuardedDb('db:saveSettings', async (_, settings) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    if (user.role !== 'admin') throw new Error('Forbidden');

    // Validate schedule times BEFORE persisting: an invalid value must
    // neither be saved nor silently kill the running cron job. Range-checked
    // (HH 00-23, MM 00-59): shape-only checks admit '99:99', which cron
    // rejects and next-run math rolls over.
    if (settings.backup_schedule && !BackupService.isValidScheduleTime(settings.backup_schedule)) {
        throw new Error('Invalid backup schedule time.');
    }
    if (settings.cloud_backup_schedule && !BackupService.isValidScheduleTime(settings.cloud_backup_schedule)) {
        throw new Error('Invalid cloud backup schedule time.');
    }

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
handleGuardedDb('db:abdmGetConfig', () => {
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
        hpr_id: databaseService.getSettings()?.abdm_hpr_id || '',
        hip_endpoint: databaseService.getSettings()?.abdm_hip_endpoint || '',
        has_recipient_key: !!databaseService.getSettings()?.abdm_recipient_key,
        has_callback_secret: databaseService.hasCallbackSecret()
    };
});
handleGuardedDb('db:abdmSaveConfig', (_, config) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    if (user.role !== 'admin') throw new Error('Forbidden');
    const patch: Record<string, unknown> = {};
    if (config && typeof config['gateway_env'] === 'string'
        && isAbdmGatewayEnv(config['gateway_env'])) {
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
    if (config && typeof config['hip_endpoint'] === 'string') {
        const endpoint = (config['hip_endpoint'] as string).trim();
        if (endpoint && !/^https:\/\//.test(endpoint)) {
            throw new Error('Transfer endpoint must be an https URL.');
        }
        patch['abdm_hip_endpoint'] = endpoint;
    }
    if (config && typeof config['recipient_key'] === 'string') {
        const key = (config['recipient_key'] as string).trim();
        if (!key) {
            // Empty field means "leave the stored key alone", never wipe it.
        } else {
            patch['abdm_recipient_key'] = JSON.stringify(parseKeyMaterial(key));
        }
    }
    if (config && typeof config['callback_secret'] === 'string') {
        const secret = (config['callback_secret'] as string).trim();
        // Empty field leaves the stored secret alone; only a new value
        // replaces it. Minimum length keeps weak shared secrets out.
        if (secret) {
            if (secret.length < 16) {
                throw new Error('Callback password must be at least 16 characters.');
            }
            patch['abdm_callback_secret'] = secret;
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
handleGuardedDb('db:abdmSetSecret', (_, payload) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    if (user.role !== 'admin') throw new Error('Forbidden');
    const secret = payload && typeof payload.secret === 'string' ? payload.secret : '';
    return abdmSessionService.saveClientSecret(secret);
});
handleGuardedDb('db:abdmTestConnectivity', async () => {
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
handleGuardedDb('db:abdmAbhaRequestOtp', (_, payload) => {
    const user = requireAbdmDeskRole(sessionService.getUser());
    return abdmAbhaService.requestEnrollmentOtp(payload || {});
});
handleGuardedDb('db:abdmAbhaRequestLoginOtp', (_, payload) => {
    const user = requireAbdmDeskRole(sessionService.getUser());
    const args = payload || {};
    return abdmAbhaService.requestLoginOtp(args.abhaAddress);
});handleGuardedDb('db:abdmAbhaConfirmLoginOtp', (_, payload) => {
    const user = requireAbdmDeskRole(sessionService.getUser());
    const args = payload || {};
    return abdmAbhaService.verifyLoginOtp(args.txnId, args.otp);
});
handleGuardedDb('db:abdmHiuGetPublicKey', () => {
    requireAbdmDeskRole(sessionService.getUser());
    return hiuService.ensureKeypair();
});
function requireHiuClinician(user: any) {
    if (!user) throw new Error('Unauthorized');
    if (!['doctor', 'admin'].includes(user.role)) throw new Error('Forbidden');
    return user;
}
handleGuardedDb('db:abdmHiuRequestConsent', (_, payload) => {
    const user = requireHiuClinician(sessionService.getUser());
    const args = payload || {};
    return hiuService.requestConsent({
        patientId: args.patientId ?? null,
        abhaAddress: args.abhaAddress,
        hiTypes: args.hiTypes,
        dateFrom: args.dateFrom ?? null,
        dateTo: args.dateTo ?? null
    }, user.id);
});
handleGuardedDb('db:abdmHiuGetConsents', (_, payload) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    const args = payload || {};
    return databaseService.getConsents(args.patientId ?? null);
});
handleGuardedDb('db:abdmHiuFetchRecords', (_, payload) => {
    const user = requireHiuClinician(sessionService.getUser());
    const args = payload || {};
    return hiuService.fetchForConsent(Number(args.consentId), user.id);
});
handleGuardedDb('db:abdmHiuGetExternalRecords', (_, payload) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    const args = payload || {};
    databaseService.expireFetchedRecords();
    const rows = databaseService.getFetchedRecords(Number(args.patientId)) as any[];
    return rows.map((row) => {
        try {
            return {
                id: row.id,
                consentId: row.consent_id,
                fetchedAt: row.fetched_at,
                expiresAt: row.expires_at,
                status: row.status,
                parsed: parseClinicalBundle(row.bundle_json)
            };
        } catch (e) {
            return {
                id: row.id,
                consentId: row.consent_id,
                fetchedAt: row.fetched_at,
                expiresAt: row.expires_at,
                status: row.status,
                parsed: null,
                error: e instanceof Error ? e.message : 'Unreadable record.'
            };
        }
    });
});
handleGuardedDb('db:abdmHiuClearExternalRecords', (_, payload) => {
    const user = requireHiuClinician(sessionService.getUser());
    const args = payload || {};
    return databaseService.clearFetchedRecords(Number(args.patientId), user.id);
});
handleGuardedDb('db:abdmHiuImportMedication', (_, payload) => {
    const user = requireHiuClinician(sessionService.getUser());
    const args = payload || {};
    return databaseService.importExternalMedication(
        Number(args.patientId),
        {
            medicine_name: args.medicine_name ?? args.name,
            dosage: args.dosage,
            frequency: args.frequency,
            source: args.source
        },
        args.overrideReason ?? null,
        user.id
    );
});
handleGuardedDb('db:abdmAbhaConfirmOtp', (_, payload) => {
    const user = requireAbdmDeskRole(sessionService.getUser());
    const args = payload || {};
    return abdmAbhaService.confirmEnrollmentOtp(args.txnId, args.otp);
});
handleGuardedDb('db:abdmAbhaLookup', (_, payload) => {
    const user = requireAbdmDeskRole(sessionService.getUser());
    const args = payload || {};
    return abdmAbhaService.lookupAddress(args.abhaAddress);
});
handleGuardedDb('db:abdmAbhaCard', (_, payload) => {
    const user = requireAbdmDeskRole(sessionService.getUser());
    const args = payload || {};
    return abdmAbhaService.getCard(args.abhaAddress);
});
handleGuardedDb('db:abdmLinkAbha', (_, payload) => {
    const user = requireAbdmDeskRole(sessionService.getUser());
    const args = payload || {};
    return databaseService.linkAbhaAddress(args.patientId, {
        abhaAddress: args.abhaAddress ?? null,
        abhaName: args.abhaName ?? null
    }, user.id);
});
handleGuardedDb('db:abdmGetShareTokens', () => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    return databaseService.getPendingShareTokens();
});
handleGuardedDb('db:abdmGetInbox', () => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    return databaseService.getPendingInbox();
});
handleGuardedDb('db:abdmAckInbox', (_, payload) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    if (!['doctor', 'receptionist', 'admin'].includes(user.role)) throw new Error('Forbidden');
    const args = payload || {};
    return databaseService.ackInbox(args.id, user.id);
});
handleGuardedDb('db:abdmTransferBundle', async (_, payload) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    if (!['doctor', 'admin'].includes(user.role)) throw new Error('Forbidden');
    const args = payload || {};
    const settings = databaseService.getSettings() || {};
    const recipientKey = settings.abdm_recipient_key || '';
    if (!recipientKey) {
        throw new Error('No recipient key configured. Add one under Settings → ABDM first.');
    }
    if (!args.bundle) throw new Error('A health record bundle is required.');
    return fideliusService.pushBundle(args.bundle, recipientKey, settings.abdm_hip_endpoint || '');
});
handleGuardedDb('db:abdmAcceptShareToken', (_, payload) => {
    const user = requireAbdmDeskRole(sessionService.getUser());
    const args = payload || {};
    return databaseService.acceptShareToken(args.tokenId ?? args.id, user.id);
});
handleGuardedDb('db:abdmAcceptShareTokenAndCheckIn', (_, payload) => {
    const user = requireAbdmDeskRole(sessionService.getUser());
    const args = payload || {};
    return databaseService.acceptShareTokenAndCheckIn(args.tokenId ?? args.id, user.id);
});
handleGuardedDb('db:findPatientByAbha', (_, payload) => {
    const user = requireAbdmDeskRole(sessionService.getUser());
    const args = payload || {};
    return databaseService.findPatientByAbhaAddress(args.abhaAddress);
});
handleGuardedDb('db:abdmSimulateShare', () => {
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
handleGuardedDb('db:getQueue', () => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    return databaseService.getQueue();
});
handleGuardedDb('db:addToQueue', (_, data) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    return invokeDbMethod(databaseService, 'addToQueue', [data], user.id);
});
handleGuardedDb('db:updateQueueStatus', (_, data) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    return invokeDbMethod(databaseService, 'updateQueueStatus', [data], user.id);
});
handleGuardedDb('db:updateQueueStatusByPatientId', (_, data) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    return invokeDbMethod(databaseService, 'updateQueueStatusByPatientId', [data], user.id);
});
handleGuardedDb('db:removeFromQueue', (_, id) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    return invokeDbMethod(databaseService, 'removeFromQueue', [id], user.id);
});
handleGuardedDb('db:reassessQueueTriage', (_, data) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    return invokeDbMethod(databaseService, 'reassessQueueTriage', [data], user.id);
});
handleGuardedDb('db:getQueueTriageHistory', (_, queueId) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    return databaseService.getQueueTriageHistory(queueId);
});

// Audit IPC Handlers
handleGuardedDb('db:getAuditLogs', (_, limit) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    return databaseService.getAuditLogs(limit);
});

// Cloud IPC Handlers (#154). Pairing and the public listing are admin-only;
// any signed-in user can see the state and refresh the inbox.
const requireUser = () => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    return user;
};
const requireAdminUser = () => {
    const user = requireUser();
    if (user.role !== 'admin') throw new Error('Forbidden');
    return user;
};
const requirePaired = () => {
    if (!cloudLink.pairing.isPaired()) throw new Error('This computer is not paired with NalamDesk Cloud.');
};
// Cloud calls read the database, wait on the network and write back, so a
// restore must drain them like any other database work.
const handleCloud = (channel: string, handler: (...args: any[]) => unknown) =>
    ipcMain.handle(channel, (...args) => databaseService.runWork(async () => handler(...args)));
function cloudStatus() {
    return {
        ...cloudLink.pairing.status(),
        listingEnabled: !!databaseService.getSettings()?.cloud_enabled,
        mailbox: cloudLink.mailboxStatus()
    };
}
handleCloud('cloud:getStatus', () => {
    requireUser();
    return cloudStatus();
});
handleCloud('cloud:requestPairing', async (_, input) => {
    requireAdminUser();
    await cloudLink.pairing.request({ hfrId: String(input?.hfrId ?? ''), label: String(input?.label ?? '') });
    return cloudStatus();
});
handleCloud('cloud:cancelPairing', async () => {
    requireAdminUser();
    await cloudLink.pairing.cancel();
    return cloudStatus();
});
handleCloud('cloud:activatePairing', async (_, input) => {
    requireAdminUser();
    await cloudLink.pairing.activate({ code: String(input?.code ?? '') });
    return cloudStatus();
});
handleCloud('cloud:forgetPairing', () => {
    requireAdminUser();
    cloudLink.pairing.forget();
    databaseService.saveSettings({ cloud_enabled: 0, cloud_clinic_id: null });
    return cloudStatus();
});
handleCloud('cloud:enableListing', async (_, input) => {
    requireAdminUser();
    requirePaired();
    const name = String(input?.name ?? '').trim();
    const city = String(input?.city ?? '').trim();
    if (!name || !city) throw new Error('Clinic name and city are required.');
    await cloudLink.booking.enableListing({ name, city, specialty: String(input?.specialty ?? '').trim() || undefined });
    databaseService.saveSettings({ cloud_enabled: 1, cloud_clinic_id: cloudLink.pairing.status().clinicId ?? null });
    return cloudStatus();
});
handleCloud('cloud:disableListing', async () => {
    requireAdminUser();
    if (cloudLink.pairing.isPaired()) await cloudLink.booking.disableListing();
    databaseService.saveSettings({ cloud_enabled: 0 });
    return cloudStatus();
});
handleCloud('cloud:publishSlots', async (_, slots, dates) => {
    requireAdminUser();
    requirePaired();
    const published = await cloudLink.booking.publishSlots(Array.isArray(dates) ? dates : [], Array.isArray(slots) ? slots : []);
    return { published };
});
// Not handleCloud: the reader fences each save itself, so a restore never
// waits on a slow mailbox download.
ipcMain.handle('cloud:syncNow', async () => {
    requireUser();
    if (!cloudLink.pairing.isPaired()) return { success: false, paired: false, saved: 0 };
    const saved = await cloudLink.checkMailbox();
    return { success: true, paired: true, saved };
});
handleCloud('cloud:getPublishedSlots', async (_, date) => {
    requireUser();
    if (!cloudLink.pairing.isPaired()) return [];
    const day = String(date ?? '');
    return cloudLink.booking.publishedSlots(day, day);
});
// Accept or decline an online booking request: the cloud first (it books or
// releases the slot and updates the patient's status page), then locally.
handleCloud('cloud:decide', async (_, input) => {
    requireDesk();
    const ref = String(input?.ref ?? '');
    const decision = input?.decision === 'accepted' ? 'accepted' : input?.decision === 'declined' ? 'declined' : null;
    if (!decision) throw new Error('Decision must be accepted or declined.');
    try {
        await cloudLink.booking.decide(ref, decision);
    } catch (error) {
        // Requests left over from the retired cloud sync have no online
        // reference; they are decided locally only.
        if (error instanceof BookingError && error.code === 'bad_ref') {
            databaseService.updateAppointmentRequestStatus(ref, decision === 'declined' ? 'rejected' : 'accepted');
            return { success: true, local: true };
        }
        if (error instanceof BookingError) throw new Error(`${error.code}: ${error.message}`);
        throw error;
    }
    return { success: true };
});

// Appointment Request IPC
// Appointment Request IPC
handleGuardedDb('db:getAppointmentRequests', () => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    return databaseService.getAppointmentRequests();
});
handleGuardedDb('db:updateAppointmentRequestStatus', (_, { id, status }) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    return databaseService.updateAppointmentRequestStatus(id, status);
});

// Appointments (Bookings) IPC
// Appointments (Bookings) IPC
handleGuardedDb('db:getAppointments', (_, date) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    return databaseService.getAppointments(date);
});
handleGuardedDb('db:getAppointmentsByPatient', (_, patientId) =>
    invokeDbMethod(databaseService, 'getAppointmentsByPatient', [patientId], requireDesk(['doctor', 'receptionist', 'nurse', 'admin']).id));
handleGuardedDb('db:saveAppointment', (_, appt) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    if (!['doctor', 'receptionist', 'admin'].includes(user.role)) throw new Error('Forbidden');
    return databaseService.saveAppointment(appt, user.id);
});
// Appointment lifecycle (issue #19): desk roles move bookings through
// reasoned states; nurses hold no appointment grants.
const requireDesk = (roles: string[] = ['doctor', 'receptionist', 'admin']) => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    if (!roles.includes(user.role)) throw new Error('Forbidden');
    return user;
};
handleGuardedDb('db:transitionAppointment', (_, input) =>
    invokeDbMethod(databaseService, 'transitionAppointment', [input], requireDesk().id));
handleGuardedDb('db:getAppointmentHistory', (_, id) =>
    invokeDbMethod(databaseService, 'getAppointmentHistory', [id], requireDesk().id));
handleGuardedDb('db:getAppointmentByVisit', (_, visitId) =>
    invokeDbMethod(databaseService, 'getAppointmentByVisit', [visitId], requireDesk(['doctor', 'receptionist', 'nurse', 'admin']).id));
handleGuardedDb('db:detectConflicts', (_, input) =>
    invokeDbMethod(databaseService, 'detectConflicts', [input], requireDesk().id));
handleGuardedDb('db:checkInAppointment', (_, id) =>
    invokeDbMethod(databaseService, 'checkInAppointment', [id], requireDesk().id));
handleGuardedDb('db:fulfillAppointment', (_, input) =>
    invokeDbMethod(databaseService, 'fulfillAppointment', [input], requireDesk(['doctor', 'admin']).id));

function requireCatalogSession(roles: string[]) {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    if (!roles.includes(user.role)) throw new Error('Forbidden');
    return user;
}

handleGuardedDb('db:searchConditions', (_, query, limit) => {
    requireCatalogSession(['doctor', 'admin']);
    return databaseService.searchConditions(query, limit);
});
handleGuardedDb('db:searchMedicines', (_, query, limit) => {
    requireCatalogSession(['doctor', 'admin']);
    return databaseService.searchMedicines(query, limit);
});
handleGuardedDb('db:createCondition', (_, input) => {
    requireCatalogSession(['doctor', 'admin']);
    return databaseService.createCondition(input);
});
handleGuardedDb('db:createMedicine', (_, input) => {
    requireCatalogSession(['doctor', 'admin']);
    return databaseService.createMedicine(input);
});
handleGuardedDb('db:getConditionMedPresets', (_, conditionId) => {
    requireCatalogSession(['doctor', 'admin']);
    return databaseService.getConditionMedPresets(conditionId);
});
handleGuardedDb('db:listConditions', (_, includeRetired) => {
    requireCatalogSession(['admin']);
    return databaseService.listConditions(includeRetired);
});
handleGuardedDb('db:listMedicines', (_, includeRetired) => {
    requireCatalogSession(['admin']);
    return databaseService.listMedicines(includeRetired);
});
handleGuardedDb('db:updateCondition', (_, input) => {
    requireCatalogSession(['admin']);
    return databaseService.updateCondition(input);
});
handleGuardedDb('db:updateMedicine', (_, input) => {
    requireCatalogSession(['admin']);
    return databaseService.updateMedicine(input);
});
handleGuardedDb('db:retireCondition', (_, id) => {
    requireCatalogSession(['admin']);
    return databaseService.retireCondition(id);
});
handleGuardedDb('db:retireMedicine', (_, id) => {
    requireCatalogSession(['admin']);
    return databaseService.retireMedicine(id);
});
handleGuardedDb('db:replaceConditionMedPresets', (_, input) => {
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
    if (user.role !== 'admin') throw new Error('Forbidden');
    // Manual trigger for testing
    console.log('[Main] Manual backup triggered via IPC');
    await backupService.performBackup();
    return { success: true };
});

ipcMain.handle('backup:listSystemBackups', async () => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    if (user.role !== 'admin') throw new Error('Forbidden');
    return backupService.listSystemBackups();
});

ipcMain.handle('backup:getLocalBackupHealth', async () => {
    const user = sessionService.getUser();
    if (!user) throw new Error('Unauthorized');
    if (user.role !== 'admin') throw new Error('Forbidden');
    return backupService.getLocalBackupHealth();
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
