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
    verifyAbha: '/v3/profile/account/verify',
    abhaCard: '/v3/profile/account/abha-card'
};

const MOCK_OTP_HINT = 'Mock gateway: any 6-digit code is accepted.';

/**
 * ABHA enrollment, verification, and card fetch (main process).
 * Authenticates through AbdmSessionService; without credentials every call is
 * served by the sandbox-shaped mock responder, flagged on every result.
 */
export class AbdmAbhaService {
    constructor(private readonly deps: AbdmAbhaDeps = {}) { }

    private nowMs(): number {
        return this.deps.nowMs ? this.deps.nowMs() : Date.now();
    }

    private async authorized(path: string, body: unknown): Promise<{ json: any; mock: boolean }> {
        const getSession = this.deps.getSessionToken;
        const session = getSession
            ? await getSession()
            : { token: `mock-abdm-token-${this.nowMs()}`, mock: true };
        if (session.mock) {
            return { json: this.mockRespond(path, body), mock: true };
        }
        const base = this.deps.gatewayBaseUrl ? this.deps.gatewayBaseUrl() : '';
        const fetchFn = this.deps.fetchFn || fetch;
        let response: any;
        try {
            response = await fetchFn(`${base}${path}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` },
                body: JSON.stringify(body || {})
            });
        } catch (error) {
            throw new Error(`ABDM gateway is unreachable: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (!response || !response.ok) {
            throw new Error(`ABDM request rejected (HTTP ${response?.status || 'unknown'}).`);
        }
        return { json: await response.json(), mock: false };
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
        const { json, mock } = await this.authorized(path, { [via === 'mobile' ? 'mobile' : 'aadhaar']: identifier });
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
