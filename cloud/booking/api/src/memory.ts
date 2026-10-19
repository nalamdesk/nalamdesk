// In-memory stores with the same conditional-write rules as src/dynamo.ts.
// Used by the tests and the local dev server.
import type { Booking, BookingStore, Clinic, ClinicListing, ClinicStore, Slot, SlotStore } from './ports.js';
import { slotIdOf } from './validate.js';

export class MemoryClinicStore implements ClinicStore {
    readonly rows = new Map<string, Clinic>();

    async get(clinicId: string) {
        const row = this.rows.get(clinicId);
        return row ? { ...row } : null;
    }

    async listListed() {
        return [...this.rows.values()].filter((row) => row.listed).map((row) => ({ ...row }));
    }

    async upsertListing(clinicId: string, listing: ClinicListing, nowMs: number) {
        const existing = this.rows.get(clinicId);
        this.rows.set(clinicId, {
            clinicId,
            ...listing,
            listed: true,
            online: existing?.online ?? false,
            lastSeenAt: nowMs
        });
    }

    async unlist(clinicId: string, nowMs: number) {
        const existing = this.rows.get(clinicId);
        if (existing) this.rows.set(clinicId, { ...existing, listed: false, lastSeenAt: nowMs });
    }

    async touch(clinicId: string, nowMs: number) {
        const existing = this.rows.get(clinicId);
        if (existing) existing.lastSeenAt = Math.max(existing.lastSeenAt, nowMs);
    }

    async setPresence(clinicId: string, online: boolean, atMs: number) {
        const existing = this.rows.get(clinicId);
        if (existing) {
            existing.online = online;
            existing.lastSeenAt = Math.max(existing.lastSeenAt, atMs);
        }
    }
}

export class MemorySlotStore implements SlotStore {
    readonly rows = new Map<string, Slot>();

    private key(clinicId: string, slotId: string) {
        return `${clinicId}|${slotId}`;
    }

    async get(clinicId: string, slotId: string) {
        const row = this.rows.get(this.key(clinicId, slotId));
        return row ? { ...row } : null;
    }

    async listBetween(clinicId: string, fromDate: string, toDate: string) {
        return [...this.rows.values()]
            .filter((row) => row.clinicId === clinicId && row.date >= fromDate && row.date <= toDate)
            .map((row) => ({ ...row }));
    }

    async publish(clinicId: string, dates: string[], slots: { date: string; time: string }[], nowMs: number) {
        const wanted = new Set(slots.map((s) => slotIdOf(s.date, s.time)));
        for (const [key, row] of this.rows) {
            if (row.clinicId !== clinicId || !dates.includes(row.date) || wanted.has(row.slotId)) continue;
            const lapsed = row.state === 'held' && (row.heldUntil ?? 0) <= nowMs;
            if (row.state === 'available' || lapsed) this.rows.delete(key);
        }
        for (const s of slots) {
            const slotId = slotIdOf(s.date, s.time);
            const key = this.key(clinicId, slotId);
            if (!this.rows.has(key)) this.rows.set(key, { clinicId, slotId, date: s.date, time: s.time, state: 'available' });
        }
    }

    async hold(clinicId: string, slotId: string, ref: string, untilMs: number, nowMs: number) {
        const row = this.rows.get(this.key(clinicId, slotId));
        if (!row) return false;
        const free = row.state === 'available' || (row.state === 'held' && (row.heldUntil ?? 0) <= nowMs);
        if (!free) return false;
        Object.assign(row, { state: 'held', ref, heldUntil: untilMs });
        return true;
    }

    async book(clinicId: string, slotId: string, ref: string) {
        const row = this.rows.get(this.key(clinicId, slotId));
        if (!row || row.state !== 'held' || row.ref !== ref) return false;
        row.state = 'booked';
        delete row.heldUntil;
        return true;
    }

    async release(clinicId: string, slotId: string, ref: string) {
        const row = this.rows.get(this.key(clinicId, slotId));
        if (!row || row.state !== 'held' || row.ref !== ref) return false;
        row.state = 'available';
        delete row.ref;
        delete row.heldUntil;
        return true;
    }
}

export class MemoryBookingStore implements BookingStore {
    readonly rows = new Map<string, Booking>();

    async create(booking: Booking) {
        if (this.rows.has(booking.ref)) return false;
        this.rows.set(booking.ref, { ...booking });
        return true;
    }

    async get(ref: string) {
        const row = this.rows.get(ref);
        return row ? { ...row } : null;
    }

    async delete(ref: string) {
        this.rows.delete(ref);
    }

    async countOpen(clinicId: string, phoneKey: string, nowMs: number) {
        let open = 0;
        for (const row of this.rows.values()) {
            if (row.clinicId === clinicId && row.phoneKey === phoneKey && row.status === 'requested' && row.expiresAt > nowMs) open++;
        }
        return open;
    }

    async decide(ref: string, status: 'accepted' | 'declined') {
        const row = this.rows.get(ref);
        if (!row || row.status !== 'requested') return false;
        row.status = status;
        delete row.phoneKey;
        return true;
    }
}
