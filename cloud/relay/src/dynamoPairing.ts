import * as crypto from 'node:crypto';
import {
    ConditionalCheckFailedException, DeleteItemCommand, DynamoDBClient, GetItemCommand, PutItemCommand, QueryCommand,
    ScanCommand, TransactionCanceledException, TransactWriteItemsCommand, UpdateItemCommand, type AttributeValue
} from '@aws-sdk/client-dynamodb';
import { PAIRING_LIMITS, type Device, type PairingRateLimiter, type PairingRequest, type PairingStore } from './pairing.js';

type Client = Pick<DynamoDBClient, 'send'>;
type Item = Record<string, AttributeValue>;

export interface PairingTables {
    devices: string;
    pairing: string;
    clinicIds: string;
}

const s = (value: string): AttributeValue => ({ S: value });
const n = (value: number): AttributeValue => ({ N: String(value) });
const seconds = (ms: number) => Math.ceil(ms / 1000);

function conditionFailed(error: unknown): boolean {
    const name = (error as { name?: string })?.name;
    return error instanceof ConditionalCheckFailedException || error instanceof TransactionCanceledException ||
        name === 'ConditionalCheckFailedException' || name === 'TransactionCanceledException';
}

function requestItem(r: PairingRequest): Item {
    const item: Item = {
        hfrId: s(r.hfrId), requestId: s(r.requestId), status: s(r.status),
        signingPublicKey: s(r.signingPublicKey), sealingPublicKey: s(r.sealingPublicKey),
        label: s(r.label), appVersion: s(r.appVersion), createdAt: n(r.createdAt),
        // DynamoDB TTL wants epoch seconds; reads compare expiresAtMs.
        expiresAt: n(seconds(r.expiresAt)), expiresAtMs: n(r.expiresAt)
    };
    return item;
}

function toRequest(item: Item | undefined): PairingRequest | null {
    if (!item?.hfrId?.S || !item.requestId?.S || !item.signingPublicKey?.S || !item.sealingPublicKey?.S) return null;
    const request: PairingRequest = {
        hfrId: item.hfrId.S,
        requestId: item.requestId.S,
        status: item.status?.S === 'approved' ? 'approved' : 'pending',
        signingPublicKey: item.signingPublicKey.S,
        sealingPublicKey: item.sealingPublicKey.S,
        label: item.label?.S ?? '',
        appVersion: item.appVersion?.S ?? '',
        createdAt: Number(item.createdAt?.N ?? 0),
        expiresAt: Number(item.expiresAtMs?.N ?? Number(item.expiresAt?.N ?? 0) * 1000)
    };
    if (item.codeHash?.S) request.codeHash = item.codeHash.S;
    if (item.codeExpiresAt?.N) request.codeExpiresAt = Number(item.codeExpiresAt.N);
    if (item.codeAttempts?.N) request.codeAttempts = Number(item.codeAttempts.N);
    if (item.approvedBy?.S) request.approvedBy = item.approvedBy.S;
    if (item.approvedAt?.N) request.approvedAt = Number(item.approvedAt.N);
    return request;
}

export function deviceItem(d: Device): Item {
    const item: Item = {
        deviceId: s(d.deviceId), clinicId: s(d.clinicId), hipId: s(d.hipId), status: s(d.status),
        signingPublicKey: s(d.signingPublicKey), signingKeyCreatedAt: n(d.signingKeyCreatedAt),
        sealingPublicKey: s(d.sealingPublicKey), dataPushToken: s(d.dataPushToken), linkedToBridge: { BOOL: d.linkedToBridge },
        label: s(d.label), appVersion: s(d.appVersion), pairedAt: n(d.pairedAt), approvedBy: s(d.approvedBy)
    };
    if (d.previousSigningPublicKey) item.previousSigningPublicKey = s(d.previousSigningPublicKey);
    if (d.previousKeyValidUntil) item.previousKeyValidUntil = n(d.previousKeyValidUntil);
    if (d.revokedAt) item.revokedAt = n(d.revokedAt);
    if (d.revokedReason) item.revokedReason = s(d.revokedReason);
    if (d.revokedBy) item.revokedBy = s(d.revokedBy);
    return item;
}

export function toDevice(item: Item | undefined): Device | null {
    if (!item?.deviceId?.S || !item.clinicId?.S || !item.hipId?.S || !item.signingPublicKey?.S) return null;
    const device: Device = {
        deviceId: item.deviceId.S,
        clinicId: item.clinicId.S,
        hipId: item.hipId.S,
        status: item.status?.S === 'active' ? 'active' : 'revoked',
        signingPublicKey: item.signingPublicKey.S,
        signingKeyCreatedAt: Number(item.signingKeyCreatedAt?.N ?? 0),
        sealingPublicKey: item.sealingPublicKey?.S ?? '',
        dataPushToken: item.dataPushToken?.S ?? '',
        linkedToBridge: item.linkedToBridge?.BOOL === true,
        label: item.label?.S ?? '',
        appVersion: item.appVersion?.S ?? '',
        pairedAt: Number(item.pairedAt?.N ?? 0),
        approvedBy: item.approvedBy?.S ?? ''
    };
    if (item.previousSigningPublicKey?.S) device.previousSigningPublicKey = item.previousSigningPublicKey.S;
    if (item.previousKeyValidUntil?.N) device.previousKeyValidUntil = Number(item.previousKeyValidUntil.N);
    if (item.revokedAt?.N) device.revokedAt = Number(item.revokedAt.N);
    if (item.revokedReason?.S === 'replaced' || item.revokedReason?.S === 'ops') device.revokedReason = item.revokedReason.S;
    if (item.revokedBy?.S) device.revokedBy = item.revokedBy.S;
    return device;
}

/** Pairing requests, devices and clinic IDs in the Core tables (#153). */
export class DynamoPairingStore implements PairingStore {
    private readonly client: Client;

    constructor(private readonly tables: PairingTables, options: { client?: Client } = {}) {
        this.client = options.client ?? new DynamoDBClient({});
    }

    async getRequest(hfrId: string): Promise<PairingRequest | null> {
        const result = await this.client.send(new GetItemCommand({ TableName: this.tables.pairing, Key: { hfrId: s(hfrId) }, ConsistentRead: true }));
        return toRequest(result.Item);
    }

    async createRequest(request: PairingRequest, nowMs: number): Promise<boolean> {
        try {
            await this.client.send(new PutItemCommand({
                TableName: this.tables.pairing,
                Item: requestItem(request),
                // A lapsed request may be replaced before TTL removes it.
                ConditionExpression: 'attribute_not_exists(hfrId) OR expiresAtMs < :now',
                ExpressionAttributeValues: { ':now': n(nowMs) }
            }));
            return true;
        } catch (error) {
            if (conditionFailed(error)) return false;
            throw error;
        }
    }

    async deleteRequest(hfrId: string, requestId: string): Promise<boolean> {
        try {
            await this.client.send(new DeleteItemCommand({
                TableName: this.tables.pairing,
                Key: { hfrId: s(hfrId) },
                ConditionExpression: 'requestId = :id',
                ExpressionAttributeValues: { ':id': s(requestId) }
            }));
            return true;
        } catch (error) {
            if (conditionFailed(error)) return false;
            throw error;
        }
    }

    async listRequests(): Promise<PairingRequest[]> {
        // At most one row per HFR ID, each gone within a day: a scan stays small.
        const out: PairingRequest[] = [];
        let start: Item | undefined;
        do {
            const page = await this.client.send(new ScanCommand({ TableName: this.tables.pairing, ExclusiveStartKey: start, ConsistentRead: true }));
            for (const item of page.Items ?? []) {
                const request = toRequest(item);
                if (request) out.push(request);
            }
            start = page.LastEvaluatedKey;
        } while (start);
        return out;
    }

    async approve(hfrId: string, requestId: string, code: { hash: string; expiresAt: number }, approvedBy: string, nowMs: number): Promise<boolean> {
        try {
            await this.client.send(new UpdateItemCommand({
                TableName: this.tables.pairing,
                Key: { hfrId: s(hfrId) },
                UpdateExpression: 'SET #status = :approved, codeHash = :hash, codeExpiresAt = :codeExpiresAt, codeAttempts = :zero, approvedBy = :by, approvedAt = :now',
                ConditionExpression: 'requestId = :id AND expiresAtMs > :now',
                ExpressionAttributeNames: { '#status': 'status' },
                ExpressionAttributeValues: {
                    ':approved': s('approved'), ':hash': s(code.hash), ':codeExpiresAt': n(code.expiresAt), ':zero': n(0),
                    ':by': s(approvedBy), ':now': n(nowMs), ':id': s(requestId)
                }
            }));
            return true;
        } catch (error) {
            if (conditionFailed(error)) return false;
            throw error;
        }
    }

    async recordFailedAttempt(hfrId: string, requestId: string): Promise<number> {
        try {
            const result = await this.client.send(new UpdateItemCommand({
                TableName: this.tables.pairing,
                Key: { hfrId: s(hfrId) },
                UpdateExpression: 'ADD codeAttempts :one',
                ConditionExpression: 'requestId = :id',
                ExpressionAttributeValues: { ':one': n(1), ':id': s(requestId) },
                ReturnValues: 'UPDATED_NEW'
            }));
            return Number(result.Attributes?.codeAttempts?.N ?? PAIRING_LIMITS.maxCodeAttempts);
        } catch (error) {
            if (conditionFailed(error)) return PAIRING_LIMITS.maxCodeAttempts;
            throw error;
        }
    }

    async clinicIdFor(hipId: string): Promise<string> {
        const existing = await this.client.send(new GetItemCommand({ TableName: this.tables.clinicIds, Key: { hipId: s(hipId) }, ConsistentRead: true }));
        if (existing.Item?.clinicId?.S) return existing.Item.clinicId.S;
        const clinicId = `cln_${crypto.randomBytes(10).toString('hex')}`;
        try {
            await this.client.send(new PutItemCommand({
                TableName: this.tables.clinicIds,
                Item: { hipId: s(hipId), clinicId: s(clinicId) },
                ConditionExpression: 'attribute_not_exists(hipId)'
            }));
            return clinicId;
        } catch (error) {
            if (!conditionFailed(error)) throw error;
            const raced = await this.client.send(new GetItemCommand({ TableName: this.tables.clinicIds, Key: { hipId: s(hipId) }, ConsistentRead: true }));
            const value = raced.Item?.clinicId?.S;
            if (!value) throw error;
            return value;
        }
    }

    async devicesFor(hipId: string): Promise<Device[]> {
        const result = await this.client.send(new QueryCommand({
            TableName: this.tables.devices,
            IndexName: 'byHipId',
            KeyConditionExpression: 'hipId = :hip',
            ExpressionAttributeValues: { ':hip': s(hipId) }
        }));
        // The index is eventually consistent; read each row from the table.
        const ids = (result.Items ?? []).map((item) => item.deviceId?.S).filter((id): id is string => !!id);
        const devices = await Promise.all(ids.map((id) => this.getDevice(id)));
        return devices.filter((d): d is Device => d !== null);
    }

    async getDevice(deviceId: string): Promise<Device | null> {
        const result = await this.client.send(new GetItemCommand({ TableName: this.tables.devices, Key: { deviceId: s(deviceId) }, ConsistentRead: true }));
        return toDevice(result.Item);
    }

    async activate(device: Device, revokeDeviceIds: string[], request: { hfrId: string; requestId: string; codeHash: string }, nowMs: number): Promise<boolean> {
        try {
            await this.client.send(new TransactWriteItemsCommand({
                TransactItems: [
                    {
                        Put: {
                            TableName: this.tables.devices,
                            Item: deviceItem(device),
                            ConditionExpression: 'attribute_not_exists(deviceId)'
                        }
                    },
                    ...revokeDeviceIds.map((deviceId) => ({
                        Update: {
                            TableName: this.tables.devices,
                            Key: { deviceId: s(deviceId) },
                            UpdateExpression: 'SET #status = :revoked, revokedAt = :now, revokedReason = :replaced',
                            ConditionExpression: '#status = :active',
                            ExpressionAttributeNames: { '#status': 'status' },
                            ExpressionAttributeValues: { ':revoked': s('revoked'), ':now': n(nowMs), ':replaced': s('replaced'), ':active': s('active') }
                        }
                    })),
                    {
                        Delete: {
                            TableName: this.tables.pairing,
                            Key: { hfrId: s(request.hfrId) },
                            ConditionExpression: 'requestId = :id AND codeHash = :hash AND #status = :approved',
                            ExpressionAttributeNames: { '#status': 'status' },
                            ExpressionAttributeValues: { ':id': s(request.requestId), ':hash': s(request.codeHash), ':approved': s('approved') }
                        }
                    }
                ]
            }));
            return true;
        } catch (error) {
            if (conditionFailed(error)) return false;
            throw error;
        }
    }

    async revoke(deviceId: string, reason: 'ops', by: string, nowMs: number): Promise<boolean> {
        try {
            await this.client.send(new UpdateItemCommand({
                TableName: this.tables.devices,
                Key: { deviceId: s(deviceId) },
                UpdateExpression: 'SET #status = :revoked, revokedAt = :now, revokedReason = :reason, revokedBy = :by',
                ConditionExpression: '#status = :active',
                ExpressionAttributeNames: { '#status': 'status' },
                ExpressionAttributeValues: { ':revoked': s('revoked'), ':now': n(nowMs), ':reason': s(reason), ':by': s(by), ':active': s('active') }
            }));
            return true;
        } catch (error) {
            if (conditionFailed(error)) return false;
            throw error;
        }
    }

    async rotateKey(deviceId: string, oldKey: string, newKey: string, validUntil: number, nowMs: number): Promise<boolean> {
        try {
            await this.client.send(new UpdateItemCommand({
                TableName: this.tables.devices,
                Key: { deviceId: s(deviceId) },
                UpdateExpression: 'SET signingPublicKey = :new, previousSigningPublicKey = :old, previousKeyValidUntil = :until, signingKeyCreatedAt = :now',
                ConditionExpression: 'signingPublicKey = :old AND #status = :active',
                ExpressionAttributeNames: { '#status': 'status' },
                ExpressionAttributeValues: { ':new': s(newKey), ':old': s(oldKey), ':until': n(validUntil), ':now': n(nowMs), ':active': s('active') }
            }));
            return true;
        } catch (error) {
            if (conditionFailed(error)) return false;
            throw error;
        }
    }
}

/**
 * Pairing requests per client IP, hourly and daily, as counters in the Core
 * nonces table (`rl#...` keys) with their own TTL.
 */
export class DynamoPairingRateLimiter implements PairingRateLimiter {
    private readonly client: Client;

    constructor(private readonly noncesTable: string, options: { client?: Client } = {}) {
        this.client = options.client ?? new DynamoDBClient({});
    }

    private async count(key: string, expiresAtMs: number): Promise<number> {
        const result = await this.client.send(new UpdateItemCommand({
            TableName: this.noncesTable,
            Key: { nonceKey: s(key) },
            UpdateExpression: 'ADD hits :one SET expiresAt = if_not_exists(expiresAt, :ttl)',
            ExpressionAttributeValues: { ':one': n(1), ':ttl': n(seconds(expiresAtMs)) },
            ReturnValues: 'UPDATED_NEW'
        }));
        return Number(result.Attributes?.hits?.N ?? 0);
    }

    async allow(ipKey: string, nowMs: number): Promise<boolean> {
        const hour = Math.floor(nowMs / 3_600_000);
        const day = Math.floor(nowMs / 86_400_000);
        const [hourly, daily] = await Promise.all([
            this.count(`rl#pair-ip#${ipKey}#h${hour}`, (hour + 2) * 3_600_000),
            this.count(`rl#pair-ip#${ipKey}#d${day}`, (day + 2) * 86_400_000)
        ]);
        return hourly <= PAIRING_LIMITS.ipPerHour && daily <= PAIRING_LIMITS.ipPerDay;
    }
}
