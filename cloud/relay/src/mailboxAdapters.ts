import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { DynamoMailbox } from '@nalamdesk/cloud-shared';
import type { Inbox, InboxItem, Mailbox } from './ports.js';

/** Download links for large items last this long; the desktop fetches right after listing. */
const LINK_SECONDS = 300;

/**
 * The shared DynamoDB/S3 mailbox as the relay sees it: callbacks and data
 * pushes go in, the paired desktop lists and acknowledges. Items kept in S3
 * are listed as presigned links, so a 5 MB data push never passes through
 * the relay's response.
 */
export class RelayMailbox implements Mailbox, Inbox {
    private readonly s3: S3Client;
    private readonly store: DynamoMailbox;

    constructor(private readonly options: { table: string; bucket: string; s3?: S3Client; store?: DynamoMailbox }) {
        this.s3 = options.s3 ?? new S3Client({});
        this.store = options.store ?? new DynamoMailbox({ table: options.table, bucket: options.bucket, s3: this.s3 });
    }

    put(item: Parameters<Mailbox['put']>[0]): Promise<string> {
        return this.store.put(item);
    }

    remove(clinicId: string, itemIds: string[]): Promise<void> {
        return this.store.ack(clinicId, itemIds);
    }

    async list(clinicId: string): Promise<{ items: InboxItem[]; more: boolean }> {
        const page = await this.store.list(clinicId);
        const items = await Promise.all(page.items.map(async (item): Promise<InboxItem> => {
            const base = { id: item.itemId, type: item.type, createdAt: item.createdAt };
            if (item.sealed) return { ...base, sealed: item.sealed };
            const url = await getSignedUrl(this.s3, new GetObjectCommand({ Bucket: this.options.bucket, Key: item.s3Key }), { expiresIn: LINK_SECONDS });
            return { ...base, url };
        }));
        return { items, more: page.more };
    }

    ack(clinicId: string, ids: string[]): Promise<void> {
        return this.store.ack(clinicId, ids);
    }

    purge(clinicId: string, beforeMs: number): Promise<number> {
        return this.store.purge(clinicId, beforeMs);
    }
}
