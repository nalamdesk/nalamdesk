import * as crypto from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import { AbdmAbhaService } from './AbdmAbhaService';

function mockRelay() {
    return { isMockMode: () => true, send: vi.fn() };
}

const { publicKey: ABHA_PUBLIC_KEY, privateKey: ABHA_PRIVATE_KEY } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});

const decrypt = (value: string) => crypto.privateDecrypt(
    { key: ABHA_PRIVATE_KEY, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' },
    Buffer.from(value, 'base64')
).toString('utf8');

/** A paired relay: the certificate route answers with the ABHA key, others from `answers` by path. */
function liveRelay(answers: Record<string, unknown> = {}, cert: unknown = { publicKey: ABHA_PUBLIC_KEY }) {
    const send = vi.fn(async (_upstream: string, _method: string, path: string, _body?: unknown) =>
        (path === '/v3/profile/public/certificate' ? cert : answers[path] ?? {}));
    return { isMockMode: vi.fn(() => false), send };
}

describe('AbdmAbhaService (mock gateway)', () => {
    it('validates identifiers before requesting enrollment codes', async () => {
        const svc = new AbdmAbhaService({ relay: mockRelay() });
        await expect(svc.requestEnrollmentOtp({ via: 'aadhaar', identifier: '123' }))
            .rejects.toThrow('12 digits');
        await expect(svc.requestEnrollmentOtp({ via: 'mobile', identifier: '12' }))
            .rejects.toThrow('10 to 15 digits');
    });

    it('runs the mock enrollment round trip with any 6-digit code, and never calls the relay', async () => {
        const relay = mockRelay();
        const svc = new AbdmAbhaService({ relay });
        const started = await svc.requestEnrollmentOtp({ via: 'mobile', identifier: '9876543210' });
        expect(started.txnId.startsWith('mock-txn-')).toBe(true);
        expect(started.mock).toBe(true);
        expect(started.hint).toContain('6-digit');

        const created = await svc.confirmEnrollmentOtp(started.txnId, '482916');
        expect(created.abhaAddress.endsWith('@sbx')).toBe(true);
        expect(created.name).toBe('Demo Patient');
        expect(created.mock).toBe(true);
        expect(relay.send).not.toHaveBeenCalled();
    });

    it('serves the mock when no relay is wired at all', async () => {
        const svc = new AbdmAbhaService();
        expect(await svc.lookupAddress('demo.patient@sbx')).toMatchObject({ exists: true, mock: true });
    });

    it('rejects short codes before calling the gateway', async () => {
        const svc = new AbdmAbhaService({ relay: mockRelay() });
        await expect(svc.confirmEnrollmentOtp('mock-txn-1', '12')).rejects.toThrow('6-digit');
        await expect(svc.confirmEnrollmentOtp('', '482916')).rejects.toThrow('transaction is missing');
    });

    it('looks up addresses and reports missing ones', async () => {
        const svc = new AbdmAbhaService({ relay: mockRelay() });
        const found = await svc.lookupAddress('demo.patient@sbx');
        expect(found).toMatchObject({ exists: true, mock: true });
        const missing = await svc.lookupAddress('unknown.person@sbx');
        expect(missing.exists).toBe(false);
        await expect(svc.lookupAddress(' ')).rejects.toThrow('Health ID is required');
    });

    it('fetches a printable card payload', async () => {
        const svc = new AbdmAbhaService({ relay: mockRelay() });
        const card = await svc.getCard('demo.patient@sbx');
        expect(card).toMatchObject({ abhaAddress: 'demo.patient@sbx', mock: true });
        expect(card.name).toBeTruthy();
        await expect(svc.getCard('')).rejects.toThrow('Health ID is required');
    });

    it('runs the mock profile-login round trip with any 6-digit code', async () => {
        const svc = new AbdmAbhaService({ relay: mockRelay() });
        await expect(svc.requestLoginOtp('')).rejects.toThrow('Health ID is required');
        const started = await svc.requestLoginOtp('asha.worker@sbx');
        expect(started.txnId.startsWith('mock-login-')).toBe(true);
        expect(started.mock).toBe(true);
        expect(started.hint).toContain('6-digit');

        // The verified address is the requested one, not a fixed demo address.
        const verified = await svc.verifyLoginOtp(started.txnId, '482916');
        expect(verified).toMatchObject({ abhaAddress: 'asha.worker@sbx', mock: true });
        await expect(svc.verifyLoginOtp('', '482916')).rejects.toThrow('transaction is missing');
        await expect(svc.verifyLoginOtp(started.txnId, '12')).rejects.toThrow('6-digit');
    });

    it('falls back to the profile payload for unknown mock transactions', async () => {
        const svc = new AbdmAbhaService({ relay: mockRelay() });
        const verified = await svc.verifyLoginOtp('mock-login-unknown', '482916');
        expect(verified.abhaAddress).toBe('demo.patient@sbx');
    });
});

describe('AbdmAbhaService (through the relay)', () => {
    it('sends enrollment through v3 request/otp then byAadhaar, RSA-encrypting the identifier', async () => {
        const relay = liveRelay({
            '/v3/enrollment/request/otp': { txnId: 'live-txn-1' },
            '/v3/enrollment/enrol/byAadhaar': { abhaAddress: 'real@abdm', name: 'Real Patient' }
        });
        const svc = new AbdmAbhaService({ relay });

        const started = await svc.requestEnrollmentOtp({ via: 'aadhaar', identifier: '1234 5678 9012' });
        expect(started).toEqual({ txnId: 'live-txn-1', mock: false });
        const [upstream, method, path, body] = relay.send.mock.calls[1]!;
        expect([upstream, method, path]).toEqual(['abha', 'POST', '/v3/enrollment/request/otp']);
        expect(decrypt((body as any).aadhaar)).toBe('123456789012');
        expect(relay.send.mock.calls[0]!.slice(0, 3)).toEqual(['abha', 'GET', '/v3/profile/public/certificate']);

        expect(await svc.confirmEnrollmentOtp('live-txn-1', '482916')).toEqual({ abhaAddress: 'real@abdm', name: 'Real Patient', mock: false });
        const [, confirmMethod, confirmPath] = relay.send.mock.calls[2]!;
        expect([confirmMethod, confirmPath]).toEqual(['POST', '/v3/enrollment/enrol/byAadhaar']);
    });

    it('verifies mobile updates through v3 auth/byAbdm', async () => {
        const relay = liveRelay({ '/v3/enrollment/auth/byAbdm': { abhaAddress: 'real@abdm', name: 'Real Patient' } });
        const svc = new AbdmAbhaService({ relay });
        expect(await svc.confirmEnrollmentOtp({ via: 'byAbdm', txnId: 'live-txn-2', otp: '482916' }))
            .toEqual({ abhaAddress: 'real@abdm', name: 'Real Patient', mock: false });
        expect(relay.send.mock.calls[0]!.slice(1, 3)).toEqual(['POST', '/v3/enrollment/auth/byAbdm']);
    });

    it('suggests and registers ABHA addresses through strict v3 routes', async () => {
        const relay = liveRelay({
            '/v3/enrollment/enrol/suggestion': { abhaAddresses: ['real@abdm'] },
            '/v3/enrollment/enrol/abha-address': { success: true }
        });
        const svc = new AbdmAbhaService({ relay });
        expect(await svc.suggestAbhaAddresses()).toMatchObject({ suggestions: ['real@abdm'], mock: false });
        expect(relay.send.mock.calls[0]!.slice(1, 3)).toEqual(['GET', '/v3/enrollment/enrol/suggestion']);
        expect(await svc.setEnrolAbhaAddress('txn-1', 'real@abdm')).toEqual({ mock: false });
        expect(relay.send.mock.calls[1]!.slice(1, 3)).toEqual(['POST', '/v3/enrollment/enrol/abha-address']);
    });

    it('reads profile, QR, search and secondary-user routes through strict v3', async () => {
        const relay = liveRelay({
            '/v3/profile/account': { abhaAddress: 'real@abdm' },
            '/v3/profile/account/qrCode': { qrCode: 'qr-payload' }
        });
        const svc = new AbdmAbhaService({ relay });
        expect((await svc.getProfile()).profile).toMatchObject({ abhaAddress: 'real@abdm' });
        expect((await svc.getQrCode()).qrCode).toBe('qr-payload');
    });

    it('runs profile login with an encrypted login ID and OTP', async () => {
        const relay = liveRelay({
            '/v3/profile/login/request/otp': { txnId: 'live-txn-9' },
            '/v3/profile/login/verify': { ABHAProfile: { preferredAbhaAddress: 'real@abdm', firstName: 'Real', lastName: 'Patient' } }
        });
        const svc = new AbdmAbhaService({ relay });

        expect(await svc.requestLoginOtp('real@abdm')).toEqual({ txnId: 'live-txn-9', mock: false });
        const login = relay.send.mock.calls[1]![3] as any;
        expect(login).toMatchObject({ scope: ['abha-login'], loginHint: 'abha-number', otpSystem: 'abdm' });
        expect(decrypt(login.loginId)).toBe('real@abdm');

        const verified = await svc.verifyLoginOtp('live-txn-9', '482916');
        expect(verified).toEqual({ abhaAddress: 'real@abdm', name: 'Real Patient', mock: false });
        expect(decrypt((relay.send.mock.calls[2]![3] as any).authData.otp.otpValue)).toBe('482916');
    });

    it('reads a login answer that lists addresses instead of a preferred one', async () => {
        const svc = new AbdmAbhaService({ relay: liveRelay({ '/v3/profile/login/verify': { ABHAProfile: { phrAddress: ['first@abdm'], name: 'Asha' } } }) });
        expect(await svc.verifyLoginOtp('t', '482916')).toEqual({ abhaAddress: 'first@abdm', name: 'Asha', mock: false });

        const empty = new AbdmAbhaService({ relay: liveRelay({ '/v3/profile/login/verify': {} }) });
        await expect(empty.verifyLoginOtp('t', '482916')).rejects.toThrow('could not verify');
        await expect(new AbdmAbhaService({ relay: liveRelay({ '/v3/profile/login/request/otp': {} }) }).requestLoginOtp('a@abdm'))
            .rejects.toThrow('did not return a transaction');
    });

    it('looks up an address and fetches the card through the relay', async () => {
        const relay = liveRelay({
            '/v3/profile/account/verify': { exists: false },
            '/v3/profile/account/abha-card': { name: 'Real', gender: 'M', dob: '1990-01-01', image: 'AAAA', mimeType: 'image/png' }
        });
        const svc = new AbdmAbhaService({ relay });

        expect(await svc.lookupAddress('real@abdm')).toEqual({ exists: false, name: '', mock: false });
        expect(relay.send).toHaveBeenLastCalledWith('abha', 'POST', '/v3/profile/account/verify', { abhaAddress: 'real@abdm' });

        expect(await svc.getCard('real@abdm')).toEqual({
            abhaAddress: 'real@abdm', name: 'Real', gender: 'M', dateOfBirth: '1990-01-01', imageBase64: 'AAAA', mimeType: 'image/png', mock: false
        });
        expect(relay.send).toHaveBeenLastCalledWith('abha', 'GET', '/v3/profile/account/abha-card', undefined);
    });

    it('fetches the certificate once a day, and again after invalidation', async () => {
        let now = 1_000;
        const relay = liveRelay({ '/v3/enrollment/request/otp': { txnId: 't' } });
        const svc = new AbdmAbhaService({ relay, nowMs: () => now });
        const certCalls = () => relay.send.mock.calls.filter((call) => call[2] === '/v3/profile/public/certificate').length;

        await svc.requestEnrollmentOtp({ via: 'mobile', identifier: '9876543210' });
        await svc.requestEnrollmentOtp({ via: 'mobile', identifier: '9876543210' });
        expect(certCalls()).toBe(1);

        svc.invalidateCert();
        await svc.requestEnrollmentOtp({ via: 'mobile', identifier: '9876543210' });
        expect(certCalls()).toBe(2);

        now += 25 * 60 * 60 * 1000;
        await svc.requestEnrollmentOtp({ via: 'mobile', identifier: '9876543210' });
        expect(certCalls()).toBe(3);
    });

    it('fails plainly when the certificate is unusable', async () => {
        const svc = new AbdmAbhaService({ relay: liveRelay({}, { publicKey: 'nope' }) });
        await expect(svc.requestEnrollmentOtp({ via: 'mobile', identifier: '9876543210' })).rejects.toThrow('usable public key');
    });

    it('decides mock or relay once per operation, so pairing mid-flight never sends plaintext', async () => {
        const relay = liveRelay({ '/v3/enrollment/request/otp': { txnId: 't' } });
        relay.isMockMode.mockReturnValueOnce(true);
        const svc = new AbdmAbhaService({ relay });

        const started = await svc.requestEnrollmentOtp({ via: 'mobile', identifier: '9876543210' });

        expect(started.mock).toBe(true);
        expect(relay.send).not.toHaveBeenCalled();
        expect(relay.isMockMode).toHaveBeenCalledTimes(1);
    });

    it('passes relay errors through to the desk', async () => {
        const relay = { isMockMode: () => false, send: vi.fn(async () => { throw new Error('ABDM request rejected (HTTP 403 (path_not_allowed)).'); }) };
        const svc = new AbdmAbhaService({ relay });
        await expect(svc.lookupAddress('real@abdm')).rejects.toThrow('HTTP 403');
    });
});
