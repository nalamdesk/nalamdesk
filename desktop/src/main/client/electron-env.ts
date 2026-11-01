// Electron pieces shared by the entry point and client mode (#194).

import { app, safeStorage } from 'electron';
import { DEV_APP_NAME, getDevUserDataPath, isDevRuntime } from '../../shared/runtime-config';
import type { SecretCipher } from './connection-store';

/**
 * The userData folder the app uses, set up the same way as single-PC mode:
 * development builds keep their own folder (or the E2E one).
 */
export function configureUserDataPath(): string {
    if (isDevRuntime(app.isPackaged)) {
        app.setName(DEV_APP_NAME);
        app.setPath('userData', process.env['NALAMDESK_E2E_USER_DATA'] || getDevUserDataPath(app.getPath('appData')));
    }
    return app.getPath('userData');
}

/** Seals the device credential with the OS keychain. */
export const safeStorageCipher: SecretCipher = {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
    decrypt: (sealed) => safeStorage.decryptString(Buffer.from(sealed, 'base64'))
};
