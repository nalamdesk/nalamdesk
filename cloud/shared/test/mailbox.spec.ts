import { BatchWriteItemCommand, PutItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb';
import { PublishCommand } from '@aws-sdk/client-iot-data-plane';
import { DeleteObjectsCommand, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { DynamoMailbox, IotDoorbell, isMailboxItemId, MAILBOX_LIMITS, newMailboxItemId } from '../src/index.js';

function client(respond: (command: any) => unknown = () => ({})) {
    const sent: any[] = [];
    return { sent, send: async (command: any) => { sent.push(command); return respond(command); } };
}

const NOW = 1_792_400_000_000;

describe('DynamoMailbox', () => {
    it('keeps small items inline with a 48-hour TTL', async () => {
        const dynamo = client();
        const s3 = client();
        const mailbox = new DynamoMailbox({ table: 'mail', bucket: 'b', dynamo: dynamo as never, s3: s3 as never, nowMs: () => NOW });
        const id = await mailbox.put({ clinicId: 'cln_1', type: 'booking-request', sealed: 'abc' });
        expect(isMailboxItemId(id)).toBe(true);
        expect(s3.sent).toHaveLength(0);
        const put = dynamo.sent[0] as PutItemCommand;
        expect(put.input.Item).toMatchObject({
            clinicId: { S: 'cln_1' }, itemId: { S: id }, sealed: { S: 'abc' }, type: { S: 'booking-request' },
            expiresAt: { N: String((NOW + MAILBOX_LIMITS.ttlMs) / 1000) }
        });
    });

    it('puts large items in S3 first and keeps a pointer', async () => {
        const dynamo = client();
        const s3 = client();
        const mailbox = new DynamoMailbox({ table: 'mail', bucket: 'b', dynamo: dynamo as never, s3: s3 as never, nowMs: () => NOW });
        const big = 'x'.repeat(MAILBOX_LIMITS.inlineMaxBytes + 1);
        const id = await mailbox.put({ clinicId: 'cln_1', type: 'abdm-data-push', sealed: big });
        expect((s3.sent[0] as PutObjectCommand).input).toMatchObject({ Bucket: 'b', Key: `mailbox/cln_1/${id}` });
        const item = (dynamo.sent[0] as PutItemCommand).input.Item!;
        expect(item.sealed).toBeUndefined();
        expect(item.s3Key).toEqual({ S: `mailbox/cln_1/${id}` });
    });

    it('lists oldest first within the item and byte limits', async () => {
        const rows = Array.from({ length: 3 }, (_, i) => ({
            clinicId: { S: 'cln_1' }, itemId: { S: newMailboxItemId(NOW + i) }, type: { S: 'abdm-callback' },
            size: { N: String(MAILBOX_LIMITS.listMaxInlineBytes / 2) }, createdAt: { N: String(NOW + i) }, sealed: { S: 's' }
        }));
        const dynamo = client(() => ({ Items: [...rows, { clinicId: { S: 'cln_1' }, itemId: { S: 'junk' } }] }));
        const mailbox = new DynamoMailbox({ table: 'mail', bucket: 'b', dynamo: dynamo as never, s3: client() as never, nowMs: () => NOW });
        const page = await mailbox.list('cln_1');
        expect(page.items.map((item) => item.itemId)).toEqual([rows[0]!.itemId.S, rows[1]!.itemId.S]);
        expect(page.more).toBe(true);
        expect((dynamo.sent[0] as QueryCommand).input).toMatchObject({ ConsistentRead: true, ExpressionAttributeValues: { ':c': { S: 'cln_1' } } });
    });

    it('starts the listing at the 48-hour cut, so expired rows cannot fill the page', async () => {
        const dynamo = client(() => ({ Items: [] }));
        const mailbox = new DynamoMailbox({ table: 'mail', bucket: 'b', dynamo: dynamo as never, s3: client() as never, nowMs: () => NOW });
        await mailbox.list('cln_1');
        const query = (dynamo.sent[0] as QueryCommand).input;
        expect(query.KeyConditionExpression).toBe('clinicId = :c AND itemId >= :from');
        const from = query.ExpressionAttributeValues![':from']!.S as string;
        expect(newMailboxItemId(NOW - MAILBOX_LIMITS.ttlMs - 1) < from).toBe(true);
        expect(newMailboxItemId(NOW - MAILBOX_LIMITS.ttlMs + 1) > from).toBe(true);
    });

    it('acknowledges only well-formed IDs, scoped to the clinic, and drops their S3 objects', async () => {
        const dynamo = client();
        const s3 = client();
        const mailbox = new DynamoMailbox({ table: 'mail', bucket: 'b', dynamo: dynamo as never, s3: s3 as never });
        const id = newMailboxItemId(NOW);
        await mailbox.ack('cln_1', [id, id, 'not-an-id']);
        const batch = (dynamo.sent[0] as BatchWriteItemCommand).input.RequestItems!.mail!;
        expect(batch).toEqual([{ DeleteRequest: { Key: { clinicId: { S: 'cln_1' }, itemId: { S: id } } } }]);
        expect((s3.sent[0] as DeleteObjectsCommand).input.Delete!.Objects).toEqual([{ Key: `mailbox/cln_1/${id}` }]);
    });

    it('retries unprocessed deletes and keeps the S3 objects when rows remain', async () => {
        let calls = 0;
        const stuck = client((command) => {
            if (!(command instanceof BatchWriteItemCommand)) return {};
            calls++;
            return { UnprocessedItems: command.input.RequestItems };
        });
        const s3 = client();
        const mailbox = new DynamoMailbox({ table: 'mail', bucket: 'b', dynamo: stuck as never, s3: s3 as never });
        await expect(mailbox.ack('cln_1', [newMailboxItemId(NOW)])).rejects.toThrow('mailbox_delete_incomplete');
        expect(calls).toBe(5);
        expect(s3.sent).toHaveLength(0);

        let first = true;
        const flaky = client((command) => {
            if (!(command instanceof BatchWriteItemCommand) || !first) return {};
            first = false;
            return { UnprocessedItems: command.input.RequestItems };
        });
        const ok = new DynamoMailbox({ table: 'mail', bucket: 'b', dynamo: flaky as never, s3: s3 as never });
        await ok.ack('cln_1', [newMailboxItemId(NOW)]);
        expect(flaky.sent.filter((c) => c instanceof BatchWriteItemCommand)).toHaveLength(2);
        expect(s3.sent).toHaveLength(1);
    });

    it('purges a clinic\'s mail stored before a replacement, and keeps what came after', async () => {
        const old = newMailboxItemId(NOW - 1);
        const fresh = newMailboxItemId(NOW + 1);
        // The row of a put that finished while the objects went shows up on the second sweep.
        let queries = 0;
        const late = newMailboxItemId(NOW - 2);
        const dynamo = client((command) => (command instanceof QueryCommand ? { Items: [{ itemId: { S: ++queries === 1 ? old : late } }] } : {}));
        const s3 = client((command) => (command instanceof ListObjectsV2Command
            ? { Contents: [{ Key: `mailbox/cln_1/${old}` }, { Key: `mailbox/cln_1/${fresh}` }] } : {}));
        const mailbox = new DynamoMailbox({ table: 'mail', bucket: 'b', dynamo: dynamo as never, s3: s3 as never });
        expect(await mailbox.purge('cln_1', NOW)).toBe(2);
        const query = (dynamo.sent[0] as QueryCommand).input;
        expect(query.ConsistentRead).toBe(true);
        const deleted = dynamo.sent.filter((c) => c instanceof BatchWriteItemCommand)
            .flatMap((c) => (c as BatchWriteItemCommand).input.RequestItems!.mail!.map((r) => r.DeleteRequest!.Key!.itemId!.S));
        expect(deleted).toEqual([old, late]);
        expect(query.KeyConditionExpression).toBe('clinicId = :c AND itemId < :cut');
        expect(old < (query.ExpressionAttributeValues![':cut']!.S as string)).toBe(true);
        expect(fresh > (query.ExpressionAttributeValues![':cut']!.S as string)).toBe(true);
        expect(dynamo.sent.some((c) => c instanceof BatchWriteItemCommand)).toBe(true);
        expect((s3.sent[1] as DeleteObjectsCommand).input.Delete!.Objects).toEqual([{ Key: `mailbox/cln_1/${old}` }]);
    });
});

describe('IotDoorbell', () => {
    it('publishes an empty message to the clinic topic', async () => {
        const iot = client();
        await new IotDoorbell('x-ats.iot.ap-south-1.amazonaws.com', 'nalamdesk/sandbox/clinic', { client: iot as never }).ring('cln_1');
        const input = (iot.sent[0] as PublishCommand).input;
        expect(input.topic).toBe('nalamdesk/sandbox/clinic/cln_1/mail');
        expect(input.payload).toHaveLength(0);
    });
});
