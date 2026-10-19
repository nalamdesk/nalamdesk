import * as crypto from 'node:crypto';
import { ed25519PublicKey, ed25519PublicKeyRaw } from '@nalamdesk/cloud-shared';

// Device pairing (#154). One active desktop per clinic, bound to the
// clinic's HFR ID:
//   1. The desktop asks to pair with its HFR ID and two public keys, signed
//      by the new signing key (proof it holds the key).
//   2. NalamDesk staff check the facility in HFR, link it to the bridge in
//      ABDM and approve in the ops console. Approval mints a one-time code,
//      which staff read to the HFR-registered contact. Only a keyed hash of
//      the code is stored.
//   3. The desktop sends the code, signed by the same key. The relay creates
//      the device and revokes any other active device for that HFR ID.
// Nothing is issued before approval, and the code alone is not enough: the
// activation must also be signed by the key in the original request.

export const PAIRING_LIMITS = {
    /** A pending request lapses after this long. */
    requestTtlMs: 24 * 60 * 60 * 1000,
    /** The code read to the clinic works for this long. */
    codeTtlMs: 15 * 60 * 1000,
    /** Wrong codes before the request is voided. */
    maxCodeAttempts: 5,
    /** Accepted distance between the desktop's timestamp and server time. */
    clockWindowMs: 60_000,
    /** How long the key before a rotation stays valid, for requests in flight. */
    rotationOverlapMs: 10 * 60 * 1000,
    /** Pairing requests per client IP. */
    ipPerHour: 5,
    ipPerDay: 20
};

// HFR facility IDs as NHA issues them: IN followed by ten digits. To confirm
// during sandbox registration (#152).
export const HFR_ID = /^IN\d{10}$/;
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const KEY = /^[A-Za-z0-9+/]{43}=$/;

export type PairingStatus = 'pending' | 'approved';

export interface PairingRequest {
    hfrId: string;
    requestId: string;
    status: PairingStatus;
    /** Raw 32-byte Ed25519 public key, base64. */
    signingPublicKey: string;
    /** Raw 32-byte X25519 public key, base64. */
    sealingPublicKey: string;
    label: string;
    appVersion: string;
    createdAt: number;
    /** Epoch ms; the request reads as gone afterwards. */
    expiresAt: number;
    codeHash?: string;
    codeExpiresAt?: number;
    codeAttempts?: number;
    approvedBy?: string;
    approvedAt?: number;
}

export type DeviceStatus = 'active' | 'revoked';

/** A row of the Core devices table. */
export interface Device {
    deviceId: string;
    clinicId: string;
    hipId: string;
    status: DeviceStatus;
    signingPublicKey: string;
    signingKeyCreatedAt: number;
    previousSigningPublicKey?: string;
    previousKeyValidUntil?: number;
    sealingPublicKey: string;
    dataPushToken: string;
    linkedToBridge: boolean;
    label: string;
    appVersion: string;
    pairedAt: number;
    approvedBy: string;
    revokedAt?: number;
    revokedReason?: 'replaced' | 'ops';
    revokedBy?: string;
}

export interface PairingStore {
    getRequest(hfrId: string): Promise<PairingRequest | null>;
    /** Conditional create: false while a live request exists for the HFR ID. */
    createRequest(request: PairingRequest, nowMs: number): Promise<boolean>;
    /** Deletes the request only if it is still this one. */
    deleteRequest(hfrId: string, requestId: string): Promise<boolean>;
    listRequests(): Promise<PairingRequest[]>;
    /** Marks this request approved with a fresh code; false if it changed or lapsed. */
    approve(hfrId: string, requestId: string, code: { hash: string; expiresAt: number }, approvedBy: string, nowMs: number): Promise<boolean>;
    /** Adds a wrong-code attempt and returns the new count. */
    recordFailedAttempt(hfrId: string, requestId: string): Promise<number>;
    /** The clinic ID for an HFR ID, created on first use and kept across replacements. */
    clinicIdFor(hipId: string): Promise<string>;
    devicesFor(hipId: string): Promise<Device[]>;
    getDevice(deviceId: string): Promise<Device | null>;
    /**
     * One transaction: create the device, revoke the listed devices and
     * delete the request (only if it still carries this code hash).
     */
    activate(device: Device, revokeDeviceIds: string[], request: { hfrId: string; requestId: string; codeHash: string }, nowMs: number): Promise<boolean>;
    revoke(deviceId: string, reason: 'ops', by: string, nowMs: number): Promise<boolean>;
    /** Swaps the signing key if it is still `oldKey`, keeping the old one until validUntil. */
    rotateKey(deviceId: string, oldKey: string, newKey: string, validUntil: number, nowMs: number): Promise<boolean>;
}

/** Counts pairing requests per client IP. */
export interface PairingRateLimiter {
    allow(ipKey: string, nowMs: number): Promise<boolean>;
}

/** Hooks run after a device is revoked: the IoT certificate and mailbox (#155). */
export interface DeviceLifecycle {
    revoked(device: Device): Promise<void>;
}

export const noLifecycle: DeviceLifecycle = { revoked: async () => undefined };

export type PairingResult<T> = { ok: true; value: T } | { ok: false; status: number; code: string; extra?: Record<string, unknown> };

const refuse = <T>(status: number, code: string, extra?: Record<string, unknown>): PairingResult<T> =>
    extra ? { ok: false, status, code, extra } : { ok: false, status, code };

// ---- Messages the desktop signs ----

export const pairingMessages = {
    request: (r: { hfrId: string; signingPublicKey: string; sealingPublicKey: string; label: string; appVersion: string; timestamp: string }) =>
        ['nalamdesk-pair-request-v1', r.hfrId, r.signingPublicKey, r.sealingPublicKey, r.label, r.appVersion, r.timestamp].join('|'),
    cancel: (r: { hfrId: string; timestamp: string }) => ['nalamdesk-pair-cancel-v1', r.hfrId, r.timestamp].join('|'),
    activate: (r: { hfrId: string; code: string; signingPublicKey: string; sealingPublicKey: string; timestamp: string }) =>
        ['nalamdesk-pair-activate-v1', r.hfrId, r.code, r.signingPublicKey, r.sealingPublicKey, r.timestamp].join('|'),
    rotate: (r: { deviceId: string; oldKey: string; newKey: string }) => ['nalamdesk-rotate-v1', r.deviceId, r.oldKey, r.newKey].join('|')
};

export function verifyEd25519(publicKeyRaw: string, message: string, signature: string): boolean {
    try {
        const bytes = Buffer.from(signature, 'base64url');
        return bytes.length === 64 && crypto.verify(null, Buffer.from(message, 'utf8'), ed25519PublicKey(publicKeyRaw), bytes);
    } catch {
        return false;
    }
}

function validX25519(raw: string): boolean {
    if (!KEY.test(raw)) return false;
    const bytes = Buffer.from(raw, 'base64');
    if (bytes.length !== 32 || bytes.every((b) => b === 0)) return false;
    try {
        crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), bytes]), format: 'der', type: 'spki' });
        return true;
    } catch {
        return false;
    }
}

function validEd25519(raw: string): boolean {
    if (!KEY.test(raw)) return false;
    try {
        return ed25519PublicKeyRaw(ed25519PublicKey(raw)) === raw;
    } catch {
        return false;
    }
}

/** 8 characters of Crockford base32 (about 40 bits), shown as XXXX-XXXX. */
export function newPairingCode(): string {
    let code = '';
    for (let i = 0; i < 8; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    return code;
}

/** Accepts what a person types: any case, spaces or dashes, O for 0 and I or L for 1. */
export function normalizeCode(input: string): string {
    return String(input ?? '').toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
}

export function formatCode(code: string): string {
    return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** Short, stable label for a signing key, so staff can tell requests apart. */
export function keyFingerprint(publicKeyRaw: string): string {
    const digest = crypto.createHash('sha256').update(Buffer.from(publicKeyRaw, 'base64')).digest();
    let out = '';
    for (let i = 0; i < 8; i++) out += CODE_ALPHABET[digest[i]! % 32];
    return formatCode(out);
}

const randomId = (prefix: string, bytes = 12) => {
    let out = '';
    for (const b of crypto.randomBytes(bytes)) out += CODE_ALPHABET[b % 32];
    return `${prefix}_${out.toLowerCase()}`;
};

const text = (value: unknown, max: number) =>
    typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, max) : '';

export interface PairingServiceOptions {
    store: PairingStore;
    ipLimiter: PairingRateLimiter;
    /** Keyed-hash secret for codes, from Parameter Store. */
    pepper: () => Promise<Buffer>;
    /** `https://<bridge domain>`, for the clinic's HIU data push URL. */
    bridgeUrl: string;
    lifecycle?: DeviceLifecycle;
    nowMs?: () => number;
    generateCode?: () => string;
}

export interface ActivatedDevice {
    deviceId: string;
    clinicId: string;
    hipId: string;
    dataPushUrl: string;
    serverTimeMs: number;
}

export class PairingService {
    private readonly nowMs: () => number;
    private readonly lifecycle: DeviceLifecycle;
    private readonly generateCode: () => string;

    constructor(private readonly options: PairingServiceOptions) {
        this.nowMs = options.nowMs ?? Date.now;
        this.lifecycle = options.lifecycle ?? noLifecycle;
        this.generateCode = options.generateCode ?? newPairingCode;
    }

    private clock<T>(timestamp: unknown): PairingResult<T> | null {
        const now = this.nowMs();
        if (typeof timestamp !== 'string' || !/^\d{13}$/.test(timestamp)) return refuse(400, 'bad_request');
        if (Math.abs(now - Number(timestamp)) > PAIRING_LIMITS.clockWindowMs) return refuse(401, 'clock_skew', { serverTime: now });
        return null;
    }

    private async codeHash(hfrId: string, requestId: string, code: string): Promise<string> {
        return crypto.createHmac('sha256', await this.options.pepper()).update(`${hfrId}|${requestId}|${code}`).digest('hex');
    }

    private async live(hfrId: string): Promise<PairingRequest | null> {
        const request = await this.options.store.getRequest(hfrId);
        return request && request.expiresAt > this.nowMs() ? request : null;
    }

    async request(body: Record<string, unknown>, clientIp: string): Promise<PairingResult<{ requestId: string; expiresAt: number }>> {
        const hfrId = typeof body.hfrId === 'string' ? body.hfrId.trim().toUpperCase() : '';
        const signingPublicKey = String(body.signingPublicKey ?? '');
        const sealingPublicKey = String(body.sealingPublicKey ?? '');
        const label = text(body.label, 60);
        const appVersion = text(body.appVersion, 32);
        if (!HFR_ID.test(hfrId)) return refuse(400, 'bad_hfr_id');
        if (!validEd25519(signingPublicKey) || !validX25519(sealingPublicKey) || !label) return refuse(400, 'bad_request');
        const skew = this.clock<{ requestId: string; expiresAt: number }>(body.timestamp);
        if (skew) return skew;
        const timestamp = body.timestamp as string;
        const message = pairingMessages.request({ hfrId, signingPublicKey, sealingPublicKey, label, appVersion, timestamp });
        if (!verifyEd25519(signingPublicKey, message, String(body.signature ?? ''))) return refuse(401, 'bad_signature');

        const ipKey = crypto.createHash('sha256').update(`nalamdesk-pair-ip|${clientIp}`).digest('base64url').slice(0, 22);
        if (!(await this.options.ipLimiter.allow(ipKey, this.nowMs()))) return refuse(429, 'rate_limited');

        const existing = await this.live(hfrId);
        if (existing) {
            // A retry from the same install gets the same answer.
            if (existing.signingPublicKey === signingPublicKey && existing.sealingPublicKey === sealingPublicKey) {
                return { ok: true, value: { requestId: existing.requestId, expiresAt: existing.expiresAt } };
            }
            return refuse(409, 'pending_exists');
        }
        const now = this.nowMs();
        const request: PairingRequest = {
            hfrId, requestId: randomId('pr'), status: 'pending', signingPublicKey, sealingPublicKey, label, appVersion,
            createdAt: now, expiresAt: now + PAIRING_LIMITS.requestTtlMs
        };
        if (!(await this.options.store.createRequest(request, now))) return refuse(409, 'pending_exists');
        return { ok: true, value: { requestId: request.requestId, expiresAt: request.expiresAt } };
    }

    async cancel(body: Record<string, unknown>): Promise<PairingResult<null>> {
        const hfrId = typeof body.hfrId === 'string' ? body.hfrId.trim().toUpperCase() : '';
        if (!HFR_ID.test(hfrId)) return refuse(400, 'bad_hfr_id');
        const skew = this.clock<null>(body.timestamp);
        if (skew) return skew;
        const request = await this.live(hfrId);
        if (!request) return refuse(404, 'no_request');
        const message = pairingMessages.cancel({ hfrId, timestamp: body.timestamp as string });
        if (!verifyEd25519(request.signingPublicKey, message, String(body.signature ?? ''))) return refuse(401, 'bad_signature');
        await this.options.store.deleteRequest(hfrId, request.requestId);
        return { ok: true, value: null };
    }

    async activate(body: Record<string, unknown>): Promise<PairingResult<ActivatedDevice>> {
        const hfrId = typeof body.hfrId === 'string' ? body.hfrId.trim().toUpperCase() : '';
        const code = normalizeCode(String(body.code ?? ''));
        if (!HFR_ID.test(hfrId)) return refuse(400, 'bad_hfr_id');
        if (!/^[0-9A-HJKMNP-TV-Z]{8}$/.test(code)) return refuse(400, 'bad_code_format');
        const skew = this.clock<ActivatedDevice>(body.timestamp);
        if (skew) return skew;
        const request = await this.live(hfrId);
        if (!request) return (await this.alreadyActivated(hfrId, code, body)) ?? refuse(404, 'no_request');

        // The signature comes first, so only the install that asked can spend attempts.
        const message = pairingMessages.activate({
            hfrId, code, signingPublicKey: request.signingPublicKey, sealingPublicKey: request.sealingPublicKey, timestamp: body.timestamp as string
        });
        if (!verifyEd25519(request.signingPublicKey, message, String(body.signature ?? ''))) return refuse(401, 'bad_signature');
        if (request.status !== 'approved' || !request.codeHash) return refuse(409, 'not_approved');
        const now = this.nowMs();
        if ((request.codeExpiresAt ?? 0) <= now) return refuse(410, 'code_expired');

        const presented = Buffer.from(await this.codeHash(hfrId, request.requestId, code), 'hex');
        if (!crypto.timingSafeEqual(presented, Buffer.from(request.codeHash, 'hex'))) {
            const attempts = await this.options.store.recordFailedAttempt(hfrId, request.requestId);
            if (attempts >= PAIRING_LIMITS.maxCodeAttempts) {
                await this.options.store.deleteRequest(hfrId, request.requestId);
                return refuse(410, 'request_voided');
            }
            return refuse(401, 'bad_code', { attemptsLeft: PAIRING_LIMITS.maxCodeAttempts - attempts });
        }

        const clinicId = await this.options.store.clinicIdFor(hfrId);
        const previous = (await this.options.store.devicesFor(hfrId)).filter((d) => d.status === 'active');
        const device: Device = {
            deviceId: randomId('dev', 16),
            clinicId,
            hipId: hfrId,
            status: 'active',
            signingPublicKey: request.signingPublicKey,
            signingKeyCreatedAt: now,
            sealingPublicKey: request.sealingPublicKey,
            dataPushToken: crypto.randomBytes(32).toString('base64url'),
            // Staff approve only after linking the facility to the bridge.
            linkedToBridge: true,
            label: request.label,
            appVersion: request.appVersion,
            pairedAt: now,
            approvedBy: request.approvedBy ?? 'unknown'
        };
        const committed = await this.options.store.activate(device, previous.map((d) => d.deviceId), {
            hfrId, requestId: request.requestId, codeHash: request.codeHash
        }, now);
        if (!committed) return refuse(409, 'conflict');
        for (const old of previous) {
            await this.lifecycle.revoked({ ...old, status: 'revoked', revokedAt: now, revokedReason: 'replaced' }).catch(() => undefined);
        }
        return {
            ok: true,
            value: {
                deviceId: device.deviceId,
                clinicId,
                hipId: hfrId,
                dataPushUrl: `${this.options.bridgeUrl}/hiu/data-push/${device.dataPushToken}`,
                serverTimeMs: now
            }
        };
    }

    /**
     * A retried activation whose first answer was lost: the request is gone,
     * but the install that now owns the active device proves it with the same
     * signed message and gets the same answer. Nothing new is created.
     */
    private async alreadyActivated(hfrId: string, code: string, body: Record<string, unknown>): Promise<PairingResult<ActivatedDevice> | null> {
        const devices = (await this.options.store.devicesFor(hfrId)).filter((d) => d.status === 'active');
        for (const device of devices) {
            const message = pairingMessages.activate({
                hfrId, code, signingPublicKey: device.signingPublicKey, sealingPublicKey: device.sealingPublicKey, timestamp: body.timestamp as string
            });
            if (!verifyEd25519(device.signingPublicKey, message, String(body.signature ?? ''))) continue;
            return {
                ok: true,
                value: {
                    deviceId: device.deviceId,
                    clinicId: device.clinicId,
                    hipId: hfrId,
                    dataPushUrl: `${this.options.bridgeUrl}/hiu/data-push/${device.dataPushToken}`,
                    serverTimeMs: this.nowMs()
                }
            };
        }
        return null;
    }

    // ---- Ops ----

    async listRequests(): Promise<(Omit<PairingRequest, 'codeHash' | 'signingPublicKey' | 'sealingPublicKey'> & { keyFingerprint: string })[]> {
        const now = this.nowMs();
        return (await this.options.store.listRequests())
            .filter((r) => r.expiresAt > now)
            .sort((a, b) => a.createdAt - b.createdAt)
            .map(({ codeHash: _hash, signingPublicKey, sealingPublicKey: _sealing, ...rest }) => ({ ...rest, keyFingerprint: keyFingerprint(signingPublicKey) }));
    }

    async approve(hfrId: string, requestId: string, approvedBy: string): Promise<PairingResult<{ code: string; expiresAt: number }>> {
        const request = await this.live(hfrId);
        if (!request || request.requestId !== requestId) return refuse(404, 'no_request');
        const code = this.generateCode();
        const now = this.nowMs();
        const expiresAt = now + PAIRING_LIMITS.codeTtlMs;
        const hash = await this.codeHash(hfrId, requestId, code);
        if (!(await this.options.store.approve(hfrId, requestId, { hash, expiresAt }, approvedBy, now))) return refuse(404, 'no_request');
        return { ok: true, value: { code: formatCode(code), expiresAt } };
    }

    async reject(hfrId: string, requestId: string): Promise<PairingResult<null>> {
        if (!(await this.options.store.deleteRequest(hfrId, requestId))) return refuse(404, 'no_request');
        return { ok: true, value: null };
    }

    async devices(hipId: string): Promise<PairingResult<Omit<Device, 'dataPushToken'>[]>> {
        if (!HFR_ID.test(hipId)) return refuse(400, 'bad_hfr_id');
        const devices = (await this.options.store.devicesFor(hipId)).sort((a, b) => b.pairedAt - a.pairedAt);
        return { ok: true, value: devices.map(({ dataPushToken: _token, ...rest }) => rest) };
    }

    async revoke(deviceId: string, by: string): Promise<PairingResult<null>> {
        const device = await this.options.store.getDevice(deviceId);
        if (!device) return refuse(404, 'no_device');
        if (device.status !== 'active') return refuse(409, 'already_revoked');
        const now = this.nowMs();
        if (!(await this.options.store.revoke(deviceId, 'ops', by, now))) return refuse(409, 'already_revoked');
        await this.lifecycle.revoked({ ...device, status: 'revoked', revokedAt: now, revokedReason: 'ops', revokedBy: by }).catch(() => undefined);
        return { ok: true, value: null };
    }

    // ---- Paired device ----

    async rotateKey(deviceId: string, body: Record<string, unknown>): Promise<PairingResult<null>> {
        const newKey = String(body.signingPublicKey ?? '');
        if (!validEd25519(newKey)) return refuse(400, 'bad_request');
        const device = await this.options.store.getDevice(deviceId);
        if (!device || device.status !== 'active') return refuse(401, 'device_revoked');
        if (newKey === device.signingPublicKey) return refuse(400, 'same_key');
        const message = pairingMessages.rotate({ deviceId, oldKey: device.signingPublicKey, newKey });
        if (!verifyEd25519(newKey, message, String(body.proof ?? ''))) return refuse(401, 'bad_proof');
        const now = this.nowMs();
        // One rotation at a time, so the key before it keeps its full overlap.
        if ((device.previousKeyValidUntil ?? 0) > now) return refuse(409, 'rotation_in_progress');
        if (!(await this.options.store.rotateKey(deviceId, device.signingPublicKey, newKey, now + PAIRING_LIMITS.rotationOverlapMs, now))) {
            return refuse(409, 'conflict');
        }
        return { ok: true, value: null };
    }
}
