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
/** The relay's download links last 5 minutes; past this, the rest of a page is listed again for fresh links. */
const LINK_FRESH_MS = 4 * 60 * 1000;

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
    /** Oldest items first; `after` (an item ID) starts the page past it. */
    list(after?: string): Promise<{ items: ListedItem[]; more: boolean }>;
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
    /** After each successful pass, with the number of items saved per type (possibly none). */
    onSynced?: (saved: SyncCounts) => void;
    nowMs?: () => number;
    /**
     * Each item's save and acknowledgement run as one unit of work, so a
     * restore drains them; listing and downloads run outside it and never
     * hold a restore up.
     */
    runWork?: <T>(work: () => Promise<T>) => Promise<T>;
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
            this.deps.onSynced?.(saved);
            return saved;
        })();
        return this.running;
    }

    private work<T>(task: () => Promise<T>): Promise<T> {
        return this.deps.runWork ? this.deps.runWork(task) : task();
    }

    private async pass(saved: SyncCounts): Promise<void> {
        const now = this.deps.nowMs ?? Date.now;
        let after: string | undefined;
        for (let page = 0; page < MAX_PAGES; page++) {
            const { items, more } = await this.deps.transport.list(after);
            const listedAt = now();
            let reached = 0;
            for (; reached < items.length; reached++) {
                const listed = items[reached]!;
                // Slow downloads earlier on the page must not leave later links expired.
                if (!listed.sealed && listed.url && now() - listedAt > LINK_FRESH_MS) break;
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
                const item: MailboxItem = { id: listed.id, type: listed.type, sealed };
                // Acknowledged before the work ends: a restore must not land
                // between the save and the cloud deleting its copy.
                const result = await this.work(async () => {
                    let outcome: HandleResult;
                    try {
                        outcome = await handler.handle(item);
                    } catch (error) {
                        log.error(`[Mailbox] Handler for ${item.type} failed`, error);
                        outcome = 'retry';
                    }
                    if (outcome !== 'retry') {
                        // A failed delete leaves the item to be saved again
                        // (saves are idempotent) and must not stop newer mail.
                        try {
                            await this.deps.transport.ack([item.id]);
                        } catch (error) {
                            log.warn(`[Mailbox] Could not acknowledge item ${item.id}: ${(error as Error).message}`);
                        }
                    }
                    return outcome;
                });
                if (result === 'saved') saved[item.type] = (saved[item.type] ?? 0) + 1;
            }
            if (reached < items.length) {
                // Lists the rest again with fresh links, starting past the last
                // item reached. Each refresh moves forward (the first item is
                // always reached), so it does not count against the page budget.
                if (reached > 0) after = items[reached - 1]!.id;
                page--;
                continue;
            }
            if (!more || items.length === 0) return;
            // Items kept for a retry stay ahead of the rest, so the next page
            // starts past this one; they are tried again on the next pass.
            after = items[items.length - 1]!.id;
        }
    }
}
