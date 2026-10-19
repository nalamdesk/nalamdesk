import { ConditionalCheckFailedException, GetItemCommand, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { describe, expect, it } from 'vitest';
import { DynamoDeviceRegistry, DynamoNonceStore } from '../src/index.js';

const row = {
    deviceId: { S: 'dev_0123456789' },
    clinicId: { S: 'cln_1' },
    hipId: { S: 'IN2710000123' },
    status: { S: 'active' },
    signingPublicKey: { S: 'key' },
    sealingPublicKey: { S: 'not needed here' }
};

describe('DynamoDeviceRegistry', () => {
    it('reads a device by ID and caches it for 30 seconds', async () => {
        const sent: unknown[] = [];
        let now = 0;
        const registry = new DynamoDeviceRegistry('devices', {
            client: { send: async (command: unknown) => { sent.push(command); return { Item: row }; } } as never,
            nowMs: () => now
        });
        expect(await registry.get('dev_0123456789')).toEqual({
            deviceId: 'dev_0123456789', clinicId: 'cln_1', hipId: 'IN2710000123', status: 'active', signingPublicKey: 'key'
        });
        expect(sent[0]).toBeInstanceOf(GetItemCommand);
        expect((sent[0] as GetItemCommand).input).toEqual({ TableName: 'devices', Key: { deviceId: { S: 'dev_0123456789' } } });
        now = 29_999;
        await registry.get('dev_0123456789');
        expect(sent).toHaveLength(1);
        now = 30_000;
        await registry.get('dev_0123456789');
        expect(sent).toHaveLength(2);
    });

    it('maps the rotation overlap and rejects incomplete rows', async () => {
        const items = [
            { ...row, previousSigningPublicKey: { S: 'old' }, previousKeyValidUntil: { N: '123' } },
            { ...row, status: { S: 'pending' } },
            undefined
        ];
        const registry = new DynamoDeviceRegistry('devices', { client: { send: async () => ({ Item: items.shift() }) } as never });
        expect(await registry.get('a_device_1')).toMatchObject({ previousSigningPublicKey: 'old', previousKeyValidUntil: 123 });
        expect(await registry.get('a_device_2')).toBeNull();
        expect(await registry.get('a_device_3')).toBeNull();
    });
});

describe('DynamoNonceStore', () => {
    it('claims a nonce with a conditional put and a TTL in seconds', async () => {
        const sent: PutItemCommand[] = [];
        const store = new DynamoNonceStore('nonces', { client: { send: async (c: PutItemCommand) => { sent.push(c); return {}; } } as never });
        expect(await store.claim('dev#n', 1_792_400_300_500)).toBe(true);
        expect(sent[0]!.input).toEqual({
            TableName: 'nonces',
            Item: { nonceKey: { S: 'dev#n' }, expiresAt: { N: '1792400301' } },
            ConditionExpression: 'attribute_not_exists(nonceKey)'
        });
    });

    it('reports a replay when the condition fails, and rethrows other errors', async () => {
        const conditional = new ConditionalCheckFailedException({ message: 'exists', $metadata: {} });
        const store = new DynamoNonceStore('nonces', { client: { send: async () => { throw conditional; } } as never });
        expect(await store.claim('dev#n', 0)).toBe(false);
        const broken = new DynamoNonceStore('nonces', { client: { send: async () => { throw new Error('throttled'); } } as never });
        await expect(broken.claim('dev#n', 0)).rejects.toThrow('throttled');
    });
});
