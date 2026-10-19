import { DynamoDBClient, QueryCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';
import type { Facility, FacilityDirectory } from './ports.js';

const CACHE_MS = 30 * 1000;

type Item = Record<string, AttributeValue>;

function toFacility(item: Item | undefined): Facility | null {
    if (!item || item.status?.S !== 'active') return null;
    const clinicId = item.clinicId?.S;
    const hipId = item.hipId?.S;
    const sealingPublicKey = item.sealingPublicKey?.S;
    if (!clinicId || !hipId || !sealingPublicKey) return null;
    return { clinicId, hipId, sealingPublicKey, linkedToBridge: item.linkedToBridge?.BOOL === true };
}

/**
 * Facility lookups against the Core devices table (#153). Only an active
 * device counts, so a revoked install stops receiving callbacks within the
 * 30-second cache window.
 */
export class DynamoFacilityDirectory implements FacilityDirectory {
    private readonly cache = new Map<string, { value: Facility | null; at: number }>();
    private readonly client: Pick<DynamoDBClient, 'send'>;
    private readonly nowMs: () => number;

    constructor(
        private readonly tableName: string,
        options: { client?: Pick<DynamoDBClient, 'send'>; nowMs?: () => number } = {}
    ) {
        this.client = options.client ?? new DynamoDBClient({});
        this.nowMs = options.nowMs ?? Date.now;
    }

    byHipId(hipId: string): Promise<Facility | null> {
        return this.lookup('byHipId', 'hipId', hipId);
    }

    byDataPushToken(token: string): Promise<Facility | null> {
        return this.lookup('byDataPushToken', 'dataPushToken', token);
    }

    private async lookup(indexName: string, attribute: string, value: string): Promise<Facility | null> {
        const key = `${indexName}:${value}`;
        const hit = this.cache.get(key);
        if (hit && this.nowMs() - hit.at < CACHE_MS) return hit.value;
        const result = await this.client.send(new QueryCommand({
            TableName: this.tableName,
            IndexName: indexName,
            KeyConditionExpression: '#k = :v',
            FilterExpression: '#s = :active',
            ExpressionAttributeNames: { '#k': attribute, '#s': 'status' },
            ExpressionAttributeValues: { ':v': { S: value }, ':active': { S: 'active' } }
        }));
        const facility = toFacility(result.Items?.[0]);
        this.cache.set(key, { value: facility, at: this.nowMs() });
        if (this.cache.size > 5000) this.cache.clear();
        return facility;
    }
}
