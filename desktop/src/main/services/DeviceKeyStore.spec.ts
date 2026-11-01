import { beforeEach, describe, expect, it, vi } from 'vitest';

const safeStorage = {
    isEncryptionAvailable: vi.fn(),
    getSelectedStorageBackend: vi.fn(),
    encryptString: vi.fn(),
    decryptString: vi.fn()
};

describe('ElectronSafeStorageDeviceKeyStore', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        safeStorage.isEncryptionAvailable.mockReturnValue(true);
        safeStorage.getSelectedStorageBackend.mockReturnValue('keychain');
    });

    it('round-trips a 32-byte key without exposing plaintext to the config', async () => {
        const key = Buffer.alloc(32, 7);
        safeStorage.encryptString.mockReturnValue(Buffer.from('ciphertext'));
        safeStorage.decryptString.mockReturnValue(key.toString('base64'));
        const { ElectronSafeStorageDeviceKeyStore } = await import('./DeviceKeyStore');
        const store = new ElectronSafeStorageDeviceKeyStore(safeStorage as any);
        expect(store.protect(key)).toEqual(Buffer.from('ciphertext'));
        expect(safeStorage.encryptString).toHaveBeenCalledWith(key.toString('base64'));
        expect(store.unprotect(Buffer.from('ciphertext'))).toEqual(key);
    });

    it('fails when Electron reports encryption unavailable', async () => {
        safeStorage.isEncryptionAvailable.mockReturnValue(false);
        const { ElectronSafeStorageDeviceKeyStore } = await import('./DeviceKeyStore');
        const store = new ElectronSafeStorageDeviceKeyStore(safeStorage as any);
        expect(store.status()).toMatchObject({ available: false, reason: 'ENCRYPTION_UNAVAILABLE' });
        expect(() => store.protect(Buffer.alloc(32))).toThrow('ENCRYPTION_UNAVAILABLE');
    });

    it('rejects Linux basic_text instead of silently weakening protection', async () => {
        const originalPlatform = process.platform;
        Object.defineProperty(process, 'platform', { value: 'linux' });
        safeStorage.getSelectedStorageBackend.mockReturnValue('basic_text');
        try {
            const { ElectronSafeStorageDeviceKeyStore } = await import('./DeviceKeyStore');
            expect(new ElectronSafeStorageDeviceKeyStore(safeStorage as any).status()).toMatchObject({
                available: false,
                reason: 'INSECURE_LINUX_BACKEND',
                backend: 'basic_text'
            });
            expect(() => new ElectronSafeStorageDeviceKeyStore(safeStorage as any).protect(Buffer.alloc(32)))
                .toThrow(/INSECURE_LINUX_BACKEND:.*gnome-libsecret/);
        } finally {
            Object.defineProperty(process, 'platform', { value: originalPlatform });
        }
    });

    it('accepts gnome-libsecret when the system keyring is present', async () => {
        const originalPlatform = process.platform;
        Object.defineProperty(process, 'platform', { value: 'linux' });
        safeStorage.isEncryptionAvailable.mockReturnValue(true);
        safeStorage.getSelectedStorageBackend.mockReturnValue('gnome_libsecret');
        try {
            const { ElectronSafeStorageDeviceKeyStore } = await import('./DeviceKeyStore');
            expect(new ElectronSafeStorageDeviceKeyStore(safeStorage as any).status()).toMatchObject({
                available: true,
                provider: 'electron-safe-storage',
                backend: 'gnome_libsecret'
            });
        } finally {
            Object.defineProperty(process, 'platform', { value: originalPlatform });
        }
    });

    it('names gnome-libsecret and the supported fix when the keyring is missing', async () => {
        const originalPlatform = process.platform;
        Object.defineProperty(process, 'platform', { value: 'linux' });
        safeStorage.isEncryptionAvailable.mockReturnValue(false);
        safeStorage.getSelectedStorageBackend.mockReturnValue('basic_text');
        try {
            const { ElectronSafeStorageDeviceKeyStore, formatEncryptionUnavailableMessage, isDeviceCryptoFailure } =
                await import('./DeviceKeyStore');
            const status = new ElectronSafeStorageDeviceKeyStore(safeStorage as any).status();
            expect(status.reason).toBe('ENCRYPTION_UNAVAILABLE');
            expect(status.message).toContain('gnome-libsecret');
            expect(status.message).toContain('libsecret-1-0');
            expect(status.message).toContain('gnome-keyring');
            expect(status.message).toContain('Do not launch with --password-store=basic');
            expect(formatEncryptionUnavailableMessage('linux')).toContain('gnome-libsecret');
            expect(() => new ElectronSafeStorageDeviceKeyStore(safeStorage as any).protect(Buffer.alloc(32)))
                .toThrow(/ENCRYPTION_UNAVAILABLE:.*gnome-libsecret/);
            expect(isDeviceCryptoFailure(status.message)).toBe(true);
            expect(isDeviceCryptoFailure('ENCRYPTION_UNAVAILABLE')).toBe(true);
            expect(isDeviceCryptoFailure('DEVICE_UNLOCK_FAILED')).toBe(true);
            expect(isDeviceCryptoFailure('SYSTEM_ERROR')).toBe(false);
            expect(isDeviceCryptoFailure(undefined)).toBe(false);
            expect(formatEncryptionUnavailableMessage('darwin'))
                .toBe('ENCRYPTION_UNAVAILABLE: OS-backed encryption is not available on this device.');
        } finally {
            Object.defineProperty(process, 'platform', { value: originalPlatform });
        }
    });

    it('omits backend when Electron cannot report the selected store', async () => {
        safeStorage.getSelectedStorageBackend.mockImplementation(() => {
            throw new Error('backend unavailable');
        });
        const { ElectronSafeStorageDeviceKeyStore } = await import('./DeviceKeyStore');
        expect(new ElectronSafeStorageDeviceKeyStore(safeStorage as any).status().backend).toBeUndefined();
    });
});
