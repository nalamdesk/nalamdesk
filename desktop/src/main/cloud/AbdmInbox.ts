import type * as crypto from 'node:crypto';
import log from 'electron-log';
import type { HandleResult, MailboxHandler, MailboxItem } from './MailboxReader';
import { openSealed } from './mailboxSeal';

// ABDM items from the mailbox (#155): gateway callbacks and HIU data pushes
// the relay sealed to this computer. They are opened here and kept in the
// local `abdm_mailbox` table (inside the encrypted database) for the ABDM
// flows to pick up (#160). Saving is idempotent on the mailbox item ID, so
// an item offered twice is stored once.

export type AbdmInboxType = 'abdm-callback' | 'abdm-data-push';

export interface AbdmInboxRow {
    id: string;
    type: AbdmInboxType;
    /** Callback path, such as `/api/v3/hip/patient/share`; null for data pushes. */
    path: string | null;
    /** The callback's REQUEST-ID header, when present. */
    request_id: string | null;
    received_at: string | null;
    /** For a callback, `{ headers, body }`; for a data push, the HIP's JSON as sent. */
    payload: string;
}

export interface AbdmInboxStore {
    saveAbdmInboxItem(row: AbdmInboxRow): void;
}

export interface AbdmInboxDeps {
    store: AbdmInboxStore;
    clinicId: () => string;
    privateKey: () => crypto.KeyObject;
}

export class AbdmInboxHandler implements MailboxHandler {
    constructor(private readonly type: AbdmInboxType, private readonly deps: AbdmInboxDeps) {}

    handle(item: MailboxItem): HandleResult {
        let row: AbdmInboxRow;
        try {
            const plain = openSealed(item.sealed, this.deps.privateKey(), this.deps.clinicId(), this.type).toString('utf8');
            row = this.type === 'abdm-callback' ? callbackRow(item.id, plain) : { id: item.id, type: this.type, path: null, request_id: null, received_at: null, payload: plain };
        } catch (error) {
            log.warn(`[ABDM inbox] Dropping unreadable ${this.type}: ${(error as Error).message}`);
            return 'dropped';
        }
        try {
            this.deps.store.saveAbdmInboxItem(row);
            return 'saved';
        } catch (error) {
            log.error(`[ABDM inbox] Could not save a ${this.type}`, error);
            return 'retry';
        }
    }
}

/** The relay's callback envelope: `{ path, receivedAt, headers, body }`. */
function callbackRow(id: string, plain: string): AbdmInboxRow {
    const envelope = JSON.parse(plain);
    if (!envelope || typeof envelope.path !== 'string' || !envelope.path.startsWith('/api/v3/')) throw new Error('bad_callback');
    const headers = envelope.headers && typeof envelope.headers === 'object' ? envelope.headers : {};
    return {
        id,
        type: 'abdm-callback',
        path: envelope.path,
        request_id: typeof headers['request-id'] === 'string' ? headers['request-id'] : null,
        received_at: typeof envelope.receivedAt === 'string' ? envelope.receivedAt : null,
        payload: JSON.stringify({ headers, body: typeof envelope.body === 'string' ? envelope.body : '' })
    };
}
