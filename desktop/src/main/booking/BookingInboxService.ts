import * as crypto from 'node:crypto';
import log from 'electron-log';

// Online booking on the desktop (#158). The patient's browser seals name,
// phone and reason to this clinic's X25519 key; the cloud stores only that
// ciphertext in the shared 48-hour mailbox. This service lists the clinic,
// publishes slots, opens booking requests locally and reports accept/decline.
//
// It talks to the cloud only through ports owned by earlier iterations:
//   ClinicCloudTransport -> #154 (signed device requests) and #155 (mailbox fetch/ack)
//   ClinicSealingKey     -> #154 (the X25519 key created at pairing, in DeviceKeyStore)
// main.ts keeps the old CloudSyncService until those adapters exist.

const MAILBOX_LABEL = 'nalamdesk-mailbox-v1';
const BOOKING_TYPE = 'booking-request';
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const REF_PATTERN = /^[0-9A-HJKMNP-TV-Z]{12}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
export const FALLBACK_SYNC_MS = 30 * 60 * 1000;

export interface MailboxEntry {
    id: string;
    type: string;
    sealed: string;
}

export interface CloudResponse {
    status: number;
    body: any;
}

export interface ClinicCloudTransport {
    /** Signed request to the booking API, e.g. `PUT /api/clinic/listing`. */
    send(method: 'GET' | 'PUT' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<CloudResponse>;
    /** Signed `GET /inbox` from the shared mailbox. */
    fetchInbox(): Promise<MailboxEntry[]>;
    /** Signed acknowledgement; the mailbox deletes the items. */
    ack(ids: string[]): Promise<void>;
}

export interface ClinicSealingKey {
    clinicId(): string;
    /** Raw 32-byte X25519 public key, base64. */
    publicKeyRaw(): string;
    privateKey(): crypto.KeyObject;
}

export interface BookingRequestStore {
    saveAppointmentRequest(req: { id: string; patient_name: string; phone: string; date: string | null; time: string | null; reason: string }): unknown;
    updateAppointmentRequestStatus(id: string, status: string): unknown;
}

export interface BookingRequest {
    ref: string;
    slotId: string | null;
    date: string | null;
    time: string | null;
    name: string;
    phone: string;
    reason: string;
}

export type Decision = 'accepted' | 'declined';

export class BookingError extends Error {
    constructor(readonly code: string, message: string) {
        super(message);
    }
}

function rawToPublicKey(rawBase64: string): crypto.KeyObject {
    const raw = Buffer.from(String(rawBase64 || ''), 'base64');
    if (raw.length !== 32) throw new Error('Sealing key must be a 32-byte X25519 public key.');
    return crypto.createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

/**
 * Opens a mailbox envelope. Matches `open()` in cloud/relay/src/seal.ts and
 * the browser sealer in cloud/booking/web/src/lib/seal.ts; the clinic ID and
 * item type are bound as associated data, so a moved or relabelled item fails.
 */
export function openSealed(sealed: string, privateKey: crypto.KeyObject, clinicId: string, type: string): Buffer {
    const envelope = JSON.parse(Buffer.from(sealed, 'base64').toString('utf8'));
    if (envelope?.v !== 1) throw new Error('Unsupported envelope version.');
    const shared = crypto.diffieHellman({ publicKey: rawToPublicKey(envelope.epk), privateKey });
    const key = Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.from(envelope.salt, 'base64'), Buffer.from(MAILBOX_LABEL), 32));
    shared.fill(0);
    try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
        decipher.setAAD(Buffer.from(`${MAILBOX_LABEL}|${clinicId}|${type}`, 'utf8'));
        decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
        return Buffer.concat([decipher.update(Buffer.from(envelope.ct, 'base64')), decipher.final()]);
    } finally {
        key.fill(0);
    }
}

const text = (value: unknown, max: number) =>
    typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';

/** Validates the browser's payload (version 1) after it is opened. */
export function parseBookingPayload(plain: Buffer, clinicId: string): BookingRequest {
    const payload = JSON.parse(plain.toString('utf8'));
    if (!payload || payload.v !== 1) throw new Error('unsupported_payload');
    if (typeof payload.ref !== 'string' || !REF_PATTERN.test(payload.ref)) throw new Error('bad_ref');
    if (payload.clinicId !== clinicId) throw new Error('wrong_clinic');
    const slot = payload.slot;
    const hasSlot = slot && typeof slot === 'object';
    if (hasSlot && (!DATE_PATTERN.test(String(slot.date)) || !TIME_PATTERN.test(String(slot.time)))) throw new Error('bad_slot');
    if (hasSlot && payload.slotId !== `${slot.date}T${slot.time}`) throw new Error('bad_slot');
    const name = text(payload.name, 80);
    const phone = typeof payload.phone === 'string' ? payload.phone.replace(/\D/g, '') : '';
    if (!name || phone.length < 10 || phone.length > 15) throw new Error('bad_contact');
    return {
        ref: payload.ref,
        slotId: hasSlot ? payload.slotId : null,
        date: hasSlot ? slot.date : null,
        time: hasSlot ? slot.time : null,
        name,
        phone,
        reason: text(payload.reason, 300)
    };
}

export interface BookingInboxDeps {
    transport: ClinicCloudTransport;
    key: ClinicSealingKey;
    store: BookingRequestStore;
    /** Called after new requests are saved, so the UI can refresh. */
    onNewRequests?: (count: number) => void;
}

export class BookingInboxService {
    private timer: NodeJS.Timeout | null = null;
    private running: Promise<number> | null = null;
    private rerun = false;

    constructor(private readonly deps: BookingInboxDeps) {}

    // ---- Listing and slots ----

    async enableListing(listing: { name: string; city: string; specialty?: string }): Promise<void> {
        await this.expectOk(await this.deps.transport.send('PUT', '/api/clinic/listing', {
            name: listing.name,
            city: listing.city,
            specialty: listing.specialty || undefined,
            sealingPublicKey: this.deps.key.publicKeyRaw()
        }));
    }

    async disableListing(): Promise<void> {
        await this.expectOk(await this.deps.transport.send('DELETE', '/api/clinic/listing'));
    }

    /** Replaces the open slots on `dates`; held and booked ones stay. */
    async publishSlots(dates: string[], slots: { date: string; time: string }[]): Promise<number> {
        const response = await this.expectOk(await this.deps.transport.send('PUT', '/api/clinic/slots', { dates, slots }));
        return Number(response.body?.published ?? 0);
    }

    async publishedSlots(from: string, to: string): Promise<{ slotId: string; date: string; time: string; state: string; ref?: string }[]> {
        const response = await this.expectOk(await this.deps.transport.send('GET', `/api/clinic/slots?from=${from}&to=${to}`));
        return response.body?.slots ?? [];
    }

    // ---- Inbox ----

    /**
     * Fetch on connect, on every doorbell ring, every 30 minutes and on
     * Refresh. Calls that arrive mid-fetch are folded into one more pass.
     */
    start(): void {
        if (this.timer) return;
        this.sync().catch(() => undefined);
        this.timer = setInterval(() => this.sync().catch(() => undefined), FALLBACK_SYNC_MS);
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    /** Doorbell (IoT Core) handler from #155. */
    onDoorbell(): void {
        this.sync().catch(() => undefined);
    }

    /** Resolves with the number of new booking requests saved. */
    sync(): Promise<number> {
        if (this.running) {
            this.rerun = true;
            return this.running;
        }
        this.running = (async () => {
            let saved = 0;
            try {
                do {
                    this.rerun = false;
                    saved += await this.syncOnce();
                } while (this.rerun);
            } finally {
                this.running = null;
            }
            if (saved > 0) this.deps.onNewRequests?.(saved);
            return saved;
        })();
        return this.running;
    }

    private async syncOnce(): Promise<number> {
        const items = await this.deps.transport.fetchInbox();
        const clinicId = this.deps.key.clinicId();
        const done: string[] = [];
        let saved = 0;
        for (const item of items) {
            // ABDM callbacks share the mailbox; their reader acknowledges them.
            if (item.type !== BOOKING_TYPE) continue;
            let request: BookingRequest;
            try {
                request = parseBookingPayload(openSealed(item.sealed, this.deps.key.privateKey(), clinicId, BOOKING_TYPE), clinicId);
            } catch (error) {
                // It will never open (wrong key, tampered, malformed), so drop it
                // rather than fetch it every 30 minutes until it expires.
                log.warn(`[Booking] Dropping unreadable mailbox item: ${(error as Error).message}`);
                done.push(item.id);
                continue;
            }
            try {
                this.deps.store.saveAppointmentRequest({
                    id: request.ref,
                    patient_name: request.name,
                    phone: request.phone,
                    date: request.date,
                    time: request.time,
                    reason: request.reason
                });
                saved++;
                done.push(item.id);
            } catch (error) {
                // Not acknowledged, so the next fetch tries again.
                log.error('[Booking] Could not save a booking request', error);
            }
        }
        if (done.length > 0) await this.deps.transport.ack(done);
        return saved;
    }

    // ---- Accept / decline ----

    /**
     * Tells the cloud first (which books or releases the slot and updates the
     * patient's status page), then records the decision locally. A retried
     * decision is fine; a slot that lapsed and was taken is reported.
     */
    async decide(ref: string, decision: Decision): Promise<void> {
        if (!REF_PATTERN.test(ref)) throw new BookingError('bad_ref', 'Not an online booking reference.');
        const response = await this.deps.transport.send('POST', `/api/clinic/bookings/${ref}/decision`, { decision });
        if (response.status === 409 && response.body?.error === 'already_decided') {
            const status = String(response.body?.status || '').toLowerCase();
            if (status === 'accepted' || status === 'declined') this.deps.store.updateAppointmentRequestStatus(ref, status === 'declined' ? 'rejected' : status);
            throw new BookingError('already_decided', `This request was already ${status || 'decided'}.`);
        }
        if (response.status === 409 && response.body?.error === 'slot_lost') {
            throw new BookingError('slot_lost', 'The request expired and the slot was taken by someone else.');
        }
        if (response.status === 404) {
            // Expired after 48 hours: the patient can no longer see a status.
            throw new BookingError('expired', 'This request has expired online. Call the patient directly.');
        }
        await this.expectOk(response);
        // The renderer already uses `rejected` for a declined request.
        this.deps.store.updateAppointmentRequestStatus(ref, decision === 'declined' ? 'rejected' : 'accepted');
    }

    private async expectOk(response: CloudResponse): Promise<CloudResponse> {
        if (response.status >= 200 && response.status < 300) return response;
        const code = String(response.body?.error || `http_${response.status}`);
        throw new BookingError(code, `Online booking request failed (${code}).`);
    }
}
