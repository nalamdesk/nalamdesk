import * as crypto from 'node:crypto';
import { BatchWriteItemCommand, DynamoDBClient, PutItemCommand, QueryCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';
import { DeleteObjectsCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

// The shared 48-hour mailbox (#155). The relay (ABDM callbacks and HIU data
// pushes) and the booking API (booking requests) put sealed items for a
// clinic; the clinic's paired desktop lists them over a signed request and
// acknowledges what it saved, which deletes them. Nothing here can open an
// item: each is sealed to the clinic's X25519 key before it arrives.
//
// Items up to 300 KB live in the DynamoDB row. Larger ones (HIU data pushes
// can reach 5 MB) go to S3 under mailbox/<clinicId>/<itemId>, and the row
// keeps a pointer. DynamoDB TTL and an S3 lifecycle rule both drop anything
// left after 48 hours.

export const MAILBOX_LIMITS = {
    ttlMs: 48 * 60 * 60 * 1000,
    /** Sealed items larger than this go to S3. */
    inlineMaxBytes: 300 * 1024,
    /** Items one listing returns. */
    listMaxItems: 50,
    /** Inline bytes one listing returns; the rest wait for the next page. */
    listMaxInlineBytes: 3 * 1024 * 1024,
    /** IDs one acknowledgement may carry. */
    ackMaxIds: 100
};

export type MailboxItemType = 'abdm-callback' | 'abdm-data-push' | 'booking-request';

export interface MailboxPut {
    clinicId: string;
    type: MailboxItemType;
    /** Sealed envelope, base64. */
    sealed: string;
}

export interface StoredMailboxItem {
    itemId: string;
    clinicId: string;
    type: MailboxItemType;
    createdAt: number;
    size: number;
    /** Present for inline items. */
    sealed?: string;
    /** Present for items kept in S3. */
    s3Key?: string;
}

type DynamoClient = Pick<DynamoDBClient, 'send'>;
type S3 = Pick<S3Client, 'send'>;
type Item = Record<string, AttributeValue>;

const ITEM_ID = /^m[0-9a-z]{9}[0-9a-z]{16}$/;
const TYPES: readonly MailboxItemType[] = ['abdm-callback', 'abdm-data-push', 'booking-request'];

export const isMailboxItemId = (value: unknown): value is string => typeof value === 'string' && ITEM_ID.test(value);

/** Time-ordered, so a query returns the oldest mail first. */
export function newMailboxItemId(nowMs: number): string {
    return `m${nowMs.toString(36).padStart(9, '0')}${crypto.randomBytes(10).toString('hex').slice(0, 16)}`;
}

export const mailboxObjectKey = (clinicId: string, itemId: string) => `mailbox/${clinicId}/${itemId}`;

/** Lowest item ID that can be stored at or after `ms`: IDs sort by time. */
const itemIdFloor = (ms: number) => `m${Math.max(0, Math.floor(ms)).toString(36).padStart(9, '0')}`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function toStored(item: Item): StoredMailboxItem | null {
    const itemId = item.itemId?.S;
    const clinicId = item.clinicId?.S;
    const type = item.type?.S as MailboxItemType | undefined;
    if (!itemId || !clinicId || !type || !TYPES.includes(type)) return null;
    const stored: StoredMailboxItem = { itemId, clinicId, type, createdAt: Number(item.createdAt?.N ?? 0), size: Number(item.size?.N ?? 0) };
    if (item.sealed?.S) stored.sealed = item.sealed.S;
    else if (item.s3Key?.S) stored.s3Key = item.s3Key.S;
    else return null;
    return stored;
}

export interface DynamoMailboxOptions {
    table: string;
    bucket: string;
    dynamo?: DynamoClient;
    s3?: S3;
    nowMs?: () => number;
}

export class DynamoMailbox {
    private readonly dynamo: DynamoClient;
    private readonly s3: S3;
    private readonly nowMs: () => number;

    constructor(private readonly options: DynamoMailboxOptions) {
        this.dynamo = options.dynamo ?? new DynamoDBClient({});
        this.s3 = options.s3 ?? new S3Client({});
        this.nowMs = options.nowMs ?? Date.now;
    }

    /** Stores a sealed item for 48 hours; resolves with its item ID. */
    async put(input: MailboxPut): Promise<string> {
        const now = this.nowMs();
        const itemId = newMailboxItemId(now);
        const size = Buffer.byteLength(input.sealed, 'utf8');
        const item: Item = {
            clinicId: { S: input.clinicId },
            itemId: { S: itemId },
            type: { S: input.type },
            size: { N: String(size) },
            createdAt: { N: String(now) },
            expiresAt: { N: String(Math.ceil((now + MAILBOX_LIMITS.ttlMs) / 1000)) }
        };
        if (size > MAILBOX_LIMITS.inlineMaxBytes) {
            const key = mailboxObjectKey(input.clinicId, itemId);
            await this.s3.send(new PutObjectCommand({
                Bucket: this.options.bucket, Key: key, Body: input.sealed, ContentType: 'text/plain'
            }));
            item.s3Key = { S: key };
        } else {
            item.sealed = { S: input.sealed };
        }
        await this.dynamo.send(new PutItemCommand({ TableName: this.options.table, Item: item }));
        return itemId;
    }

    /**
     * The clinic's oldest unexpired items, up to the item and inline-byte
     * limits. `more` says another listing would return further items.
     */
    async list(clinicId: string): Promise<{ items: StoredMailboxItem[]; more: boolean }> {
        const now = this.nowMs();
        // The key condition starts at the 48-hour cut, so expired rows still
        // waiting for TTL deletion never use up the page's Limit.
        const result = await this.dynamo.send(new QueryCommand({
            TableName: this.options.table,
            KeyConditionExpression: 'clinicId = :c AND itemId >= :from',
            FilterExpression: 'expiresAt > :now',
            ExpressionAttributeValues: {
                ':c': { S: clinicId },
                ':from': { S: itemIdFloor(now - MAILBOX_LIMITS.ttlMs) },
                ':now': { N: String(Math.floor(now / 1000)) }
            },
            ConsistentRead: true,
            Limit: MAILBOX_LIMITS.listMaxItems + 1
        }));
        const items: StoredMailboxItem[] = [];
        let bytes = 0;
        let more = !!result.LastEvaluatedKey;
        for (const raw of result.Items ?? []) {
            const item = toStored(raw);
            if (!item) continue;
            const cost = item.sealed ? item.size : 0;
            if (items.length >= MAILBOX_LIMITS.listMaxItems || (items.length > 0 && bytes + cost > MAILBOX_LIMITS.listMaxInlineBytes)) {
                more = true;
                break;
            }
            items.push(item);
            bytes += cost;
        }
        return { items, more };
    }

    /**
     * Deletes the clinic's items with these IDs (and their S3 objects).
     * Unknown IDs are ignored. Throws if a row could not be deleted, before
     * any S3 object goes, so no row is left pointing at a missing object.
     */
    async ack(clinicId: string, itemIds: string[]): Promise<void> {
        const ids = [...new Set(itemIds.filter(isMailboxItemId))];
        for (let i = 0; i < ids.length; i += 25) {
            await this.batchDelete(clinicId, ids.slice(i, i + 25));
        }
        if (ids.length > 0) {
            await this.deleteObjects(ids.map((id) => mailboxObjectKey(clinicId, id)));
        }
    }

    /**
     * Drops a clinic's mail stored before `beforeMs`: its device was replaced
     * or revoked, and no later key can open it. Mail that arrives after the
     * replacement was sealed to the new key and stays.
     */
    async purge(clinicId: string, beforeMs: number): Promise<number> {
        const cut = itemIdFloor(beforeMs);
        let removed = await this.deleteRowsBefore(clinicId, cut);

        const prefix = `mailbox/${clinicId}/`;
        let token: string | undefined;
        do {
            const listing = await this.s3.send(new ListObjectsV2Command({ Bucket: this.options.bucket, Prefix: prefix, ContinuationToken: token }));
            const keys = (listing.Contents ?? []).map((object) => object.Key)
                .filter((key): key is string => !!key && key.slice(prefix.length) < cut);
            if (keys.length) {
                await this.deleteObjects(keys);
            }
            token = listing.IsTruncated ? listing.NextContinuationToken : undefined;
        } while (token);

        // A put stores its object before its row, so a row written while the
        // objects went may point at one just deleted. Sweep the rows again.
        removed += await this.deleteRowsBefore(clinicId, cut);
        return removed;
    }

    private async deleteRowsBefore(clinicId: string, cut: string): Promise<number> {
        let removed = 0;
        let startKey: Item | undefined;
        do {
            const page = await this.dynamo.send(new QueryCommand({
                TableName: this.options.table,
                KeyConditionExpression: 'clinicId = :c AND itemId < :cut',
                ExpressionAttributeValues: { ':c': { S: clinicId }, ':cut': { S: cut } },
                ProjectionExpression: 'itemId',
                ConsistentRead: true,
                ExclusiveStartKey: startKey
            }));
            const ids = (page.Items ?? []).map((item) => item.itemId?.S).filter((id): id is string => !!id);
            for (let i = 0; i < ids.length; i += 25) await this.batchDelete(clinicId, ids.slice(i, i + 25));
            removed += ids.length;
            startKey = page.LastEvaluatedKey;
        } while (startKey);
        return removed;
    }

    /** DeleteObjects reports per-key failures in a successful response: retry those, then throw. */
    private async deleteObjects(keys: string[]): Promise<void> {
        let pending = keys;
        for (let attempt = 0; attempt < 5; attempt++) {
            if (attempt > 0) await sleep(50 * 2 ** attempt);
            const result = await this.s3.send(new DeleteObjectsCommand({
                Bucket: this.options.bucket, Delete: { Objects: pending.map((Key) => ({ Key })), Quiet: true }
            }));
            pending = (result?.Errors ?? []).map((error) => error.Key).filter((key): key is string => !!key);
            if (!pending.length) return;
        }
        throw new Error('mailbox_delete_incomplete');
    }

    private async batchDelete(clinicId: string, ids: string[]): Promise<void> {
        let requests: Record<string, any[]> = {
            [this.options.table]: ids.map((id) => ({ DeleteRequest: { Key: { clinicId: { S: clinicId }, itemId: { S: id } } } }))
        };
        for (let attempt = 0; attempt < 5; attempt++) {
            if (attempt > 0) await sleep(50 * 2 ** attempt);
            const result = await this.dynamo.send(new BatchWriteItemCommand({ RequestItems: requests }));
            requests = (result.UnprocessedItems ?? {}) as Record<string, any[]>;
            if (!Object.values(requests).some((list) => list?.length)) return;
        }
        throw new Error('mailbox_delete_incomplete');
    }
}
