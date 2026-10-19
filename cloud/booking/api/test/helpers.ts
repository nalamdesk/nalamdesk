import * as crypto from 'node:crypto';
import { createBookingApp, type BookingDeps } from '../src/app.js';
import type { BookingLogEntry } from '../src/log.js';
import { MemoryBookingStore, MemoryClinicStore, MemorySlotStore } from '../src/memory.js';
import type { DeviceAuthResult, MailboxItem } from '../src/ports.js';
import { seal } from './sealReference.js';

export const CLINIC_ID = 'clinic-1';
// 2026-10-19 09:00 IST.
export const NOW = Date.UTC(2026, 9, 19, 3, 30);
export const TODAY = '2026-10-19';
export const TOMORROW = '2026-10-20';

let refCounter = 0;
export function newRef(): string {
    const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    let n = ++refCounter;
    let out = '';
    for (let i = 0; i < 12; i++) {
        out = alphabet[n % 32] + out;
        n = Math.floor(n / 32);
    }
    return out;
}

export function phoneDigest(phone: string): string {
    return crypto.createHash('sha256').update(`nalamdesk-booking-phone-v1|${phone}`).digest('hex');
}

export function clinicKeys() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
    return {
        privateKey,
        publicRaw: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64')
    };
}

export async function harness(overrides: Partial<BookingDeps> = {}) {
    const clinic = clinicKeys();
    const clinics = new MemoryClinicStore();
    const slots = new MemorySlotStore();
    const bookings = new MemoryBookingStore();
    const mailbox: MailboxItem[] = [];
    const rings: string[] = [];
    const logs: BookingLogEntry[] = [];
    let auth: DeviceAuthResult = { ok: true, deviceId: 'dev-1', clinicId: CLINIC_ID, hipId: 'IN2710000123' };
    let mailboxFails = false;
    let now = NOW;

    await clinics.upsertListing(CLINIC_ID, { name: 'Arogya Clinic', city: 'Chennai', specialty: 'General Practice', sealingPublicKey: clinic.publicRaw }, NOW);
    await slots.publish(CLINIC_ID, [TODAY, TOMORROW], [
        { date: TODAY, time: '08:30' },
        { date: TODAY, time: '10:00' },
        { date: TOMORROW, time: '10:00' },
        { date: TOMORROW, time: '10:30' }
    ], NOW);

    const app = createBookingApp({
        clinics,
        slots,
        bookings,
        devices: { authenticate: async () => auth },
        mailbox: {
            put: async (item) => {
                if (mailboxFails) throw new Error('down');
                mailbox.push(item);
                return `item-${mailbox.length}`;
            }
        },
        doorbell: { ring: async (clinicId) => { rings.push(clinicId); } },
        phonePepper: Buffer.alloc(32, 7),
        logger: (entry) => logs.push(entry),
        nowMs: () => now,
        ...overrides
    });

    const sealFor = (payload: unknown) =>
        seal(Buffer.from(JSON.stringify(payload)), clinic.publicRaw, CLINIC_ID, 'booking-request');

    const book = (input: { ref?: string; slotId?: string | null; phone?: string; sealed?: string; clinicId?: string } = {}) => {
        const ref = input.ref ?? newRef();
        return app.request('/api/book', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                clinicId: input.clinicId ?? CLINIC_ID,
                ref,
                slotId: input.slotId === undefined ? `${TOMORROW}T10:00` : input.slotId,
                phoneDigest: phoneDigest(input.phone ?? '9876543210'),
                sealed: input.sealed ?? sealFor({ v: 1, ref, name: 'Asha', phone: input.phone ?? '9876543210', reason: 'Fever' })
            })
        });
    };

    const clinicCall = (method: string, path: string, body?: unknown) => app.request(path, {
        method,
        headers: { 'content-type': 'application/json', 'x-nd-device': 'dev-1', 'x-nd-signature': 'sig' },
        body: body === undefined ? undefined : JSON.stringify(body)
    });

    return {
        app, clinics, slots, bookings, mailbox, rings, logs, clinic, sealFor, book, clinicCall,
        setAuth: (value: DeviceAuthResult) => { auth = value; },
        failMailbox: () => { mailboxFails = true; },
        setNow: (value: number) => { now = value; }
    };
}
