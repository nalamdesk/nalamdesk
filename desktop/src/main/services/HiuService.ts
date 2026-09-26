import * as crypto from 'node:crypto';
import type { DeviceKeyStore } from './DeviceKeyStore';
import { FideliusService, type FideliusEnvelope } from './FideliusService';

export interface HiuDeps {
    getSettings?: () => any;
    getHiuPrivateProtected?: () => string | null;
    saveHiuPrivateProtected?: (value: string) => unknown;
    saveSettingsPatch?: (patch: Record<string, unknown>) => unknown;
    keyStore?: DeviceKeyStore;
    nowMs?: () => number;
    /** Consent-record store (DatabaseService subset); required for consent flows. */
    store?: {
        createConsentRequest: (input: any, actingUserId?: number) => any;
        getConsentById: (id: number) => any;
        getConsentByRequestId: (gatewayRequestId: string) => any;
        updateConsentStatus: (id: number, status: string, handle?: string | null, actingUserId?: number) => any;
        storeFetchedRecord: (input: any, actingUserId?: number) => any;
    };
    /** Gateway session snapshot for live calls. */
    session?: {
        getSessionToken: () => Promise<{ token: string; mock: boolean }>;
        gatewayBaseUrl: () => string;
    };
}

export interface HiuConsentRequest {
    patientId?: number | null;
    abhaAddress: string;
    hiTypes: string[];
    dateFrom?: string | null;
    dateTo?: string | null;
}

// Mock-mode retention for fetched records (matches the issue's 30-day rule).
const MOCK_RETENTION_DAYS = 30;

/**
 * HIU (Health Information User) identity: the clinic's own X25519 keypair
 * used to receive encrypted health records under patient consent (M3).
 *
 * The private half is generated once, wrapped by the OS keychain, and stored
 * as an opaque blob — the same contract as the ABDM client secret: it never
 * appears in generic settings reads, IPC getters, or LAN responses. Only
 * the public half (raw 32-byte base64) is shareable.
 */
export class HiuService {
    /** SQL-datetime expiry 30 days out (the issue's retention rule). */
    static retentionExpiry(nowMs = Date.now()): string {
        return new Date(nowMs + MOCK_RETENTION_DAYS * 24 * 60 * 60 * 1000)
            .toISOString().slice(0, 19).replace('T', ' ');
    }

    constructor(private readonly deps: HiuDeps = {}) { }

    private nowMs(): number {
        return this.deps.nowMs ? this.deps.nowMs() : Date.now();
    }

    /** Shareable HIU public key (raw base64), or null before first use. */
    getPublicKey(): string | null {
        try {
            return this.deps.getSettings?.()?.abdm_hiu_public_key || null;
        } catch {
            return null;
        }
    }

    /**
     * Generates the HIU keypair on first use; later calls return the stored
     * public key without touching private material. Throws
     * ENCRYPTION_UNAVAILABLE when device crypto cannot wrap the key.
     */
    ensureKeypair(): { publicKey: string } {
        const existing = this.getPublicKey();
        if (existing && this.deps.getHiuPrivateProtected?.()) return { publicKey: existing };
        const store = this.deps.keyStore;
        if (!store) throw new Error('ENCRYPTION_UNAVAILABLE');
        const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519', {
            publicKeyEncoding: { type: 'spki', format: 'pem' },
            privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
        });
        const publicRaw = crypto.createPublicKey(publicKey)
            .export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
        let wrapped: Buffer;
        try {
            wrapped = store.protect(Buffer.from(privateKey, 'utf8'));
        } catch (error) {
            throw new Error(`ENCRYPTION_UNAVAILABLE: ${error instanceof Error ? error.message : String(error)}`);
        }
        this.deps.saveHiuPrivateProtected?.(wrapped.toString('base64'));
        this.deps.saveSettingsPatch?.({ abdm_hiu_public_key: publicRaw });
        return { publicKey: publicRaw };
    }

    /** Test seam for the inbound decrypt path PR2 builds on. */
    decryptForTest(envelope: FideliusEnvelope): unknown {
        return this.decryptRecord(envelope);
    }

    /** Decrypts one inbound record envelope with the HIU private key. */
    decryptRecord(envelope: FideliusEnvelope): unknown {
        if (!envelope || typeof envelope !== 'object') throw new Error('A record envelope is required.');
        for (const field of ['ephemeralPublicKey', 'nonce', 'ciphertext', 'tag'] as const) {
            if (!String((envelope as any)[field] || '').trim()) {
                throw new Error(`Record envelope is missing ${field}.`);
            }
        }
        return new FideliusService().decryptEnvelope(envelope, this.readPrivatePem());
    }

    /**
     * Requests outside records for a health ID. Mock mode records the request
     * locally and returns a mock gateway id end-to-end; live gateway
     * certification has not happened, so live calls refuse explicitly
     * rather than posting a guessed consent shape.
     */
    async requestConsent(input: HiuConsentRequest, actingUserId?: number): Promise<any> {
        const store = this.deps.store;
        if (!store) throw new Error('Consent store is not configured.');
        const session = this.deps.session;
        const snapshot = session
            ? await session.getSessionToken()
            : { token: `mock-hiu-token-${this.nowMs()}`, mock: true };
        if (!snapshot.mock) {
            throw new Error('Live HIU consent is not certified in this build; use the mock gateway.');
        }
        return store.createConsentRequest({
            patientId: input?.patientId ?? null,
            abhaAddress: input?.abhaAddress,
            hiTypes: input?.hiTypes,
            dateFrom: input?.dateFrom ?? null,
            dateTo: input?.dateTo ?? null,
            gatewayRequestId: `mock-consent-${this.nowMs()}`
        }, actingUserId);
    }

    /**
     * Applies a consent notification to the matching request. Bookkeeping
     * only — fetched clinical data is never auto-applied to the chart.
     */
    handleNotify(kind: string, payload: any, actingUserId?: number): { handled: boolean; consentId?: number } {
        const store = this.deps.store;
        if (!store) throw new Error('Consent store is not configured.');
        const cleanKind = String(kind || '').trim();
        const statusByKind: Record<string, string> = {
            'consent-granted': 'granted',
            'consent-denied': 'denied',
            'consent-expired': 'expired'
        };
        const next = statusByKind[cleanKind];
        if (!next) throw new Error(`Unsupported consent notification: ${cleanKind || '(empty)'}`);
        const requestId = String(payload?.requestId || payload?.gatewayRequestId || '').trim();
        if (!requestId) throw new Error('Consent notification carries no request id.');
        const existing = store.getConsentByRequestId(requestId);
        if (!existing) throw new Error('Consent request not found for this notification.');
        const updated = store.updateConsentStatus(
            Number(existing.id), next, payload?.consentHandle ?? payload?.consentId ?? null, actingUserId);
        return { handled: true, consentId: Number(updated?.id ?? existing.id) };
    }

    /**
     * Fetches outside records for a granted consent into the encrypted cache.
     * Mock mode synthesizes a bundle through the real encrypt→decrypt path;
     * live fetch refuses explicitly until gateway certification lands.
     */
    async fetchForConsent(consentId: number, actingUserId?: number): Promise<any> {
        const store = this.deps.store;
        if (!store) throw new Error('Consent store is not configured.');
        const session = this.deps.session;
        const snapshot = session
            ? await session.getSessionToken()
            : { token: `mock-hiu-token-${this.nowMs()}`, mock: true };
        if (!snapshot.mock) {
            throw new Error('Live HIU fetch is not certified in this build; use the mock gateway.');
        }
        const consent = store.getConsentById(Number(consentId));
        if (!consent) throw new Error('Consent request not found.');
        if (consent.status && consent.status !== 'granted') {
            throw new Error('Records can only be fetched for a granted consent.');
        }
        const { publicKey } = this.ensureKeypair();
        const bundle = this.buildMockClinicalBundle(consent);
        const envelope = new FideliusService().encryptBundle(bundle, publicKey);
        const decrypted = this.decryptRecord(envelope);
        return store.storeFetchedRecord({
            consentId: Number(consent.id),
            patientId: consent.patient_id ?? null,
            careContextRef: null,
            bundleJson: JSON.stringify(decrypted),
            expiresAt: HiuService.retentionExpiry(this.nowMs())
        }, actingUserId);
    }

    /** Minimal mock clinical document; PR3 parses this shape back. */
    private buildMockClinicalBundle(consent: any): unknown {
        const stamp = new Date(this.nowMs()).toISOString();
        return {
            resourceType: 'Bundle',
            type: 'document',
            timestamp: stamp,
            entry: [
                {
                    resource: {
                        resourceType: 'Composition',
                        title: `Outside record for ${consent?.abha_address || 'health ID'}`,
                        date: stamp
                    }
                },
                {
                    resource: {
                        resourceType: 'Condition',
                        code: { text: 'Essential hypertension' },
                        clinicalStatus: 'active'
                    }
                },
                {
                    resource: {
                        resourceType: 'MedicationRequest',
                        medicationCodeableConcept: { text: 'Amlodipine 5mg' },
                        status: 'active'
                    }
                }
            ]
        };
    }

    private readPrivatePem(): string {
        const store = this.deps.keyStore;
        const wrapped: string | null | undefined = this.deps.getHiuPrivateProtected?.();
        if (!store || !wrapped) throw new Error('ENCRYPTION_UNAVAILABLE');
        return store.unprotect(Buffer.from(wrapped, 'base64')).toString('utf8');
    }
}
