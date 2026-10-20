import * as crypto from 'node:crypto';
import type { DeviceKeyStore } from './DeviceKeyStore';
import {
    FideliusService,
    toFideliusPublicKey,
    type FideliusEnvelope,
    type FideliusKeyMaterial
} from './FideliusService';

export interface HiuDeps {
    getSettings?: () => any;
    getHiuPrivateProtected?: () => string | null;
    saveHiuPrivateProtected?: (value: string) => unknown;
    saveSettingsPatch?: (patch: Record<string, unknown>) => unknown;
    /** Atomic two-half write; preferred over the single-column writers. */
    saveHiuKeypair?: (publicKey: string, protectedPrivate: string) => unknown;
    keyStore?: DeviceKeyStore;
    nowMs?: () => number;
    /** Consent-record store (DatabaseService subset); required for consent flows. */
    store?: {
        createConsentRequest: (input: any, actingUserId?: number) => any;
        getConsentById: (id: number) => any;
        getConsentByRequestId: (gatewayRequestId: string) => any;
        updateConsentStatus: (id: number, status: string, handle?: string | null, actingUserId?: number) => any;
        storeFetchedRecord: (input: any, actingUserId?: number) => any;
        getPendingInbox?: () => any[];
    };
    /** The relay connection (#160); without one the HIU runs against the mock gateway. */
    relay?: { isMockMode: () => boolean };
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

// Consent-notification kinds this service applies (mirrors
// DatabaseService.inboxConsentKinds; kept local to avoid a service cycle).
const HIU_NOTIFY_KINDS = [
    'consent-requested',
    'consent-granted',
    'consent-denied',
    'consent-expired',
    'data-ready'
] as const;

/**
 * HIU (Health Information User) identity: the clinic's own Curve25519
 * keypair used to receive encrypted health records under patient consent (M3).
 *
 * The private half is generated once, wrapped by the OS keychain, and stored
 * as an opaque blob: it never
 * appears in generic settings reads, IPC getters, or LAN responses. Only
 * the public half (Fidelius X.509 base64) is shareable.
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

    private isMock(): boolean {
        return this.deps.relay ? this.deps.relay.isMockMode() : true;
    }

    /** Shareable HIU public key (Fidelius X.509 base64), or null before first use. */
    getPublicKey(): string | null {
        try {
            return this.deps.getSettings?.()?.abdm_hiu_public_key || null;
        } catch {
            return null;
        }
    }

    /**
     * Generates the HIU keypair on first use; later calls verify the stored
     * halves still match (public key recomputed from the private one) and
     * return the public key.
     * A mismatch — edited public key, unrestorable private blob (e.g. after
     * a clean-machine restore), or torn write — regenerates a fresh pair
     * instead of advertising an undecryptable key. Throws
     * ENCRYPTION_UNAVAILABLE when device crypto cannot wrap the key.
     */
    ensureKeypair(): { publicKey: string } {
        const existing = this.getPublicKey();
        const protectedPrivate = this.deps.getHiuPrivateProtected?.() || null;
        const derived = existing && protectedPrivate ? this.derivePublicKey(protectedPrivate) : null;
        if (derived && derived.fidelius === existing) {
            return { publicKey: existing };
        }
        if (derived && derived.legacyRaw === existing) {
            // Keys made before Fidelius interop stored the raw X25519 public
            // half; same key, so re-encode it rather than rotating.
            this.saveKeypair(derived.fidelius, protectedPrivate as string);
            return { publicKey: derived.fidelius };
        }
        if ((existing || protectedPrivate) && !(existing && protectedPrivate)) {
            console.warn('[HIU] Incomplete stored keypair; generating a fresh one.');
        } else if (existing && protectedPrivate) {
            console.warn('[HIU] Stored keypair halves do not match; generating a fresh one.');
        }
        const store = this.deps.keyStore;
        if (!store) throw new Error('ENCRYPTION_UNAVAILABLE');
        const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519', {
            privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
        });
        const publicFidelius = toFideliusPublicKey(publicKey);
        let wrapped: Buffer;
        try {
            wrapped = store.protect(Buffer.from(privateKey, 'utf8'));
        } catch (error) {
            throw new Error(`ENCRYPTION_UNAVAILABLE: ${error instanceof Error ? error.message : String(error)}`);
        }
        this.saveKeypair(publicFidelius, wrapped.toString('base64'));
        return { publicKey: publicFidelius };
    }

    private saveKeypair(publicKey: string, protectedValue: string): void {
        if (this.deps.saveHiuKeypair) {
            this.deps.saveHiuKeypair(publicKey, protectedValue);
        } else {
            this.deps.saveHiuPrivateProtected?.(protectedValue);
            this.deps.saveSettingsPatch?.({ abdm_hiu_public_key: publicKey });
        }
    }

    /** Public half recomputed from the stored private key, in both encodings; null if unreadable. */
    private derivePublicKey(protectedPrivate: string): { fidelius: string; legacyRaw: string } | null {
        try {
            const store = this.deps.keyStore;
            if (!store) return null;
            const privatePem = store.unprotect(Buffer.from(protectedPrivate, 'base64')).toString('utf8');
            const publicKey = crypto.createPublicKey(crypto.createPrivateKey(privatePem));
            return {
                fidelius: toFideliusPublicKey(publicKey),
                legacyRaw: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64')
            };
        } catch {
            return null;
        }
    }

    /**
     * The HIU's ABDM key material. The nonce is derived from the private key
     * so it needs no storage of its own; senders bring a fresh key and nonce
     * every transfer, so the session key still never repeats.
     */
    keyMaterial(): FideliusKeyMaterial {
        const { publicKey } = this.ensureKeypair();
        return {
            cryptoAlg: 'ECDH',
            curve: 'Curve25519',
            dhPublicKey: {
                expiry: new Date(this.nowMs() + 24 * 60 * 60 * 1000).toISOString(),
                parameters: 'Curve25519/32byte random key',
                keyValue: publicKey
            },
            nonce: this.nonceFor(this.readPrivatePem())
        };
    }

    private nonceFor(privatePem: string): string {
        const d = crypto.createPrivateKey(privatePem).export({ format: 'jwk' }).d || '';
        return crypto.createHmac('sha256', Buffer.from(d, 'base64url'))
            .update('nalamdesk-hiu-nonce-v1')
            .digest('base64');
    }

    /** Test seam for the inbound decrypt path PR2 builds on. */
    decryptForTest(envelope: FideliusEnvelope): unknown {
        return this.decryptRecord(envelope);
    }

    /** Decrypts one inbound record envelope with the HIU private key. */
    decryptRecord(envelope: FideliusEnvelope): unknown {
        if (!envelope || typeof envelope !== 'object') throw new Error('A record envelope is required.');
        if (!envelope.keyMaterial || typeof envelope.keyMaterial !== 'object') {
            throw new Error('Record envelope is missing keyMaterial.');
        }
        if (!String(envelope.encryptedData || '').trim()) {
            throw new Error('Record envelope is missing encryptedData.');
        }
        const privatePem = this.readPrivatePem();
        return new FideliusService().decryptEnvelope(envelope, privatePem, this.nonceFor(privatePem));
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
        if (!this.isMock()) {
            throw new Error('Live HIU consent is not certified in this build; use the mock gateway.');
        }
        const created = store.createConsentRequest({
            patientId: input?.patientId ?? null,
            abhaAddress: input?.abhaAddress,
            hiTypes: input?.hiTypes,
            dateFrom: input?.dateFrom ?? null,
            dateTo: input?.dateTo ?? null,
            gatewayRequestId: `mock-consent-${this.nowMs()}-${crypto.randomBytes(4).toString('hex')}`
        }, actingUserId);
        // Out-of-order gateway notifications may already wait in the inbox;
        // apply any that match, best-effort.
        this.reconcilePendingNotifies();
        return created;
    }

    /**
     * Applies queued consent notifications that arrived before their request
     * row existed (out-of-order gateway delivery). Unknown rows are left
     * pending; failures never throw — the inbox row stays for review.
     */
    reconcilePendingNotifies(): { applied: number; skipped: number } {
        const store = this.deps.store;
        if (!store || typeof (store as any).getPendingInbox !== 'function') {
            return { applied: 0, skipped: 0 };
        }
        let applied = 0;
        let skipped = 0;
        for (const row of (store as any).getPendingInbox() || []) {
            if (!(HIU_NOTIFY_KINDS as readonly string[]).includes(String(row?.kind))) continue;
            try {
                this.handleNotify(row.kind, JSON.parse(row.payload || '{}'));
                applied += 1;
            } catch {
                skipped += 1;
            }
        }
        return { applied, skipped };
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
        if (!this.isMock()) {
            throw new Error('Live HIU fetch is not certified in this build; use the mock gateway.');
        }
        const consent = store.getConsentById(Number(consentId));
        if (!consent) throw new Error('Consent request not found.');
        if (consent.status && consent.status !== 'granted') {
            throw new Error('Records can only be fetched for a granted consent.');
        }
        const bundle = this.buildMockClinicalBundle(consent);
        const envelope = new FideliusService().encryptBundle(bundle, this.keyMaterial());
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
