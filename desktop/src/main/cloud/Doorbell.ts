import type * as crypto from 'node:crypto';
import log from 'electron-log';
import type { IClientOptions, MqttClient } from 'mqtt';
import type { DoorbellIdentity } from './CloudPairingService';
import { certificateRequest, newDoorbellKey } from './iotCsr';
import type { SignedCloudClient } from './SignedCloudClient';

// The doorbell (#155): an MQTT connection to AWS IoT Core that receives an
// empty message on this clinic's topic whenever something lands in its
// mailbox. It carries nothing; a ring only starts a mailbox fetch, so a
// missed ring costs at most the wait until the 30-minute fallback.
//
// It connects with this device's own certificate on port 8883 and, where a
// network blocks that, on 443 with the `x-amzn-mqtt-ca` ALPN protocol.

export type DoorbellState = 'off' | 'connecting' | 'live';

const PORTS = [
    { port: 8883 },
    { port: 443, ALPNProtocols: ['x-amzn-mqtt-ca'] }
];
const CONNECT_TIMEOUT_MS = 20_000;
const MIN_RETRY_MS = 5_000;
const MAX_RETRY_MS = 10 * 60_000;
/** Failed connections in a row before the certificate is replaced. */
const REISSUE_AFTER_FAILURES = 6;

export interface DoorbellIdentitySource {
    doorbellIdentity(): DoorbellIdentity | null;
    saveDoorbellIdentity(key: crypto.KeyObject, issued: { certificatePem: string; endpoint: string; clientId: string; topic: string }): void;
    clearDoorbellIdentity(): void;
    deviceId(): string | null;
}

export interface DoorbellDeps {
    identity: DoorbellIdentitySource;
    client: Pick<SignedCloudClient, 'signed'>;
    /** Connected or reconnected: fetch what may have arrived meanwhile. */
    onConnected: () => void;
    onRing: () => void;
    onStateChange?: (state: DoorbellState) => void;
    /** mqtt.connect, injectable for tests. */
    connect?: (options: IClientOptions) => MqttClient;
    /** DatabaseService.runWork: certificate issuance writes the database, so a restore drains it. */
    runWork?: <T>(work: () => Promise<T>) => Promise<T>;
}

/**
 * Asks the relay for a certificate for a fresh P-256 key, and stores both,
 * unless `wanted` says the doorbell stopped while the relay was answering.
 */
export async function issueDoorbellIdentity(deps: Pick<DoorbellDeps, 'identity' | 'client'>, wanted: () => boolean = () => true): Promise<DoorbellIdentity> {
    const deviceId = deps.identity.deviceId();
    if (!deviceId) throw new Error('This computer is not paired.');
    const key = newDoorbellKey();
    const response = await deps.client.signed('relay', 'POST', '/device/iot-certificate', { csr: certificateRequest(key, deviceId) });
    const body = response.body ?? {};
    if (response.status !== 200 || typeof body.certificatePem !== 'string' || typeof body.endpoint !== 'string'
        || typeof body.topic !== 'string' || body.clientId !== deviceId) {
        throw new Error(`Doorbell certificate refused (${body.error || response.status}).`);
    }
    if (!wanted()) throw new Error('The doorbell stopped.');
    deps.identity.saveDoorbellIdentity(key, { certificatePem: body.certificatePem, endpoint: body.endpoint, clientId: body.clientId, topic: body.topic });
    const stored = deps.identity.doorbellIdentity();
    if (!stored) throw new Error('The doorbell certificate could not be stored.');
    return stored;
}

export class Doorbell {
    private client: MqttClient | null = null;
    private retryTimer: NodeJS.Timeout | null = null;
    private connectTimer: NodeJS.Timeout | null = null;
    private running = false;
    /** Bumped on each start and stop, so work from an earlier run saves nothing. */
    private run = 0;
    private current: DoorbellState = 'off';
    private portIndex = 0;
    private failures = 0;

    constructor(private readonly deps: DoorbellDeps) {}

    state(): DoorbellState {
        return this.current;
    }

    start(): void {
        if (this.running) return;
        this.running = true;
        this.run++;
        this.failures = 0;
        void this.attempt();
    }

    stop(): void {
        this.running = false;
        this.run++;
        if (this.retryTimer) clearTimeout(this.retryTimer);
        if (this.connectTimer) clearTimeout(this.connectTimer);
        this.retryTimer = this.connectTimer = null;
        this.drop();
        this.setState('off');
    }

    private setState(state: DoorbellState): void {
        if (state === this.current) return;
        this.current = state;
        this.deps.onStateChange?.(state);
    }

    private drop(): void {
        const client = this.client;
        this.client = null;
        if (client) {
            client.removeAllListeners();
            client.on('error', () => undefined);
            client.end(true);
        }
    }

    private async attempt(): Promise<void> {
        if (!this.running) return;
        this.setState('connecting');
        let identity: DoorbellIdentity | null;
        const run = this.run;
        const wanted = () => this.running && this.run === run;
        const work = <T>(task: () => Promise<T>) => (this.deps.runWork ? this.deps.runWork(task) : task());
        try {
            // Inside the restore fence: a restore waits for an issuance in
            // flight, and one finishing after stop() writes nothing.
            identity = await work(async () => {
                if (!wanted()) return null;
                if (this.failures >= REISSUE_AFTER_FAILURES) {
                    this.deps.identity.clearDoorbellIdentity();
                    this.failures = 0;
                }
                return this.deps.identity.doorbellIdentity() ?? await issueDoorbellIdentity(this.deps, wanted);
            });
        } catch (error) {
            if (!wanted()) return;
            log.warn(`[Doorbell] No certificate yet: ${(error as Error).message}`);
            this.failures++;
            this.retry();
            return;
        }
        if (!identity || !wanted()) return;

        const { port, ALPNProtocols } = PORTS[this.portIndex]!;
        const connect = this.deps.connect ?? (await import('mqtt')).connect;
        if (!wanted()) return;
        const client = connect({
            protocol: 'mqtts',
            host: identity.endpoint,
            servername: identity.endpoint,
            port,
            ...(ALPNProtocols ? { ALPNProtocols } : {}),
            clientId: identity.clientId,
            key: identity.privateKeyPem,
            cert: identity.certificatePem,
            protocolVersion: 4,
            clean: true,
            keepalive: 300,
            reconnectPeriod: 0,
            connectTimeout: CONNECT_TIMEOUT_MS
        });
        this.client = client;
        let connected = false;
        this.connectTimer = setTimeout(() => {
            if (!connected && this.client === client) this.failed(client, 'timed out');
        }, CONNECT_TIMEOUT_MS + 1_000);

        client.on('connect', () => {
            connected = true;
            if (this.connectTimer) clearTimeout(this.connectTimer);
            client.subscribe(identity!.topic, { qos: 0 }, (error) => {
                if (error) {
                    this.failed(client, `subscribe refused: ${error.message}`);
                    return;
                }
                this.failures = 0;
                this.setState('live');
                this.deps.onConnected();
            });
        });
        client.on('message', (topic) => {
            if (topic === identity!.topic) this.deps.onRing();
        });
        client.on('error', (error) => {
            if (this.client === client) this.failed(client, error.message);
        });
        client.on('close', () => {
            if (this.client === client) this.failed(client, connected ? 'connection closed' : 'refused');
        });
    }

    private failed(client: MqttClient, reason: string): void {
        if (this.client !== client) return;
        const wasLive = this.current === 'live';
        if (this.connectTimer) clearTimeout(this.connectTimer);
        this.drop();
        if (!wasLive) {
            this.failures++;
            // Try the other port before waiting.
            this.portIndex = (this.portIndex + 1) % PORTS.length;
            log.warn(`[Doorbell] Connection failed (${reason}); next on port ${PORTS[this.portIndex]!.port}.`);
        } else {
            log.info(`[Doorbell] Disconnected (${reason}).`);
        }
        this.setState('connecting');
        if (wasLive || this.portIndex !== 0) this.retry(MIN_RETRY_MS);
        else this.retry();
    }

    private retry(delayMs?: number): void {
        if (!this.running) return;
        if (this.retryTimer) clearTimeout(this.retryTimer);
        const backoff = delayMs ?? Math.min(MAX_RETRY_MS, MIN_RETRY_MS * 2 ** Math.min(this.failures, 8));
        this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            void this.attempt();
        }, backoff);
    }
}
