import type * as crypto from 'node:crypto';
import log from 'electron-log';
import type { HandleResult, MailboxHandler, MailboxItem } from '../cloud/MailboxReader';
import { openSealed } from '../cloud/mailboxSeal';

// Online booking on the desktop (#158). The patient's browser seals name,
// phone and reason to this clinic's X25519 key; the cloud stores only that
// ciphertext in the shared 48-hour mailbox. This service lists the clinic,
// publishes slots, opens booking requests locally and reports accept/decline.
//
// It talks to the cloud through ports wired in main/cloud/CloudLink.ts:
//   ClinicCloudTransport -> signed booking API requests (#154)
//   ClinicSealingKey     -> the X25519 key created at pairing (#154)
// and receives sealed requests from the shared MailboxReader (#155).

const BOOKING_TYPE = 'booking-request';
const REF_PATTERN = /^[0-9A-HJKMNP-TV-Z]{12}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
export interface CloudResponse {
    status: number;
    body: any;
}

export interface ClinicCloudTransport {
    /** Signed request to the booking API, e.g. `PUT /api/clinic/listing`. */
    send(method: 'GET' | 'PUT' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<CloudResponse>;
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
    /** Books the appointment and marks the request accepted in one transaction; a repeat does nothing. */
    acceptAppointmentRequest(id: string, slot: AppointmentSlot): unknown;
}

export interface AppointmentSlot {
    date: string;
    time: string;
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
}

export class BookingInboxService implements MailboxHandler {
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

    /** Opens and saves one `booking-request` item from the mailbox. */
    handle(item: MailboxItem): HandleResult {
        const clinicId = this.deps.key.clinicId();
        let request: BookingRequest;
        try {
            request = parseBookingPayload(openSealed(item.sealed, this.deps.key.privateKey(), clinicId, BOOKING_TYPE), clinicId);
        } catch (error) {
            // It will never open (wrong key, tampered, malformed), so drop it
            // rather than fetch it every 30 minutes until it expires.
            log.warn(`[Booking] Dropping unreadable mailbox item: ${(error as Error).message}`);
            return 'dropped';
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
            return 'saved';
        } catch (error) {
            // Not acknowledged, so the next fetch tries again.
            log.error('[Booking] Could not save a booking request', error);
            return 'retry';
        }
    }

    // ---- Accept / decline ----

    /**
     * Tells the cloud first (which books or releases the slot and updates the
     * patient's status page), then records the decision locally. An
     * acceptance with a slot books the appointment in the same local
     * transaction that marks the request accepted. A retried decision is
     * fine, and a retried acceptance the cloud already holds still books the
     * appointment once; a slot that lapsed and was taken is reported.
     */
    async decide(ref: string, decision: Decision, slot?: AppointmentSlot): Promise<void> {
        if (!REF_PATTERN.test(ref)) throw new BookingError('bad_ref', 'Not an online booking reference.');
        const response = await this.deps.transport.send('POST', `/api/clinic/bookings/${ref}/decision`, { decision });
        if (response.status === 409 && response.body?.error === 'already_decided') {
            const status = String(response.body?.status || '').toLowerCase();
            if (status === 'accepted' && decision === 'accepted' && slot) {
                // An earlier acceptance reached the cloud but not this computer.
                this.deps.store.acceptAppointmentRequest(ref, slot);
                return;
            }
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
        if (decision === 'accepted' && slot) this.deps.store.acceptAppointmentRequest(ref, slot);
        // The renderer already uses `rejected` for a declined request.
        else this.deps.store.updateAppointmentRequestStatus(ref, decision === 'declined' ? 'rejected' : 'accepted');
    }

    private async expectOk(response: CloudResponse): Promise<CloudResponse> {
        if (response.status >= 200 && response.status < 300) return response;
        const code = String(response.body?.error || `http_${response.status}`);
        throw new BookingError(code, `Online booking request failed (${code}).`);
    }
}
