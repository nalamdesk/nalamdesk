// Client-server protocol version (#193). Server and clients share one
// release number, but a clinic upgrades the server and its computers at
// different moments, so the wire protocol is versioned separately: bump
// PROTOCOL_VERSION only when an older client can no longer talk to the new
// server correctly. The server accepts its own version and the one before.
//
// Shared by the server and the clients; no Node-only imports.

export const PROTOCOL_VERSION = 1;
export const MIN_SUPPORTED_PROTOCOL = Math.max(1, PROTOCOL_VERSION - 1);

/** Request header carrying the client's protocol; the server echoes its own. */
export const PROTOCOL_HEADER = 'x-nalamdesk-protocol';
/** Response header carrying the server's release version. */
export const SERVER_VERSION_HEADER = 'x-nalamdesk-server-version';
/** Request header carrying the joined computer's device credential. */
export const DEVICE_HEADER = 'x-nalamdesk-device';

export type ProtocolVerdict =
    | { ok: true; version: number }
    | { ok: false; upgrade: 'client' | 'server'; error: string };

/**
 * Checks a client's protocol header. A missing header is accepted as the
 * current version: the browser UI is served by the server itself and so
 * always matches it.
 */
export function checkClientProtocol(header: string | string[] | undefined): ProtocolVerdict {
    if (header === undefined || header === '') return { ok: true, version: PROTOCOL_VERSION };
    const raw = Array.isArray(header) ? header[0] : header;
    const version = Number(raw);
    if (!Number.isInteger(version) || version < 1) {
        return { ok: false, upgrade: 'client', error: 'INVALID_PROTOCOL' };
    }
    if (version < MIN_SUPPORTED_PROTOCOL) {
        return { ok: false, upgrade: 'client', error: 'CLIENT_TOO_OLD' };
    }
    if (version > PROTOCOL_VERSION) {
        return { ok: false, upgrade: 'server', error: 'SERVER_TOO_OLD' };
    }
    return { ok: true, version };
}
