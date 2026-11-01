// The app in client mode (#194): a window onto a NalamDesk Server. No
// database, vault, Cloud identity, backups or local API server run here;
// the bundled UI talks to the server through this process, which pins the
// server's certificate and adds the computer's device credential.

import { app, BrowserWindow, ipcMain, session, shell } from 'electron';
import * as path from 'node:path';
import { autoUpdater } from 'electron-updater';
import log from 'electron-log';
import { getDevUiProxyUrl, isDevRuntime } from '../../shared/runtime-config';
import { configureUserDataPath, safeStorageCipher } from './electron-env';
import { forgetServerConnection, loadServerConnection, type ServerConnection } from './connection-store';
import { createPinnedTransport } from './pinned-transport';
import { ClientStreams, sanitizeRendererRequest } from './client-bridge';

const isDev = isDevRuntime(app.isPackaged);
const userDataPath = configureUserDataPath();

let connection: ServerConnection | null = null;
let connectionError: string | null = null;
try {
    connection = loadServerConnection(userDataPath, safeStorageCipher);
    if (!connection) connectionError = 'CONNECTION_UNREADABLE';
} catch (e) {
    // The keychain could not open the device credential (another OS user,
    // a reset keychain): the computer must join again.
    log.warn(`[Client] Could not read the server connection: ${(e as Error).message}`);
    connectionError = 'DEVICE_CREDENTIAL_UNREADABLE';
}

const transport = createPinnedTransport({
    serverUrl: connection?.serverUrl ?? 'https://invalid.localhost',
    pinnedCert: connection?.pinnedCert ?? null,
    fingerprint256: connection?.fingerprint256 ?? null,
    deviceToken: connection?.deviceToken ?? null
});
const streams = new ClientStreams(() => transport);
let mainWindow: BrowserWindow | null = null;

const staticPath = isDev
    ? path.join(__dirname, '../../../dist/nalamdesk/browser')
    : path.join(app.getAppPath(), 'dist/nalamdesk/browser');

function isOwnWindow(event: Electron.IpcMainInvokeEvent): boolean {
    return !!mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents;
}

ipcMain.handle('client:info', (event) => {
    if (!isOwnWindow(event)) return null;
    return {
        serverUrl: connection?.serverUrl ?? null,
        deviceName: connection?.deviceName ?? null,
        pinned: !!connection?.pinnedCert,
        appVersion: app.getVersion(),
        error: connectionError
    };
});

ipcMain.handle('client:request', async (event, input) => {
    if (!isOwnWindow(event) || !connection) throw new Error('NOT_CONNECTED');
    const req = sanitizeRendererRequest(input);
    if (!req) throw new Error('REQUEST_NOT_ALLOWED');
    return transport.request(req);
});

ipcMain.handle('client:streamOpen', (event, id: string, input) => {
    if (!isOwnWindow(event) || !connection) return false;
    const sender = event.sender;
    return streams.start(id, input, {
        chunk: (streamId, text) => { if (!sender.isDestroyed()) sender.send('client:streamChunk', streamId, text); },
        end: (streamId, result) => { if (!sender.isDestroyed()) sender.send('client:streamEnd', streamId, result); }
    });
});

ipcMain.handle('client:streamClose', (event, id: string) => {
    if (isOwnWindow(event)) streams.stop(id);
});

// Leaves the server: forget the address and credential and restart as a
// fresh install. The admin can also revoke the computer on the server.
ipcMain.handle('client:disconnect', (event) => {
    if (!isOwnWindow(event)) return false;
    streams.stopAll();
    forgetServerConnection(userDataPath);
    app.relaunch();
    app.exit(0);
    return true;
});

ipcMain.handle('client:openExternal', async (event, url: string) => {
    if (!isOwnWindow(event)) return;
    if (typeof url === 'string' && url.startsWith('https://')) await shell.openExternal(url);
});

function applySecurityPolicy(): void {
    const csp = isDev
        ? "default-src 'self' 'unsafe-inline' data:; script-src 'self' 'unsafe-eval' 'unsafe-inline'; connect-src 'self' ws://localhost:* ws://127.0.0.1:*; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:;"
        : "default-src 'self' 'unsafe-inline' data:; script-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:;";
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
        callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } });
    });
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    // The window loads only the bundled UI (or the dev server); the
    // server is reached through this process, never from the page.
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
        let url: URL;
        try {
            url = new URL(details.url);
        } catch {
            return callback({ cancel: true });
        }
        const local = url.protocol === 'file:' || url.protocol === 'devtools:'
            || (isDev && (url.hostname === 'localhost' || url.hostname === '127.0.0.1'));
        const fonts = url.protocol === 'https:' && (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com');
        callback({ cancel: !(local || fonts) });
    });
}

async function createWindow(): Promise<void> {
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 800,
        title: connection ? `NalamDesk — ${new URL(connection.serverUrl).host}` : 'NalamDesk',
        icon: isDev ? path.join(__dirname, '../../../build/icon.png') : path.join(app.getAppPath(), 'build/icon.png'),
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            preload: path.join(__dirname, 'client-preload.js')
        }
    });
    mainWindow.setMenu(null);
    mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    mainWindow.on('closed', () => {
        streams.stopAll();
        mainWindow = null;
    });
    if (isDev) {
        await mainWindow.loadURL(getDevUiProxyUrl());
    } else {
        await mainWindow.loadFile(path.join(staticPath, 'index.html'));
    }
}

if (app.requestSingleInstanceLock()) {
    app.on('second-instance', () => {
        if (mainWindow?.isMinimized()) mainWindow.restore();
        mainWindow?.focus();
    });
    void app.whenReady().then(async () => {
        applySecurityPolicy();
        await createWindow();
        // Client computers keep updating themselves; the server is upgraded
        // by its operator.
        if (!isDev) {
            autoUpdater.logger = log;
            autoUpdater.checkForUpdatesAndNotify().catch((e) => log.warn(`[Client] Update check failed: ${(e as Error).message}`));
        }
    });
    app.on('window-all-closed', () => app.quit());
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) void createWindow();
    });
} else {
    app.quit();
}
