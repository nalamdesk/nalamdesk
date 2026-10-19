import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { serve } from '@hono/node-server';
import { createBookingApp } from './app.js';
import { documentClient, DynamoBookingStore, DynamoClinicStore, DynamoSlotStore } from './dynamo.js';
import type { DeviceAuthenticator, Doorbell, Mailbox } from './ports.js';

// Entry point for the Web Function (a plain Node HTTP server on $PORT).
// The device authenticator, mailbox and doorbell adapters arrive with #154
// and #155; until they are wired in, the API refuses to start rather than
// accept bookings it cannot deliver or clinic calls it cannot verify.

function notWired(name: string, issue: string): never {
    throw new Error(`Booking API: ${name} adapter is not wired yet (${issue}).`);
}

function required(name: string): string {
    const value = process.env[name];
    if (!value) throw new Error(`Booking API: ${name} is not set.`);
    return value;
}

const adapters: { devices?: DeviceAuthenticator; mailbox?: Mailbox; doorbell?: Doorbell } = {};

const db = documentClient(process.env.AWS_REGION);
// The phone pepper is read once at start-up from Secrets Manager, so it never
// sits in the function's environment.
const secret = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: required('BOOKING_PHONE_PEPPER_SECRET') }));
const pepper = Buffer.from(secret.SecretString ?? '', 'utf8');
if (pepper.length < 32) throw new Error('Booking API: the phone pepper secret must be at least 32 characters.');

const app = createBookingApp({
    clinics: new DynamoClinicStore(db, required('BOOKING_CLINICS_TABLE')),
    slots: new DynamoSlotStore(db, required('BOOKING_SLOTS_TABLE')),
    bookings: new DynamoBookingStore(db, required('BOOKING_REQUESTS_TABLE')),
    devices: adapters.devices ?? notWired('device authenticator', '#154'),
    mailbox: adapters.mailbox ?? notWired('mailbox', '#155'),
    doorbell: adapters.doorbell ?? notWired('doorbell', '#155'),
    phonePepper: pepper
});

serve({ fetch: app.fetch, port: Number(process.env.PORT) || 8080 });
