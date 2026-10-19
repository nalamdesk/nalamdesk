import * as crypto from 'node:crypto';
import { serve } from '@hono/node-server';
import { createBookingApp, istDate } from './app.js';
import { MemoryBookingStore, MemoryClinicStore, MemorySlotStore } from './memory.js';
import type { MailboxItem } from './ports.js';
import { addDays } from './validate.js';

// Local development server: in-memory stores, two demo clinics with fresh
// sealing keys, and a mailbox that only counts what arrives. Clinic routes
// accept an `x-dev-clinic` header in place of a device signature, so never
// deploy this file. Run with `npm run dev`; the site's Vite proxy points here.

const clinics = new MemoryClinicStore();
const slots = new MemorySlotStore();
const bookings = new MemoryBookingStore();
const mailbox: MailboxItem[] = [];
const now = Date.now();

const demo = [
    { clinicId: 'demo-anna-nagar', name: 'Arogya Family Clinic', city: 'Chennai', specialty: 'General Practice', online: true },
    { clinicId: 'demo-gandhipuram', name: 'Kovai Child Care', city: 'Coimbatore', specialty: 'Paediatrics', online: false }
];
for (const clinic of demo) {
    const { publicKey } = crypto.generateKeyPairSync('x25519');
    const sealingPublicKey = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
    await clinics.upsertListing(clinic.clinicId, { ...clinic, sealingPublicKey }, now);
    Object.assign(clinics.rows.get(clinic.clinicId)!, { online: clinic.online, lastSeenAt: clinic.online ? now : now - 60 * 60 * 1000 });
    const dates = [0, 1, 2].map((d) => addDays(istDate(now), d));
    const times = ['09:30', '10:00', '10:30', '11:00', '11:30', '16:00', '16:30', '17:00', '17:30'];
    await slots.publish(clinic.clinicId, dates, dates.flatMap((date) => times.map((time) => ({ date, time }))), now);
}

const app = createBookingApp({
    clinics,
    slots,
    bookings,
    devices: {
        authenticate: async ({ headers }) => {
            const clinicId = headers.get('x-dev-clinic');
            return clinicId ? { ok: true, deviceId: `dev-${clinicId}`, clinicId, hipId: 'dev' } : { ok: false, status: 401, code: 'unsigned' };
        }
    },
    mailbox: {
        put: async (item) => {
            mailbox.push(item);
            process.stdout.write(`mailbox: ${item.type} for ${item.clinicId} (${item.sealed.length} sealed chars)\n`);
            return `item-${mailbox.length}`;
        }
    },
    doorbell: { ring: async () => undefined },
    phonePepper: crypto.randomBytes(32)
});

const port = Number(process.env.PORT) || 8787;
serve({ fetch: app.fetch, port });
process.stdout.write(`Booking API (dev, in-memory) on http://localhost:${port}\n`);
