// Server-side auth state for NalamDesk Server (#193): the session signing
// key kept in the vault, one-time join codes, joined computers and their
// revocable credentials, and refreshable user sessions bound to a computer.
//
// Only SHA-256 hashes of codes and tokens are stored. Tokens carry 256 bits
// of randomness, so a fast hash is enough; join code secrets are short but
// live for minutes, are single use, and are attempt-limited by the caller.

import * as crypto from 'node:crypto';

export type Clock = () => number;

/** better-sqlite3-shaped handle (also satisfied by the test adapter). */
export interface SqlHandle {
    prepare(sql: string): { run(...args: any[]): any; get(...args: any[]): any; all(...args: any[]): any[] };
    transaction<T extends (...args: any[]) => any>(fn: T): T;
}

export class AuthStoreNotReady extends Error {
    constructor() { super('AUTH_STORE_NOT_READY'); }
}

export interface JoinedDevice {
    id: string;
    name: string;
    joinedAt: number;
    joinIp: string | null;
    lastSeenAt: number | null;
    lastIp: string | null;
    revokedAt: number | null;
}

export interface ServerSession {
    id: string;
    userId: number;
    deviceId: string | null;
    facilityId: number | null;
    expiresAt: number;
}

export interface SessionPolicy {
    /** Idle lifetime: each refresh pushes expiry this far out. */
    idleMs: number;
    /** Hard lifetime from sign-in, regardless of refreshes. */
    absoluteMs: number;
}

export const DEFAULT_SESSION_POLICY: SessionPolicy = {
    idleMs: 12 * 60 * 60_000,
    absoluteMs: 24 * 60 * 60_000
};

export const SIGNING_KEY_SECRET = 'session_signing_key';
const DEVICE_TOKEN_PREFIX = 'ndd_';
const REFRESH_TOKEN_PREFIX = 'ndr_';
const LAST_SEEN_THROTTLE_MS = 60_000;

const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const randomToken = () => crypto.randomBytes(32).toString('base64url');

function hashesEqual(a: string, b: string): boolean {
    const left = Buffer.from(a, 'hex');
    const right = Buffer.from(b, 'hex');
    return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/** Splits `<prefix><id>.<secret>`; null when malformed. */
function splitToken(token: unknown, prefix: string): { id: string; secret: string } | null {
    if (typeof token !== 'string' || !token.startsWith(prefix) || token.length > 512) return null;
    const body = token.slice(prefix.length);
    const dot = body.indexOf('.');
    if (dot <= 0 || dot === body.length - 1) return null;
    return { id: body.slice(0, dot), secret: body.slice(dot + 1) };
}

export class ServerAuthStore {
    private readonly cachedSecrets = new Map<string, string>();

    constructor(
        private readonly handle: () => SqlHandle | null | undefined,
        private readonly now: Clock = Date.now,
        private readonly policy: SessionPolicy = DEFAULT_SESSION_POLICY
    ) { }

    /** Throws AuthStoreNotReady until the vault is open. */
    assertReady(): void {
        this.db();
    }

    private db(): SqlHandle {
        const db = this.handle();
        if (!db) throw new AuthStoreNotReady();
        return db;
    }

    // --- Vault secrets ----------------------------------------------------

    /** Returns the named secret, creating it on first use. */
    getOrCreateSecret(name: string, generate: () => string = () => crypto.randomBytes(64).toString('base64')): string {
        const cached = this.cachedSecrets.get(name);
        if (cached) return cached;
        const db = this.db();
        const read = () => db.prepare('SELECT value FROM server_secrets WHERE name = ?').get(name)?.value as string | undefined;
        let value = read();
        if (!value) {
            db.prepare('INSERT OR IGNORE INTO server_secrets (name, value, created_at) VALUES (?, ?, ?)')
                .run(name, generate(), this.now());
            value = read()!;
        }
        this.cachedSecrets.set(name, value);
        return value;
    }

    /** Replaces the session signing key: every issued access token stops working. */
    rotateSigningKey(): void {
        this.db().prepare('INSERT OR REPLACE INTO server_secrets (name, value, created_at) VALUES (?, ?, ?)')
            .run(SIGNING_KEY_SECRET, crypto.randomBytes(64).toString('base64'), this.now());
        this.cachedSecrets.delete(SIGNING_KEY_SECRET);
    }

    /** Drops cached secrets, e.g. after a restore swaps the database. */
    clearCache(): void {
        this.cachedSecrets.clear();
    }

    // --- Join codes -------------------------------------------------------

    /** Stores a one-time join code secret; the caller formats and shows it. */
    issueJoinCode(input: { secret: string; createdBy: number | null; deviceName?: string | null; ttlMs: number }) {
        const createdAt = this.now();
        const expiresAt = createdAt + input.ttlMs;
        const result = this.db().prepare(`
            INSERT INTO join_codes (code_hash, device_name, created_by, created_at, expires_at)
            VALUES (?, ?, ?, ?, ?)
        `).run(sha256(input.secret), input.deviceName ?? null, input.createdBy, createdAt, expiresAt);
        return { id: Number(result.lastInsertRowid), expiresAt };
    }

    /**
     * Redeems a join code secret once and registers the computer. Returns the
     * device credential (shown to the client once) or null when the code is
     * unknown, used, revoked or expired.
     */
    redeemJoinCode(secret: string, input: { deviceName: string; ip: string | null }): { device: JoinedDevice; token: string } | null {
        const db = this.db();
        const now = this.now();
        return db.transaction(() => {
            const code = db.prepare(`
                SELECT id, device_name FROM join_codes
                WHERE code_hash = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?
            `).get(sha256(secret), now) as { id: number; device_name: string | null } | undefined;
            if (!code) return null;
            const id = crypto.randomUUID();
            const credential = randomToken();
            const name = (code.device_name || input.deviceName || 'Unnamed computer').slice(0, 100);
            db.prepare(`
                INSERT INTO joined_devices (id, name, credential_hash, joined_at, join_code_id, join_ip, last_seen_at, last_ip)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).run(id, name, sha256(credential), now, code.id, input.ip, now, input.ip);
            db.prepare('UPDATE join_codes SET used_at = ?, used_by_device = ? WHERE id = ?').run(now, id, code.id);
            return {
                device: { id, name, joinedAt: now, joinIp: input.ip, lastSeenAt: now, lastIp: input.ip, revokedAt: null },
                token: `${DEVICE_TOKEN_PREFIX}${id}.${credential}`
            };
        })();
    }

    /** Revokes every outstanding join code, e.g. after repeated wrong guesses. */
    revokeOutstandingJoinCodes(): number {
        return Number(this.db().prepare(`
            UPDATE join_codes SET revoked_at = ? WHERE used_at IS NULL AND revoked_at IS NULL AND expires_at > ?
        `).run(this.now(), this.now()).changes ?? 0);
    }

    // --- Joined computers -------------------------------------------------

    /** Resolves a device credential to an active computer, or null. */
    authenticateDevice(token: unknown, ip: string | null = null): JoinedDevice | null {
        const parts = splitToken(token, DEVICE_TOKEN_PREFIX);
        if (!parts) return null;
        const row = this.db().prepare('SELECT * FROM joined_devices WHERE id = ?').get(parts.id) as any;
        if (!row || row.revoked_at != null || !hashesEqual(row.credential_hash, sha256(parts.secret))) return null;
        const now = this.now();
        if (!row.last_seen_at || now - row.last_seen_at > LAST_SEEN_THROTTLE_MS || row.last_ip !== ip) {
            this.db().prepare('UPDATE joined_devices SET last_seen_at = ?, last_ip = ? WHERE id = ?').run(now, ip, row.id);
            row.last_seen_at = now;
            row.last_ip = ip;
        }
        return toDevice(row);
    }

    getDevice(id: string): JoinedDevice | null {
        const row = this.db().prepare('SELECT * FROM joined_devices WHERE id = ?').get(id);
        return row ? toDevice(row) : null;
    }

    listDevices(): JoinedDevice[] {
        return this.db().prepare('SELECT * FROM joined_devices ORDER BY revoked_at IS NOT NULL, joined_at DESC').all().map(toDevice);
    }

    /** Revokes a computer and signs out every session on it. */
    revokeDevice(id: string, revokedBy: number | null): boolean {
        const db = this.db();
        const now = this.now();
        return db.transaction(() => {
            const changed = Number(db.prepare(
                'UPDATE joined_devices SET revoked_at = ?, revoked_by = ? WHERE id = ? AND revoked_at IS NULL'
            ).run(now, revokedBy, id).changes ?? 0);
            if (changed) {
                db.prepare(`UPDATE server_sessions SET revoked_at = ?, revoked_reason = 'device_revoked'
                    WHERE device_id = ? AND revoked_at IS NULL`).run(now, id);
            }
            return changed > 0;
        })();
    }

    // --- Sessions ---------------------------------------------------------

    /** A user's current role and status, read at refresh so changes apply. */
    getUser(id: number): { id: number; username: string; role: string; name: string; active: number } | null {
        return this.db().prepare('SELECT id, username, role, name, active FROM users WHERE id = ?').get(id) ?? null;
    }

    createSession(input: { userId: number; deviceId: string | null; ip: string | null; facilityId?: number | null }) {
        const now = this.now();
        const id = crypto.randomUUID();
        const secret = randomToken();
        const absolute = now + this.policy.absoluteMs;
        const expiresAt = Math.min(now + this.policy.idleMs, absolute);
        this.db().prepare(`
            INSERT INTO server_sessions (id, user_id, device_id, facility_id, refresh_hash, ip, created_at, last_used_at, expires_at, absolute_expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(id, input.userId, input.deviceId, input.facilityId ?? null, sha256(secret), input.ip, now, now, expiresAt, absolute);
        return {
            session: { id, userId: input.userId, deviceId: input.deviceId, facilityId: input.facilityId ?? null, expiresAt },
            refreshToken: `${REFRESH_TOKEN_PREFIX}${id}.${secret}`
        };
    }

    /** An active session by id, or null when revoked or expired. */
    getActiveSession(id: string): ServerSession | null {
        const row = this.db().prepare('SELECT * FROM server_sessions WHERE id = ?').get(id) as any;
        if (!row || row.revoked_at != null || row.expires_at <= this.now()) return null;
        return toSession(row);
    }

    /**
     * Trades a refresh token for a new one (rotation). Presenting a refresh
     * token that was already rotated away means it leaked: the session is
     * revoked. The device must match the one the session was bound to.
     */
    refreshSession(token: unknown, deviceId: string | null, ip: string | null):
        { session: ServerSession; refreshToken: string } | { error: 'invalid' | 'reused' | 'expired' | 'device_mismatch' } {
        const parts = splitToken(token, REFRESH_TOKEN_PREFIX);
        if (!parts) return { error: 'invalid' };
        const db = this.db();
        const now = this.now();
        return db.transaction(() => {
            const row = db.prepare('SELECT * FROM server_sessions WHERE id = ?').get(parts.id) as any;
            if (!row || row.revoked_at != null) return { error: 'invalid' as const };
            if ((row.device_id ?? null) !== deviceId) return { error: 'device_mismatch' as const };
            if (!hashesEqual(row.refresh_hash, sha256(parts.secret))) {
                db.prepare(`UPDATE server_sessions SET revoked_at = ?, revoked_reason = 'refresh_reused' WHERE id = ?`).run(now, row.id);
                return { error: 'reused' as const };
            }
            if (row.expires_at <= now) return { error: 'expired' as const };
            const secret = randomToken();
            const expiresAt = Math.min(now + this.policy.idleMs, row.absolute_expires_at);
            db.prepare('UPDATE server_sessions SET refresh_hash = ?, last_used_at = ?, expires_at = ?, ip = ? WHERE id = ?')
                .run(sha256(secret), now, expiresAt, ip, row.id);
            return {
                session: toSession({ ...row, expires_at: expiresAt }),
                refreshToken: `${REFRESH_TOKEN_PREFIX}${row.id}.${secret}`
            };
        })();
    }

    /** Sets the session's active facility; the caller reissues the access token. */
    setSessionFacility(sessionId: string, facilityId: number | null): boolean {
        return Number(this.db().prepare('UPDATE server_sessions SET facility_id = ? WHERE id = ? AND revoked_at IS NULL')
            .run(facilityId, sessionId).changes ?? 0) > 0;
    }

    revokeSession(sessionId: string, reason = 'logout'): void {
        this.db().prepare('UPDATE server_sessions SET revoked_at = ?, revoked_reason = ? WHERE id = ? AND revoked_at IS NULL')
            .run(this.now(), reason, sessionId);
    }

    /** Signs a user out everywhere, e.g. after a password change or deactivation. */
    revokeUserSessions(userId: number, reason = 'user_revoked'): number {
        return Number(this.db().prepare('UPDATE server_sessions SET revoked_at = ?, revoked_reason = ? WHERE user_id = ? AND revoked_at IS NULL')
            .run(this.now(), reason, userId).changes ?? 0);
    }
}

function toDevice(row: any): JoinedDevice {
    return {
        id: row.id,
        name: row.name,
        joinedAt: row.joined_at,
        joinIp: row.join_ip ?? null,
        lastSeenAt: row.last_seen_at ?? null,
        lastIp: row.last_ip ?? null,
        revokedAt: row.revoked_at ?? null
    };
}

function toSession(row: any): ServerSession {
    return {
        id: row.id,
        userId: row.user_id,
        deviceId: row.device_id ?? null,
        facilityId: row.facility_id ?? null,
        expiresAt: row.expires_at
    };
}
