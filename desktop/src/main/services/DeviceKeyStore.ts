import type { SafeStorage } from 'electron';

type SafeStorageApi = Pick<SafeStorage, 'isEncryptionAvailable' | 'encryptString' | 'decryptString'> &
    Partial<Pick<SafeStorage, 'getSelectedStorageBackend'>>;

/**
 * Electron is loaded on first use, not at import time: NalamDesk Server
 * imports this module for its interface and helpers, and ships without Electron.
 */
function loadElectronSafeStorage(): SafeStorageApi {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require('electron') as typeof import('electron')).safeStorage;
}

export type DeviceKeyUnavailableReason = 'ENCRYPTION_UNAVAILABLE' | 'INSECURE_LINUX_BACKEND';

export interface DeviceKeyStoreStatus {
    available: boolean;
    provider: string;
    reason?: DeviceKeyUnavailableReason;
    message?: string;
    backend?: string;
}

/** Device-bound wrapping boundary; injectable for tests and future platforms. */
export interface DeviceKeyStore {
    status(): DeviceKeyStoreStatus;
    protect(value: Buffer): Buffer;
    unprotect(value: Buffer): Buffer;
}

const DEVICE_CRYPTO_FAILURE_CODES = [
    'ENCRYPTION_UNAVAILABLE',
    'INSECURE_LINUX_BACKEND',
    'DEVICE_UNLOCK_FAILED'
] as const;

export function isDeviceCryptoFailure(message: string | undefined): boolean {
    if (!message) return false;
    return DEVICE_CRYPTO_FAILURE_CODES.some((code) => message === code || message.startsWith(`${code}:`));
}

export function formatEncryptionUnavailableMessage(platform: NodeJS.Platform = process.platform): string {
    if (platform === 'linux') {
        return [
            'ENCRYPTION_UNAVAILABLE:',
            'The Linux system keyring (gnome-libsecret) is not available.',
            'Install libsecret (package libsecret-1-0) and a keyring such as gnome-keyring, then restart NalamDesk.',
            'Do not launch with --password-store=basic.'
        ].join(' ');
    }
    return 'ENCRYPTION_UNAVAILABLE: OS-backed encryption is not available on this device.';
}

export function formatInsecureLinuxBackendMessage(): string {
    return [
        'INSECURE_LINUX_BACKEND:',
        'Electron selected the insecure basic_text password store.',
        'NalamDesk requires gnome-libsecret.',
        'Install libsecret-1-0 and gnome-keyring, then restart NalamDesk.',
        'Do not launch with --password-store=basic.'
    ].join(' ');
}

function selectedStorageBackend(safeStorage: SafeStorageApi): string | undefined {
    try {
        if (typeof safeStorage.getSelectedStorageBackend !== 'function') return undefined;
        return String(safeStorage.getSelectedStorageBackend());
    } catch {
        return undefined;
    }
}

export class ElectronSafeStorageDeviceKeyStore implements DeviceKeyStore {
    private cachedSafeStorage: SafeStorageApi | undefined;

    constructor(safeStorage?: SafeStorageApi) {
        this.cachedSafeStorage = safeStorage;
    }

    private get safeStorage(): SafeStorageApi {
        this.cachedSafeStorage ??= loadElectronSafeStorage();
        return this.cachedSafeStorage;
    }

    status(): DeviceKeyStoreStatus {
        const backend = selectedStorageBackend(this.safeStorage);
        if (!this.safeStorage.isEncryptionAvailable()) {
            return {
                available: false,
                provider: 'electron-safe-storage',
                reason: 'ENCRYPTION_UNAVAILABLE',
                message: formatEncryptionUnavailableMessage(),
                backend
            };
        }
        if (process.platform === 'linux' && backend === 'basic_text') {
            return {
                available: false,
                provider: 'electron-safe-storage',
                reason: 'INSECURE_LINUX_BACKEND',
                message: formatInsecureLinuxBackendMessage(),
                backend
            };
        }
        return { available: true, provider: 'electron-safe-storage', backend };
    }

    protect(value: Buffer): Buffer {
        this.assertAvailable();
        return this.safeStorage.encryptString(value.toString('base64'));
    }

    unprotect(value: Buffer): Buffer {
        this.assertAvailable();
        return Buffer.from(this.safeStorage.decryptString(value), 'base64');
    }

    private assertAvailable(): void {
        const current = this.status();
        if (!current.available) throw new Error(current.message || current.reason || 'DEVICE_KEY_UNAVAILABLE');
    }
}
