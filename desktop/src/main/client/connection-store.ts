// Where the app remembers the NalamDesk Server it joined (#194). Client mode
// keeps no vault, keys or patient data on disk: only the server address, the
// pinned certificate and the device credential, which is encrypted with the
// OS keychain (Electron safeStorage) like the single-PC vault key.

import * as fs from 'node:fs';
import * as path from 'node:path';

export const CONNECTION_FILE = 'server-connection.json';

export interface ServerConnection {
    serverUrl: string;
    deviceId: string;
    deviceName: string;
    deviceToken: string;
    pinnedCert: string | null;
    fingerprint256: string | null;
    joinedAt: number;
}

export interface SecretCipher {
    available(): boolean;
    encrypt(plain: string): string;
    decrypt(sealed: string): string;
}

interface StoredConnection extends Omit<ServerConnection, 'deviceToken'> {
    version: 1;
    sealedDeviceToken: string;
}

export function connectionPath(userDataPath: string): string {
    return path.join(userDataPath, CONNECTION_FILE);
}

/** True when this install runs as a client of a NalamDesk Server. */
export function hasServerConnection(userDataPath: string): boolean {
    return fs.existsSync(connectionPath(userDataPath));
}

export function saveServerConnection(userDataPath: string, connection: ServerConnection, cipher: SecretCipher): void {
    if (!cipher.available()) throw new Error('SECURE_STORAGE_UNAVAILABLE');
    const { deviceToken, ...rest } = connection;
    const stored: StoredConnection = { version: 1, ...rest, sealedDeviceToken: cipher.encrypt(deviceToken) };
    fs.mkdirSync(userDataPath, { recursive: true });
    const target = connectionPath(userDataPath);
    const temp = `${target}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(stored, null, 2), { mode: 0o600 });
    fs.renameSync(temp, target);
}

export function loadServerConnection(userDataPath: string, cipher: SecretCipher): ServerConnection | null {
    let stored: StoredConnection;
    try {
        stored = JSON.parse(fs.readFileSync(connectionPath(userDataPath), 'utf8'));
    } catch {
        return null;
    }
    if (stored?.version !== 1 || typeof stored.serverUrl !== 'string' || typeof stored.sealedDeviceToken !== 'string') return null;
    const { version: _version, sealedDeviceToken, ...rest } = stored;
    return { ...rest, deviceToken: cipher.decrypt(sealedDeviceToken) };
}

export function forgetServerConnection(userDataPath: string): void {
    fs.rmSync(connectionPath(userDataPath), { force: true });
}
