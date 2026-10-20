import log from 'electron-log';
import { BookingInboxService, type BookingRequestStore, type ClinicCloudTransport, type MailboxEntry } from '../booking/BookingInboxService';
import type { DeviceKeyStore } from '../services/DeviceKeyStore';
import { CloudPairingService, type PairingStatus } from './CloudPairingService';
import type { CloudDeviceStore } from './DeviceIdentity';
import { SignedCloudClient, type Audience } from './SignedCloudClient';

// Hourly: cheap when nothing is due.
const ROTATION_CHECK_MS = 60 * 60 * 1000;
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

/**
 * The booking API over signed requests, and the shared mailbox on the relay.
 * Until the relay serves `/inbox` (#155), an absent route reads as an empty
 * mailbox.
 */
export function bookingTransport(client: SignedCloudClient): ClinicCloudTransport {
    return {
        send: (method, path, body) => client.signed('booking', method, path, body),
        async fetchInbox(): Promise<MailboxEntry[]> {
            const response = await client.signed('relay', 'GET', '/inbox');
            if (response.status === 404 && response.body?.error === 'not_found') return [];
            if (response.status !== 200) throw new Error(`Mailbox fetch failed (${response.body?.error || response.status}).`);
            const items = Array.isArray(response.body?.items) ? response.body.items : [];
            return items.filter((item: any) => typeof item?.id === 'string' && typeof item?.type === 'string' && typeof item?.sealed === 'string');
        },
        async ack(ids: string[]): Promise<void> {
            const response = await client.signed('relay', 'POST', '/inbox/ack', { ids });
            if (response.status < 200 || response.status >= 300) throw new Error(`Mailbox acknowledgement failed (${response.body?.error || response.status}).`);
        }
    };
}

export interface CloudLinkDeps {
    store: CloudDeviceStore & BookingRequestStore;
    keyStore: DeviceKeyStore;
    appVersion: string;
    baseUrl: (audience: Audience) => string | null;
    /** New booking requests were saved; tell the renderer. */
    onNewRequests?: (count: number) => void;
    /** Pairing state changed; tell the renderer. */
    onPairingChange?: (status: PairingStatus) => void;
    fetchFn?: typeof fetch;
    nowMs?: () => number;
    /** DatabaseService.runWork: background cloud work that writes is drained by a restore. */
    runWork?: <T>(work: () => Promise<T>) => Promise<T>;
}

/**
 * Everything this computer does with NalamDesk Cloud, started only while it
 * is paired: the booking inbox (fetch on start, every 30 minutes and on
 * Refresh) and the yearly signing-key rotation.
 */
export class CloudLink {
    readonly client: SignedCloudClient;
    readonly pairing: CloudPairingService;
    readonly booking: BookingInboxService;
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
        this.booking = new BookingInboxService({
            transport: bookingTransport(this.client),
            key: this.pairing.sealingKey(),
            store: deps.store,
            onNewRequests: deps.onNewRequests,
            runWork: deps.runWork
        });
    }

    /** Call once the database is open. */
    start(): void {
        this.apply(this.pairing.status());
    }

    stop(): void {
        this.booking.stop();
        this.stopRotation?.();
        this.stopRotation = null;
    }

    private apply(status: PairingStatus): void {
        if (status.state !== 'paired' || !status.configured) {
            this.stop();
            return;
        }
        this.booking.start();
        if (!this.stopRotation) this.stopRotation = scheduleRotation(() => this.pairing.rotateSigningKeyIfDue());
    }
}
