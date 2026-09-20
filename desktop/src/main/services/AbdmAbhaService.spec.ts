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
});
