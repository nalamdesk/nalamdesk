import log from 'electron-log';
import type { FideliusEnvelope } from '../services/FideliusService';
import { HiuService, type HiuTransfer } from '../services/HiuService';
import type { AbdmInboxRow } from './AbdmInbox';
import type { AbdmRelaySend } from './SignedCloudClient';

// Applies the ABDM items the mailbox reader saved to `abdm_mailbox` (#160).
// These replace the public callback routes the local server used to expose:
// the relay receives each gateway callback or HIP data push, seals it to
// this computer, and the same rules the routes applied run here.
//
// - Scan and share (`/api/v3/hip/patient/share`) queues a front-desk token
//   and answers the gateway through the relay with the token number.
// - HIP discovery, linking, consent and records requests go to the HIP.
// - HIU consent notifications update the matching consent request and stay
//   in the callback inbox for the desk.
// - Any other callback is queued in the callback inbox for the desk.
// - A data push is decrypted with the HIU key and cached only for a matching
//   granted consent.
//
// Each item ends `processed` or `failed`; nothing is retried, so one bad
// item never blocks the ones behind it. Callback paths follow the public v3
// docs; reconfirm each against the sandbox once credentials land (#152).

export const SHARE_PATH = '/api/v3/hip/patient/share';
export const ON_SHARE_PATH = '/abdm/gateway/patient-share/v3/on-share';
export const HIU_CONSENT_NOTIFY_PATH = '/api/v3/hiu/consent/request/notify';

/** How long a scan-and-share token stays valid, as the local queue enforces it. */
const SHARE_TOKEN_EXPIRY_SECONDS = 15 * 60;
const BATCH_SIZE = 50;
// Bounds the decryption work one item can ask for.
const MAX_RECORDS_PER_PUSH = 100;

export interface AbdmMailboxItem extends AbdmInboxRow {
    status: 'new' | 'processed' | 'failed';
}

export interface AbdmMailboxStore {
    getNewAbdmMailboxItems(limit: number): AbdmMailboxItem[];
    setAbdmMailboxStatus(id: string, status: 'processed' | 'failed'): void;
    /** True when another item with this path and REQUEST-ID was already applied (a gateway retry). */
    abdmMailboxRequestSeen(path: string, requestId: string, exceptId: string): boolean;
    receiveAbhaShare(payload: any, actingUserId?: number): any;
    receiveInboxCallback(kind: string, payload: any, actingUserId?: number, requestId?: string): any;
    getConsentByRequestId(requestId: string): any;
    storeFetchedRecordBatch(rows: Array<{
        consentId: number; patientId: number | null; careContextRef: string | null; bundleJson: string; expiresAt: string;
    }>): any[];
}

export interface AbdmMailboxProcessorDeps {
    store: AbdmMailboxStore;
    hiu: {
        handleNotify(kind: string, payload: any): unknown;
        decryptRecord(envelope: FideliusEnvelope): unknown;
        // Live HIU through the relay (#164); absent in mock-only setups.
        applyCallback?(path: string | null, body: any): { followUp?: () => Promise<void> } | null;
        acknowledgeNotify?(callbackRequestId: string | null, artefactIds: string[]): Promise<void>;
        fetchArtefactDetails?(consentId: number): Promise<void>;
        transferFor?(transactionId: string, page?: { pageNumber?: unknown; pageCount?: unknown }): HiuTransfer | null;
        completeTransfer?(transfer: HiuTransfer, careContextRefs: Array<string | null>, ok: boolean, transactionId: string): (() => Promise<void>) | null;
    };
    /** HIP callbacks (#163): discovery, linking, consent and records requests. */
    hip?: {
        applyCallback(path: string | null, body: any, requestId: string | null): { followUp?: () => Promise<void> } | null;
    };
    /** Sends a signed gateway call through the relay; null when this computer is not paired. */
    relay: () => AbdmRelaySend | null;
    /** A scan-and-share token was queued; the front desk should refresh now. */
    onShare?: () => void;
    /** DatabaseService.runWork: a restore drains this work before replacing the database. */
    runWork?: <T>(work: () => Promise<T>) => Promise<T>;
    nowMs?: () => number;
}

export interface ProcessResult {
    processed: number;
    failed: number;
}

type Outcome = { status: 'processed' | 'failed'; reply?: () => Promise<void> };

export class AbdmMailboxProcessor {
    private running: Promise<ProcessResult> | null = null;
    private again = false;

    constructor(private readonly deps: AbdmMailboxProcessorDeps) {}

    /**
     * Applies every new item. Calls that arrive while a pass runs fold into
     * one more pass, so an item saved mid-pass is never left waiting.
     */
    drain(): Promise<ProcessResult> {
        if (this.running) {
            this.again = true;
            return this.running;
        }
        const run = async (): Promise<ProcessResult> => {
            const total: ProcessResult = { processed: 0, failed: 0 };
            do {
                this.again = false;
                const pass = await this.pass();
                total.processed += pass.processed;
                total.failed += pass.failed;
            } while (this.again);
            return total;
        };
        this.running = run().finally(() => {
            this.running = null;
        });
        return this.running;
    }

    private async pass(): Promise<ProcessResult> {
        const result: ProcessResult = { processed: 0, failed: 0 };
        const replies: Array<() => Promise<void>> = [];
        const work = this.deps.runWork ?? ((fn) => fn());
        let shared = false;
        // Reads and writes happen inside one unit of restore-drained work;
        // gateway replies go out after it, so a slow relay never holds a restore.
        await work(async () => {
            for (;;) {
                const items = this.deps.store.getNewAbdmMailboxItems(BATCH_SIZE);
                if (items.length === 0) break;
                for (const item of items) {
                    const outcome = this.apply(item);
                    this.deps.store.setAbdmMailboxStatus(item.id, outcome.status);
                    result[outcome.status] += 1;
                    if (outcome.reply) replies.push(outcome.reply);
                    if (outcome.status === 'processed' && item.path === SHARE_PATH) shared = true;
                }
                if (items.length < BATCH_SIZE) break;
            }
        });
        if (shared) this.deps.onShare?.();
        for (const reply of replies) {
            await reply().catch((error) => log.warn(`[ABDM mailbox] Gateway reply failed: ${(error as Error).message}`));
        }
        return result;
    }

    private apply(item: AbdmMailboxItem): Outcome {
        try {
            if (item.type === 'abdm-data-push') return this.applyDataPush(item);
            const { body } = parseCallback(item.payload);
            if (item.path && item.request_id && this.deps.store.abdmMailboxRequestSeen(item.path, item.request_id, item.id)) {
                return { status: 'processed' };
            }
            if (item.path === SHARE_PATH) return this.applyShare(item, body);
            if (item.path === HIU_CONSENT_NOTIFY_PATH) return this.applyConsentNotify(item, body);
            const hip = this.deps.hip?.applyCallback(item.path, body, item.request_id);
            if (hip) return { status: 'processed', reply: hip.followUp };
            const hiu = this.deps.hiu.applyCallback?.(item.path, body);
            if (hiu) return { status: 'processed', reply: hiu.followUp };
            this.deps.store.receiveInboxCallback(kindFor(item.path), body, undefined, item.request_id ?? undefined);
            return { status: 'processed' };
        } catch (error) {
            log.warn(`[ABDM mailbox] Could not apply ${item.type} ${item.path ?? ''}: ${(error as Error).message}`);
            return { status: 'failed' };
        }
    }

    private applyShare(item: AbdmMailboxItem, body: any): Outcome {
        const patient = body?.profile?.patient ?? {};
        const context = String(body?.metaData?.context ?? '');
        const abhaAddress = typeof patient.abhaAddress === 'string' ? patient.abhaAddress.trim() : '';
        let token: any;
        try {
            token = this.deps.store.receiveAbhaShare(shareProfile(patient, this.nowMs()));
        } catch (error) {
            const message = (error as Error).message;
            log.warn(`[ABDM mailbox] Scan and share refused: ${message}`);
            return {
                status: 'failed',
                reply: () => this.reply(onShareBody(item.request_id, { abhaAddress, status: 'FAILURE' }, message))
            };
        }
        const profile = { context, tokenNumber: String(token?.token_no ?? ''), expiry: String(SHARE_TOKEN_EXPIRY_SECONDS) };
        return {
            status: 'processed',
            reply: () => this.reply(onShareBody(item.request_id, { abhaAddress, status: 'SUCCESS', profile }))
        };
    }

    private applyConsentNotify(item: AbdmMailboxItem, body: any): Outcome {
        const notification = body?.notification ?? {};
        const requestId = String(notification.consentRequestId ?? '').trim();
        if (!requestId) throw new Error('Consent notification carries no consent request ID.');
        const status = String(notification.status ?? '').toUpperCase();
        const kind = CONSENT_KINDS[status] ?? 'consent-notify';
        const artefacts = Array.isArray(notification.consentArtefacts) ? notification.consentArtefacts : [];
        const artefactIds: string[] = artefacts
            .map((artefact: any) => (typeof artefact?.id === 'string' ? artefact.id.trim() : ''))
            .filter(Boolean)
            .slice(0, 50);
        const payload = { requestId, status, consentHandle: artefactIds[0] ?? null, artefactIds };
        this.deps.store.receiveInboxCallback(kind, payload, undefined, requestId);
        // Bookkeeping applies automatically; a notification for a request this
        // computer does not know stays in the inbox for the desk.
        let consentId: number | null = null;
        if (kind !== 'consent-notify') {
            try {
                const handled = this.deps.hiu.handleNotify(kind, payload) as { consentId?: number } | undefined;
                consentId = typeof handled?.consentId === 'number' ? handled.consentId : null;
            } catch (error) {
                log.warn(`[ABDM mailbox] Consent notification kept for review: ${(error as Error).message}`);
            }
        }
        // The consent manager expects an acknowledgement for the artefacts it
        // sent; a grant then needs each artefact's details before a fetch.
        const { acknowledgeNotify, fetchArtefactDetails } = this.deps.hiu;
        if (artefactIds.length === 0 || !acknowledgeNotify) return { status: 'processed' };
        return {
            status: 'processed',
            reply: async () => {
                await acknowledgeNotify.call(this.deps.hiu, item.request_id, artefactIds);
                if (kind === 'consent-granted' && consentId != null && fetchArtefactDetails) {
                    await fetchArtefactDetails.call(this.deps.hiu, consentId);
                }
            }
        };
    }

    private applyDataPush(item: AbdmMailboxItem): Outcome {
        const body = JSON.parse(item.payload);
        const transactionId = String(body?.transactionId ?? '').trim();
        // A push for a records request this computer sent through the relay.
        const transfer = transactionId ? this.deps.hiu.transferFor?.(transactionId, body) ?? null : null;
        const requestId = String(body?.requestId ?? body?.gatewayRequestId ?? body?.transactionId ?? '').trim();
        // Consent-gated storage: unknown, missing or not granted requests never keep clinical data.
        const consent = transfer ? transfer.consent : requestId ? this.deps.store.getConsentByRequestId(requestId) : null;
        if (!consent || consent.status !== 'granted') throw new Error('Push requires a matching granted consent.');
        const envelopes = envelopesOf(body);
        const refs = envelopes.map((envelope) => envelope.careContextRef);
        try {
            if (envelopes.length === 0) throw new Error('No record envelopes in this push.');
            if (envelopes.length > MAX_RECORDS_PER_PUSH) throw new Error('Too many records in one push.');
            const expiresAt = earliest(HiuService.retentionExpiry(this.nowMs()), transfer?.dataEraseAt ?? null);
            const rows = envelopes.map((envelope) => ({
                consentId: Number(consent.id),
                patientId: consent.patient_id ?? null,
                careContextRef: envelope.careContextRef,
                bundleJson: JSON.stringify(this.deps.hiu.decryptRecord(envelope.envelope)),
                expiresAt
            }));
            this.deps.store.storeFetchedRecordBatch(rows);
        } catch (error) {
            if (!transfer) throw error;
            log.warn(`[ABDM mailbox] Could not keep a data push: ${(error as Error).message}`);
            return { status: 'failed', reply: this.transferReply(transfer, refs, false, transactionId) };
        }
        return { status: 'processed', reply: transfer ? this.transferReply(transfer, refs, true, transactionId) : undefined };
    }

    private transferReply(transfer: HiuTransfer, refs: Array<string | null>, ok: boolean, transactionId: string): (() => Promise<void>) | undefined {
        return this.deps.hiu.completeTransfer?.(transfer, refs, ok, transactionId) ?? undefined;
    }

    private async reply(body: unknown): Promise<void> {
        const send = this.deps.relay();
        if (!send) throw new Error('This computer is not paired.');
        const response = await send('POST', ON_SHARE_PATH, body);
        if (response.status < 200 || response.status >= 300) {
            throw new Error(`HTTP ${response.status}${response.body?.error ? ` (${response.body.error})` : ''}`);
        }
    }

    private nowMs(): number {
        return this.deps.nowMs ? this.deps.nowMs() : Date.now();
    }
}

/** The earlier of two SQL datetimes or ISO times, as a SQL datetime. */
function earliest(retention: string, eraseAt: string | null): string {
    const erase = eraseAt ? Date.parse(eraseAt) : Number.NaN;
    if (!Number.isFinite(erase)) return retention;
    const keep = Date.parse(`${retention.replace(' ', 'T')}Z`);
    return erase < keep ? new Date(erase).toISOString().slice(0, 19).replace('T', ' ') : retention;
}

const CONSENT_KINDS: Record<string, string> = {
    GRANTED: 'consent-granted',
    DENIED: 'consent-denied',
    EXPIRED: 'consent-expired',
    REVOKED: 'consent-expired'
};

/** The callback inbox kind for a callback path, such as `hip-consent-request-notify`. */
export function kindFor(path: string | null): string {
    return String(path ?? '').replace(/^\/api\/v3\//, '').replace(/\//g, '-').slice(0, 64) || 'callback';
}

function parseCallback(payload: string): { headers: Record<string, string>; body: any } {
    const envelope = JSON.parse(payload);
    const text = typeof envelope?.body === 'string' ? envelope.body : '';
    return { headers: envelope?.headers ?? {}, body: text ? JSON.parse(text) : null };
}

const GENDERS: Record<string, string> = { M: 'Male', F: 'Female', O: 'Other', U: 'Other' };

/** Maps a v3 shared profile onto the local token shape `receiveAbhaShare` validates. */
export function shareProfile(patient: any, nowMs: number): Record<string, unknown> {
    const name = String(patient?.name ?? '').trim();
    const year = Number(patient?.yearOfBirth);
    const age = Number.isInteger(year) && year > 1900 ? new Date(nowMs).getFullYear() - year : null;
    const gender = GENDERS[String(patient?.gender ?? '').toUpperCase()] ?? null;
    const mobile = String(patient?.phoneNumber ?? patient?.mobile ?? '').replace(/[^\d+]/g, '') || null;
    const abhaAddress = typeof patient?.abhaAddress === 'string' ? patient.abhaAddress.trim() || null : null;
    return { name, age, gender, mobile, abhaAddress, abhaName: name || null, abhaNumber: patient?.abhaNumber ?? null };
}

function onShareBody(requestId: string | null, acknowledgement: Record<string, unknown>, error?: string): unknown {
    return {
        acknowledgement,
        ...(error ? { error: { code: 'INVALID_PROFILE', message: error.slice(0, 200) } } : {}),
        response: { requestId: requestId ?? '' }
    };
}

/**
 * Record envelopes in a push: the local `{ records: [...] }` shape, or the
 * ABDM data push with one sender key material and an `entries` list.
 */
function envelopesOf(body: any): Array<{ envelope: FideliusEnvelope; careContextRef: string | null }> {
    if (Array.isArray(body?.entries) && body?.keyMaterial) {
        return body.entries
            .filter((entry: any) => typeof entry?.content === 'string')
            .map((entry: any) => ({
                envelope: { keyMaterial: body.keyMaterial, encryptedData: entry.content, keyId: '' },
                careContextRef: typeof entry.careContextReference === 'string' ? entry.careContextReference : null
            }));
    }
    const records = Array.isArray(body?.records) ? body.records : [body?.envelope || body?.record].filter(Boolean);
    return records.map((envelope: FideliusEnvelope) => ({ envelope, careContextRef: null }));
}
