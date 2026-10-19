import type { Device, PairingRateLimiter, PairingRequest, PairingStore } from '../src/pairing.js';

/** In-memory twin of DynamoPairingStore, with the same conditions. */
export class MemoryPairingStore implements PairingStore {
    readonly requests = new Map<string, PairingRequest>();
    readonly devices = new Map<string, Device>();
    readonly clinicIds = new Map<string, string>();
    private clinicCounter = 0;

    async getRequest(hfrId: string) {
        const r = this.requests.get(hfrId);
        return r ? { ...r } : null;
    }

    async createRequest(request: PairingRequest, nowMs: number) {
        const existing = this.requests.get(request.hfrId);
        if (existing && existing.expiresAt >= nowMs) return false;
        this.requests.set(request.hfrId, { ...request });
        return true;
    }

    async deleteRequest(hfrId: string, requestId: string) {
        if (this.requests.get(hfrId)?.requestId !== requestId) return false;
        this.requests.delete(hfrId);
        return true;
    }

    async listRequests() {
        return [...this.requests.values()].map((r) => ({ ...r }));
    }

    async approve(hfrId: string, requestId: string, code: { hash: string; expiresAt: number }, approvedBy: string, nowMs: number) {
        const r = this.requests.get(hfrId);
        if (!r || r.requestId !== requestId || r.expiresAt <= nowMs) return false;
        Object.assign(r, { status: 'approved', codeHash: code.hash, codeExpiresAt: code.expiresAt, codeAttempts: 0, approvedBy, approvedAt: nowMs });
        return true;
    }

    async recordFailedAttempt(hfrId: string, requestId: string) {
        const r = this.requests.get(hfrId);
        if (!r || r.requestId !== requestId) return 5;
        r.codeAttempts = (r.codeAttempts ?? 0) + 1;
        return r.codeAttempts;
    }

    async clinicIdFor(hipId: string) {
        if (!this.clinicIds.has(hipId)) this.clinicIds.set(hipId, `cln_${++this.clinicCounter}`);
        return this.clinicIds.get(hipId)!;
    }

    async devicesFor(hipId: string) {
        return [...this.devices.values()].filter((d) => d.hipId === hipId).map((d) => ({ ...d }));
    }

    async getDevice(deviceId: string) {
        const d = this.devices.get(deviceId);
        return d ? { ...d } : null;
    }

    async activate(device: Device, revokeDeviceIds: string[], request: { hfrId: string; requestId: string; codeHash: string }, nowMs: number) {
        const r = this.requests.get(request.hfrId);
        if (this.devices.has(device.deviceId)) return false;
        if (!r || r.requestId !== request.requestId || r.codeHash !== request.codeHash || r.status !== 'approved') return false;
        if (revokeDeviceIds.some((id) => this.devices.get(id)?.status !== 'active')) return false;
        this.devices.set(device.deviceId, { ...device });
        for (const id of revokeDeviceIds) Object.assign(this.devices.get(id)!, { status: 'revoked', revokedAt: nowMs, revokedReason: 'replaced' });
        this.requests.delete(request.hfrId);
        return true;
    }

    async revoke(deviceId: string, reason: 'ops', by: string, nowMs: number) {
        const d = this.devices.get(deviceId);
        if (!d || d.status !== 'active') return false;
        Object.assign(d, { status: 'revoked', revokedAt: nowMs, revokedReason: reason, revokedBy: by });
        return true;
    }

    async rotateKey(deviceId: string, oldKey: string, newKey: string, validUntil: number, nowMs: number) {
        const d = this.devices.get(deviceId);
        if (!d || d.status !== 'active' || d.signingPublicKey !== oldKey) return false;
        Object.assign(d, { signingPublicKey: newKey, previousSigningPublicKey: oldKey, previousKeyValidUntil: validUntil, signingKeyCreatedAt: nowMs });
        return true;
    }
}

export class MemoryRateLimiter implements PairingRateLimiter {
    readonly hits = new Map<string, number>();
    constructor(private readonly limit = 5) {}
    async allow(ipKey: string) {
        const n = (this.hits.get(ipKey) ?? 0) + 1;
        this.hits.set(ipKey, n);
        return n <= this.limit;
    }
}
