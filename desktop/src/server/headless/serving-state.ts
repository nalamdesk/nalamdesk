import * as fs from 'fs';
import * as path from 'path';
import type { ApiServerOptions } from '../network';

/**
 * What `start` actually serves, recorded in the data directory so that
 * `join-code` (often run from an admin shell without the service's TLS
 * environment) pins the same certificate clients will see.
 */
export interface ServingState {
    mode: 'self-signed' | 'certificate' | 'proxy';
    /** SHA-256 of the self-signed certificate; null when nothing is pinned. */
    fingerprint256: string | null;
    recordedAt: number;
}

export const SERVING_STATE_FILE = 'serving.json';

export function servingStateFrom(options: Pick<ApiServerOptions, 'tls' | 'behindProxy'>, now: number = Date.now()): ServingState {
    if (options.behindProxy || !options.tls) return { mode: 'proxy', fingerprint256: null, recordedAt: now };
    if (options.tls.selfSigned) return { mode: 'self-signed', fingerprint256: options.tls.fingerprint256, recordedAt: now };
    return { mode: 'certificate', fingerprint256: null, recordedAt: now };
}

export function writeServingState(dataDir: string, state: ServingState): void {
    const target = path.join(dataDir, SERVING_STATE_FILE);
    const temp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(temp, target);
}

/** The recorded state, or null when the server has not started yet or the file is unusable. */
export function readServingState(dataDir: string): ServingState | null {
    let parsed: any;
    try {
        parsed = JSON.parse(fs.readFileSync(path.join(dataDir, SERVING_STATE_FILE), 'utf8'));
    } catch {
        return null;
    }
    const recordedAt = Number(parsed?.recordedAt);
    if (!Number.isFinite(recordedAt)) return null;
    if (parsed?.mode === 'self-signed' && typeof parsed.fingerprint256 === 'string' && /^[0-9a-f]{64}$/.test(parsed.fingerprint256)) {
        return { mode: 'self-signed', fingerprint256: parsed.fingerprint256, recordedAt };
    }
    if (parsed?.mode === 'certificate' || parsed?.mode === 'proxy') return { mode: parsed.mode, fingerprint256: null, recordedAt };
    return null;
}

/** ApiServer options that make a join code pin exactly what the recorded server serves. */
export function pinOptions(state: ServingState): Pick<ApiServerOptions, 'tls'> {
    if (state.mode !== 'self-signed' || !state.fingerprint256) return { tls: null };
    return { tls: { key: '', cert: '', selfSigned: true, fingerprint256: state.fingerprint256 } };
}

export function describeServingState(state: ServingState): string {
    switch (state.mode) {
        case 'self-signed':
            return `It pins the self-signed certificate (SHA-256 ${state.fingerprint256}).`;
        case 'certificate':
            return 'Clients check the server certificate against their trusted CAs (no pin).';
        case 'proxy':
            return 'Clients check the reverse proxy certificate against their trusted CAs (no pin).';
    }
}
