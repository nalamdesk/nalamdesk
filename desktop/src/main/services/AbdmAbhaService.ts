import { AbdmRelayService, type AbdmUpstream } from './AbdmRelayService';

export interface AbdmAbhaDeps {
    /** The relay connection; without one every call is served by the mock. */
    relay?: Pick<AbdmRelayService, 'isMockMode' | 'send'>;
    nowMs?: () => number;
}

export interface AbdmOtpRequest {
    via: 'aadhaar' | 'mobile';
    identifier: string;
}

export interface AbdmCard {
    abhaAddress: string;
    name: string;
    gender?: string;
    dateOfBirth?: string;
    imageBase64?: string;
    mimeType?: string;
    mock: boolean;
}

// Endpoint paths follow the ABDM sandbox layout referenced from the M1 plan.
// Reconfirm each path against the live gateway docs when real credentials land;
// the mock responder below mirrors these shapes either way.
const PATHS = {
    enrolByAadhaar: '/v3/enrollment/enrol/byAadhaar',
    enrolByMobile: '/v3/enrollment/enrol/byMobile',
    enrolVerify: '/v3/enrollment/enrol/verify',
    loginRequestOtp: '/v3/profile/login/request/otp',
    loginVerify: '/v3/profile/login/verify',
    verifyAbha: '/v3/profile/account/verify',
    abhaCard: '/v3/profile/account/abha-card',
    // ABHA public key for encrypting Aadhaar, mobile, login IDs and OTPs.
    authCert: '/v3/profile/public/certificate'
};

// Every ABHA call goes to the ABHA host through the relay.
const UPSTREAM: AbdmUpstream = 'abha';

type Snapshot = { mock: boolean };

// Gateway certificates rotate infrequently; refetch at most daily.
const CERT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const MOCK_OTP_HINT = 'Mock gateway: any 6-digit code is accepted.';

/**
 * ABHA enrollment, verification, and card fetch (main process).
 * Live calls go through the NalamDesk relay, which adds the ABDM token (#160);
 * until this computer is paired every call is served by the sandbox-shaped
 * mock responder, flagged on every result.
 */
export class AbdmAbhaService {
    private certCache: { pem: string; fetchedAt: number } | null = null;
    // Mock-mode login transactions, keyed so verification links back to the
    // address the code was requested for (the mock responder is stateless).
    private mockLoginTxns = new Map<string, string>();

    constructor(private readonly deps: AbdmAbhaDeps = {}) { }

    private nowMs(): number {
        return this.deps.nowMs ? this.deps.nowMs() : Date.now();
    }

    // Mock or relay is decided once per operation, so pairing changing
    // mid-flight can never send a mock-shaped (unencrypted) value to ABDM.
    private resolveSnapshot(): Snapshot {
        return { mock: this.deps.relay ? this.deps.relay.isMockMode() : true };
    }

    /** Drops the cached ABHA certificate (call when pairing changes). */
    invalidateCert(): void {
        this.certCache = null;
    }

    private async authorized(
        path: string,
        body: unknown,
        method: 'GET' | 'POST' = 'POST',
        snapshot: Snapshot = this.resolveSnapshot()
    ): Promise<{ json: any; mock: boolean }> {
        if (snapshot.mock || !this.deps.relay) {
            return { json: this.mockRespond(path, body), mock: true };
        }
        const json = await this.deps.relay.send(UPSTREAM, method, path, method === 'GET' ? undefined : body || {});
        return { json, mock: false };
    }

    // Fetches (and caches) the ABHA public key used to encrypt enrollment
    // identifiers on live calls. Mock sessions never reach this path.
    private async getGatewayPublicKey(snapshot: Snapshot): Promise<string> {
        const cached = this.certCache;
        if (cached && this.nowMs() - cached.fetchedAt < CERT_CACHE_TTL_MS) {
            return cached.pem;
        }
        const { json } = await this.authorized(PATHS.authCert, null, 'GET', snapshot);
        const pem = String(json?.publicKey || json?.public_key || json?.cert || '').trim();
        if (!pem.includes('BEGIN PUBLIC KEY')) {
            throw new Error('ABDM gateway did not return a usable public key.');
        }
        this.certCache = { pem, fetchedAt: this.nowMs() };
        return pem;
    }

    /** Starts enrollment: sends an OTP for an Aadhaar number or mobile number. */
    async requestEnrollmentOtp(request: AbdmOtpRequest): Promise<{ txnId: string; mock: boolean; hint?: string }> {
        const via = request?.via === 'mobile' ? 'mobile' : 'aadhaar';
        const identifier = String(request?.identifier || '').replace(/\D/g, '');
        if (via === 'aadhaar' && identifier.length !== 12) {
            throw new Error('Aadhaar number must be 12 digits.');
        }
        if (via === 'mobile' && (identifier.length < 10 || identifier.length > 15)) {
            throw new Error('Mobile number must be 10 to 15 digits.');
        }
        const path = via === 'mobile' ? PATHS.enrolByMobile : PATHS.enrolByAadhaar;
        // Live identifiers travel RSA-encrypted; mock traffic stays plaintext.
        // The session is resolved once so the decision and the request agree.
        const field = via === 'mobile' ? 'mobile' : 'aadhaar';
        const snapshot = this.resolveSnapshot();
        const value = snapshot.mock
            ? identifier
            : AbdmRelayService.encryptWithPublicKey(identifier, await this.getGatewayPublicKey(snapshot));
        const { json, mock } = await this.authorized(path, { [field]: value }, 'POST', snapshot);
        const txnId = String(json?.txnId || json?.txn_id || '');
        if (!txnId) throw new Error('ABDM enrollment did not return a transaction.');
        return mock ? { txnId, mock, hint: MOCK_OTP_HINT } : { txnId, mock };
    }

    /** Verifies the enrollment OTP; returns the created health ID and name. */
    async confirmEnrollmentOtp(txnId: string, otp: string): Promise<{ abhaAddress: string; name: string; mock: boolean }> {
        if (!String(txnId || '').trim()) throw new Error('Enrollment transaction is missing. Request a new code.');
        const code = String(otp || '').replace(/\D/g, '');
        if (code.length !== 6) throw new Error('The 6-digit code is required.');
        const { json, mock } = await this.authorized(PATHS.enrolVerify, { txnId, otp: code });
        const abhaAddress = String(json?.abhaAddress || json?.abha_address || '').trim();
        if (!abhaAddress) throw new Error('ABDM could not create the health ID. Please retry.');
        return { abhaAddress, name: String(json?.name || '').trim(), mock };
    }

    /** Starts profile login: sends an OTP for an existing health ID address. */
    async requestLoginOtp(abhaAddress: string): Promise<{ txnId: string; mock: boolean; hint?: string }> {
        const address = String(abhaAddress || '').trim();
        if (!address) throw new Error('Health ID is required.');
        // Documented v3 envelope (scope/loginHint/loginId/otpSystem). The
        // address-as-loginId mapping must be reconfirmed against the sandbox
        // at credential time; only mock traffic is exercised here.
        const snapshot = this.resolveSnapshot();
        const loginId = snapshot.mock
            ? address
            : AbdmRelayService.encryptWithPublicKey(address, await this.getGatewayPublicKey(snapshot));
        const { json, mock } = await this.authorized(PATHS.loginRequestOtp, {
            scope: ['abha-login'],
            loginHint: 'abha-number',
            loginId,
            otpSystem: 'abdm'
        }, 'POST', snapshot);
        const txnId = String(json?.txnId || json?.txn_id || '');
        if (!txnId) throw new Error('ABDM login did not return a transaction.');
        if (mock) this.mockLoginTxns.set(txnId, address);
        return mock ? { txnId, mock, hint: MOCK_OTP_HINT } : { txnId, mock };
    }

    /** Verifies the login OTP; returns the health ID and holder name. */
    async verifyLoginOtp(txnId: string, otp: string): Promise<{ abhaAddress: string; name: string; mock: boolean }> {
        if (!String(txnId || '').trim()) throw new Error('Login transaction is missing. Request a new code.');
        const code = String(otp || '').replace(/\D/g, '');
        if (code.length !== 6) throw new Error('The 6-digit code is required.');
        const snapshot = this.resolveSnapshot();
        // ABDM requires RSA-encrypted OTPs on live calls; mock stays plaintext.
        const otpValue = snapshot.mock
            ? code
            : AbdmRelayService.encryptWithPublicKey(code, await this.getGatewayPublicKey(snapshot));
        const { json, mock } = await this.authorized(PATHS.loginVerify, {
            txnId,
            scope: ['abha-login'],
            authData: { authMethods: ['otp'], otp: { txnId, otpValue } }
        }, 'POST', snapshot);
        if (mock) {
            const address = this.mockLoginTxns.get(txnId)
                || String(json?.ABHAProfile?.preferredAbhaAddress
                    || json?.ABHAProfile?.phrAddress?.[0] || '').trim();
            if (!address) throw new Error('ABDM could not verify the health ID. Please retry.');
            return { abhaAddress: address, name: 'Demo Patient', mock };
        }
        const profile = json?.ABHAProfile || {};
        const abhaAddress = String(
            profile.preferredAbhaAddress
            || (Array.isArray(profile.phrAddress) ? profile.phrAddress[0] : '')
            || json?.abhaAddress || json?.abha_address || ''
        ).trim();
        if (!abhaAddress) throw new Error('ABDM could not verify the health ID. Please retry.');
        const name = String(
            profile.name
            || [profile.firstName, profile.lastName].filter(Boolean).join(' ')
            || json?.name || ''
        ).trim();
        return { abhaAddress, name, mock };
    }

    /** Checks whether a health ID exists and returns the holder name. */
    async lookupAddress(abhaAddress: string): Promise<{ exists: boolean; name: string; mock: boolean }> {
        const address = String(abhaAddress || '').trim();
        if (!address) throw new Error('Health ID is required.');
        const { json, mock } = await this.authorized(PATHS.verifyAbha, { abhaAddress: address });
        if (json && (json.exists === false || json.found === false)) {
            return { exists: false, name: '', mock };
        }
        return { exists: true, name: String(json?.name || '').trim(), mock };
    }

    /** Fetches the printable health ID card for a verified address. */
    async getCard(abhaAddress: string): Promise<AbdmCard> {
        const address = String(abhaAddress || '').trim();
        if (!address) throw new Error('Health ID is required.');
        const { json, mock } = await this.authorized(PATHS.abhaCard, { abhaAddress: address }, 'GET');
        return {
            abhaAddress: address,
            name: String(json?.name || '').trim(),
            gender: String(json?.gender || '').trim() || undefined,
            dateOfBirth: String(json?.dateOfBirth || json?.dob || '').trim() || undefined,
            imageBase64: json?.imageBase64 || json?.image || undefined,
            mimeType: json?.mimeType || undefined,
            mock
        };
    }

    // Sandbox-shaped fake backend. Accepts any 6-digit OTP; invents stable
    // demo values derived from the transaction so repeated calls agree.
    private mockRespond(path: string, body: any): any {
        const now = this.nowMs();
        if (path === PATHS.enrolByAadhaar || path === PATHS.enrolByMobile) {
            return { txnId: `mock-txn-${now}` };
        }
        if (path === PATHS.enrolVerify) {
            const tail = String(body?.txnId || now).slice(-4);
            return { abhaAddress: `demo.patient${tail}@sbx`, name: 'Demo Patient' };
        }
        if (path === PATHS.loginRequestOtp) {
            return { txnId: `mock-login-${now}` };
        }
        if (path === PATHS.loginVerify) {
            return { ABHAProfile: { preferredAbhaAddress: 'demo.patient@sbx', name: 'Demo Patient' } };
        }
        if (path === PATHS.verifyAbha) {
            const address = String(body?.abhaAddress || '');
            if (!address || address.startsWith('unknown')) return { exists: false };
            return { exists: true, name: 'Demo Patient' };
        }
        if (path === PATHS.abhaCard) {
            return { name: 'Demo Patient', gender: 'Female', dateOfBirth: '1990-05-14' };
        }
        return {};
    }
}
