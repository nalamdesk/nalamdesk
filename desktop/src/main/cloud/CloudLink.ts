import log from 'electron-log';
import { BookingInboxService, type BookingRequestStore, type ClinicCloudTransport } from '../booking/BookingInboxService';
import type { DeviceKeyStore } from '../services/DeviceKeyStore';
import { AbdmInboxHandler, type AbdmInboxStore } from './AbdmInbox';
import { CloudPairingService, type PairingStatus } from './CloudPairingService';
import type { CloudDeviceStore } from './DeviceIdentity';
import { Doorbell, type DoorbellDeps, type DoorbellState } from './Doorbell';
import { MailboxReader, type ListedItem, type MailboxTransport } from './MailboxReader';
import { SignedCloudClient, type Audience } from './SignedCloudClient';

// Hourly: cheap when nothing is due.
const ROTATION_CHECK_MS = 60 * 60 * 1000;
// A sealed envelope is base64 JSON around base64 ciphertext, so the relay's
// 5 MiB data push grows to about 8.9 MiB.
const MAX_DOWNLOAD_BYTES = 16 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 60_000;
// A failed rotation may have reached the relay, which drops the old key 10
// minutes later, so it is retried well inside that window.
const ROTATION_RETRY_MS = 2 * 60 * 1000;

/**
 * Runs `rotate` now and hourly, and again shortly after any failure until it
 * succeeds. Returns a function that stops it.
 */
export function scheduleRotation(rotate: () => Promise<unknown>, checkMs = ROTATION_CHECK_MS, retryMs = ROTATION_RETRY_MS): () => void {
    let retry: NodeJS.Timeout | null = null;
    let stopped = false;
    const run = (): void => {
        if (retry) clearTimeout(retry);
        retry = null;
        rotate().catch((error) => {
            log.warn(`[Cloud] Key rotation deferred: ${(error as Error).message}`);
            if (!stopped && !retry) retry = setTimeout(run, retryMs);
        });
    };
    run();
    const hourly = setInterval(run, checkMs);
    return () => {
        stopped = true;
        clearInterval(hourly);
        if (retry) clearTimeout(retry);
        retry = null;
    };
}

/** Signed booking API requests (#154). */
export function bookingTransport(client: SignedCloudClient): ClinicCloudTransport {
    return {
        send: (method, path, body) => client.signed('booking', method, path, body)
    };
}

/** The mailbox on the relay (#155): signed list and acknowledge; large items from short-lived links. */
export function mailboxTransport(client: SignedCloudClient, fetchFn: typeof fetch = fetch): MailboxTransport {
    return {
        async list(after) {
            // Item IDs are [a-z0-9], so the query needs no escaping and signs as sent.
            const response = await client.signed('relay', 'GET', after ? `/inbox?after=${encodeURIComponent(after)}` : '/inbox');
            if (response.status !== 200) throw new Error(`Mailbox fetch failed (${response.body?.error || response.status}).`);
            const raw = Array.isArray(response.body?.items) ? response.body.items : [];
            const items: ListedItem[] = raw.filter((item: any) => typeof item?.id === 'string' && typeof item?.type === 'string'
                && (typeof item?.sealed === 'string' || (typeof item?.url === 'string' && item.url.startsWith('https://'))));
            return { items, more: response.body?.more === true };
        },
        async download(url) {
            // The deadline covers the body too, so one stalled link can't hold up the pass.
            const response = await fetchFn(url, { redirect: 'error', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const text = await response.text();
            if (text.length > MAX_DOWNLOAD_BYTES) throw new Error('Item too large.');
            return text;
        },
        async ack(ids) {
            const response = await client.signed('relay', 'POST', '/inbox/ack', { ids });
            if (response.status < 200 || response.status >= 300) throw new Error(`Mailbox acknowledgement failed (${response.body?.error || response.status}).`);
        }
    };
}

export interface CloudLinkDeps {
    store: CloudDeviceStore & BookingRequestStore & AbdmInboxStore;
    keyStore: DeviceKeyStore;
    appVersion: string;
    baseUrl: (audience: Audience) => string | null;
    /** New booking requests were saved; tell the renderer. */
    onNewRequests?: (count: number) => void;
    /** Pairing state changed; tell the renderer. */
    onPairingChange?: (status: PairingStatus) => void;
    /** The doorbell connected or dropped, or a mailbox check finished. */
    onMailboxChange?: () => void;
    /** ABDM callbacks or data pushes were saved to `abdm_mailbox`. */
    onAbdmItems?: (count: number) => void;
    fetchFn?: typeof fetch;
    /** mqtt.connect, injectable for tests. */
    mqttConnect?: DoorbellDeps['connect'];
    nowMs?: () => number;
    /** DatabaseService.runWork: background cloud work that writes is drained by a restore. */
    runWork?: <T>(work: () => Promise<T>) => Promise<T>;
}

/**
 * Everything this computer does with NalamDesk Cloud, started only while it
 * is paired: the mailbox reader (on start, on each doorbell ring, every 30
 * minutes and on Refresh), the doorbell connection, and the yearly
 * signing-key rotation.
 */
export class CloudLink {
    readonly client: SignedCloudClient;
    readonly pairing: CloudPairingService;
    readonly booking: BookingInboxService;
    readonly mailbox: MailboxReader;
    readonly doorbell: Doorbell;
    private stopRotation: (() => void) | null = null;

    constructor(private readonly deps: CloudLinkDeps) {
        this.client = new SignedCloudClient({
            baseUrl: deps.baseUrl,
            identity: () => this.pairing.signingIdentity(),
            onRevoked: (code) => this.pairing.markRevoked(code === 'device_revoked' ? 'revoked' : 'unknown'),
            fetchFn: deps.fetchFn,
            nowMs: deps.nowMs
        });
        this.pairing = new CloudPairingService({
            store: deps.store,
            keyStore: deps.keyStore,
            client: this.client,
            appVersion: deps.appVersion,
            nowMs: deps.nowMs,
            runWork: deps.runWork,
            onChange: (status) => {
                this.apply(status);
                deps.onPairingChange?.(status);
            }
        });
        const sealing = this.pairing.sealingKey();
        this.booking = new BookingInboxService({ transport: bookingTransport(this.client), key: sealing, store: deps.store });
        const abdm = { store: deps.store, clinicId: () => sealing.clinicId(), privateKey: () => sealing.privateKey() };
        this.mailbox = new MailboxReader({
            transport: mailboxTransport(this.client, deps.fetchFn),
            handlers: {
                'booking-request': this.booking,
                'abdm-callback': new AbdmInboxHandler('abdm-callback', abdm),
                'abdm-data-push': new AbdmInboxHandler('abdm-data-push', abdm)
            },
            nowMs: deps.nowMs,
            runWork: deps.runWork,
            onSynced: (saved) => {
                deps.onMailboxChange?.();
                if (saved['booking-request']) deps.onNewRequests?.(saved['booking-request']);
                const abdmCount = (saved['abdm-callback'] ?? 0) + (saved['abdm-data-push'] ?? 0);
                if (abdmCount) deps.onAbdmItems?.(abdmCount);
            }
        });
        this.doorbell = new Doorbell({
            identity: {
                doorbellIdentity: () => this.pairing.doorbellIdentity(),
                saveDoorbellIdentity: (key, issued) => this.pairing.saveDoorbellIdentity(key, issued),
                clearDoorbellIdentity: () => this.pairing.clearDoorbellIdentity(),
                deviceId: () => this.pairing.status().deviceId ?? null
            },
            client: this.client,
            onConnected: () => this.mailbox.onDoorbell(),
            onRing: () => this.mailbox.onDoorbell(),
            onStateChange: () => deps.onMailboxChange?.(),
            connect: deps.mqttConnect,
            runWork: deps.runWork
        });
    }

    /** For the settings screen: is the doorbell live, and when was mail last checked. */
    mailboxStatus(): { doorbell: DoorbellState; lastCheckedAt: number | null } {
        return { doorbell: this.doorbell.state(), lastCheckedAt: this.mailbox.lastCheckedAt() };
    }

    /** Refresh: check the mailbox now. Resolves with new booking requests saved. */
    async checkMailbox(): Promise<number> {
        try {
            const saved = await this.mailbox.sync();
            return saved['booking-request'] ?? 0;
        } finally {
            this.deps.onMailboxChange?.();
        }
    }

    /** Call once the database is open. */
    start(): void {
        this.apply(this.pairing.status());
    }

    stop(): void {
        this.mailbox.stop();
        this.doorbell.stop();
        this.stopRotation?.();
        this.stopRotation = null;
    }

    private apply(status: PairingStatus): void {
        if (status.state !== 'paired' || !status.configured) {
            this.stop();
            return;
        }
        this.mailbox.start();
        this.doorbell.start();
        if (!this.stopRotation) this.stopRotation = scheduleRotation(() => this.pairing.rotateSigningKeyIfDue());
    }
}
