import { describe, it, expect, vi } from 'vitest';
import { AbdmAbhaService } from './AbdmAbhaService';

function mockSession() {
    return { token: 'mock-abdm-token-1', mock: true };
}

describe('AbdmAbhaService (mock gateway)', () => {
    it('validates identifiers before requesting enrollment codes', async () => {
        const svc = new AbdmAbhaService({ getSessionToken: async () => mockSession() });
        await expect(svc.requestEnrollmentOtp({ via: 'aadhaar', identifier: '123' }))
            .rejects.toThrow('12 digits');
        await expect(svc.requestEnrollmentOtp({ via: 'mobile', identifier: '12' }))
            .rejects.toThrow('10 to 15 digits');
    });

    it('runs the mock enrollment round trip with any 6-digit code', async () => {
        const svc = new AbdmAbhaService({ getSessionToken: async () => mockSession() });
        const started = await svc.requestEnrollmentOtp({ via: 'mobile', identifier: '9876543210' });
        expect(started.txnId.startsWith('mock-txn-')).toBe(true);
        expect(started.mock).toBe(true);
        expect(started.hint).toContain('6-digit');

        const created = await svc.confirmEnrollmentOtp(started.txnId, '482916');
        expect(created.abhaAddress.endsWith('@sbx')).toBe(true);
        expect(created.name).toBe('Demo Patient');
        expect(created.mock).toBe(true);
    });

    it('rejects short codes before calling the gateway', async () => {
        const svc = new AbdmAbhaService({ getSessionToken: async () => mockSession() });
        await expect(svc.confirmEnrollmentOtp('mock-txn-1', '12')).rejects.toThrow('6-digit');
    });

    it('looks up addresses and reports missing ones', async () => {
        const svc = new AbdmAbhaService({ getSessionToken: async () => mockSession() });
        const found = await svc.lookupAddress('demo.patient@sbx');
        expect(found).toMatchObject({ exists: true, mock: true });
        const missing = await svc.lookupAddress('unknown.person@sbx');
        expect(missing.exists).toBe(false);
    });

    it('fetches a printable card payload', async () => {
        const svc = new AbdmAbhaService({ getSessionToken: async () => mockSession() });
        const card = await svc.getCard('demo.patient@sbx');
        expect(card).toMatchObject({ abhaAddress: 'demo.patient@sbx', mock: true });
        expect(card.name).toBeTruthy();
    });

    it('runs the mock profile-login round trip with any 6-digit code', async () => {
        const svc = new AbdmAbhaService({ getSessionToken: async () => mockSession() });
        await expect(svc.requestLoginOtp('')).rejects.toThrow('Health ID is required');
        const started = await svc.requestLoginOtp('demo.patient@sbx');
        expect(started.txnId.startsWith('mock-login-')).toBe(true);
        expect(started.mock).toBe(true);
        expect(started.hint).toContain('6-digit');

        const verified = await svc.verifyLoginOtp(started.txnId, '482916');
        expect(verified).toMatchObject({ abhaAddress: 'demo.patient@sbx', name: 'Demo Patient', mock: true });
        await expect(svc.verifyLoginOtp('', '482916')).rejects.toThrow('transaction is missing');
        await expect(svc.verifyLoginOtp(started.txnId, '12')).rejects.toThrow('6-digit');
    });

    it('sends profile-login calls to the login endpoints with the session token', async () => {
        const fetchFn = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ txnId: 'live-txn-9' })
        });
        const svc = new AbdmAbhaService({
            getSessionToken: async () => ({ token: 'live-token', mock: false }),
            gatewayBaseUrl: () => 'https://gateway.example',
            fetchFn
        });
        await svc.requestLoginOtp('real@abdm');
        expect(fetchFn).toHaveBeenCalledWith(
            expect.stringContaining('/v3/profile/login/request/otp'),
            expect.objectContaining({
                headers: expect.objectContaining({ Authorization: 'Bearer live-token' })
            })
        );
    });
    it('sends live calls with the session token when credentials exist', async () => {
        const fetchFn = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ exists: true, name: 'Real Patient' })
        });
        const svc = new AbdmAbhaService({
            getSessionToken: async () => ({ token: 'live-token', mock: false }),
            gatewayBaseUrl: () => 'https://gateway.example',
            fetchFn
        });
        const found = await svc.lookupAddress('real@abdm');
        expect(found).toMatchObject({ exists: true, name: 'Real Patient', mock: false });
        expect(fetchFn).toHaveBeenCalledWith(
            expect.stringContaining('/v3/profile/account/verify'),
            expect.objectContaining({
                headers: expect.objectContaining({ Authorization: 'Bearer live-token' })
            })
        );
    });

    it('RSA-encrypts live enrollment identifiers with the gateway key', async () => {
        const { generateKeyPairSync, privateDecrypt, constants } = await import('node:crypto');
        const { publicKey, privateKey } = generateKeyPairSync('rsa', {
            modulusLength: 2048,
            publicKeyEncoding: { type: 'spki', format: 'pem' },
            privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
        });
        const calls: any[] = [];
        const fetchFn = vi.fn().mockImplementation(async (url: string, init: any) => {
            calls.push([url, init]);
            if (String(url).endsWith('/v3/auth/cert')) {
                return { ok: true, json: async () => ({ publicKey }) };
            }
            return { ok: true, json: async () => ({ txnId: 'live-txn-1' }) };
        });
        const svc = new AbdmAbhaService({
            getSessionToken: async () => ({ token: 'live-token', mock: false }),
            gatewayBaseUrl: () => 'https://gateway.example',
            fetchFn
        });

        const started = await svc.requestEnrollmentOtp({ via: 'aadhaar', identifier: '123456789012' });
        expect(started).toMatchObject({ txnId: 'live-txn-1', mock: false });

        const enrolCall = calls.find(([url]) => String(url).endsWith('/byAadhaar'));
        const sent = JSON.parse(enrolCall[1].body).aadhaar;
        expect(sent).not.toContain('123456789012');
        const decrypted = privateDecrypt(
            { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' },
            Buffer.from(sent, 'base64')
        ).toString('utf8');
        expect(decrypted).toBe('123456789012');
    });

    it('fetches the gateway certificate once across enrollments', async () => {
        const { generateKeyPairSync } = await import('node:crypto');
        const { publicKey } = generateKeyPairSync('rsa', {
            modulusLength: 2048,
            publicKeyEncoding: { type: 'spki', format: 'pem' },
            privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
        });
        const fetchFn = vi.fn().mockImplementation(async (url: string) => {
            if (String(url).endsWith('/v3/auth/cert')) {
                return { ok: true, json: async () => ({ publicKey }) };
            }
            return { ok: true, json: async () => ({ txnId: 'live-txn-9' }) };
        });
        const svc = new AbdmAbhaService({
            getSessionToken: async () => ({ token: 'live-token', mock: false }),
            gatewayBaseUrl: () => 'https://gateway.example',
            fetchFn
        });

        await svc.requestEnrollmentOtp({ via: 'mobile', identifier: '9876543210' });
        await svc.requestEnrollmentOtp({ via: 'mobile', identifier: '9876500001' });
        expect(fetchFn.mock.calls.filter(([url]) => String(url).endsWith('/v3/auth/cert'))).toHaveLength(1);
    });

    it('fails plainly when the gateway certificate is unusable', async () => {
        const fetchFn = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ publicKey: 'not-a-key' })
        });
        const svc = new AbdmAbhaService({
            getSessionToken: async () => ({ token: 'live-token', mock: false }),
            gatewayBaseUrl: () => 'https://gateway.example',
            fetchFn
        });
        await expect(svc.requestEnrollmentOtp({ via: 'aadhaar', identifier: '123456789012' }))
            .rejects.toThrow('usable public key');
    });

    it('uses one session snapshot so a mid-flight flip cannot leak plaintext', async () => {
        const fetchFn = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ txnId: 'should-not-happen' })
        });
        let calls = 0;
        const svc = new AbdmAbhaService({
            getSessionToken: async () => {
                calls += 1;
                return calls === 1 ? { token: 'mock-token', mock: true } : { token: 'live-token', mock: false };
            },
            gatewayBaseUrl: () => 'https://gateway.example',
            fetchFn
        });
        const started = await svc.requestEnrollmentOtp({ via: 'aadhaar', identifier: '123456789012' });
        expect(started.mock).toBe(true);
        expect(fetchFn).not.toHaveBeenCalled();
    });

    it('scopes the certificate cache to the gateway environment', async () => {
        const { generateKeyPairSync } = await import('node:crypto');
        const keypair = (env: string) => generateKeyPairSync('rsa', {
            modulusLength: 2048,
            publicKeyEncoding: { type: 'spki', format: 'pem' },
            privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
        });
        const sandboxKeys = keypair('sandbox');
        const stagingKeys = keypair('staging');
        let env = 'sandbox';
        const certCalls: string[] = [];
        const fetchFn = vi.fn().mockImplementation(async (url: string) => {
            if (String(url).endsWith('/v3/auth/cert')) {
                certCalls.push(env);
                const keys = env === 'sandbox' ? sandboxKeys : stagingKeys;
                return { ok: true, json: async () => ({ publicKey: keys.publicKey }) };
            }
            return { ok: true, json: async () => ({ txnId: 'live-txn-env' }) };
        });
        const svc = new AbdmAbhaService({
            getSessionToken: async () => ({ token: 'live-token', mock: false }),
            gatewayBaseUrl: () => `https://${env}.example`,
            fetchFn
        });

        await svc.requestEnrollmentOtp({ via: 'aadhaar', identifier: '123456789012' });
        env = 'staging';
        await svc.requestEnrollmentOtp({ via: 'aadhaar', identifier: '123456789012' });
        expect(certCalls).toEqual(['sandbox', 'staging']);
    });

    it('refetches the certificate after explicit invalidation', async () => {
        const { generateKeyPairSync } = await import('node:crypto');
        const { publicKey } = generateKeyPairSync('rsa', {
            modulusLength: 2048,
            publicKeyEncoding: { type: 'spki', format: 'pem' },
            privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
        });
        const fetchFn = vi.fn().mockImplementation(async (url: string) => {
            if (String(url).endsWith('/v3/auth/cert')) {
                return { ok: true, json: async () => ({ publicKey }) };
            }
            return { ok: true, json: async () => ({ txnId: 'live-txn-inv' }) };
        });
        const svc = new AbdmAbhaService({
            getSessionToken: async () => ({ token: 'live-token', mock: false }),
            gatewayBaseUrl: () => 'https://gateway.example',
            fetchFn
        });

        await svc.requestEnrollmentOtp({ via: 'mobile', identifier: '9876543210' });
        svc.invalidateCert();
        await svc.requestEnrollmentOtp({ via: 'mobile', identifier: '9876543210' });
        expect(fetchFn.mock.calls.filter(([url]) => String(url).endsWith('/v3/auth/cert'))).toHaveLength(2);
    });

    it('pins token, mode, and gateway URL for the whole operation', async () => {
        const { generateKeyPairSync } = await import('node:crypto');
        const { publicKey } = generateKeyPairSync('rsa', {
            modulusLength: 2048,
            publicKeyEncoding: { type: 'spki', format: 'pem' },
            privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
        });
        let env = 'sandbox';
        const urls: string[] = [];
        const fetchFn = vi.fn().mockImplementation(async (url: string, init: any) => {
            urls.push(String(url));
            if (String(url).endsWith('/v3/auth/cert')) {
                // Flip the environment while the operation is in flight.
                env = 'staging';
                return { ok: true, json: async () => ({ publicKey }) };
            }
            return { ok: true, json: async () => ({ txnId: 'live-txn-pinned' }) };
        });
        const svc = new AbdmAbhaService({
            getSessionToken: async () => ({ token: 'live-token', mock: false }),
            gatewayBaseUrl: () => `https://${env}.example`,
            fetchFn
        });

        const started = await svc.requestEnrollmentOtp({ via: 'aadhaar', identifier: '123456789012' });

        expect(started).toMatchObject({ txnId: 'live-txn-pinned', mock: false });
        expect(urls).toHaveLength(2);
        expect(urls.every((u) => u.startsWith('https://sandbox.example'))).toBe(true);
    });

    it('captures the gateway URL before awaiting the session', async () => {
        const { generateKeyPairSync } = await import('node:crypto');
        const { publicKey } = generateKeyPairSync('rsa', {
            modulusLength: 2048,
            publicKeyEncoding: { type: 'spki', format: 'pem' },
            privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
        });
        let env = 'sandbox';
        let releaseSession!: (value: { token: string; mock: boolean }) => void;
        const urls: string[] = [];
        const fetchFn = vi.fn().mockImplementation(async (url: string) => {
            urls.push(String(url));
            if (String(url).endsWith('/v3/auth/cert')) {
                return { ok: true, json: async () => ({ publicKey }) };
            }
            return { ok: true, json: async () => ({ txnId: 'live-txn-atomic' }) };
        });
        const svc = new AbdmAbhaService({
            getSessionToken: () => new Promise((resolve) => { releaseSession = resolve as any; }),
            gatewayBaseUrl: () => `https://${env}.example`,
            fetchFn
        });

        const pending = svc.requestEnrollmentOtp({ via: 'aadhaar', identifier: '123456789012' });
        await Promise.resolve();
        // Flip the environment while the session request is still suspended.
        env = 'staging';
        releaseSession({ token: 'live-token', mock: false });
        const started = await pending;

        expect(started).toMatchObject({ txnId: 'live-txn-atomic', mock: false });
        expect(urls.length).toBeGreaterThan(0);
        expect(urls.every((u) => u.startsWith('https://sandbox.example'))).toBe(true);
    });
});
