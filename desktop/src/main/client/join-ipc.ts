// First run of the single-PC app (#194): instead of creating a vault, the
// computer can join a NalamDesk Server. On success the connection is saved
// and the app restarts in client mode.

import type { IpcMain } from 'electron';
import { joinServer, type JoinDeps } from './join';
import { saveServerConnection, type SecretCipher } from './connection-store';

export interface JoinIpcDeps {
    userDataPath: string;
    cipher: SecretCipher;
    /** False once this computer holds a single-PC vault: joining would hide it. */
    canJoin: () => boolean;
    restart: () => void;
    join?: JoinDeps;
}

export async function handleJoinRequest(input: unknown, deps: JoinIpcDeps) {
    if (!deps.canJoin()) return { ok: false as const, error: 'ALREADY_SET_UP' };
    const body = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
    const result = await joinServer({
        serverUrl: String(body['serverUrl'] ?? ''),
        code: String(body['code'] ?? ''),
        deviceName: String(body['deviceName'] ?? '')
    }, deps.join);
    if (!result.ok) return result;
    try {
        saveServerConnection(deps.userDataPath, result.connection, deps.cipher);
    } catch {
        return { ok: false as const, error: 'SECURE_STORAGE_UNAVAILABLE' };
    }
    // Let the reply reach the window before restarting into client mode.
    setTimeout(deps.restart, 750);
    return { ok: true as const, serverUrl: result.connection.serverUrl, deviceName: result.connection.deviceName };
}

export function registerJoinIpc(ipcMain: Pick<IpcMain, 'handle'>, deps: JoinIpcDeps): void {
    ipcMain.handle('client:join', (_event, input) => handleJoinRequest(input, deps));
}
