// The relay's collaborators. Each one is owned by an earlier iteration of the
// cloud plan and is injected here, so the relay logic can ship and be tested
// before those land:
//   DeviceAuthenticator  -> #154 (cloud/shared, against the Core devices and nonces tables)
//   FacilityDirectory    -> #153 / #154 (device registry, bridge links)
//   Mailbox, Inbox, Doorbell, DeviceCertificates -> #155 (48-hour sealed mailbox, IoT Core doorbell)
//   VendorCredentials    -> SSM Parameter Store (src/parameterStore.ts)

/**
 * Verifies the X-ND-* signature headers, timestamp window, nonce replay,
 * device status and rate limits (cloud/shared, shared with the booking
 * API). The relay itself still checks X-HIP-ID against the returned
 * facility and the path against its own allowlist.
 */
export type { DesktopRequest, DeviceAuthenticator, DeviceAuthResult } from '@nalamdesk/cloud-shared';

export interface Facility {
    clinicId: string;
    hipId: string;
    /** Clinic's X25519 sealing key, raw 32 bytes, base64. */
    sealingPublicKey: string;
    /** True once NalamDesk linked this HFR ID to its bridge in ABDM. */
    linkedToBridge: boolean;
}

export interface FacilityDirectory {
    byHipId(hipId: string): Promise<Facility | null>;
    /**
     * Resolves the opaque token embedded in a clinic's HIU data push URL.
     * HIPs push records without a gateway JWT, so the URL token is what
     * routes the push and keeps strangers from writing to a mailbox.
     */
    byDataPushToken(token: string): Promise<Facility | null>;
}

export type MailboxItemType = 'abdm-callback' | 'abdm-data-push';

export interface MailboxItem {
    clinicId: string;
    type: MailboxItemType;
    /** Sealed envelope; the relay cannot open it. */
    sealed: string;
}

export interface Mailbox {
    /** Stores a sealed item for up to 48 hours; resolves with its item ID. */
    put(item: MailboxItem): Promise<string>;
}

/** One mailbox item as the desktop receives it. */
export interface InboxItem {
    id: string;
    /** The relay's own types, and booking requests the booking API puts in the same mailbox. */
    type: MailboxItemType | 'booking-request';
    createdAt: number;
    /** Sealed envelope, for items kept inline. */
    sealed?: string;
    /** Short-lived download link for the sealed envelope, for large items. */
    url?: string;
}

/** The desktop's side of the mailbox (#155): list, acknowledge, and purge on revocation. */
export interface Inbox {
    list(clinicId: string): Promise<{ items: InboxItem[]; more: boolean }>;
    ack(clinicId: string, ids: string[]): Promise<void>;
    /** Drops mail stored before `beforeMs`, which only a replaced key could open. */
    purge(clinicId: string, beforeMs: number): Promise<number>;
}

/** IoT Core client certificates for the doorbell (#155): one per device. */
export interface DeviceCertificates {
    /**
     * Issues a certificate for the CSR and revokes any earlier one for the
     * device; refuses with `device_revoked` once the device is revoked.
     */
    issue(device: { deviceId: string; clinicId: string }, csrPem: string): Promise<{ certificatePem: string }>;
    /** Revokes and deletes the device's certificates and its IoT thing. */
    revoke(deviceId: string): Promise<void>;
}

/**
 * The certificates issued to each device, kept on its row (#155) so a
 * revocation finds every one even while an issue is in flight.
 */
export interface CertificateLedger {
    /** Records the certificate if the device is still active: the certificates recorded before it, or null once it is revoked. */
    record(deviceId: string, certificateArn: string): Promise<string[] | null>;
    /** The recorded certificates, read consistently. */
    recorded(deviceId: string): Promise<string[]>;
    /** Drops certificates that have been retired. */
    forget(deviceId: string, certificateArns: string[]): Promise<void>;
}

/** Where a desktop connects for doorbell rings. */
export interface DoorbellConnection {
    /** IoT data endpoint host. */
    endpoint: string;
    /** `nalamdesk/<stage>/clinic`; the clinic's topic is `<prefix>/<clinicId>/mail`. */
    topicPrefix: string;
}

export interface Doorbell {
    /** Publishes an empty "you have mail" message to the clinic's topic. */
    ring(clinicId: string): Promise<void>;
}

export interface VendorCredentials {
    /** Reads the vendor Client ID and secret (from Parameter Store in AWS). */
    load(): Promise<{ clientId: string; clientSecret: string }>;
}
