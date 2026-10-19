import {
    ConditionalCheckFailedException, GetItemCommand, PutItemCommand, TransactionCanceledException, TransactWriteItemsCommand, UpdateItemCommand
} from '@aws-sdk/client-dynamodb';
import { describe, expect, it } from 'vitest';
import { DynamoPairingRateLimiter, DynamoPairingStore, toDevice } from '../src/dynamoPairing.js';
import type { Device, PairingRequest } from '../src/pairing.js';

const tables = { devices: 'devices', pairing: 'pairing', clinicIds: 'clinic-ids' };

function recorder(respond: (command: any) => unknown = () => ({})) {
    const sent: any[] = [];
    const client = { send: async (command: any) => { sent.push(command); return respond(command); } } as never;
    return { sent, client };
}

const request: PairingRequest = {
    hfrId: 'IN2710000123', requestId: 'pr_abc', status: 'pending', signingPublicKey: 'sk', sealingPublicKey: 'xk',
    label: 'PC', appVersion: '2.4.0', createdAt: 1_000, expiresAt: 86_401_000
};

const device: Device = {
    deviceId: 'dev_new', clinicId: 'cln_1', hipId: 'IN2710000123', status: 'active', signingPublicKey: 'sk', signingKeyCreatedAt: 5,
    sealingPublicKey: 'xk', dataPushToken: 'tok', linkedToBridge: true, label: 'PC', appVersion: '2.4.0', pairedAt: 5, approvedBy: 'staff'
};

describe('DynamoPairingStore', () => {
    it('creates a request only if none is live, with TTL in seconds', async () => {
        const { sent, client } = recorder();
        expect(await new DynamoPairingStore(tables, { client }).createRequest(request, 2_000)).toBe(true);
        const input = (sent[0] as PutItemCommand).input;
        expect(input.ConditionExpression).toBe('attribute_not_exists(hfrId) OR expiresAtMs < :now');
        expect(input.Item).toMatchObject({ expiresAt: { N: '86401' }, expiresAtMs: { N: '86401000' }, status: { S: 'pending' } });

        const taken = recorder(() => { throw new ConditionalCheckFailedException({ message: 'x', $metadata: {} }); });
        expect(await new DynamoPairingStore(tables, { client: taken.client }).createRequest(request, 2_000)).toBe(false);
    });

    it('activates in one transaction: new device, old devices revoked, request deleted on its code hash', async () => {
        const { sent, client } = recorder();
        expect(await new DynamoPairingStore(tables, { client }).activate(device, ['dev_old'], { hfrId: 'IN2710000123', requestId: 'pr_abc', codeHash: 'h' }, 7, 'dev_old')).toBe(true);
        const items = (sent[0] as TransactWriteItemsCommand).input.TransactItems!;
        expect(items).toHaveLength(4);
        expect(items[0]!.Put).toMatchObject({ TableName: 'devices', ConditionExpression: 'attribute_not_exists(deviceId)' });
        expect(items[0]!.Put!.Item).toMatchObject({ status: { S: 'active' }, linkedToBridge: { BOOL: true }, dataPushToken: { S: 'tok' } });
        expect(items[1]!.Update).toMatchObject({ TableName: 'devices', Key: { deviceId: { S: 'dev_old' } }, ConditionExpression: '#status = :active' });
        expect(items[2]!.Update).toMatchObject({
            TableName: 'clinic-ids', UpdateExpression: 'SET activeDeviceId = :new',
            ConditionExpression: 'attribute_exists(clinicId) AND activeDeviceId = :expected', ExpressionAttributeValues: { ':expected': { S: 'dev_old' } }
        });
        expect(items[3]!.Delete).toMatchObject({ TableName: 'pairing', ConditionExpression: 'requestId = :id AND codeHash = :hash AND #status = :approved' });

        const raced = recorder(() => { throw new TransactionCanceledException({ message: 'x', $metadata: {} }); });
        expect(await new DynamoPairingStore(tables, { client: raced.client }).activate(device, [], { hfrId: 'IN2710000123', requestId: 'pr_abc', codeHash: 'h' }, 7, null)).toBe(false);
    });

    it('keeps one clinic ID per HFR ID, and reads the winner after a race', async () => {
        const existing = recorder(() => ({ Item: { hipId: { S: 'IN2710000123' }, clinicId: { S: 'cln_old' } } }));
        expect(await new DynamoPairingStore(tables, { client: existing.client }).clinicIdFor('IN2710000123')).toBe('cln_old');

        let reads = 0;
        const race = recorder((command) => {
            if (command instanceof GetItemCommand) return ++reads === 1 ? {} : { Item: { clinicId: { S: 'cln_winner' } } };
            throw new ConditionalCheckFailedException({ message: 'x', $metadata: {} });
        });
        expect(await new DynamoPairingStore(tables, { client: race.client }).clinicIdFor('IN2710000123')).toBe('cln_winner');
    });

    it('counts wrong codes atomically', async () => {
        const { sent, client } = recorder(() => ({ Attributes: { codeAttempts: { N: '3' } } }));
        expect(await new DynamoPairingStore(tables, { client }).recordFailedAttempt('IN2710000123', 'pr_abc')).toBe(3);
        expect((sent[0] as UpdateItemCommand).input).toMatchObject({ UpdateExpression: 'ADD codeAttempts :one', ConditionExpression: 'requestId = :id' });
    });

    it('rotates the key only while the old key is current', async () => {
        const { sent, client } = recorder();
        await new DynamoPairingStore(tables, { client }).rotateKey('dev_new', 'old', 'new', 99, 5);
        expect((sent[0] as UpdateItemCommand).input).toMatchObject({
            ConditionExpression: 'signingPublicKey = :old AND #status = :active',
            ExpressionAttributeValues: expect.objectContaining({ ':until': { N: '99' } })
        });
    });

    it('maps device rows', () => {
        expect(toDevice({ deviceId: { S: 'd' } })).toBeNull();
        expect(toDevice({
            deviceId: { S: 'd' }, clinicId: { S: 'c' }, hipId: { S: 'h' }, signingPublicKey: { S: 'k' }, status: { S: 'revoked' }, revokedReason: { S: 'replaced' }
        })).toMatchObject({ status: 'revoked', revokedReason: 'replaced', linkedToBridge: false });
    });
});

describe('DynamoPairingRateLimiter', () => {
    it('counts per IP per hour and per day in the nonces table', async () => {
        let hits = 0;
        const { sent, client } = recorder(() => ({ Attributes: { hits: { N: String(++hits) } } }));
        const limiter = new DynamoPairingRateLimiter('nonces', { client });
        expect(await limiter.allow('ipkey', 7_200_000)).toBe(true);
        const keys = sent.map((c: UpdateItemCommand) => c.input.Key!.nonceKey!.S);
        expect(keys).toEqual(['rl#pair-ip#ipkey#h2', 'rl#pair-ip#ipkey#d0']);
        expect((sent[0] as UpdateItemCommand).input.ExpressionAttributeValues![':ttl']).toEqual({ N: '14400' });

        const busy = recorder(() => ({ Attributes: { hits: { N: '6' } } }));
        expect(await new DynamoPairingRateLimiter('nonces', { client: busy.client }).allow('ipkey', 0)).toBe(false);
    });
});
