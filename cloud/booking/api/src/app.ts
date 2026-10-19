import * as crypto from 'node:crypto';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { stdoutLogger, type BookingLogEntry, type BookingLogger } from './log.js';
import type {
    Booking,
    BookingStatus,
    BookingStore,
    Clinic,
    ClinicStore,
    DeviceAuthenticator,
    Doorbell,
    Mailbox,
    SlotStore
} from './ports.js';
import {
    addDays,
    BOOKING_REF,
    CLINIC_ID,
    cleanText,
    isCalendarDate,
    isSealedEnvelope,
    isX25519PublicKey,
    LIMITS,
    PHONE_DIGEST,
    slotIdOf,
    TIME
} from './validate.js';

export interface BookingDeps {
    clinics: ClinicStore;
    slots: SlotStore;
    bookings: BookingStore;
    devices: DeviceAuthenticator;
    mailbox: Mailbox;
    doorbell: Doorbell;
    /** Server secret that turns the browser's phone digest into a per-clinic key. */
    phonePepper: Uint8Array;
    logger?: BookingLogger;
    nowMs?: () => number;
}

export const POLICY = {
    /** Sealed requests live in the mailbox this long; holds and status records match it. */
    requestTtlMs: 48 * 60 * 60 * 1000,
    maxOpenPerPhone: 2,
    /** Public directory and slot responses are cached at CloudFront this long. */
    publicCacheSeconds: 30,
    /** Without an IoT Core presence event, a desktop seen this recently counts as online. */
    onlineWindowMs: 5 * 60 * 1000,
    slotDays: 14
};

/** India Standard Time calendar date; clinics and patients are all in IST. */
export function istDate(nowMs: number): string {
    return new Date(nowMs + 330 * 60 * 1000).toISOString().slice(0, 10);
}

const STATUS_LABEL: Record<BookingStatus, string> = {
    requested: 'Requested',
    accepted: 'Accepted',
    declined: 'Declined'
};

function refuse(c: Context, status: number, code: string, extra: Record<string, unknown> = {}): Response {
    return c.json({ error: code, ...extra }, status as 400);
}

function noStore(c: Context): void {
    c.header('Cache-Control', 'no-store');
}

function publicCache(c: Context): void {
    c.header('Cache-Control', `public, max-age=${POLICY.publicCacheSeconds}`);
}

async function readJson(c: Context): Promise<Record<string, unknown> | null> {
    try {
        const parsed = await c.req.json();
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

/**
 * The booking API as a plain Hono app, so it runs unchanged on a Lambda Web
 * Function or a local Node server. CloudFront routes `/api/*` here.
 *
 * Public: `GET /api/clinics`, `GET /api/slots/:clinicId`, `POST /api/book`,
 * `GET /api/booking/:ref`. Signed by the paired desktop: everything under
 * `/api/clinic/`.
 */
export function createBookingApp(deps: BookingDeps): Hono {
    const app = new Hono();
    const log = deps.logger ?? stdoutLogger;
    const nowMs = deps.nowMs ?? Date.now;
    const timed = (entry: Omit<BookingLogEntry, 'ms'>, started: number) => log({ ...entry, ms: nowMs() - started });

    const isOnline = (clinic: Clinic, now: number) => clinic.online || now - clinic.lastSeenAt < POLICY.onlineWindowMs;
    const phoneKey = (clinicId: string, digest: string) =>
        crypto.createHmac('sha256', deps.phonePepper).update(`${clinicId}|${digest}`).digest('base64url');

    app.get('/api/health', (c) => c.json({ ok: true }));

    // ---- Public ----

    app.get('/api/clinics', async (c) => {
        const started = nowMs();
        const now = nowMs();
        const clinics = await deps.clinics.listListed();
        publicCache(c);
        timed({ route: 'clinics', path: '/api/clinics', status: 200 }, started);
        // Search runs in the browser over this list: it is small, cached, and
        // keeps search terms out of CloudFront cache keys and logs.
        return c.json({
            clinics: clinics
                .map((clinic) => ({
                    clinicId: clinic.clinicId,
                    name: clinic.name,
                    city: clinic.city,
                    specialty: clinic.specialty,
                    online: isOnline(clinic, now),
                    sealingPublicKey: clinic.sealingPublicKey
                }))
                .sort((a, b) => a.name.localeCompare(b.name))
        });
    });

    app.get('/api/slots/:clinicId', async (c) => {
        const started = nowMs();
        const clinicId = c.req.param('clinicId');
        const clinic = CLINIC_ID.test(clinicId) ? await deps.clinics.get(clinicId) : null;
        if (!clinic || !clinic.listed) {
            timed({ route: 'slots', path: '/api/slots/:clinicId', status: 404, code: 'unknown_clinic' }, started);
            return refuse(c, 404, 'unknown_clinic');
        }
        const now = nowMs();
        const today = istDate(now);
        const nowTime = new Date(now + 330 * 60 * 1000).toISOString().slice(11, 16);
        const slots = await deps.slots.listBetween(clinicId, today, addDays(today, POLICY.slotDays - 1));
        const open = slots
            .filter((slot) => slot.state === 'available' || (slot.state === 'held' && (slot.heldUntil ?? 0) <= now))
            .filter((slot) => slot.date > today || slot.time > nowTime)
            .map((slot) => ({ slotId: slot.slotId, date: slot.date, time: slot.time }))
            .sort((a, b) => a.slotId.localeCompare(b.slotId));
        publicCache(c);
        timed({ route: 'slots', path: '/api/slots/:clinicId', clinicId, status: 200 }, started);
        return c.json({ clinicId, slots: open });
    });

    app.post('/api/book', bodyLimit({
        maxSize: LIMITS.bookBodyBytes,
        onError: (c) => refuse(c, 413, 'body_too_large')
    }), async (c) => {
        const started = nowMs();
        noStore(c);
        const body = await readJson(c);
        const clinicId = body?.clinicId;
        const ref = body?.ref;
        const slotId = body?.slotId ?? null;
        const digest = body?.phoneDigest;
        const sealed = body?.sealed;
        if (
            typeof clinicId !== 'string' || !CLINIC_ID.test(clinicId)
            || typeof ref !== 'string' || !BOOKING_REF.test(ref)
            || (slotId !== null && (typeof slotId !== 'string' || slotId.length > 16))
            || typeof digest !== 'string' || !PHONE_DIGEST.test(digest)
            || !isSealedEnvelope(sealed)
        ) {
            timed({ route: 'book', path: '/api/book', status: 400, code: 'bad_request' }, started);
            return refuse(c, 400, 'bad_request');
        }
        const clinic = await deps.clinics.get(clinicId);
        if (!clinic || !clinic.listed) {
            timed({ route: 'book', path: '/api/book', status: 404, code: 'unknown_clinic' }, started);
            return refuse(c, 404, 'unknown_clinic');
        }

        const now = nowMs();
        const key = phoneKey(clinicId, digest);
        if (await deps.bookings.countOpen(clinicId, key, now) >= POLICY.maxOpenPerPhone) {
            timed({ route: 'book', path: '/api/book', clinicId, status: 429, code: 'too_many_open_requests' }, started);
            return refuse(c, 429, 'too_many_open_requests');
        }

        const expiresAt = now + POLICY.requestTtlMs;
        if (slotId !== null) {
            const slot = await deps.slots.get(clinicId, slotId);
            if (!slot) {
                timed({ route: 'book', path: '/api/book', clinicId, status: 404, code: 'unknown_slot' }, started);
                return refuse(c, 404, 'unknown_slot');
            }
            if (!(await deps.slots.hold(clinicId, slotId, ref, expiresAt, now))) {
                timed({ route: 'book', path: '/api/book', clinicId, status: 409, code: 'slot_taken' }, started);
                return refuse(c, 409, 'slot_taken');
            }
        }
        const undoHold = async () => {
            if (slotId !== null) await deps.slots.release(clinicId, slotId, ref).catch(() => false);
        };

        const booking: Booking = { ref, clinicId, slotId, status: 'requested', phoneKey: key, createdAt: now, expiresAt };
        if (!(await deps.bookings.create(booking))) {
            await undoHold();
            timed({ route: 'book', path: '/api/book', clinicId, status: 409, code: 'ref_taken' }, started);
            return refuse(c, 409, 'ref_taken');
        }

        try {
            await deps.mailbox.put({ clinicId, type: 'booking-request', sealed });
        } catch {
            await deps.bookings.delete(ref).catch(() => undefined);
            await undoHold();
            timed({ route: 'book', path: '/api/book', clinicId, status: 503, code: 'mailbox_unavailable' }, started);
            return refuse(c, 503, 'mailbox_unavailable');
        }
        // Best effort: the desktop also fetches on connect and every 30 minutes.
        deps.doorbell.ring(clinicId).catch(() => undefined);

        timed({ route: 'book', path: '/api/book', clinicId, status: 201 }, started);
        return c.json({ ref, status: STATUS_LABEL.requested }, 201);
    });

    app.get('/api/booking/:ref', async (c) => {
        const started = nowMs();
        noStore(c);
        const ref = c.req.param('ref').toUpperCase();
        const booking = BOOKING_REF.test(ref) ? await deps.bookings.get(ref) : null;
        if (!booking || booking.expiresAt <= nowMs()) {
            timed({ route: 'status', path: '/api/booking/:ref', status: 404, code: 'unknown_ref' }, started);
            return refuse(c, 404, 'unknown_ref');
        }
        const clinic = await deps.clinics.get(booking.clinicId);
        timed({ route: 'status', path: '/api/booking/:ref', clinicId: booking.clinicId, status: 200 }, started);
        return c.json({ ref, status: STATUS_LABEL[booking.status], clinicName: clinic?.name ?? null });
    });

    // ---- Signed by the clinic's paired desktop ----

    type ClinicEnv = { Variables: { clinicId: string } };
    const clinicApi = new Hono<ClinicEnv>();

    clinicApi.use('*', bodyLimit({
        maxSize: LIMITS.clinicBodyBytes,
        onError: (c) => refuse(c, 413, 'body_too_large')
    }), async (c, next) => {
        const started = nowMs();
        noStore(c);
        const body = new Uint8Array(await c.req.arrayBuffer());
        const query = new URL(c.req.url).search.slice(1);
        const auth = await deps.devices.authenticate({ method: c.req.method, path: c.req.path, query, headers: c.req.raw.headers, body });
        if (!auth.ok) {
            timed({ route: 'clinic', path: '/api/clinic/*', status: auth.status, code: auth.code }, started);
            return refuse(c, auth.status, auth.code, auth.serverTimeMs ? { serverTime: auth.serverTimeMs } : {});
        }
        c.set('clinicId', auth.clinicId);
        await deps.clinics.touch(auth.clinicId, nowMs());
        await next();
    });

    clinicApi.put('/listing', async (c) => {
        const started = nowMs();
        const clinicId = c.get('clinicId');
        const body = await readJson(c);
        const name = cleanText(body?.name);
        const city = cleanText(body?.city);
        const specialty = cleanText(body?.specialty) ?? 'General Practice';
        const sealingPublicKey = body?.sealingPublicKey;
        if (!name || !city || !isX25519PublicKey(sealingPublicKey)) {
            timed({ route: 'clinic', path: '/api/clinic/listing', clinicId, status: 400, code: 'bad_request' }, started);
            return refuse(c, 400, 'bad_request');
        }
        await deps.clinics.upsertListing(clinicId, { name, city, specialty, sealingPublicKey }, nowMs());
        timed({ route: 'clinic', path: '/api/clinic/listing', clinicId, status: 200 }, started);
        return c.json({ clinicId, listed: true });
    });

    clinicApi.delete('/listing', async (c) => {
        const started = nowMs();
        const clinicId = c.get('clinicId');
        await deps.clinics.unlist(clinicId, nowMs());
        timed({ route: 'clinic', path: '/api/clinic/listing', clinicId, status: 200 }, started);
        return c.json({ clinicId, listed: false });
    });

    clinicApi.put('/slots', async (c) => {
        const started = nowMs();
        const clinicId = c.get('clinicId');
        const body = await readJson(c);
        const dates = body?.dates;
        const slots = body?.slots;
        const today = istDate(nowMs());
        const lastDay = addDays(today, POLICY.slotDays - 1);
        const datesOk = Array.isArray(dates) && dates.length > 0 && dates.length <= LIMITS.publishDays
            && dates.every((d) => isCalendarDate(d) && d >= today && d <= lastDay);
        const slotsOk = datesOk && Array.isArray(slots) && slots.length <= LIMITS.publishDays * LIMITS.slotsPerDay
            && slots.every((s) => s && typeof s === 'object' && dates.includes(s.date) && typeof s.time === 'string' && TIME.test(s.time));
        if (!datesOk || !slotsOk) {
            timed({ route: 'clinic', path: '/api/clinic/slots', clinicId, status: 400, code: 'bad_request' }, started);
            return refuse(c, 400, 'bad_request');
        }
        const unique = new Map<string, { date: string; time: string }>();
        for (const s of slots as { date: string; time: string }[]) unique.set(slotIdOf(s.date, s.time), { date: s.date, time: s.time });
        await deps.slots.publish(clinicId, dates as string[], [...unique.values()], nowMs());
        timed({ route: 'clinic', path: '/api/clinic/slots', clinicId, status: 200 }, started);
        return c.json({ clinicId, dates, published: unique.size });
    });

    clinicApi.get('/slots', async (c) => {
        const started = nowMs();
        const clinicId = c.get('clinicId');
        const from = c.req.query('from') ?? istDate(nowMs());
        const to = c.req.query('to') ?? addDays(from, POLICY.slotDays - 1);
        if (!isCalendarDate(from) || !isCalendarDate(to) || to < from) {
            timed({ route: 'clinic', path: '/api/clinic/slots', clinicId, status: 400, code: 'bad_request' }, started);
            return refuse(c, 400, 'bad_request');
        }
        const now = nowMs();
        const slots = (await deps.slots.listBetween(clinicId, from, to)).map((slot) => ({
            slotId: slot.slotId,
            date: slot.date,
            time: slot.time,
            state: slot.state === 'held' && (slot.heldUntil ?? 0) <= now ? 'available' : slot.state,
            ref: slot.state === 'held' && (slot.heldUntil ?? 0) <= now ? undefined : slot.ref
        }));
        timed({ route: 'clinic', path: '/api/clinic/slots', clinicId, status: 200 }, started);
        return c.json({ clinicId, slots });
    });

    clinicApi.post('/bookings/:ref/decision', async (c) => {
        const started = nowMs();
        const clinicId = c.get('clinicId');
        const ref = c.req.param('ref');
        const body = await readJson(c);
        const decision = body?.decision;
        if (!BOOKING_REF.test(ref) || (decision !== 'accepted' && decision !== 'declined')) {
            timed({ route: 'clinic', path: '/api/clinic/bookings/:ref/decision', clinicId, status: 400, code: 'bad_request' }, started);
            return refuse(c, 400, 'bad_request');
        }
        const booking = await deps.bookings.get(ref);
        if (!booking || booking.clinicId !== clinicId || booking.expiresAt <= nowMs()) {
            timed({ route: 'clinic', path: '/api/clinic/bookings/:ref/decision', clinicId, status: 404, code: 'unknown_ref' }, started);
            return refuse(c, 404, 'unknown_ref');
        }
        if (booking.status !== 'requested') {
            // A retried decision is fine; changing one is not.
            if (booking.status === decision) return c.json({ ref, status: STATUS_LABEL[booking.status] });
            timed({ route: 'clinic', path: '/api/clinic/bookings/:ref/decision', clinicId, status: 409, code: 'already_decided' }, started);
            return refuse(c, 409, 'already_decided', { status: STATUS_LABEL[booking.status] });
        }
        if (booking.slotId !== null) {
            const moved = decision === 'accepted'
                ? await deps.slots.book(clinicId, booking.slotId, ref)
                : await deps.slots.release(clinicId, booking.slotId, ref);
            if (!moved && decision === 'accepted') {
                // The hold is gone (lapsed and taken by someone else).
                timed({ route: 'clinic', path: '/api/clinic/bookings/:ref/decision', clinicId, status: 409, code: 'slot_lost' }, started);
                return refuse(c, 409, 'slot_lost');
            }
        }
        if (!(await deps.bookings.decide(ref, decision))) {
            const latest = await deps.bookings.get(ref);
            if (latest?.status === decision) return c.json({ ref, status: STATUS_LABEL[decision] });
            timed({ route: 'clinic', path: '/api/clinic/bookings/:ref/decision', clinicId, status: 409, code: 'already_decided' }, started);
            return refuse(c, 409, 'already_decided');
        }
        timed({ route: 'clinic', path: '/api/clinic/bookings/:ref/decision', clinicId, status: 200 }, started);
        return c.json({ ref, status: STATUS_LABEL[decision] });
    });

    app.route('/api/clinic', clinicApi);

    app.notFound((c) => refuse(c, 404, 'not_found'));
    app.onError((_error, c) => refuse(c, 500, 'internal_error'));
    return app;
}
