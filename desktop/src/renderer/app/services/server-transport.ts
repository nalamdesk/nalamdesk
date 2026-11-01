// Transports for the UI's server connection (#194).
//
// - Browser: fetch on the page's own origin (the server serves the UI), with
//   the browser's device credential from localStorage.
// - App in client mode: the main process sends each request over pinned
//   HTTPS and adds the computer's credential, which the page never sees.

import type { ServerTransport, TransportRequest, TransportResponse } from '../../../shared/server-client';
import { DEVICE_HEADER } from '../../../shared/protocol';

export interface NalamdeskClientBridge {
    info(): Promise<{ serverUrl: string | null; deviceName: string | null; pinned: boolean; appVersion: string; error: string | null } | null>;
    request(req: TransportRequest): Promise<TransportResponse>;
    openStream(id: string, req: TransportRequest): Promise<boolean>;
    closeStream(id: string): Promise<void>;
    onStreamChunk(listener: (id: string, text: string) => void): () => void;
    onStreamEnd(listener: (id: string, result: { status: number; body?: string; error?: string }) => void): () => void;
    disconnect(): Promise<boolean>;
}

export const BROWSER_DEVICE_KEY = 'nalamdesk_device';

/** The app's client-mode bridge, when this page runs inside it. */
export function clientBridge(): NalamdeskClientBridge | null {
    return (globalThis as { nalamdeskClient?: NalamdeskClientBridge }).nalamdeskClient ?? null;
}

export interface BrowserDevice {
    deviceId: string;
    deviceName: string;
    deviceToken: string;
}

export function readBrowserDevice(storage: Pick<Storage, 'getItem'> = localStorage): BrowserDevice | null {
    try {
        const parsed = JSON.parse(storage.getItem(BROWSER_DEVICE_KEY) ?? 'null');
        return parsed && typeof parsed.deviceToken === 'string' ? parsed : null;
    } catch {
        return null;
    }
}

function headersOf(response: Response): Record<string, string> {
    const out: Record<string, string> = {};
    response.headers.forEach((value, key) => { out[key.toLowerCase()] = value; });
    return out;
}

export function createFetchTransport(
    getDeviceToken: () => string | null,
    fetchImpl: typeof fetch = (...args) => fetch(...args)
): ServerTransport {
    const init = (req: TransportRequest, signal?: AbortSignal): RequestInit => {
        const headers: Record<string, string> = { ...req.headers };
        const device = getDeviceToken();
        if (device) headers[DEVICE_HEADER] = device;
        return { method: req.method, headers, body: req.body, signal, credentials: 'same-origin', cache: 'no-store' };
    };
    return {
        async request(req) {
            const response = await fetchImpl(req.path, init(req));
            return { status: response.status, headers: headersOf(response), body: await response.text() };
        },
        async stream(req, onChunk, signal) {
            let response: Response;
            try {
                response = await fetchImpl(req.path, init(req, signal));
            } catch (e) {
                if (signal.aborted) return { status: 0 };
                throw e;
            }
            if (response.status !== 200 || !response.body) return { status: response.status, body: await response.text() };
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            try {
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    onChunk(decoder.decode(value, { stream: true }));
                }
            } catch (e) {
                if (!signal.aborted) throw e;
            }
            return { status: response.status };
        }
    };
}

let streamSeq = 0;

export function createBridgeTransport(bridge: NalamdeskClientBridge): ServerTransport {
    return {
        request: (req) => bridge.request(req),
        stream(req, onChunk, signal) {
            const id = `s${Date.now().toString(36)}${(streamSeq++).toString(36)}`;
            return new Promise((resolve, reject) => {
                const offChunk = bridge.onStreamChunk((streamId, text) => { if (streamId === id) onChunk(text); });
                const offEnd = bridge.onStreamEnd((streamId, result) => {
                    if (streamId !== id) return;
                    cleanup();
                    if (result.error && !signal.aborted) reject(new Error(result.error));
                    else resolve({ status: result.status, body: result.body });
                });
                const onAbort = () => { void bridge.closeStream(id); };
                const cleanup = () => {
                    offChunk();
                    offEnd();
                    signal.removeEventListener('abort', onAbort);
                };
                signal.addEventListener('abort', onAbort, { once: true });
                bridge.openStream(id, req).then((opened) => {
                    if (!opened) {
                        cleanup();
                        reject(new Error('STREAM_REFUSED'));
                    }
                }, (e) => {
                    cleanup();
                    reject(e);
                });
            });
        }
    };
}
