import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { serve } from '@hono/node-server';
import { buildServerApp, listenAddress, type Adapters } from './bootstrap.js';
import { documentClient, DynamoBookingStore, DynamoClinicStore, DynamoSlotStore } from './dynamo.js';

// Entry point for the Web Function, bundled to one CommonJS index.js by
// infra/bundle.ts. The device authenticator, mailbox and doorbell adapters
// arrive with #154 and #155; until then it serves a 503 holding app.

function required(name: string): string {
    const value = process.env[name];
    if (!value) throw new Error(`Booking API: ${name} is not set.`);
    return value;
}

async function main() {
    const adapters: Adapters = {};
    const db = documentClient(process.env.AWS_REGION);
    // The phone pepper is a SecureString in Parameter Store (as the relay keeps
    // its vendor secret), read once at start-up so it never sits in the
    // function's environment. scripts/deploy.sh creates it on first deploy.
    const parameter = await new SSMClient({}).send(new GetParameterCommand({ Name: required('BOOKING_PHONE_PEPPER_PARAM'), WithDecryption: true }));
    const pepper = Buffer.from(parameter.Parameter?.Value ?? '', 'utf8');
    if (pepper.length < 32) throw new Error('Booking API: the phone pepper parameter must be at least 32 characters.');

    const { app, missing } = buildServerApp({
        clinics: new DynamoClinicStore(db, required('BOOKING_CLINICS_TABLE')),
        slots: new DynamoSlotStore(db, required('BOOKING_SLOTS_TABLE')),
        bookings: new DynamoBookingStore(db, required('BOOKING_REQUESTS_TABLE')),
        phonePepper: pepper
    }, adapters);
    const { hostname, port } = listenAddress(process.env);
    serve({ fetch: app.fetch, hostname, port }, () => {
        console.log(JSON.stringify({ msg: 'booking api listening', port, missing }));
    });
}

main().catch((error) => {
    console.error(JSON.stringify({ msg: 'booking api failed to start', error: (error as Error).message }));
    process.exit(1);
});
