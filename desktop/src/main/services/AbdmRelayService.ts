import * as crypto from 'node:crypto';
import { CloudUnavailableError, type AbdmRelaySend } from '../cloud/SignedCloudClient';

export type AbdmUpstream = 'abha' | 'gateway';

export interface AbdmRelayDeps {
    getSettings?: () => any;
    /** Signed calls through the relay as the paired facility; null before pairing. */
    relay?: () => AbdmRelaySend | null;
    /** The paired HFR ID, shown in Settings; null before pairing. */
    pairedHfrId?: () => string | null;
    nowMs?: () => number;
}

export interface AbdmConnectionStatus {
    mode: 'mock' | 'relay';
    paired: boolean;
    /** The HFR ID this computer is paired as; it is also the HIP ID the relay sends. */
    hfr_id: string | null;
    /** An admin chose the mock gateway even though the computer is paired. */
    forced_mock: boolean;
}

// The relay's own certificate route, used as a harmless connectivity probe.
const PROBE_PATH = '/v3/profile/public/certificate';

/**
 * ABDM through the NalamDesk relay (#160). The clinic computer holds no ABDM
 * credentials: the relay adds the vendor token and the facility headers to
 * every signed call. Until this computer is paired, or when an admin turns
 * the mock gateway on for offline work, the ABDM flows run against an
 * in-process mock shaped like the sandbox, clearly labeled.
 */
export class AbdmRelayService {
    constructor(private readonly deps: AbdmRelayDeps = {}) { }

    private get settings(): any {
        try {
            return this.deps.getSettings?.() || {};
        } catch {
            return {};
        }
    }

    private nowMs(): number {
        return this.deps.nowMs ? this.deps.nowMs() : Date.now();
    }

    private forcedMock(): boolean {
        const value = this.settings.abdm_mock;
        return value === 1 || value === true;
    }

    private sender(): AbdmRelaySend | null {
        try {
            return this.deps.relay?.() ?? null;
        } catch {
            return null;
        }
    }

    isMockMode(): boolean {
        return this.forcedMock() || !this.sender();
    }

    status(): AbdmConnectionStatus {
        const paired = !!this.sender();
        let hfrId: string | null = null;
        try {
            hfrId = paired ? this.deps.pairedHfrId?.() ?? null : null;
        } catch {
            hfrId = null;
        }
        const forced = this.forcedMock();
        return { mode: forced || !paired ? 'mock' : 'relay', paired, hfr_id: hfrId, forced_mock: forced };
    }

    /**
     * One ABDM call through the relay. Resolves with the JSON body of a 2xx
     * answer; anything else throws a message fit for the front desk.
     */
    async send(upstream: AbdmUpstream, method: 'GET' | 'POST', path: string, body?: unknown): Promise<any> {
        const send = this.sender();
        if (!send) throw new Error('This computer is not paired with NalamDesk Cloud, so ABDM is in mock mode.');
        let response: Awaited<ReturnType<AbdmRelaySend>>;
        try {
            response = await send(method, `/abdm/${upstream}${path}`, method === 'GET' ? undefined : body ?? {});
        } catch (error) {
            if (error instanceof CloudUnavailableError) throw new Error(`ABDM relay is unreachable: ${error.message}`);
            throw error;
        }
        if (response.status < 200 || response.status >= 300) {
            const code = typeof response.body?.error === 'string' ? ` (${response.body.error})` : '';
            throw new Error(`ABDM request rejected (HTTP ${response.status}${code}).`);
        }
        return response.body;
    }

    /** Lightweight check for the Settings test button: one relayed read, no patient data. */
    async testConnectivity(): Promise<{ ok: boolean; mode: 'mock' | 'relay'; detail: string; latencyMs?: number }> {
        const status = this.status();
        if (status.mode === 'mock') {
            return {
                ok: true,
                mode: 'mock',
                detail: status.forced_mock
                    ? 'Mock gateway is on for testing; turn it off to use the relay.'
                    : 'Mock gateway active: pair this computer with NalamDesk Cloud to reach ABDM.'
            };
        }
        const started = this.nowMs();
        try {
            await this.send('abha', 'GET', PROBE_PATH);
            return { ok: true, mode: 'relay', detail: `ABDM reached through the relay as ${status.hfr_id}.`, latencyMs: this.nowMs() - started };
        } catch (error) {
            return { ok: false, mode: 'relay', detail: error instanceof Error ? error.message : 'ABDM relay check failed.' };
        }
    }

    /** RSA-OAEP (SHA-1 MGF1) encryption for Aadhaar/mobile OTP payloads. */
    static encryptWithPublicKey(payload: string, publicKeyPem: string): string {
        return crypto.publicEncrypt(
            {
                key: publicKeyPem,
                padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
                oaepHash: 'sha1'
            },
            Buffer.from(String(payload), 'utf8')
        ).toString('base64');
    }
}

/** The ABDM settings the desk sees: registry identity, the relay connection, and no secrets. */
export function abdmConfigView(settings: any, relay: AbdmRelayService): Record<string, unknown> {
    const s = settings || {};
    const status = relay.status();
    return {
        mock: status.mode === 'mock',
        forced_mock: status.forced_mock,
        paired: status.paired,
        paired_hfr_id: status.hfr_id || '',
        hip_id: s.abdm_hip_id || '',
        counter_id: s.abdm_counter_id || '',
        hfr_id: s.abdm_hfr_id || '',
        hpr_id: s.abdm_hpr_id || '',
        hip_endpoint: s.abdm_hip_endpoint || '',
        has_recipient_key: !!s.abdm_recipient_key
    };
}
