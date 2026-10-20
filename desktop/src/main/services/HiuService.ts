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
        // Live consent through the relay (#164).
        setConsentRequestId?: (id: number, consentRequestId: string) => any;
        failConsentRequest?: (id: number, error: string) => any;
        discardConsentRequest?: (id: number) => unknown;
        saveHiuArtefacts?: (consentId: number, artefactIds: string[], status: string) => any[];
        getHiuArtefacts?: (consentId: number) => any[];
        findHiuArtefact?: (field: 'id' | 'fetch_request_id' | 'hi_request_id' | 'transaction_id', value: string) => any;
        updateHiuArtefact?: (id: string, patch: Record<string, string | null>) => any;
    };
    /** The relay connection (#160); without one the HIU runs against the mock gateway. */
    relay?: {
        isMockMode: () => boolean;
        send?: (upstream: 'gateway', method: 'POST', path: string, body: unknown, headers?: { 'request-id'?: string }) => Promise<any>;
    };
    /** The paired facility ID; the relay sends it as X-HIU-ID. */
    hiuId?: () => string | null;
    /** Where HIPs push records for this clinic: the relay's data push URL from pairing. */
    dataPushUrl?: () => string | null;
    /** The clinician named on a consent request. */
    requester?: (actingUserId?: number) => { name: string; hprId: string | null };
    newRequestId?: () => string;
}

/** A live transfer a data push belongs to: the consent artefact it answers. */
export interface HiuTransfer {
    artefactId: string;
    consent: any;
    /** The consent's own erase date; cached records never outlive it. */
    dataEraseAt: string | null;
    lastPage: boolean;
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

// Live HIU paths (#164). Gateway calls go through the relay's allowlist;
// callbacks arrive sealed through the mailbox. Both follow the public ABDM
// v3 docs; reconfirm against the sandbox once credentials land (#152).
export const HIU_ON_INIT_PATH = '/api/v3/hiu/consent/request/on-init';
export const HIU_ON_FETCH_PATH = '/api/v3/hiu/consent/on-fetch';
export const HIU_ON_REQUEST_PATH = '/api/v3/hiu/health-information/on-request';
const CONSENT_INIT = '/consent/v3/request/init';
const CONSENT_FETCH = '/consent/v3/fetch';
const CONSENT_ON_NOTIFY = '/consent/v3/request/hiu/on-notify';
const HI_REQUEST = '/data-flow/v3/health-information/request';
const HI_NOTIFY = '/data-flow/v3/health-information/notify';

/** Health information types a consent can ask for (ABDM HI types). */
export const HI_TYPES = [
    'OPConsultation', 'Prescription', 'DischargeSummary', 'DiagnosticReport',
    'ImmunizationRecord', 'HealthDocumentRecord', 'WellnessRecord'
] as const;

// With no dates given, a request covers the last five years.
const DEFAULT_RANGE_YEARS = 5;

const ARTEFACT_STATUS: Record<string, string> = {
    GRANTED: 'granted',
    REVOKED: 'revoked',
    EXPIRED: 'expired',
    DENIED: 'denied'
};

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

    private newRequestId(): string {
        return this.deps.newRequestId ? this.deps.newRequestId() : crypto.randomUUID();
    }

    private async gateway(path: string, body: unknown, requestId?: string): Promise<any> {
        const send = this.deps.relay?.send;
        if (!send) throw new Error('This computer is not paired with NalamDesk Cloud, so ABDM is in mock mode.');
        return send('gateway', 'POST', path, body, { 'request-id': requestId ?? this.newRequestId() });
    }

    private liveStore() {
        const store = this.deps.store;
        if (!store?.setConsentRequestId || !store.failConsentRequest || !store.saveHiuArtefacts
            || !store.getHiuArtefacts || !store.findHiuArtefact || !store.updateHiuArtefact) {
            throw new Error('Consent store is not configured for live consent.');
        }
        return store as Required<NonNullable<HiuDeps['store']>>;
    }

    private requireHiuId(): string {
        const id = String(this.deps.hiuId?.() ?? '').trim();
        if (!id) throw new Error('This computer is not paired with a facility, so it cannot ask for records.');
        return id;
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
     * locally and returns a mock gateway id end-to-end; through the relay it
     * sends a consent request to the consent manager, which answers through
     * the mailbox (on-init, then notify).
     */
    async requestConsent(input: HiuConsentRequest, actingUserId?: number): Promise<any> {
        const store = this.deps.store;
        if (!store) throw new Error('Consent store is not configured.');
        if (!this.isMock()) return this.requestConsentLive(input, actingUserId);
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
        const artefactIds = Array.isArray(payload?.artefactIds) ? payload.artefactIds.map(String) : [];
        if (artefactIds.length > 0 && store.saveHiuArtefacts) {
            store.saveHiuArtefacts(Number(existing.id), artefactIds, next === 'granted' ? 'granted' : 'revoked');
        }
        return { handled: true, consentId: Number(updated?.id ?? existing.id) };
    }

    /**
     * Fetches outside records for a granted consent into the encrypted cache.
     * Mock mode synthesizes a bundle through the real encrypt→decrypt path;
     * through the relay it asks each HIP for its records, which arrive later
     * as data pushes in the mailbox.
     */
    async fetchForConsent(consentId: number, actingUserId?: number): Promise<any> {
        const store = this.deps.store;
        if (!store) throw new Error('Consent store is not configured.');
        const consent = store.getConsentById(Number(consentId));
        if (!consent) throw new Error('Consent request not found.');
        if (consent.status && consent.status !== 'granted') {
            throw new Error('Records can only be fetched for a granted consent.');
        }
        if (!this.isMock()) return this.requestHealthInformation(consent);
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

    private async requestConsentLive(input: HiuConsentRequest, actingUserId?: number): Promise<any> {
        const store = this.liveStore();
        const hiuId = this.requireHiuId();
        const hiTypes = Array.isArray(input?.hiTypes) ? input.hiTypes.map((t) => String(t || '').trim()).filter(Boolean) : [];
        const unknown = hiTypes.filter((t) => !(HI_TYPES as readonly string[]).includes(t));
        if (unknown.length > 0) throw new Error(`Unknown health information type: ${unknown.join(', ')}`);
        const range = this.dateRange(input?.dateFrom, input?.dateTo);
        const requestId = this.newRequestId();
        const created = store.createConsentRequest({
            patientId: input?.patientId ?? null,
            abhaAddress: input?.abhaAddress,
            hiTypes,
            dateFrom: input?.dateFrom ?? null,
            dateTo: input?.dateTo ?? null,
            gatewayRequestId: requestId
        }, actingUserId);
        const requester = this.deps.requester?.(actingUserId) ?? { name: 'Clinic', hprId: null };
        const body = {
            consent: {
                purpose: { text: 'Care Management', code: 'CAREMGT', refUri: 'http://terminology.hl7.org/ValueSet/v3-PurposeOfUse' },
                patient: { id: String(input.abhaAddress).trim() },
                hiu: { id: hiuId },
                requester: {
                    name: requester.name,
                    ...(requester.hprId ? { identifier: { type: 'REGNO', value: requester.hprId, system: 'https://www.mciindia.org' } } : {})
                },
                hiTypes,
                permission: {
                    accessMode: 'VIEW',
                    dateRange: range,
                    dataEraseAt: new Date(this.nowMs() + MOCK_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString(),
                    frequency: { unit: 'HOUR', value: 1, repeats: 0 }
                }
            }
        };
        try {
            await this.gateway(CONSENT_INIT, body, requestId);
        } catch (error) {
            store.discardConsentRequest(Number(created.id));
            throw error;
        }
        return created;
    }

    /** ISO range for a request: whole days from the form, else the last five years. */
    private dateRange(from?: string | null, to?: string | null): { from: string; to: string } {
        const now = this.nowMs();
        const parse = (value: string | null | undefined, endOfDay: boolean): string | null => {
            const text = String(value ?? '').trim();
            if (!text) return null;
            const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z` : text);
            if (!Number.isFinite(ms)) throw new Error(`Invalid date: ${text}`);
            return new Date(ms).toISOString();
        };
        const start = parse(from, false) ?? new Date(now - DEFAULT_RANGE_YEARS * 365 * 24 * 60 * 60 * 1000).toISOString();
        const end = parse(to, true) ?? new Date(now).toISOString();
        if (start > end) throw new Error('The start date is after the end date.');
        return { from: start, to: end };
    }

    /**
     * Applies an HIU gateway callback from the mailbox. Returns null for a
     * path this service does not own; otherwise any gateway call to make
     * once the database work is done.
     */
    applyCallback(path: string | null, body: any): { followUp?: () => Promise<void> } | null {
        if (path === HIU_ON_INIT_PATH) return this.applyOnInit(body);
        if (path === HIU_ON_FETCH_PATH) return this.applyOnFetch(body);
        if (path === HIU_ON_REQUEST_PATH) return this.applyOnRequest(body);
        return null;
    }

    private applyOnInit(body: any): { followUp?: () => Promise<void> } {
        const store = this.liveStore();
        const requestId = String(body?.response?.requestId ?? '').trim();
        const consent = requestId ? store.getConsentByRequestId(requestId) : null;
        if (!consent) throw new Error('Consent request not found for this on-init.');
        const consentRequestId = typeof body?.consentRequest?.id === 'string' ? body.consentRequest.id.trim() : '';
        if (body?.error || !consentRequestId) {
            store.failConsentRequest(Number(consent.id), gatewayError(body?.error));
            return {};
        }
        store.setConsentRequestId(Number(consent.id), consentRequestId);
        // A notify can beat its on-init; it waits in the inbox until now.
        this.reconcilePendingNotifies();
        return { followUp: () => this.fetchArtefactDetails(Number(consent.id)) };
    }

    private applyOnFetch(body: any): Record<string, never> {
        const store = this.liveStore();
        const requestId = String(body?.response?.requestId ?? '').trim();
        const artefact = requestId ? store.findHiuArtefact('fetch_request_id', requestId) : null;
        if (!artefact) throw new Error('Consent artefact not found for this on-fetch.');
        const detail = body?.consent?.consentDetail;
        if (body?.error || !detail) {
            store.updateHiuArtefact(artefact.id, { error: gatewayError(body?.error) });
            return {};
        }
        if (String(detail.consentId ?? '') !== artefact.id) throw new Error('On-fetch names a different consent artefact.');
        const status = ARTEFACT_STATUS[String(body?.consent?.status ?? '').toUpperCase()] ?? artefact.status;
        store.updateHiuArtefact(artefact.id, {
            status,
            hip_id: stringOrNull(detail.hip?.id),
            date_from: stringOrNull(detail.permission?.dateRange?.from),
            date_to: stringOrNull(detail.permission?.dateRange?.to),
            data_erase_at: stringOrNull(detail.permission?.dataEraseAt),
            error: null
        });
        return {};
    }

    private applyOnRequest(body: any): Record<string, never> {
        const store = this.liveStore();
        const requestId = String(body?.response?.requestId ?? '').trim();
        const artefact = requestId ? store.findHiuArtefact('hi_request_id', requestId) : null;
        if (!artefact) throw new Error('Records request not found for this on-request.');
        const transactionId = stringOrNull(body?.hiRequest?.transactionId);
        if (body?.error || !transactionId) {
            store.updateHiuArtefact(artefact.id, { transfer_status: 'failed', error: gatewayError(body?.error) });
            return {};
        }
        store.updateHiuArtefact(artefact.id, { transaction_id: transactionId, transfer_status: 'acknowledged', error: null });
        return {};
    }

    /** Asks the consent manager for each granted artefact's details (HIP, dates); best effort. */
    async fetchArtefactDetails(consentId: number): Promise<void> {
        if (this.isMock()) return;
        const store = this.liveStore();
        for (const artefact of store.getHiuArtefacts(consentId)) {
            if (artefact.status !== 'granted' || artefact.hip_id) continue;
            const requestId = this.newRequestId();
            store.updateHiuArtefact(artefact.id, { fetch_request_id: requestId });
            await this.gateway(CONSENT_FETCH, { consentId: artefact.id }, requestId);
        }
    }

    /** Acknowledges a consent notification to the consent manager. */
    async acknowledgeNotify(callbackRequestId: string | null, artefactIds: string[]): Promise<void> {
        await this.gateway(CONSENT_ON_NOTIFY, {
            acknowledgement: artefactIds.map((consentId) => ({ status: 'OK', consentId })),
            response: { requestId: callbackRequestId ?? '' }
        });
    }

    private async requestHealthInformation(consent: any): Promise<{ requested: number }> {
        const store = this.liveStore();
        const dataPushUrl = String(this.deps.dataPushUrl?.() ?? '').trim();
        if (!dataPushUrl) throw new Error('This computer has no data push address yet; pair it with NalamDesk Cloud again.');
        const artefacts = store.getHiuArtefacts(Number(consent.id)).filter((a) => a.status === 'granted');
        if (artefacts.length === 0) throw new Error('The consent manager has not sent the granted consent yet. Try again shortly.');
        const keyMaterial = this.keyMaterial();
        const fallback = this.dateRange(consent.date_from, consent.date_to);
        let requested = 0;
        for (const artefact of artefacts) {
            const requestId = this.newRequestId();
            store.updateHiuArtefact(artefact.id, {
                hi_request_id: requestId, transaction_id: null, transfer_status: 'requested', error: null
            });
            await this.gateway(HI_REQUEST, {
                hiRequest: {
                    consent: { id: artefact.id },
                    dateRange: { from: artefact.date_from || fallback.from, to: artefact.date_to || fallback.to },
                    dataPushUrl,
                    keyMaterial
                }
            }, requestId);
            requested += 1;
        }
        // Artefacts whose details never arrived are asked for again.
        await this.fetchArtefactDetails(Number(consent.id)).catch(() => undefined);
        return { requested };
    }

    /**
     * The live transfer a data push belongs to, by its transaction ID; null
     * when it is not one this computer asked for. Only a granted artefact
     * of a granted consent may keep records.
     */
    transferFor(transactionId: string, page?: { pageNumber?: unknown; pageCount?: unknown }): HiuTransfer | null {
        const store = this.deps.store;
        if (!store?.findHiuArtefact || !transactionId) return null;
        const artefact = store.findHiuArtefact('transaction_id', transactionId);
        if (!artefact) return null;
        const consent = store.getConsentById(Number(artefact.consent_id));
        if (!consent || consent.status !== 'granted' || artefact.status !== 'granted') {
            throw new Error('Push requires a matching granted consent.');
        }
        const number = Number(page?.pageNumber);
        const count = Number(page?.pageCount);
        return {
            artefactId: artefact.id,
            consent,
            dataEraseAt: artefact.data_erase_at ?? null,
            lastPage: !(Number.isFinite(number) && Number.isFinite(count)) || number >= count
        };
    }

    /**
     * Records how a push went and returns the transfer notification for the
     * consent manager, sent once the last page is in (or at once on failure).
     */
    completeTransfer(transfer: HiuTransfer, careContextRefs: Array<string | null>, ok: boolean, transactionId: string): (() => Promise<void>) | null {
        const store = this.deps.store;
        if (!ok || transfer.lastPage) {
            store?.updateHiuArtefact?.(transfer.artefactId, { transfer_status: ok ? 'transferred' : 'failed' });
        }
        if (ok && !transfer.lastPage) return null;
        const artefact = store?.findHiuArtefact?.('id', transfer.artefactId);
        const hiuId = String(this.deps.hiuId?.() ?? '');
        return () => this.gateway(HI_NOTIFY, {
            notification: {
                consentId: transfer.artefactId,
                transactionId,
                doneAt: new Date(this.nowMs()).toISOString(),
                notifier: { type: 'HIU', id: hiuId },
                statusNotification: {
                    sessionStatus: ok ? 'TRANSFERRED' : 'FAILED',
                    hipId: artefact?.hip_id ?? '',
                    statusResponses: careContextRefs.filter((ref): ref is string => !!ref).map((ref) => ({
                        careContextReference: ref,
                        hiStatus: ok ? 'OK' : 'ERRORED',
                        description: ok ? 'Data received' : 'Could not read the records'
                    }))
                }
            }
        }).then(() => undefined);
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

function stringOrNull(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** A short message from a gateway error object, for the desk. */
function gatewayError(error: any): string {
    const message = typeof error?.message === 'string' ? error.message : '';
    const code = error?.code != null ? String(error.code) : '';
    return (message || (code ? `Error ${code}` : 'Refused by the consent manager.')).slice(0, 500);
}
