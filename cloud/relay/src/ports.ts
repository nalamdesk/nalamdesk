// The relay's collaborators. Each one is owned by an earlier iteration of the
// cloud plan and is injected here, so the relay logic can ship and be tested
// before those land:
//   DeviceAuthenticator  -> #154 (cloud/shared, against the Core devices and nonces tables)
//   FacilityDirectory    -> #153 / #154 (device registry, bridge links)
//   Mailbox, Doorbell    -> #155 (48-hour sealed mailbox, IoT Core doorbell)
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

export interface Doorbell {
    /** Publishes an empty "you have mail" message to the clinic's topic. */
    ring(clinicId: string): Promise<void>;
}

export interface VendorCredentials {
    /** Reads the vendor Client ID and secret (from Parameter Store in AWS). */
    load(): Promise<{ clientId: string; clientSecret: string }>;
}
