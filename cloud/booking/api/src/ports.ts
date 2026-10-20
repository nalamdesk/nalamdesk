// The booking API's collaborators. The stores are this stack's own DynamoDB
// tables (src/dynamo.ts, with in-memory twins in src/memory.ts). The rest
// come from cloud/shared and work on Core resources:
//   DeviceAuthenticator -> #154 (the Core devices and nonces tables)
//   Mailbox, Doorbell   -> #155 (DynamoMailbox and IotDoorbell)

/** Verifies the X-ND-* signature headers, timestamp window, nonce replay and device status (cloud/shared). */
export type { DesktopRequest, DeviceAuthenticator, DeviceAuthResult } from '@nalamdesk/cloud-shared';

export type MailboxItemType = 'abdm-callback' | 'abdm-data-push' | 'booking-request';

export interface MailboxItem {
    clinicId: string;
    type: MailboxItemType;
    /** Sealed envelope; the cloud cannot open it. */
    sealed: string;
}

export interface Mailbox {
    /** Stores a sealed item for up to 48 hours; resolves with its item ID. */
    put(item: MailboxItem): Promise<string>;
    /** Deletes items this API stored but must not deliver. */
    remove(clinicId: string, itemIds: string[]): Promise<void>;
}

/** Status of a paired desktop in the Core devices table (#154), read consistently. */
export interface ActiveDevices {
    /** True while the device is the clinic's active, unrevoked computer. */
    isActive(deviceId: string, clinicId: string): Promise<boolean>;
}

export interface Doorbell {
    /** Publishes an empty "you have mail" message to the clinic's topic. */
    ring(clinicId: string): Promise<void>;
}

// ---- This stack's own tables ----

export interface ClinicListing {
    name: string;
    city: string;
    specialty: string;
    /** Clinic's X25519 sealing key, raw 32 bytes, base64. */
    sealingPublicKey: string;
    /** The paired desktop that published the listing and holds the private key. */
    deviceId: string;
}

export interface Clinic extends ClinicListing {
    clinicId: string;
    listed: boolean;
    /** Set from IoT Core connection events once #155 lands. */
    online: boolean;
    /** Last signed request from the clinic's desktop, epoch ms. */
    lastSeenAt: number;
}

export interface ClinicStore {
    get(clinicId: string): Promise<Clinic | null>;
    /** Every listed clinic. The directory is small, so filtering happens in the app. */
    listListed(): Promise<Clinic[]>;
    upsertListing(clinicId: string, listing: ClinicListing, nowMs: number): Promise<void>;
    unlist(clinicId: string, nowMs: number): Promise<void>;
    touch(clinicId: string, nowMs: number): Promise<void>;
    setPresence(clinicId: string, online: boolean, atMs: number): Promise<void>;
}

export type SlotState = 'available' | 'held' | 'booked';

export interface Slot {
    clinicId: string;
    /** `YYYY-MM-DDTHH:MM`, derived from date and time, so a republish keeps holds. */
    slotId: string;
    date: string;
    time: string;
    state: SlotState;
    /** Booking reference holding or owning the slot. */
    ref?: string;
    /** A hold past this time reads as available again. */
    heldUntil?: number;
}

export interface SlotStore {
    get(clinicId: string, slotId: string): Promise<Slot | null>;
    listBetween(clinicId: string, fromDate: string, toDate: string): Promise<Slot[]>;
    /**
     * Replaces the open slots on the given dates. Held and booked slots are
     * kept even when they are missing from the new list.
     */
    publish(clinicId: string, dates: string[], slots: { date: string; time: string }[], nowMs: number): Promise<void>;
    /**
     * Conditional write: succeeds only if the slot is available or its hold
     * has lapsed. Exactly one of two concurrent holds wins.
     */
    hold(clinicId: string, slotId: string, ref: string, untilMs: number, nowMs: number): Promise<boolean>;
    /** Held by `ref` -> booked. */
    book(clinicId: string, slotId: string, ref: string): Promise<boolean>;
    /** Held by `ref` -> available. */
    release(clinicId: string, slotId: string, ref: string): Promise<boolean>;
}

export type BookingStatus = 'requested' | 'accepted' | 'declined';

export interface Booking {
    ref: string;
    clinicId: string;
    slotId: string | null;
    status: BookingStatus;
    /** HMAC of the browser's phone digest under a server pepper; never the number. Dropped once decided. */
    phoneKey?: string;
    createdAt: number;
    /** Epoch ms; the record reads as gone afterwards and DynamoDB TTL removes it. */
    expiresAt: number;
}

export interface BookingStore {
    /** Conditional create; false if the reference is already taken. */
    create(booking: Booking): Promise<boolean>;
    get(ref: string): Promise<Booking | null>;
    delete(ref: string): Promise<void>;
    /** Requests still waiting for this phone at this clinic. */
    countOpen(clinicId: string, phoneKey: string, nowMs: number): Promise<number>;
    /** requested -> accepted/declined; false if it was already decided. */
    decide(ref: string, status: Exclude<BookingStatus, 'requested'>): Promise<boolean>;
}
