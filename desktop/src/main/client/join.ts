// Joining this computer to a NalamDesk Server (#194): trade the admin's
// one-time join code for a device credential, pinning a self-signed
// certificate on first contact.

import { joinCodeIsPinned, joinCodeMatchesFingerprint, parseJoinCode } from '../../shared/join-code';
import { checkServerHello, type ServerHello, type ServerTransport } from '../../shared/server-client';
import { PROTOCOL_HEADER, PROTOCOL_VERSION } from '../../shared/protocol';
import { createPinnedTransport, fetchPeerCertificate, normalizeServerUrl, type PeerCertificate } from './pinned-transport';
import type { ServerConnection } from './connection-store';

export interface JoinInput {
    serverUrl: string;
    code: string;
    deviceName: string;
}

export type JoinError =
    | 'INVALID_ADDRESS'
    | 'INVALID_CODE'
    | 'UNREACHABLE'
    | 'WRONG_SERVER'
    | 'CLIENT_UPGRADE_REQUIRED'
    | 'SERVER_UPGRADE_REQUIRED'
    | 'NOT_A_NALAMDESK_SERVER'
    | 'TOO_MANY_ATTEMPTS'
    | 'JOIN_FAILED';

export type JoinResult = { ok: true; connection: ServerConnection } | { ok: false; error: JoinError };

export interface JoinDeps {
    fetchPeerCertificate?: (serverUrl: string) => Promise<PeerCertificate>;
    createTransport?: typeof createPinnedTransport;
    now?: () => number;
}

function joinErrorFor(status: number, error: unknown): JoinError {
    if (status === 429) return 'TOO_MANY_ATTEMPTS';
    if (error === 'WRONG_SERVER') return 'WRONG_SERVER';
    if (error === 'INVALID_CODE') return 'INVALID_CODE';
    return 'JOIN_FAILED';
}

async function sayHello(transport: ServerTransport): Promise<ServerHello | JoinError> {
    let res;
    try {
        res = await transport.request({ method: 'GET', path: '/api/server/hello', headers: { [PROTOCOL_HEADER]: String(PROTOCOL_VERSION) } });
    } catch {
        return 'UNREACHABLE';
    }
    let hello: ServerHello;
    try {
        hello = JSON.parse(res.body);
    } catch {
        return 'NOT_A_NALAMDESK_SERVER';
    }
    if (res.status === 426) return (hello as unknown as { upgrade?: string })?.upgrade === 'server' ? 'SERVER_UPGRADE_REQUIRED' : 'CLIENT_UPGRADE_REQUIRED';
    if (res.status !== 200 || hello?.product !== 'nalamdesk-server') return 'NOT_A_NALAMDESK_SERVER';
    const verdict = checkServerHello(hello);
    if (!verdict.ok) return verdict.upgrade === 'client' ? 'CLIENT_UPGRADE_REQUIRED' : 'SERVER_UPGRADE_REQUIRED';
    return hello;
}

export async function joinServer(input: JoinInput, deps: JoinDeps = {}): Promise<JoinResult> {
    const serverUrl = normalizeServerUrl(input.serverUrl);
    if (!serverUrl) return { ok: false, error: 'INVALID_ADDRESS' };
    const code = String(input.code ?? '');
    if (!parseJoinCode(code)) return { ok: false, error: 'INVALID_CODE' };
    const deviceName = String(input.deviceName ?? '').trim().slice(0, 100) || 'Unnamed computer';

    let pinned: PeerCertificate | null = null;
    if (joinCodeIsPinned(code)) {
        try {
            pinned = await (deps.fetchPeerCertificate ?? fetchPeerCertificate)(serverUrl);
        } catch {
            return { ok: false, error: 'UNREACHABLE' };
        }
        // The certificate is not the one the admin's server holds: a typo in
        // the address, another server, or someone in between.
        if (!joinCodeMatchesFingerprint(code, pinned.fingerprint256)) return { ok: false, error: 'WRONG_SERVER' };
    }

    const transport = (deps.createTransport ?? createPinnedTransport)({
        serverUrl,
        pinnedCert: pinned?.pem ?? null,
        fingerprint256: pinned?.fingerprint256 ?? null
    });
    const hello = await sayHello(transport);
    if (typeof hello === 'string') return { ok: false, error: hello };

    let res;
    try {
        res = await transport.request({
            method: 'POST',
            path: '/api/devices/join',
            headers: { 'content-type': 'application/json', [PROTOCOL_HEADER]: String(PROTOCOL_VERSION) },
            body: JSON.stringify({ code, name: deviceName })
        });
    } catch {
        return { ok: false, error: 'UNREACHABLE' };
    }
    let body: any = null;
    try {
        body = JSON.parse(res.body);
    } catch { /* handled below */ }
    if (res.status !== 200 || typeof body?.deviceToken !== 'string') {
        return { ok: false, error: joinErrorFor(res.status, body?.error) };
    }
    return {
        ok: true,
        connection: {
            serverUrl,
            deviceId: String(body.deviceId),
            deviceName: String(body.deviceName ?? deviceName),
            deviceToken: body.deviceToken,
            pinnedCert: pinned?.pem ?? null,
            fingerprint256: pinned?.fingerprint256 ?? null,
            joinedAt: (deps.now ?? Date.now)()
        }
    };
}
