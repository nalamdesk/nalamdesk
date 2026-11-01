// Login and join throttling (#193). In memory: one server process owns the
// listener, and a restart is an operator action, not something an attacker
// on the network can trigger.

export type Clock = () => number;

export type LimitVerdict = { allowed: true } | { allowed: false; retryAfterSec: number };

const MAX_TRACKED_KEYS = 10_000;

/** Counts events per key in a sliding window and refuses past a limit. */
export class SlidingWindowLimiter {
    private readonly hits = new Map<string, number[]>();

    constructor(
        private readonly limit: number,
        private readonly windowMs: number,
        private readonly now: Clock = Date.now
    ) { }

    check(key: string): LimitVerdict {
        const recent = this.recent(key);
        if (recent.length < this.limit) return { allowed: true };
        const retryAt = recent[recent.length - this.limit] + this.windowMs;
        return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((retryAt - this.now()) / 1000)) };
    }

    record(key: string): void {
        const recent = this.recent(key);
        recent.push(this.now());
        this.hits.delete(key);
        this.hits.set(key, recent);
        evictOldest(this.hits);
    }

    reset(key: string): void {
        this.hits.delete(key);
    }

    private recent(key: string): number[] {
        const cutoff = this.now() - this.windowMs;
        const list = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
        if (list.length === 0) this.hits.delete(key);
        return list;
    }
}

interface LockState {
    failures: number;
    lockedUntil: number;
    lastFailure: number;
}

export interface LoginLimiterOptions {
    /** Failed logins allowed from one address per window. */
    perIpLimit?: number;
    perIpWindowMs?: number;
    /** Consecutive failures for one username before it locks. */
    lockoutThreshold?: number;
    /** First lockout; doubles with each further failure, up to the cap. */
    lockoutBaseMs?: number;
    lockoutMaxMs?: number;
    /** Failure streaks older than this are forgotten. */
    failureMemoryMs?: number;
    now?: Clock;
}

/**
 * Per-address failure window plus per-username lockout with exponential
 * backoff. Usernames are tracked whether or not they exist, so the lockout
 * response never tells an attacker which accounts are real.
 */
export class LoginLimiter {
    private readonly ip: SlidingWindowLimiter;
    private readonly users = new Map<string, LockState>();
    private readonly now: Clock;
    private readonly threshold: number;
    private readonly baseMs: number;
    private readonly maxMs: number;
    private readonly memoryMs: number;

    constructor(options: LoginLimiterOptions = {}) {
        this.now = options.now ?? Date.now;
        this.ip = new SlidingWindowLimiter(options.perIpLimit ?? 30, options.perIpWindowMs ?? 15 * 60_000, this.now);
        this.threshold = options.lockoutThreshold ?? 5;
        this.baseMs = options.lockoutBaseMs ?? 60_000;
        this.maxMs = options.lockoutMaxMs ?? 15 * 60_000;
        this.memoryMs = options.failureMemoryMs ?? 60 * 60_000;
    }

    check(ip: string, username: string): LimitVerdict {
        const byIp = this.ip.check(ip);
        if (!byIp.allowed) return byIp;
        const state = this.state(username);
        if (state && state.lockedUntil > this.now()) {
            return { allowed: false, retryAfterSec: Math.ceil((state.lockedUntil - this.now()) / 1000) };
        }
        return { allowed: true };
    }

    /** Records a failure; returns true when this failure locked the username. */
    recordFailure(ip: string, username: string): boolean {
        this.ip.record(ip);
        const key = normalize(username);
        const state = this.state(username) ?? { failures: 0, lockedUntil: 0, lastFailure: 0 };
        state.failures += 1;
        state.lastFailure = this.now();
        let locked = false;
        if (state.failures >= this.threshold) {
            const steps = state.failures - this.threshold;
            state.lockedUntil = this.now() + Math.min(this.maxMs, this.baseMs * 2 ** Math.min(steps, 20));
            locked = true;
        }
        this.users.delete(key);
        this.users.set(key, state);
        evictOldest(this.users);
        return locked;
    }

    recordSuccess(_ip: string, username: string): void {
        this.users.delete(normalize(username));
    }

    private state(username: string): LockState | undefined {
        const key = normalize(username);
        const state = this.users.get(key);
        if (state && state.lockedUntil <= this.now() && this.now() - state.lastFailure > this.memoryMs) {
            this.users.delete(key);
            return undefined;
        }
        return state;
    }
}

function normalize(username: string): string {
    return String(username).trim().toLowerCase();
}

function evictOldest<K, V>(map: Map<K, V>): void {
    while (map.size > MAX_TRACKED_KEYS) {
        const oldest = map.keys().next().value as K;
        map.delete(oldest);
    }
}
