// Live events for clients (#193): a Server-Sent Events stream replacing
// renderer push and polling. Events name what changed (a topic and the
// method that changed it), never the data: a client refetches through the
// RBAC-checked API, so the stream carries no patient information and needs
// no per-role filtering.

import type { FastifyReply, FastifyRequest } from 'fastify';

export type EventTopic = 'queue' | 'appointments' | 'bookings' | 'abdm.inbox' | 'patients' | 'billing' | 'clinical' | 'settings' | 'users' | 'data';

export interface ServerEvent {
    id: number;
    topic: EventTopic;
    at: number;
    method?: string;
}

interface Subscriber {
    write: (chunk: string) => boolean;
    close: () => void;
    sessionId: string | null;
    deviceId: string | null;
}

export interface EventHubOptions {
    heartbeatMs?: number;
    replaySize?: number;
    maxSubscribers?: number;
    now?: () => number;
}

const READ_ONLY = /^(get|find|list|search|preview|detect|validate)/;

/** Topics a successful API call changed; empty for reads. */
export function topicsForMethod(method: string): EventTopic[] {
    if (READ_ONLY.test(method)) return [];
    const topics = new Set<EventTopic>();
    if (/Queue|Consultation|checkIn/i.test(method)) topics.add('queue');
    if (/AppointmentRequest/.test(method)) topics.add('bookings');
    else if (/Appointment|checkIn|fulfill/i.test(method)) topics.add('appointments');
    if (/(^abdm(Accept|Ack|Simulate))|ShareToken|Inbox/.test(method)) topics.add('abdm.inbox');
    if (/Patient|Identifier|Abha|merge/i.test(method)) topics.add('patients');
    if (/Invoice|Payment/.test(method)) topics.add('billing');
    if (/Visit|Vitals|Allerg|Condition|Medication|Prescription/.test(method)) topics.add('clinical');
    if (/Settings|Role|Override|Demo|Condition|Medicine/.test(method)) topics.add('settings');
    if (/User/.test(method)) topics.add('users');
    if (topics.size === 0) topics.add('data');
    return [...topics];
}

export class EventHub {
    private readonly subscribers = new Set<Subscriber>();
    private readonly replay: ServerEvent[] = [];
    private nextId = 1;
    private heartbeat: ReturnType<typeof setInterval> | null = null;
    private readonly heartbeatMs: number;
    private readonly replaySize: number;
    private readonly maxSubscribers: number;
    private readonly now: () => number;

    /** Returns false when the subscriber's session is no longer valid. */
    sessionCheck: ((sessionId: string | null, deviceId: string | null) => boolean) | null = null;

    constructor(options: EventHubOptions = {}) {
        this.heartbeatMs = options.heartbeatMs ?? 25_000;
        this.replaySize = options.replaySize ?? 500;
        this.maxSubscribers = options.maxSubscribers ?? 500;
        this.now = options.now ?? Date.now;
    }

    get subscriberCount(): number {
        return this.subscribers.size;
    }

    publish(topic: EventTopic, method?: string): ServerEvent {
        const event: ServerEvent = { id: this.nextId++, topic, at: this.now(), ...(method ? { method } : {}) };
        this.replay.push(event);
        if (this.replay.length > this.replaySize) this.replay.shift();
        const frame = formatEvent(event);
        for (const sub of [...this.subscribers]) {
            try { sub.write(frame); } catch { this.drop(sub); }
        }
        return event;
    }

    /** Publishes every topic a successful API call changed. */
    publishForMethod(method: string): void {
        for (const topic of topicsForMethod(method)) this.publish(topic, method);
    }

    /** Ends streams for a revoked session or computer. */
    disconnect(filter: { sessionId?: string; deviceId?: string }): void {
        for (const sub of [...this.subscribers]) {
            if ((filter.sessionId && sub.sessionId === filter.sessionId)
                || (filter.deviceId && sub.deviceId === filter.deviceId)) {
                this.drop(sub);
            }
        }
    }

    /** Fastify handler body: takes over the reply and streams until the client leaves. */
    stream(request: FastifyRequest, reply: FastifyReply, auth: { sessionId: string | null; deviceId: string | null }): void {
        if (this.subscribers.size >= this.maxSubscribers) {
            reply.code(503).send({ error: 'TOO_MANY_STREAMS' });
            return;
        }
        reply.hijack();
        const res = reply.raw;
        res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache, no-transform',
            connection: 'keep-alive',
            'x-accel-buffering': 'no'
        });
        res.write(`retry: 3000\n\n`);

        const lastId = Number(request.headers['last-event-id'] ?? (request.query as any)?.lastEventId);
        if (Number.isInteger(lastId) && lastId > 0) {
            const oldest = this.replay[0]?.id ?? this.nextId;
            if (lastId < oldest - 1 || lastId >= this.nextId) {
                // Missed more than the buffer holds, or the server restarted
                // since: tell the client to refetch everything.
                res.write(`event: resync\ndata: {}\n\n`);
            } else {
                for (const event of this.replay) if (event.id > lastId) res.write(formatEvent(event));
            }
        }

        const sub: Subscriber = {
            write: (chunk) => res.write(chunk),
            close: () => res.end(),
            sessionId: auth.sessionId,
            deviceId: auth.deviceId
        };
        this.subscribers.add(sub);
        this.ensureHeartbeat();
        const cleanup = () => {
            this.subscribers.delete(sub);
            this.stopHeartbeatIfIdle();
        };
        request.raw.on('close', cleanup);
        res.on('close', cleanup);
    }

    close(): void {
        for (const sub of [...this.subscribers]) this.drop(sub);
        this.stopHeartbeatIfIdle();
    }

    private drop(sub: Subscriber): void {
        this.subscribers.delete(sub);
        try { sub.close(); } catch { /* already gone */ }
        this.stopHeartbeatIfIdle();
    }

    private ensureHeartbeat(): void {
        if (this.heartbeat) return;
        this.heartbeat = setInterval(() => {
            for (const sub of [...this.subscribers]) {
                if (this.sessionCheck && !this.sessionCheck(sub.sessionId, sub.deviceId)) {
                    this.drop(sub);
                    continue;
                }
                try { sub.write(`: ping\n\n`); } catch { this.drop(sub); }
            }
        }, this.heartbeatMs);
        this.heartbeat.unref?.();
    }

    private stopHeartbeatIfIdle(): void {
        if (this.subscribers.size === 0 && this.heartbeat) {
            clearInterval(this.heartbeat);
            this.heartbeat = null;
        }
    }
}

function formatEvent(event: ServerEvent): string {
    return `id: ${event.id}\nevent: ${event.topic}\ndata: ${JSON.stringify(event)}\n\n`;
}
