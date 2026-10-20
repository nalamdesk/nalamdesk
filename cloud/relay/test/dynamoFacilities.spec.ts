import { describe, expect, it, vi } from 'vitest';
import { DynamoFacilityDirectory } from '../src/dynamoFacilities.js';

const active = {
    deviceId: { S: 'dev-1' }, clinicId: { S: 'clinic-1' }, hipId: { S: 'IN27' },
    sealingPublicKey: { S: 'key' }, linkedToBridge: { BOOL: true }, status: { S: 'active' }
};

describe('DynamoFacilityDirectory', () => {
    it('queries the HIP ID index for an active device', async () => {
        const client = { send: vi.fn(async () => ({ Items: [active] })) };
        const directory = new DynamoFacilityDirectory('devices', { client: client as any });
        expect(await directory.byHipId('IN27')).toEqual({ deviceId: 'dev-1', clinicId: 'clinic-1', hipId: 'IN27', sealingPublicKey: 'key', linkedToBridge: true });
        const input = (client.send.mock.calls[0] as any)[0].input;
        expect(input).toMatchObject({ TableName: 'devices', IndexName: 'byHipId', ExpressionAttributeValues: { ':v': { S: 'IN27' }, ':active': { S: 'active' } } });
    });

    it('treats revoked or incomplete rows as unknown', async () => {
        const client = { send: vi.fn(async () => ({ Items: [{ ...active, status: { S: 'revoked' } }] })) };
        const directory = new DynamoFacilityDirectory('devices', { client: client as any });
        expect(await directory.byDataPushToken('t')).toBeNull();
        const partial = { send: vi.fn(async () => ({ Items: [{ ...active, sealingPublicKey: undefined }] })) };
        expect(await new DynamoFacilityDirectory('devices', { client: partial as any }).byHipId('IN27')).toBeNull();
    });

    it('caches lookups for 30 seconds', async () => {
        const now = { t: 0 };
        const client = { send: vi.fn(async () => ({ Items: [active] })) };
        const directory = new DynamoFacilityDirectory('devices', { client: client as any, nowMs: () => now.t });
        await directory.byHipId('IN27');
        now.t = 29_000;
        await directory.byHipId('IN27');
        expect(client.send).toHaveBeenCalledTimes(1);
        now.t = 30_000;
        await directory.byHipId('IN27');
        expect(client.send).toHaveBeenCalledTimes(2);
    });

    it('checks the device is still current with a consistent read, and forgets it if not', async () => {
        let row: Record<string, unknown> = { status: { S: 'active' }, sealingPublicKey: { S: 'key' } };
        const client = { send: vi.fn(async (command: any) => (command.input.IndexName ? { Items: [active] } : { Item: row })) };
        const directory = new DynamoFacilityDirectory('devices', { client: client as any, nowMs: () => 0 });
        const facility = (await directory.byHipId('IN27'))!;
        expect(await directory.stillCurrent(facility)).toBe(true);
        expect((client.send.mock.calls[1] as any)[0].input).toMatchObject({ TableName: 'devices', Key: { deviceId: { S: 'dev-1' } }, ConsistentRead: true });
        row = { status: { S: 'revoked' }, sealingPublicKey: { S: 'key' } };
        expect(await directory.stillCurrent(facility)).toBe(false);
        await directory.byHipId('IN27');
        expect(client.send.mock.calls.filter((c: any) => c[0].input.IndexName)).toHaveLength(2);
        expect(await directory.stillCurrent({ ...facility, deviceId: undefined })).toBe(false);
    });
});
