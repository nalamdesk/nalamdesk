import { ConditionalCheckFailedException, GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { describe, expect, it } from 'vitest';
import { DynamoCertificateLedger } from '../src/certificateLedger.js';

function client(respond: (command: any) => unknown) {
    const sent: any[] = [];
    return { sent, send: async (command: any) => (sent.push(command), respond(command)) };
}

describe('DynamoCertificateLedger', () => {
    it('records a certificate only while the device is active', async () => {
        const db = client(() => ({ Attributes: { status: { S: 'active' }, iotCertArns: { SS: ['arn:old'] } } }));
        expect(await new DynamoCertificateLedger('devices', { client: db as never }).record('dev_1', 'arn:new')).toEqual(['arn:old']);
        const update = db.sent[0] as UpdateItemCommand;
        expect(update).toBeInstanceOf(UpdateItemCommand);
        expect(update.input).toMatchObject({
            TableName: 'devices', Key: { deviceId: { S: 'dev_1' } }, UpdateExpression: 'ADD iotCertArns :arn',
            ConditionExpression: '#status = :active', ExpressionAttributeValues: { ':arn': { SS: ['arn:new'] }, ':active': { S: 'active' } },
            ReturnValues: 'ALL_OLD'
        });
    });

    it('answers null once the device is revoked', async () => {
        const db = client(() => { throw new ConditionalCheckFailedException({ message: 'no', $metadata: {} }); });
        expect(await new DynamoCertificateLedger('devices', { client: db as never }).record('dev_1', 'arn:new')).toBeNull();
    });

    it('reads the recorded certificates consistently and forgets retired ones', async () => {
        const db = client((command) => (command instanceof GetItemCommand ? { Item: { iotCertArns: { SS: ['arn:a'] } } } : {}));
        const ledger = new DynamoCertificateLedger('devices', { client: db as never });
        expect(await ledger.recorded('dev_1')).toEqual(['arn:a']);
        expect((db.sent[0] as GetItemCommand).input.ConsistentRead).toBe(true);
        await ledger.forget('dev_1', ['arn:a']);
        expect((db.sent[1] as UpdateItemCommand).input).toMatchObject({ UpdateExpression: 'DELETE iotCertArns :arns', ExpressionAttributeValues: { ':arns': { SS: ['arn:a'] } } });
        await ledger.forget('dev_1', []);
        expect(db.sent).toHaveLength(2);
    });
});
