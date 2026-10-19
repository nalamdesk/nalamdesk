import log from 'electron-log';

// The one reader of this clinic's 48-hour cloud mailbox (#155). The relay
// stores ABDM callbacks and HIU data pushes there, the booking API stores
// online booking requests, all sealed to this computer's X25519 key. The
// reader lists items over a signed request, hands each to the handler for
// its type, and acknowledges what was saved (or can never be opened), which
// deletes it from the cloud. Anything else stays and is offered again on the
// next pass until it expires.
//
// Passes run on start, on every doorbell ring, every 30 minutes and on
// Refresh; calls that arrive mid-pass fold into one more pass.

export const FALLBACK_SYNC_MS = 30 * 60 * 1000;
/** Pages one pass reads at most (50 items each); the rest wait for the next pass. */
const MAX_PAGES = 20;

export interface ListedItem {
    id: string;
    type: string;
    createdAt?: number;
    /** Inline sealed envelope. */
    sealed?: string;
    /** Short-lived download link for a large sealed envelope. */
    url?: string;
}

export interface MailboxItem {
    id: string;
    type: string;
    sealed: string;
}

export interface MailboxTransport {
    list(): Promise<{ items: ListedItem[]; more: boolean }>;
    /** Fetches a large item's sealed envelope from its link. */
    download(url: string): Promise<string>;
    ack(ids: string[]): Promise<void>;
}

/**
 * `saved`: stored locally, acknowledge. `dropped`: can never be opened,
 * acknowledge so it is not offered again. `retry`: leave it in the mailbox.
 */
export type HandleResult = 'saved' | 'dropped' | 'retry';

export interface MailboxHandler {
    handle(item: MailboxItem): Promise<HandleResult> | HandleResult;
}

export type SyncCounts = Record<string, number>;

export interface MailboxReaderDeps {
    transport: MailboxTransport;
    handlers: Record<string, MailboxHandler>;
    /** After each pass, with the number of items saved per type. */
    onSynced?: (saved: SyncCounts) => void;
    nowMs?: () => number;
}

export class MailboxReader {
    private timer: NodeJS.Timeout | null = null;
    private running: Promise<SyncCounts> | null = null;
    private rerun = false;
    private lastChecked: number | null = null;

    constructor(private readonly deps: MailboxReaderDeps) {}

    start(): void {
        if (this.timer) return;
        this.sync().catch(() => undefined);
        this.timer = setInterval(() => this.sync().catch(() => undefined), FALLBACK_SYNC_MS);
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    /** When the last pass finished without an error. */
    lastCheckedAt(): number | null {
        return this.lastChecked;
    }

    onDoorbell(): void {
        this.sync().catch((error) => log.warn(`[Mailbox] Fetch after doorbell failed: ${(error as Error).message}`));
    }

    /** Resolves with the number of items saved per type. */
    sync(): Promise<SyncCounts> {
        if (this.running) {
            this.rerun = true;
            return this.running;
        }
        this.running = (async () => {
            const saved: SyncCounts = {};
            try {
                do {
                    this.rerun = false;
                    await this.pass(saved);
                } while (this.rerun);
                this.lastChecked = (this.deps.nowMs ?? Date.now)();
            } finally {
                this.running = null;
            }
            if (Object.keys(saved).length > 0) this.deps.onSynced?.(saved);
            return saved;
        })();
        return this.running;
    }

    private async pass(saved: SyncCounts): Promise<void> {
        for (let page = 0; page < MAX_PAGES; page++) {
            const { items, more } = await this.deps.transport.list();
            const done: string[] = [];
            for (const listed of items) {
                const handler = this.deps.handlers[listed.type];
                if (!handler) continue;
                let sealed = listed.sealed;
                try {
                    if (!sealed && listed.url) sealed = await this.deps.transport.download(listed.url);
                } catch (error) {
                    log.warn(`[Mailbox] Could not download item ${listed.id}: ${(error as Error).message}`);
                    continue;
                }
                if (!sealed) continue;
                let result: HandleResult;
                try {
                    result = await handler.handle({ id: listed.id, type: listed.type, sealed });
                } catch (error) {
                    log.error(`[Mailbox] Handler for ${listed.type} failed`, error);
                    result = 'retry';
                }
                if (result === 'retry') continue;
                done.push(listed.id);
                if (result === 'saved') saved[listed.type] = (saved[listed.type] ?? 0) + 1;
            }
            for (let i = 0; i < done.length; i += 100) await this.deps.transport.ack(done.slice(i, i + 100));
            // A page with nothing acknowledged would come back unchanged.
            if (!more || done.length === 0) return;
        }
    }
}
