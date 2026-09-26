import { AbdmSessionService } from './AbdmSessionService';

export interface AbdmAbhaDeps {
    getSessionToken?: () => Promise<{ token: string; mock: boolean }>;
    gatewayBaseUrl?: () => string;
    fetchFn?: (url: string, init?: any) => Promise<any>;
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
    // Gateway public key for encrypting enrollment identifiers (HIE-CM cert
    // endpoint per public ABDM docs; reconfirm at live integration).
    authCert: '/v3/auth/cert'
};

// Gateway certificates rotate infrequently; refetch at most daily.
const CERT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const MOCK_OTP_HINT = 'Mock gateway: any 6-digit code is accepted.';

/**
 * ABHA enrollment, verification, and card fetch (main process).
 * Authenticates through AbdmSessionService; without credentials every call is
 * served by the sandbox-shaped mock responder, flagged on every result.
 */
export class AbdmAbhaService {
    private certCache: { pem: string; baseUrl: string; fetchedAt: number } | null = null;

    constructor(private readonly deps: AbdmAbhaDeps = {}) { }

    private nowMs(): number {
        return this.deps.nowMs ? this.deps.nowMs() : Date.now();
    }

    // One operation snapshot per call: token, mock flag, and gateway URL are
    // resolved together so a configuration flip mid-flight can never mix one
    // environment's credentials with another's endpoint. The URL is captured
    // synchronously before any await, so even a flip during session
    // resolution cannot split the snapshot.
    private async resolveSnapshot(): Promise<{ token: string; mock: boolean; baseUrl: string }> {
        const baseUrl = this.deps.gatewayBaseUrl ? this.deps.gatewayBaseUrl() : '';
        const getSession = this.deps.getSessionToken;
        const session = getSession
            ? await getSession()
            : { token: `mock-abdm-token-${this.nowMs()}`, mock: true };
        return { ...session, baseUrl };
    }

    /** Drops the cached gateway certificate (call when gateway config changes). */
    invalidateCert(): void {
        this.certCache = null;
    }

    private async authorized(
        path: string,
        body: unknown,
        method = 'POST',
        snapshot?: { token: string; mock: boolean; baseUrl: string }
    ): Promise<{ json: any; mock: boolean }> {
        const active = snapshot ?? await this.resolveSnapshot();
        if (active.mock) {
            return { json: this.mockRespond(path, body), mock: true };
        }
        const fetchFn = this.deps.fetchFn || fetch;
        let response: any;
        try {
            response = await fetchFn(`${active.baseUrl}${path}`, {
                method,
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${active.token}` },
                body: method === 'GET' ? undefined : JSON.stringify(body || {})
            });
        } catch (error) {
            throw new Error(`ABDM gateway is unreachable: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (!response || !response.ok) {
            throw new Error(`ABDM request rejected (HTTP ${response?.status || 'unknown'}).`);
        }
        return { json: await response.json(), mock: false };
    }

    // Fetches (and caches) the gateway public key used to encrypt enrollment
    // identifiers on live calls. The cache is keyed by gateway base URL so an
    // environment switch never reuses the previous environment's key. Mock
    // sessions never reach this path.
    private async getGatewayPublicKey(
        snapshot: { token: string; mock: boolean; baseUrl: string }
    ): Promise<string> {
        const cached = this.certCache;
        if (cached && cached.baseUrl === snapshot.baseUrl && this.nowMs() - cached.fetchedAt < CERT_CACHE_TTL_MS) {
            return cached.pem;
        }
        const { json } = await this.authorized(PATHS.authCert, null, 'GET', snapshot);
        const pem = String(json?.publicKey || json?.public_key || json?.cert || '').trim();
        if (!pem.includes('BEGIN PUBLIC KEY')) {
            throw new Error('ABDM gateway did not return a usable public key.');
        }
        this.certCache = { pem, baseUrl: snapshot.baseUrl, fetchedAt: this.nowMs() };
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
        const snapshot = await this.resolveSnapshot();
        const value = snapshot.mock
            ? identifier
            : AbdmSessionService.encryptWithPublicKey(identifier, await this.getGatewayPublicKey(snapshot));
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
        const { json, mock } = await this.authorized(PATHS.loginRequestOtp, { abhaAddress: address });
        const txnId = String(json?.txnId || json?.txn_id || '');
        if (!txnId) throw new Error('ABDM login did not return a transaction.');
        return mock ? { txnId, mock, hint: MOCK_OTP_HINT } : { txnId, mock };
    }

    /** Verifies the login OTP; returns the health ID and holder name. */
    async verifyLoginOtp(txnId: string, otp: string): Promise<{ abhaAddress: string; name: string; mock: boolean }> {
        if (!String(txnId || '').trim()) throw new Error('Login transaction is missing. Request a new code.');
        const code = String(otp || '').replace(/\D/g, '');
        if (code.length !== 6) throw new Error('The 6-digit code is required.');
        const { json, mock } = await this.authorized(PATHS.loginVerify, { txnId, otp: code });
        const abhaAddress = String(json?.abhaAddress || json?.abha_address || '').trim();
        if (!abhaAddress) throw new Error('ABDM could not verify the health ID. Please retry.');
        return { abhaAddress, name: String(json?.name || '').trim(), mock };
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
        const { json, mock } = await this.authorized(PATHS.abhaCard, { abhaAddress: address });
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
            return { abhaAddress: 'demo.patient@sbx', name: 'Demo Patient' };
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
