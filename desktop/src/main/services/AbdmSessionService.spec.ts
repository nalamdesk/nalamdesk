import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AbdmSessionService, ABDM_MOCK_TOKEN_TTL_MS } from './AbdmSessionService';

function fakeKeyStore() {
    return {
        status: vi.fn().mockReturnValue({ available: true, provider: 'test' }),
        protect: vi.fn().mockImplementation((value: Buffer) => Buffer.from(`protected:${value.toString('utf8')}`)),
        unprotect: vi.fn().mockImplementation((value: Buffer) => {
            const raw = value.toString('utf8');
            if (!raw.startsWith('protected:')) throw new Error('bad blob');
            return Buffer.from(raw.slice('protected:'.length));
        })
    };
}

describe('AbdmSessionService', () => {
    let settings: any;
    let savedPatches: Record<string, unknown>[];
    let savedSecrets: string[];

    beforeEach(() => {
        settings = {};
        savedPatches = [];
        savedSecrets = [];
    });

    function service(overrides: any = {}) {
        return new AbdmSessionService({
            getSettings: () => settings,
            getSecretProtected: () => settings.abdm_client_secret_protected || null,
            saveSettingsPatch: (patch) => { savedPatches.push(patch); Object.assign(settings, patch); },
            saveSecretProtected: (value) => { savedSecrets.push(value); settings.abdm_client_secret_protected = value; },
            keyStore: fakeKeyStore(),
            nowMs: () => 1_000_000,
            ...overrides
        });
    }

    it('stays in mock mode without credentials and mints mock sessions', async () => {
        const svc = service();
        expect(svc.isMockMode()).toBe(true);
        const session = await svc.getSessionToken();
        expect(session.mock).toBe(true);
        expect(session.token.startsWith('mock-abdm-token-')).toBe(true);
    });

    it('caches the session and shares one in-flight request', async () => {
        let calls = 0;
        const svc = service({
            fetchFn: vi.fn().mockImplementation(async () => {
                calls += 1;
                return { ok: true, json: async () => ({ accessToken: 'live-token', expiresIn: 900 }) };
            })
        });
        settings.abdm_mock = 0;
        settings.abdm_client_id = 'CID';
        settings.abdm_client_secret_protected = Buffer.from('protected:s3cret', 'utf8').toString('base64');

        const [a, b] = await Promise.all([svc.getSessionToken(), svc.getSessionToken()]);
        expect(a.token).toBe('live-token');
        expect(b.token).toBe('live-token');
        expect(calls).toBe(1);
        expect(svc.isMockMode()).toBe(false);
    });

    it('refreshes proactively before expiry', async () => {
        let now = 1_000_000;
        let calls = 0;
        const svc = service({
            nowMs: () => now,
            fetchFn: vi.fn().mockImplementation(async () => {
                calls += 1;
                return { ok: true, json: async () => ({ accessToken: `live-${calls}`, expiresIn: 900 }) };
            })
        });
        settings.abdm_mock = 0;
        settings.abdm_client_id = 'CID';
        settings.abdm_client_secret_protected = Buffer.from('protected:s3cret', 'utf8').toString('base64');

        await svc.getSessionToken();
        // Move inside the 2-minute proactive refresh window (15-min TTL).
        now += 15 * 60 * 1000 - 60 * 1000;
        const refreshed = await svc.getSessionToken();
        expect(refreshed.token).toBe('live-2');
        expect(calls).toBe(2);
    });

    it('stores the secret protected and never in plaintext settings', async () => {
        const svc = service();
        await svc.saveClientSecret('s3cret');
        expect(savedSecrets).toHaveLength(1);
        expect(savedPatches.every((p) => !JSON.stringify(p).includes('s3cret'))).toBe(true);
        expect(settings.abdm_client_secret_protected).not.toContain('s3cret');
    });

    it('refuses to store when the keychain is unavailable', async () => {
        const svc = service({
            keyStore: {
                status: () => ({ available: false, provider: 'test', reason: 'ENCRYPTION_UNAVAILABLE', message: 'no keyring' }),
                protect: () => { throw new Error('unreachable'); },
                unprotect: () => { throw new Error('unreachable'); }
            } as any
        });
        await expect(svc.saveClientSecret('s3cret')).rejects.toThrow('ENCRYPTION_UNAVAILABLE');
    });

    it('reports mock connectivity without credentials', async () => {
        const svc = service();
        const result = await svc.testConnectivity();
        expect(result).toMatchObject({ ok: true, mode: 'mock' });
    });

    it('reports live failures plainly', async () => {
        const svc = service({
            fetchFn: vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) })
        });
        settings.abdm_mock = 0;
        settings.abdm_client_id = 'CID';
        settings.abdm_client_secret_protected = Buffer.from('protected:s3cret', 'utf8').toString('base64');
        const result = await svc.testConnectivity();
        expect(result.ok).toBe(false);
        expect(result.mode).toBe('live');
        expect(result.detail).toContain('401');
    });

    it('uses the mock TTL constant consistently', () => {
        expect(ABDM_MOCK_TOKEN_TTL_MS).toBe(20 * 60 * 1000);
    });
});
