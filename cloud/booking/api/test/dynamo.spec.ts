import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import { DynamoBookingStore, DynamoSlotStore } from '../src/dynamo.js';

function fakeClient(respond: (name: string, input: Record<string, any>) => unknown) {
    const sent: { name: string; input: Record<string, any> }[] = [];
    const client = {
        send: async (command: { constructor: { name: string }; input: Record<string, any> }) => {
            sent.push({ name: command.constructor.name, input: command.input });
            return respond(command.constructor.name, command.input);
        }
    } as unknown as DynamoDBDocumentClient;
    return { client, sent };
}

const conditionFailed = () => {
    throw new ConditionalCheckFailedException({ message: 'no', $metadata: {} });
};

describe('DynamoDB adapters', () => {
    it('holds a slot with a conditional update and reports a lost race as false', async () => {
        const { client, sent } = fakeClient(() => ({}));
        const slots = new DynamoSlotStore(client, 'slots');
        expect(await slots.hold('c1', '2026-10-20T10:00', 'REF000000001', 2000, 1000)).toBe(true);
        const update = sent[0]!.input;
        expect(update.ConditionExpression).toBe('attribute_exists(slotId) AND (#s = :available OR (#s = :held AND heldUntil <= :now))');
        expect(update.ExpressionAttributeValues).toMatchObject({ ':ref': 'REF000000001', ':until': 2000, ':now': 1000 });

        const lost = new DynamoSlotStore(fakeClient(conditionFailed).client, 'slots');
        expect(await lost.hold('c1', '2026-10-20T10:00', 'REF000000002', 2000, 1000)).toBe(false);
    });

    it('rethrows errors that are not a failed condition', async () => {
        const slots = new DynamoSlotStore(fakeClient(() => { throw new Error('throttled'); }).client, 'slots');
        await expect(slots.book('c1', 's', 'r')).rejects.toThrow('throttled');
    });

    it('writes bookings with the phone index and a TTL in seconds, and never overwrites one', async () => {
        const { client, sent } = fakeClient(() => ({}));
        const bookings = new DynamoBookingStore(client, 'bookings');
        await bookings.create({ ref: 'R', clinicId: 'c1', slotId: null, status: 'requested', phoneKey: 'k', createdAt: 1, expiresAt: 172_800_500 });
        expect(sent[0]!.input.Item).toMatchObject({ phoneIndex: 'c1#k', ttl: 172_801 });
        expect(sent[0]!.input.ConditionExpression).toBe('attribute_not_exists(#ref)');
    });

    it('counts open requests on the phone index', async () => {
        const { client, sent } = fakeClient(() => ({ Count: 2 }));
        expect(await new DynamoBookingStore(client, 'bookings').countOpen('c1', 'k', 5)).toBe(2);
        expect(sent[0]!.input).toMatchObject({ IndexName: 'byPhone', Select: 'COUNT', ExpressionAttributeValues: { ':p': 'c1#k', ':now': 5 } });
    });

    it('lists a clinic\'s slots by date range on the sort key', async () => {
        const { client, sent } = fakeClient(() => ({ Items: [{ slotId: '2026-10-20T10:00' }] }));
        const list = await new DynamoSlotStore(client, 'slots').listBetween('c1', '2026-10-20', '2026-10-21');
        expect(list).toHaveLength(1);
        expect(sent[0]!.input.ExpressionAttributeValues).toEqual({ ':c': 'c1', ':from': '2026-10-20T', ':to': '2026-10-21T~' });
    });
});
