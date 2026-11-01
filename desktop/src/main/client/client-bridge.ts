// The renderer's way to the server in client mode (#194). The renderer
// builds API requests and holds the user's session; the main process checks
// each request, adds the device credential and sends it over pinned HTTPS.
// The renderer can only reach /api/ paths on the joined server.

import type { ServerTransport, TransportRequest } from '../../shared/server-client';

const ALLOWED_METHODS = new Set(['GET', 'POST', 'DELETE']);
const ALLOWED_HEADERS = new Set(['content-type', 'authorization', 'accept', 'last-event-id', 'x-nalamdesk-protocol']);
const MAX_REQUEST_BYTES = 5 * 1024 * 1024;

/** Returns a clean request, or null when the renderer asked for something it may not. */
export function sanitizeRendererRequest(input: unknown): TransportRequest | null {
    if (!input || typeof input !== 'object') return null;
    const { method, path, headers, body } = input as Record<string, unknown>;
    if (typeof method !== 'string' || !ALLOWED_METHODS.has(method)) return null;
    if (typeof path !== 'string' || !/^\/api\/[A-Za-z0-9/_.:%?=&-]*$/.test(path) || path.includes('..') || path.includes('//')) return null;
    if (body !== undefined && (typeof body !== 'string' || body.length > MAX_REQUEST_BYTES)) return null;
    const clean: Record<string, string> = {};
    if (headers && typeof headers === 'object') {
        for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
            const name = key.toLowerCase();
            if (ALLOWED_HEADERS.has(name) && typeof value === 'string' && !/[\r\n]/.test(value)) clean[name] = value;
        }
    }
    return { method: method as TransportRequest['method'], path, headers: clean, ...(body === undefined ? {} : { body }) };
}

export interface StreamSink {
    chunk(id: string, text: string): void;
    end(id: string, result: { status: number; body?: string; error?: string }): void;
}

/** Event streams the renderer opened, so they can be closed or dropped with the window. */
export class ClientStreams {
    private readonly open = new Map<string, AbortController>();

    constructor(private readonly transport: () => ServerTransport) { }

    start(id: string, input: unknown, sink: StreamSink): boolean {
        const req = sanitizeRendererRequest(input);
        if (!req || req.method !== 'GET' || typeof id !== 'string' || !id || this.open.has(id)) return false;
        const controller = new AbortController();
        this.open.set(id, controller);
        this.transport().stream(req, (text) => sink.chunk(id, text), controller.signal)
            .then((result) => sink.end(id, result))
            .catch((e: Error) => sink.end(id, { status: 0, error: e?.message ?? 'UNREACHABLE' }))
            .finally(() => this.open.delete(id));
        return true;
    }

    stop(id: string): void {
        this.open.get(id)?.abort();
        this.open.delete(id);
    }

    stopAll(): void {
        for (const controller of this.open.values()) controller.abort();
        this.open.clear();
    }
}
