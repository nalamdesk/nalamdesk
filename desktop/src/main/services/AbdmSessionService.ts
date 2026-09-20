import * as crypto from 'node:crypto';
import type { DeviceKeyStore } from './DeviceKeyStore';

export type AbdmGatewayEnv = 'sandbox' | 'staging';

export const ABDM_GATEWAY_BASE_URLS: Record<AbdmGatewayEnv, string> = {
    sandbox: 'https://dev.abdm.gov.in/gateway',
    staging: 'https://staging.abdm.gov.in/gateway'
};

// All ABDM traffic stays local-first: without credentials the service runs
// against an in-process mock shaped like the sandbox, clearly labeled.
export const ABDM_MOCK_TOKEN_TTL_MS = 20 * 60 * 1000;
const PROACTIVE_REFRESH_MS = 2 * 60 * 1000;

export interface AbdmSessionDeps {
    getSettings?: () => any;
    getSecretProtected?: () => string | null;
    saveSettingsPatch?: (patch: Record<string, unknown>) => void;
    saveSecretProtected?: (protectedValue: string) => void;
    keyStore?: DeviceKeyStore;
    fetchFn?: (url: string, init?: any) => Promise<any>;
    nowMs?: () => number;
}

interface CachedSession {
    token: string;
    expiresAt: number;
    mock: boolean;
}

/**
 * ABDM Gateway v3 session management (main process).
 *
 * - Authenticates with client_credentials, caches the JWT, and refreshes it
 *   proactively before expiry. Concurrent callers share one in-flight request.
 * - The Client Secret lives in the OS keychain via DeviceKeyStore; only the
 *   protected blob is persisted, through the dedicated secret writer.
 * - RSA-OAEP helper encrypts Aadhaar/mobile OTP payloads with ABDM public keys.
 */
export class AbdmSessionService {
    private cached: CachedSession | null = null;
    private inflight: Promise<CachedSession> | null = null;

    constructor(private readonly deps: AbdmSessionDeps = {}) { }

    private get settings(): any {
        try {
            return this.deps.getSettings?.() || {};
        } catch {
            return {};
        }
    }

    private nowMs(): number {
        return this.deps.nowMs ? this.deps.nowMs() : Date.now();
    }

    gatewayEnv(): AbdmGatewayEnv {
        return this.settings.abdm_gateway_env === 'staging' ? 'staging' : 'sandbox';
    }

    gatewayBaseUrl(): string {
        return ABDM_GATEWAY_BASE_URLS[this.gatewayEnv()];
    }

    isMockMode(): boolean {
        const settings = this.settings;
        if (settings.abdm_mock === 0 || settings.abdm_mock === false) return false;
        if (settings.abdm_mock === 1 || settings.abdm_mock === true) return true;
        // Default to mock until real credentials are configured.
        return !(settings.abdm_client_id && this.hasStoredSecret());
    }

    hasStoredSecret(): boolean {
        try {
            if (this.deps.getSecretProtected) return !!this.deps.getSecretProtected();
        } catch {
            return false;
        }
        return !!this.settings.abdm_client_secret_protected;
    }

    hasClientId(): boolean {
        return !!String(this.settings.abdm_client_id || '').trim();
    }

    /** Stores the Client Secret in the OS keychain; persists only the protected blob. */
    async saveClientSecret(secret: string): Promise<{ stored: boolean; mock: boolean }> {
        const value = String(secret || '');
        if (!value) throw new Error('Client secret is required.');
        const keyStore = this.deps.keyStore;
        if (!keyStore) throw new Error('Secret storage is not available on this device.');
        const status = keyStore.status();
        if (!status.available) {
            throw new Error(`${status.reason || 'ENCRYPTION_UNAVAILABLE'}: ${status.message || 'OS-backed encryption is not available.'}`);
        }
        const protectedValue = keyStore.protect(Buffer.from(value, 'utf8')).toString('base64');
        this.deps.saveSecretProtected?.(protectedValue);
        this.invalidate();
        return { stored: true, mock: this.isMockMode() };
    }

    private readClientSecret(): string {
        // No fallback to generic settings: the blob must only arrive through
        // the dedicated accessor, never a settings read.
        const protectedValue = this.deps.getSecretProtected ? this.deps.getSecretProtected() : null;
        if (!protectedValue) throw new Error('ABDM client secret is not configured.');
        const keyStore = this.deps.keyStore;
        if (!keyStore) throw new Error('Secret storage is not available on this device.');
        const status = keyStore.status();
        if (!status.available) {
            throw new Error(`${status.reason || 'ENCRYPTION_UNAVAILABLE'}: ${status.message || 'OS-backed encryption is not available.'}`);
        }
        return keyStore.unprotect(Buffer.from(String(protectedValue), 'base64')).toString('utf8');
    }

    /** Returns a valid session token, refreshing proactively before expiry. */
    async getSessionToken(): Promise<{ token: string; mock: boolean }> {
        const cached = this.cached;
        if (cached && this.nowMs() < cached.expiresAt - PROACTIVE_REFRESH_MS) {
            return { token: cached.token, mock: cached.mock };
        }
        if (!this.inflight) {
            this.inflight = this.openSession().finally(() => {
                this.inflight = null;
            });
        }
        const session = await this.inflight;
        return { token: session.token, mock: session.mock };
    }

    invalidate(): void {
        this.cached = null;
    }

    /** Lightweight connectivity probe used by the Settings test button. */
    async testConnectivity(): Promise<{ ok: boolean; mode: 'mock' | 'live'; detail: string; latencyMs?: number }> {
        if (this.isMockMode()) {
            return { ok: true, mode: 'mock', detail: 'Mock gateway active: no ABDM credentials configured yet.' };
        }
        const started = this.nowMs();
        try {
            this.invalidate();
            await this.getSessionToken();
            return {
                ok: true,
                mode: 'live',
                detail: `Gateway session established (${this.gatewayEnv()}).`,
                latencyMs: this.nowMs() - started
            };
        } catch (error) {
            return {
                ok: false,
                mode: 'live',
                detail: error instanceof Error ? error.message : 'Gateway session failed.'
            };
        }
    }

    /** RSA-OAEP (SHA-1 MGF1) encryption for Aadhaar/mobile OTP payloads. */
    static encryptWithPublicKey(payload: string, publicKeyPem: string): string {
        return crypto.publicEncrypt(
            {
                key: publicKeyPem,
                padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
                oaepHash: 'sha1'
            },
            Buffer.from(String(payload), 'utf8')
        ).toString('base64');
    }

    private async openSession(): Promise<CachedSession> {
        if (this.isMockMode()) {
            const session: CachedSession = {
                token: `mock-abdm-token-${this.nowMs()}`,
                expiresAt: this.nowMs() + ABDM_MOCK_TOKEN_TTL_MS,
                mock: true
            };
            this.cached = session;
            return session;
        }
        const clientId = String(this.settings.abdm_client_id || '').trim();
        if (!clientId) throw new Error('ABDM Client ID is not configured.');
        const clientSecret = this.readClientSecret();
        const fetchFn = this.deps.fetchFn || fetch;
        const url = `${this.gatewayBaseUrl()}/api/hiecm/gateway/v3/sessions`;
        let response: any;
        try {
            response = await fetchFn(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ clientId, clientSecret })
            });
        } catch (error) {
            throw new Error(`ABDM gateway is unreachable: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (!response || !response.ok) {
            throw new Error(`ABDM session rejected (HTTP ${response?.status || 'unknown'}). Check the Client ID and secret.`);
        }
        const body = await response.json();
        const token = body?.accessToken || body?.access_token;
        if (!token) throw new Error('ABDM session response did not include an access token.');
        const ttlMs = Number(body?.expiresIn || body?.expires_in) > 0
            ? Number(body.expiresIn || body.expires_in) * 1000
            : ABDM_MOCK_TOKEN_TTL_MS;
        const session: CachedSession = { token: String(token), expiresAt: this.nowMs() + ttlMs, mock: false };
        this.cached = session;
        return session;
    }
}
