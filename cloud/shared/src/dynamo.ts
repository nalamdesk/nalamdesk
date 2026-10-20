import { ConditionalCheckFailedException, DynamoDBClient, GetItemCommand, PutItemCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';
import type { DeviceRecord, DeviceRegistry, NonceStore } from './verifier.js';
import { VERIFIER_LIMITS } from './verifier.js';

type Client = Pick<DynamoDBClient, 'send'>;
type Item = Record<string, AttributeValue>;

export function toDeviceRecord(item: Item | undefined): DeviceRecord | null {
    const deviceId = item?.deviceId?.S;
    const clinicId = item?.clinicId?.S;
    const hipId = item?.hipId?.S;
    const signingPublicKey = item?.signingPublicKey?.S;
    const status = item?.status?.S;
    if (!deviceId || !clinicId || !hipId || !signingPublicKey || (status !== 'active' && status !== 'revoked')) return null;
    const record: DeviceRecord = { deviceId, clinicId, hipId, status, signingPublicKey };
    if (item?.previousSigningPublicKey?.S && item.previousKeyValidUntil?.N) {
        record.previousSigningPublicKey = item.previousSigningPublicKey.S;
        record.previousKeyValidUntil = Number(item.previousKeyValidUntil.N);
    }
    return record;
}

/**
 * Device lookups by ID against the Core devices table. Rows, and misses,
 * are cached for 30 seconds, so a revocation reaches every environment
 * within that window.
 */
export class DynamoDeviceRegistry implements DeviceRegistry {
    private readonly cache = new Map<string, { value: DeviceRecord | null; at: number }>();
    private readonly client: Client;
    private readonly nowMs: () => number;

    constructor(private readonly tableName: string, options: { client?: Client; nowMs?: () => number } = {}) {
        this.client = options.client ?? new DynamoDBClient({});
        this.nowMs = options.nowMs ?? Date.now;
    }

    async get(deviceId: string, options: { fresh?: boolean } = {}): Promise<DeviceRecord | null> {
        const hit = this.cache.get(deviceId);
        if (!options.fresh && hit && this.nowMs() - hit.at < VERIFIER_LIMITS.deviceCacheMs) return hit.value;
        const result = await this.client.send(new GetItemCommand({
            TableName: this.tableName, Key: { deviceId: { S: deviceId } }, ...(options.fresh ? { ConsistentRead: true } : {})
        }));
        const value = toDeviceRecord(result.Item);
        if (this.cache.size > 5000) this.cache.clear();
        this.cache.set(deviceId, { value, at: this.nowMs() });
        return value;
    }
}

/**
 * Replay check against the Core nonces table: a conditional put that fails
 * if the key exists. DynamoDB TTL (epoch seconds in expiresAt) removes old
 * nonces; that is lazy, which only keeps them longer.
 */
export class DynamoNonceStore implements NonceStore {
    private readonly client: Client;

    constructor(private readonly tableName: string, options: { client?: Client } = {}) {
        this.client = options.client ?? new DynamoDBClient({});
    }

    async claim(key: string, expiresAtMs: number): Promise<boolean> {
        try {
            await this.client.send(new PutItemCommand({
                TableName: this.tableName,
                Item: { nonceKey: { S: key }, expiresAt: { N: String(Math.ceil(expiresAtMs / 1000)) } },
                ConditionExpression: 'attribute_not_exists(nonceKey)'
            }));
            return true;
        } catch (error) {
            if (error instanceof ConditionalCheckFailedException || (error as { name?: string })?.name === 'ConditionalCheckFailedException') return false;
            throw error;
        }
    }
}
