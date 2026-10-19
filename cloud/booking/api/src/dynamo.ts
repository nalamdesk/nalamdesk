// DynamoDB adapters for the booking stack's own tables. Table names come from
// the CDK stack (infra/), which also sets TTL on `ttl` and the phone index.
//   clinics:  PK clinicId
//   slots:    PK clinicId, SK slotId (`YYYY-MM-DDTHH:MM`)
//   bookings: PK ref, GSI `byPhone` on phoneIndex (`clinicId#phoneKey`), TTL `ttl`
import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
    DeleteCommand,
    DynamoDBDocumentClient,
    GetCommand,
    PutCommand,
    QueryCommand,
    ScanCommand,
    UpdateCommand
} from '@aws-sdk/lib-dynamodb';
import type { Booking, BookingStore, Clinic, ClinicListing, ClinicStore, Slot, SlotStore } from './ports.js';
import { slotIdOf } from './validate.js';

export interface BookingTables {
    clinics: string;
    slots: string;
    bookings: string;
}

export function documentClient(region?: string): DynamoDBDocumentClient {
    return DynamoDBDocumentClient.from(new DynamoDBClient(region ? { region } : {}), {
        marshallOptions: { removeUndefinedValues: true }
    });
}

async function conditional(run: () => Promise<unknown>): Promise<boolean> {
    try {
        await run();
        return true;
    } catch (error) {
        if (error instanceof ConditionalCheckFailedException || (error as { name?: string })?.name === 'ConditionalCheckFailedException') return false;
        throw error;
    }
}

const epochSeconds = (ms: number) => Math.ceil(ms / 1000);

export class DynamoClinicStore implements ClinicStore {
    constructor(private readonly db: DynamoDBDocumentClient, private readonly table: string) {}

    async get(clinicId: string) {
        const { Item } = await this.db.send(new GetCommand({ TableName: this.table, Key: { clinicId } }));
        return (Item as Clinic | undefined) ?? null;
    }

    async listListed() {
        const clinics: Clinic[] = [];
        let start: Record<string, unknown> | undefined;
        do {
            const page = await this.db.send(new ScanCommand({
                TableName: this.table,
                FilterExpression: '#listed = :yes',
                ExpressionAttributeNames: { '#listed': 'listed' },
                ExpressionAttributeValues: { ':yes': true },
                ExclusiveStartKey: start
            }));
            clinics.push(...((page.Items ?? []) as Clinic[]));
            start = page.LastEvaluatedKey;
        } while (start);
        return clinics;
    }

    async upsertListing(clinicId: string, listing: ClinicListing, nowMs: number) {
        await this.db.send(new UpdateCommand({
            TableName: this.table,
            Key: { clinicId },
            UpdateExpression: 'SET #name = :name, city = :city, specialty = :specialty, sealingPublicKey = :key, listed = :yes, lastSeenAt = :now, online = if_not_exists(online, :no)',
            ExpressionAttributeNames: { '#name': 'name' },
            ExpressionAttributeValues: {
                ':name': listing.name,
                ':city': listing.city,
                ':specialty': listing.specialty,
                ':key': listing.sealingPublicKey,
                ':yes': true,
                ':no': false,
                ':now': nowMs
            }
        }));
    }

    async unlist(clinicId: string, nowMs: number) {
        await conditional(() => this.db.send(new UpdateCommand({
            TableName: this.table,
            Key: { clinicId },
            UpdateExpression: 'SET listed = :no, lastSeenAt = :now',
            ConditionExpression: 'attribute_exists(clinicId)',
            ExpressionAttributeValues: { ':no': false, ':now': nowMs }
        })));
    }

    async touch(clinicId: string, nowMs: number) {
        await conditional(() => this.db.send(new UpdateCommand({
            TableName: this.table,
            Key: { clinicId },
            UpdateExpression: 'SET lastSeenAt = :now',
            ConditionExpression: 'attribute_exists(clinicId) AND lastSeenAt < :now',
            ExpressionAttributeValues: { ':now': nowMs }
        })));
    }

    async setPresence(clinicId: string, online: boolean, atMs: number) {
        await conditional(() => this.db.send(new UpdateCommand({
            TableName: this.table,
            Key: { clinicId },
            UpdateExpression: 'SET online = :online, lastSeenAt = :at',
            ConditionExpression: 'attribute_exists(clinicId) AND lastSeenAt <= :at',
            ExpressionAttributeValues: { ':online': online, ':at': atMs }
        })));
    }
}

export class DynamoSlotStore implements SlotStore {
    constructor(private readonly db: DynamoDBDocumentClient, private readonly table: string) {}

    async get(clinicId: string, slotId: string) {
        const { Item } = await this.db.send(new GetCommand({ TableName: this.table, Key: { clinicId, slotId } }));
        return (Item as Slot | undefined) ?? null;
    }

    async listBetween(clinicId: string, fromDate: string, toDate: string) {
        const slots: Slot[] = [];
        let start: Record<string, unknown> | undefined;
        do {
            const page = await this.db.send(new QueryCommand({
                TableName: this.table,
                KeyConditionExpression: 'clinicId = :c AND slotId BETWEEN :from AND :to',
                ExpressionAttributeValues: { ':c': clinicId, ':from': `${fromDate}T`, ':to': `${toDate}T~` },
                ExclusiveStartKey: start
            }));
            slots.push(...((page.Items ?? []) as Slot[]));
            start = page.LastEvaluatedKey;
        } while (start);
        return slots;
    }

    async publish(clinicId: string, dates: string[], slots: { date: string; time: string }[], nowMs: number) {
        const wanted = new Set(slots.map((s) => slotIdOf(s.date, s.time)));
        const existing = (await Promise.all(dates.map((d) => this.listBetween(clinicId, d, d)))).flat();
        const stale = existing.filter((row) => !wanted.has(row.slotId));
        const have = new Set(existing.map((row) => row.slotId));
        // Each delete and put is conditional, so a booking that lands mid-publish keeps its slot.
        await Promise.all(stale.map((row) => conditional(() => this.db.send(new DeleteCommand({
            TableName: this.table,
            Key: { clinicId, slotId: row.slotId },
            ConditionExpression: '#s = :available OR (#s = :held AND heldUntil <= :now)',
            ExpressionAttributeNames: { '#s': 'state' },
            ExpressionAttributeValues: { ':available': 'available', ':held': 'held', ':now': nowMs }
        })))));
        await Promise.all(slots.filter((s) => !have.has(slotIdOf(s.date, s.time))).map((s) => conditional(() => this.db.send(new PutCommand({
            TableName: this.table,
            Item: { clinicId, slotId: slotIdOf(s.date, s.time), date: s.date, time: s.time, state: 'available' },
            ConditionExpression: 'attribute_not_exists(slotId)'
        })))));
    }

    hold(clinicId: string, slotId: string, ref: string, untilMs: number, nowMs: number) {
        return conditional(() => this.db.send(new UpdateCommand({
            TableName: this.table,
            Key: { clinicId, slotId },
            UpdateExpression: 'SET #s = :held, #ref = :ref, heldUntil = :until',
            ConditionExpression: 'attribute_exists(slotId) AND (#s = :available OR (#s = :held AND heldUntil <= :now))',
            ExpressionAttributeNames: { '#s': 'state', '#ref': 'ref' },
            ExpressionAttributeValues: { ':held': 'held', ':available': 'available', ':ref': ref, ':until': untilMs, ':now': nowMs }
        })));
    }

    book(clinicId: string, slotId: string, ref: string) {
        return conditional(() => this.db.send(new UpdateCommand({
            TableName: this.table,
            Key: { clinicId, slotId },
            UpdateExpression: 'SET #s = :booked REMOVE heldUntil',
            ConditionExpression: '#s = :held AND #ref = :ref',
            ExpressionAttributeNames: { '#s': 'state', '#ref': 'ref' },
            ExpressionAttributeValues: { ':booked': 'booked', ':held': 'held', ':ref': ref }
        })));
    }

    release(clinicId: string, slotId: string, ref: string) {
        return conditional(() => this.db.send(new UpdateCommand({
            TableName: this.table,
            Key: { clinicId, slotId },
            UpdateExpression: 'SET #s = :available REMOVE #ref, heldUntil',
            ConditionExpression: '#s = :held AND #ref = :ref',
            ExpressionAttributeNames: { '#s': 'state', '#ref': 'ref' },
            ExpressionAttributeValues: { ':available': 'available', ':held': 'held', ':ref': ref }
        })));
    }
}

export class DynamoBookingStore implements BookingStore {
    constructor(private readonly db: DynamoDBDocumentClient, private readonly table: string) {}

    create(booking: Booking) {
        return conditional(() => this.db.send(new PutCommand({
            TableName: this.table,
            Item: { ...booking, phoneIndex: `${booking.clinicId}#${booking.phoneKey}`, ttl: epochSeconds(booking.expiresAt) },
            ConditionExpression: 'attribute_not_exists(#ref)',
            ExpressionAttributeNames: { '#ref': 'ref' }
        })));
    }

    async get(ref: string) {
        const { Item } = await this.db.send(new GetCommand({ TableName: this.table, Key: { ref } }));
        if (!Item) return null;
        const { phoneIndex: _phoneIndex, ttl: _ttl, ...booking } = Item;
        return booking as Booking;
    }

    async delete(ref: string) {
        await this.db.send(new DeleteCommand({ TableName: this.table, Key: { ref } }));
    }

    async countOpen(clinicId: string, phoneKey: string, nowMs: number) {
        const { Count } = await this.db.send(new QueryCommand({
            TableName: this.table,
            IndexName: 'byPhone',
            KeyConditionExpression: 'phoneIndex = :p',
            FilterExpression: '#s = :requested AND expiresAt > :now',
            ExpressionAttributeNames: { '#s': 'status' },
            ExpressionAttributeValues: { ':p': `${clinicId}#${phoneKey}`, ':requested': 'requested', ':now': nowMs },
            Select: 'COUNT'
        }));
        return Count ?? 0;
    }

    decide(ref: string, status: 'accepted' | 'declined') {
        // A decided request no longer counts toward the phone limit, so its
        // phone key is dropped with the decision.
        return conditional(() => this.db.send(new UpdateCommand({
            TableName: this.table,
            Key: { ref },
            UpdateExpression: 'SET #s = :status REMOVE phoneIndex, phoneKey',
            ConditionExpression: '#s = :requested',
            ExpressionAttributeNames: { '#s': 'status' },
            ExpressionAttributeValues: { ':status': status, ':requested': 'requested' }
        })));
    }
}
