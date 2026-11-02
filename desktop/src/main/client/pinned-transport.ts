// HTTPS to a NalamDesk Server from the app in client mode (#194). Runs in
// the main process so the renderer never holds the computer's device
// credential, and so a self-signed server certificate can be pinned: the
// join code carries the start of its fingerprint, the join stores the whole
// certificate, and every later connection must present exactly that one.
// Servers with an operator certificate are verified against the system CAs.

import * as https from 'node:https';
import * as tls from 'node:tls';
import * as net from 'node:net';
import * as crypto from 'node:crypto';
import { DEVICE_HEADER } from '../../shared/protocol';
import type { ServerTransport, TransportRequest, TransportResponse } from '../../shared/server-client';

export interface PinnedTransportOptions {
    /** https://host[:port] */
    serverUrl: string;
    /** PEM of a pinned self-signed certificate; absent means system CAs. */
    pinnedCert?: string | null;
    /** Lower-case hex SHA-256 fingerprint of the pinned certificate. */
    fingerprint256?: string | null;
    /** The computer's device credential, added to every request. */
    deviceToken?: string | null;
    timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 20 * 1024 * 1024;

export function normalizeFingerprint(value: string | undefined | null): string {
    return String(value ?? '').replace(/:/g, '').toLowerCase();
}

/** Validates an address typed by a person: https only, no path or credentials. */
export function normalizeServerUrl(input: string): string | null {
    let raw = String(input ?? '').trim();
    if (!raw) return null;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `https://${raw}`;
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        return null;
    }
    if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) return null;
    if (url.pathname !== '/' && url.pathname !== '') return null;
    if (url.search || url.hash) return null;
    return `https://${url.host}`;
}

function tlsOptions(options: PinnedTransportOptions): https.RequestOptions {
    if (!options.pinnedCert) return {};
    const expected = normalizeFingerprint(options.fingerprint256);
    return {
        // Trust only the pinned certificate, and only by its fingerprint: a
        // self-signed certificate often lacks the IP or name being dialled.
        ca: options.pinnedCert,
        // Reviewed (Sonar S5527): the identity check is the pinned
        // fingerprint, which is stricter than a hostname match.
        checkServerIdentity: (_host: string, cert: tls.PeerCertificate) => // NOSONAR
            normalizeFingerprint(cert.fingerprint256) === expected ? undefined : new Error('CERTIFICATE_PIN_MISMATCH')
    };
}

function flattenHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
        if (value !== undefined) out[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
    }
    return out;
}

export function createPinnedTransport(options: PinnedTransportOptions): ServerTransport {
    const base = new URL(options.serverUrl);
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const pin = tlsOptions(options);

    const open = (req: TransportRequest, onResponse: (res: import('node:http').IncomingMessage) => void, onError: (e: Error) => void) => {
        const headers: Record<string, string> = { ...req.headers };
        if (options.deviceToken) headers[DEVICE_HEADER] = options.deviceToken;
        if (req.body !== undefined) headers['content-length'] = String(Buffer.byteLength(req.body));
        const request = https.request({
            protocol: 'https:',
            hostname: base.hostname.replace(/^\[|\]$/g, ''),
            port: base.port || 443,
            method: req.method,
            path: req.path,
            headers,
            agent: false,
            ...pin
        }, onResponse);
        request.on('error', onError);
        return request;
    };

    return {
        request(req) {
            return new Promise<TransportResponse>((resolve, reject) => {
                const request = open(req, (res) => {
                    const chunks: Buffer[] = [];
                    let size = 0;
                    res.on('data', (chunk: Buffer) => {
                        size += chunk.length;
                        if (size > MAX_BODY_BYTES) {
                            request.destroy(new Error('RESPONSE_TOO_LARGE'));
                            return;
                        }
                        chunks.push(chunk);
                    });
                    res.on('end', () => resolve({
                        status: res.statusCode ?? 0,
                        headers: flattenHeaders(res.headers),
                        body: Buffer.concat(chunks).toString('utf8')
                    }));
                    res.on('error', reject);
                }, reject);
                request.setTimeout(timeoutMs, () => request.destroy(new Error('TIMEOUT')));
                if (req.body !== undefined) request.write(req.body);
                request.end();
            });
        },

        stream(req, onChunk, signal) {
            return new Promise((resolve, reject) => {
                if (signal.aborted) {
                    resolve({ status: 0 });
                    return;
                }
                const request = open(req, (res) => {
                    const status = res.statusCode ?? 0;
                    res.setEncoding('utf8');
                    if (status !== 200) {
                        let body = '';
                        res.on('data', (chunk: string) => { body += chunk; });
                        res.on('end', () => resolve({ status, body }));
                        return;
                    }
                    // Heartbeats arrive every 25 s; silence for much longer
                    // means the connection is dead even if the socket is not.
                    request.setTimeout(75_000, () => request.destroy(new Error('STREAM_IDLE')));
                    res.on('data', (chunk: string) => onChunk(chunk));
                    res.on('end', () => resolve({ status }));
                    res.on('error', (e) => (signal.aborted ? resolve({ status }) : reject(e)));
                }, (e) => (signal.aborted ? resolve({ status: 0 }) : reject(e)));
                request.setTimeout(timeoutMs, () => request.destroy(new Error('TIMEOUT')));
                signal.addEventListener('abort', () => request.destroy(), { once: true });
                request.end();
            });
        }
    };
}

export interface PeerCertificate {
    pem: string;
    fingerprint256: string;
}

/**
 * Reads the server's certificate without trusting it, so the join can
 * compare it with the fingerprint in the code before sending anything.
 */
export function fetchPeerCertificate(serverUrl: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<PeerCertificate> {
    const url = new URL(serverUrl);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    return new Promise((resolve, reject) => {
        const socket = tls.connect({
            host,
            port: Number(url.port || 443),
            ...(net.isIP(host) ? {} : { servername: host }),
            // Read-only probe: nothing is sent on this socket. The certificate
            // is checked by fingerprint against the join code before any
            // request; later connections pin it with full verification.
            // Reviewed (Sonar S4830): an unknown self-signed certificate
            // cannot be read any other way.
            rejectUnauthorized: false // NOSONAR
        }, () => {
            const peer = socket.getPeerCertificate(true);
            socket.end();
            if (!peer?.raw) {
                reject(new Error('NO_CERTIFICATE'));
                return;
            }
            const pem = new crypto.X509Certificate(peer.raw).toString();
            resolve({ pem, fingerprint256: normalizeFingerprint(peer.fingerprint256) });
        });
        socket.setTimeout(timeoutMs, () => socket.destroy(new Error('TIMEOUT')));
        socket.on('error', reject);
    });
}
