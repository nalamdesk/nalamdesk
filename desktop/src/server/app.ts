import Fastify, { FastifyInstance, FastifyRequest, FastifyReply, InjectOptions } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCors from '@fastify/cors';
import * as jwt from 'jsonwebtoken';
import { DatabaseService } from '../main/services/DatabaseService';
import * as argon2 from 'argon2';
import * as crypto from 'crypto';
import * as dotenv from 'dotenv';
import * as http from 'node:http';
import { loadDevelopmentEnv } from '../shared/load-env';
import { invokeDbMethod } from '../shared/ipc-db-args';
import { hashUrlForPathname } from '../shared/hash-app-path';
import { AbdmSessionService } from '../main/services/AbdmSessionService';
import { AbdmAbhaService } from '../main/services/AbdmAbhaService';
import { HiuService } from '../main/services/HiuService';
import { parseClinicalBundle } from '../shared/fhir/parser';
import { FideliusService } from '../main/services/FideliusService';
import { ElectronSafeStorageDeviceKeyStore } from '../main/services/DeviceKeyStore';

loadDevelopmentEnv();
dotenv.config();

if (process.env['NODE_ENV'] === 'production' && !process.env['JWT_SECRET']) {
    console.error('FATAL: JWT_SECRET must be set in production');
    process.exit(1);
}
const JWT_SECRET = process.env['JWT_SECRET'] || crypto.randomBytes(64).toString('hex');

const ABDM_SERVICE_METHODS = new Set([
    'abdmGetConfig', 'abdmSaveConfig', 'abdmSetSecret', 'abdmTestConnectivity',
    'abdmSimulateShare', 'abdmAbhaLookup', 'abdmAbhaRequestOtp',
    'abdmAbhaConfirmOtp', 'abdmAbhaRequestLoginOtp', 'abdmAbhaConfirmLoginOtp',
    'abdmAbhaCard', 'abdmLinkAbha', 'abdmTransferBundle', 'abdmHiuGetPublicKey',
    'abdmHiuRequestConsent', 'abdmHiuGetConsents', 'abdmHiuFetchRecords',
    'abdmHiuGetExternalRecords', 'abdmHiuClearExternalRecords', 'abdmHiuImportMedication'
]);

const ALLOWED_IPC_METHODS = [
    'getQueue', 'addToQueue', 'reassessQueueTriage', 'getQueueTriageHistory', 'updateQueueStatus', 'updateQueueStatusByPatientId', 'removeFromQueue',
    'getAuditLogs',
    'getAppointmentRequests', 'updateAppointmentRequestStatus',
    'getAppointments', 'saveAppointment',
    'validateUser', 'getPermissions',
    'getDashboardStats',
    'getPatients', 'getPatientById', 'savePatient', 'deletePatient',
    'getVisits', 'getAllVisits', 'saveVisit', 'deleteVisit',
    'beginConsultation', 'getActiveConsultation', 'saveConsultationProgress',
    'completeConsultation', 'postponeConsultation', 'resumeConsultation', 'beginNextConsultation',
    'getVitals', 'saveVitals', 'getEncounterVitals', 'getVitalsHistory',
    'getAllergies', 'saveAllergy', 'deleteAllergy',
    'getConditions', 'saveCondition', 'deleteCondition',
    'getMedications', 'saveMedication', 'deleteMedication',
    'getPatientSafetyContext',
    'abdmGetShareTokens', 'findPatientByAbha', 'abdmAcceptShareToken',
    'abdmAcceptShareTokenAndCheckIn', 'abdmGetInbox', 'abdmAckInbox', 'abdmTransferBundle',
    'abdmGetConfig', 'abdmSaveConfig', 'abdmSetSecret', 'abdmTestConnectivity',
    'abdmSimulateShare', 'abdmAbhaLookup', 'abdmAbhaRequestOtp',
    'abdmAbhaConfirmOtp', 'abdmAbhaRequestLoginOtp', 'abdmAbhaConfirmLoginOtp',
    'abdmAbhaCard', 'abdmLinkAbha', 'abdmHiuGetPublicKey', 'abdmHiuRequestConsent',
    'abdmHiuGetConsents', 'abdmHiuFetchRecords', 'abdmHiuGetExternalRecords',
    'abdmHiuClearExternalRecords', 'abdmHiuImportMedication',
    'getSettings', 'getPublicSettings', 'saveSettings',
    'getDoctors',
    'getUsers', 'saveUser', 'deleteUser', 'updateUserPassword',
    'searchConditions', 'searchMedicines', 'createCondition', 'createMedicine',
    'getConditionMedPresets', 'listConditions', 'listMedicines',
    'updateCondition', 'updateMedicine', 'retireCondition', 'retireMedicine',
    'replaceConditionMedPresets'
];

export class ApiServer {
    private abdmSessionSvc: AbdmSessionService | null = null;
    private abdmAbhaSvc: AbdmAbhaService | null = null;
    private hiuSvc: HiuService | null = null;

    // ABDM services are built lazily: unit tests that never touch ABDM flows
    // never pay for (or need) keychain access.
    private abdmServices() {
        if (!this.abdmSessionSvc || !this.abdmAbhaSvc || !this.hiuSvc) {
            const db = this.dbService as any;
            const session = new AbdmSessionService({
                getSettings: () => db.getSettings(),
                getSecretProtected: () => db.getAbdmSecretProtected(),
                saveSettingsPatch: (patch: Record<string, unknown>) => db.saveSettings(patch),
                saveSecretProtected: (value: string) => db.saveAbdmSecretProtected(value),
                keyStore: new ElectronSafeStorageDeviceKeyStore()
            });
            this.abdmSessionSvc = session;
            this.abdmAbhaSvc = new AbdmAbhaService({
                getSessionToken: () => session.getSessionToken(),
                gatewayBaseUrl: () => session.gatewayBaseUrl()
            });
            this.hiuSvc = new HiuService({
                getSettings: () => db.getSettings(),
                getHiuPrivateProtected: () => db.getHiuPrivateProtected(),
                saveHiuPrivateProtected: (value: string) => db.saveHiuPrivateProtected(value),
                saveSettingsPatch: (patch: Record<string, unknown>) => db.saveSettings(patch),
                saveHiuKeypair: (publicKey: string, protectedPrivate: string) =>
                    db.saveHiuKeypair(publicKey, protectedPrivate),
                keyStore: new ElectronSafeStorageDeviceKeyStore(),
                store: {
                    createConsentRequest: (input: any, actingUserId?: number) => db.createConsentRequest(input, actingUserId),
                    getConsentById: (id: number) => db.getConsentById(id),
                    getConsentByRequestId: (requestId: string) => db.getConsentByRequestId(requestId),
                    updateConsentStatus: (id: number, status: string, handle?: string | null, actingUserId?: number) =>
                        db.updateConsentStatus(id, status, handle, actingUserId),
                    storeFetchedRecord: (input: any, actingUserId?: number) => db.storeFetchedRecord(input, actingUserId),
                    getPendingInbox: () => db.getPendingInbox()
                },
                session: {
                    getSessionToken: () => session.getSessionToken(),
                    gatewayBaseUrl: () => session.gatewayBaseUrl()
                }
            });
        }
        return { session: this.abdmSessionSvc, abha: this.abdmAbhaSvc, hiu: this.hiuSvc };
    }

    private async invokeAbdmMethod(method: string, args: unknown[], user: any): Promise<unknown> {
        const { session, abha, hiu } = this.abdmServices();
        const payload = ((args || [])[0] || {}) as Record<string, any>;
        const db = this.dbService as any;
        switch (method) {
            case 'abdmGetConfig': {
                const settings = db.getSettings() || {};
                return {
                    gateway_env: session.gatewayEnv(),
                    client_id: session.hasClientId() ? settings.abdm_client_id || '' : '',
                    has_secret: session.hasStoredSecret(),
                    mock: session.isMockMode(),
                    hip_id: settings.abdm_hip_id || '',
                    counter_id: settings.abdm_counter_id || '',
                    hfr_id: settings.abdm_hfr_id || '',
                    hpr_id: settings.abdm_hpr_id || '',
                    hip_endpoint: settings.abdm_hip_endpoint || '',
                    has_recipient_key: !!settings.abdm_recipient_key,
                    has_callback_secret: db.hasCallbackSecret()
                };
            }
            case 'abdmSaveConfig': {
                const patch: Record<string, unknown> = {};
                if (typeof payload['gateway_env'] === 'string'
                    && ['sandbox', 'staging'].includes(payload['gateway_env'])) {
                    patch['abdm_gateway_env'] = payload['gateway_env'];
                }
                if (typeof payload['client_id'] === 'string') patch['abdm_client_id'] = String(payload['client_id']).trim();
                if (typeof payload['hip_id'] === 'string') patch['abdm_hip_id'] = String(payload['hip_id']).trim();
                if (typeof payload['counter_id'] === 'string') patch['abdm_counter_id'] = String(payload['counter_id']).trim();
                for (const key of ['hfr_id', 'hpr_id']) {
                    if (typeof payload[key] === 'string') {
                        if (String(payload[key]).trim().length > 100) {
                            throw new Error('Registry IDs must be under 100 characters.');
                        }
                        patch[`abdm_${key}`] = String(payload[key]).trim();
                    }
                }
                if (typeof payload['hip_endpoint'] === 'string') {
                    const endpoint = String(payload['hip_endpoint']).trim();
                    if (endpoint && !/^https:\/\//.test(endpoint)) {
                        throw new Error('Transfer endpoint must be an https URL.');
                    }
                    patch['abdm_hip_endpoint'] = endpoint;
                }
                if (typeof payload['recipient_key'] === 'string') {
                    const key = String(payload['recipient_key']).trim();
                    if (key) {
                        if (Buffer.from(key, 'base64').length !== 32) {
                            throw new Error('Recipient key must be a 32-byte X25519 public key.');
                        }
                        patch['abdm_recipient_key'] = key;
                    }
                }
                if (typeof payload['callback_secret'] === 'string') {
                    const secret = String(payload['callback_secret']).trim();
                    if (secret) {
                        if (secret.length < 16) {
                            throw new Error('Callback password must be at least 16 characters.');
                        }
                        patch['abdm_callback_secret'] = secret;
                    }
                }
                if (payload['mock'] !== undefined) patch['abdm_mock'] = payload['mock'] ? 1 : 0;
                const result = db.saveSettings(patch);
                session.invalidate();
                abha.invalidateCert();
                return result;
            }
            case 'abdmSetSecret':
                return session.saveClientSecret(String(payload['secret'] || ''));
            case 'abdmTestConnectivity':
                return session.testConnectivity();
            case 'abdmSimulateShare': {
                if (!session.isMockMode()) {
                    throw new Error('Demo scans are only available while the mock gateway is active.');
                }
                const demo = Math.floor(1000 + Math.random() * 9000);
                return db.receiveAbhaShare({
                    name: 'Demo Patient', age: 34, gender: 'Female', mobile: '9876500000',
                    abhaAddress: `demo.patient${demo}@sbx`, abhaName: 'Demo Patient'
                }, user?.id);
            }
            case 'abdmAbhaLookup':
                return abha.lookupAddress(payload['abhaAddress']);
            case 'abdmAbhaRequestOtp':
                return abha.requestEnrollmentOtp({ via: payload['via'], identifier: payload['identifier'] });
            case 'abdmAbhaConfirmOtp':
                return abha.confirmEnrollmentOtp(payload['txnId'], payload['otp']);
            case 'abdmAbhaRequestLoginOtp':
                return abha.requestLoginOtp(payload['abhaAddress']);
            case 'abdmAbhaConfirmLoginOtp':
                return abha.verifyLoginOtp(payload['txnId'], payload['otp']);
            case 'abdmHiuGetPublicKey':
                return hiu.ensureKeypair();
            case 'abdmHiuRequestConsent':
                return hiu.requestConsent({
                    patientId: payload['patientId'] ?? null,
                    abhaAddress: payload['abhaAddress'],
                    hiTypes: payload['hiTypes'],
                    dateFrom: payload['dateFrom'] ?? null,
                    dateTo: payload['dateTo'] ?? null
                }, user?.id);
            case 'abdmHiuGetConsents':
                return db.getConsents(payload['patientId'] ?? null);
            case 'abdmHiuFetchRecords':
                return hiu.fetchForConsent(Number(payload['consentId']), user?.id);
            case 'abdmHiuGetExternalRecords': {
                db.expireFetchedRecords();
                const rows = db.getFetchedRecords(Number(payload['patientId'])) as any[];
                return rows.map((row) => {
                    try {
                        return {
                            id: row.id, consentId: row.consent_id, fetchedAt: row.fetched_at,
                            expiresAt: row.expires_at, status: row.status,
                            parsed: parseClinicalBundle(row.bundle_json)
                        };
                    } catch (e) {
                        return {
                            id: row.id, consentId: row.consent_id, fetchedAt: row.fetched_at,
                            expiresAt: row.expires_at, status: row.status, parsed: null,
                            error: e instanceof Error ? e.message : 'Unreadable record.'
                        };
                    }
                });
            }
            case 'abdmHiuClearExternalRecords':
                return db.clearFetchedRecords(Number(payload['patientId']), user?.id);
            case 'abdmHiuImportMedication':
                return db.importExternalMedication(
                    Number(payload['patientId']),
                    {
                        medicine_name: payload['medicine_name'] ?? payload['name'],
                        dosage: payload['dosage'],
                        frequency: payload['frequency'],
                        source: payload['source']
                    },
                    payload['overrideReason'] ?? null,
                    user?.id
                );
            case 'abdmAbhaCard':
                return abha.getCard(payload['abhaAddress']);
            case 'abdmLinkAbha':
                return db.linkAbhaAddress(payload['patientId'], {
                    abhaAddress: payload['abhaAddress'] ?? null,
                    abhaName: payload['abhaName'] ?? null
                }, user?.id);
            case 'abdmTransferBundle': {
                const recipientKey = db.getSettings()?.abdm_recipient_key || '';
                if (!recipientKey) {
                    throw new Error('No recipient key configured. Add one under Settings → ABDM first.');
                }
                if (!payload['bundle']) throw new Error('A health record bundle is required.');
                const fidelius = new FideliusService();
                return fidelius.pushBundle(
                    payload['bundle'], recipientKey, db.getSettings()?.abdm_hip_endpoint || '');
            }
            default:
                throw new Error(`Method not implemented: ${method}`);
        }
    }
    private fastify: FastifyInstance;
    private dbService: DatabaseService;
    // Sliding-window hit timestamps per source IP for the public callback.
    private shareCallbackHits = new Map<string, number[]>();

    // Rejects floods on the unauthenticated share route. Tune conservatively:
    // a reception counter scans at human pace; bursts above this are abuse.
    private shareCallbackAllowed(ip: string, limit = 30, windowMs = 60_000): boolean {
        const now = Date.now();
        const hits = (this.shareCallbackHits.get(ip) || []).filter((t) => now - t < windowMs);
        if (hits.length >= limit) {
            this.shareCallbackHits.set(ip, hits);
            return false;
        }
        hits.push(now);
        this.shareCallbackHits.set(ip, hits);
        return true;
    }
    private staticPath: string;
    private _started = false;
    private oauthResolver: ((code: string) => void) | null = null;
    private oauthRejecter: ((err: Error) => void) | null = null;
    private oauthTimeout: ReturnType<typeof setTimeout> | null = null;
    private expectedOAuthState: string | null = null;
    private devUiProxyUrl?: string;

    constructor(dbService: DatabaseService, staticPath: string, devUiProxyUrl?: string) {
        this.dbService = dbService;
        this.staticPath = staticPath;
        this.devUiProxyUrl = devUiProxyUrl;
        this.fastify = Fastify({ logger: true });
    }

    private async setup() {
        // CORS
        this.fastify.register(fastifyCors, (_instance: any) => {
            return (req: any, callback: any) => {
                const allowedOrigins = process.env['ALLOWED_ORIGINS']
                    ? process.env['ALLOWED_ORIGINS'].split(',')
                    : [];

                // Allow all in dev (Electron npm start or NODE_ENV=development)
                if ((this.devUiProxyUrl || process.env['NODE_ENV'] === 'development') && allowedOrigins.length === 0) {
                    callback(null, { origin: true });
                    return;
                }

                const origin = req.headers.origin;
                if (allowedOrigins.includes(origin)) {
                    callback(null, { origin: true });
                } else {
                    callback(null, { origin: false });
                }
            };
        });

        console.log(`[API Server] Serving static files from: ${this.staticPath}`);
        if (this.devUiProxyUrl) {
            console.log(`[API Server] Dev LAN UI proxy → ${this.devUiProxyUrl}`);
        }

        if (!this.devUiProxyUrl) {
            this.fastify.register(fastifyStatic, {
                root: this.staticPath,
                prefix: '/',
            });
        }

        // API Routes
        this.fastify.post('/api/auth/login', this.handleLogin.bind(this));

        // Google Drive OAuth callback (same port as API — avoids a second listener)
        this.fastify.get('/oauth2callback', async (request, reply) => {
            const query = request.query as { code?: string; state?: string };
            const { code, state } = query;

            const resolve = this.oauthResolver;
            const reject = this.oauthRejecter;
            const expectedState = this.expectedOAuthState;

            if (!resolve && !reject) {
                reply.code(400).type('text/html').send('No pending authentication request.');
                return;
            }

            if (!expectedState || state !== expectedState) {
                reply.code(400).type('text/html').send('Invalid OAuth state. Please try again.');
                return;
            }

            const capturedResolve = resolve;
            const capturedReject = reject;
            this.clearOAuthWait();

            reply.type('text/html').send('Authentication successful! You can close this window.');

            if (code && capturedResolve) {
                capturedResolve(code);
                return;
            }

            capturedReject?.(new Error('No authorization code received'));
        });

        // ABDM Scan & Share profile callback (gateway-initiated, unauthenticated
        // by design: the gateway cannot hold clinic credentials). The payload
        // is strictly validated and stored as a numbered queue token; nothing
        // executes from it. Rate-limited per source IP with a small body cap,
        // and documented tunnel setup is required for sandbox callbacks to
        // reach this port (see DEVELOPER_GUIDE). Intake still needs an
        // explicit human accept before any patient record is created.
        this.fastify.post('/abdm/v0.5/patients/profile/share',
            { bodyLimit: 8192 },
            async (request: any, reply: any) => {
                if (!this.shareCallbackAllowed(request.ip || 'unknown')) {
                    return reply.code(429).send({ error: 'Too many share requests. Slow down and retry.' });
                }
                try {
                    const token = this.dbService.receiveAbhaShare(request.body);
                    return reply.code(202).send({ status: 'queued', tokenNo: (token as any)?.token_no });
                } catch (e: any) {
                    return reply.code(400).send({ error: e instanceof Error ? e.message : 'Invalid share payload.' });
                }
            });

        // Generic ABDM callback inbox (consent events, data-share notices).
        // Same posture as the share route: validated, rate-limited, and
        // stored for explicit human handling — never auto-applied. When a
        // callback secret is configured, the sender must prove knowledge of
        // it; otherwise the route stays open for sandbox testing.
        this.fastify.post('/abdm/v0.5/callbacks/:kind',
            { bodyLimit: 8192 },
            async (request: any, reply: any) => {
                if (!this.shareCallbackAllowed(`${request.ip || 'unknown'}:inbox`)) {
                    return reply.code(429).send({ error: 'Too many callbacks. Slow down and retry.' });
                }
                const liveCallbacks = !this.abdmServices().session.isMockMode();
                if (!this.dbService.callbackSecretMatches(request.headers?.['x-callback-token'], liveCallbacks)) {
                    return reply.code(401).send({ error: 'Callback authentication required.' });
                }
                try {
                    const kind = (request.params as any)?.kind;
                    const row = this.dbService.receiveInboxCallback(kind, request.body);
                    // Consent bookkeeping applies automatically; clinical data
                    // never does. Best-effort: the 202 stands either way.
                    try {
                        const { hiu } = this.abdmServices();
                        if ((DatabaseService.inboxConsentKinds as readonly string[]).includes(String(kind))) {
                            hiu.handleNotify(kind, request.body);
                        }
                    } catch (notifyError) {
                        console.error('[HIU notify]', notifyError);
                    }
                    return reply.code(202).send({ status: 'queued', id: (row as any)?.id });
                } catch (e: any) {
                    return reply.code(400).send({ error: e instanceof Error ? e.message : 'Invalid callback.' });
                }
            });

        // HIU direct data push (M3): gateway-delivered encrypted records for
        // granted consents. Same posture as the inbox route — validated,
        // rate-limited, secret-gated — but bundles may reach 256 KB, so the
        // body cap is larger. Each record is decrypted on receipt (proving
        // the HIU keypair) and cached encrypted-at-rest; nothing is
        // auto-applied to the chart.
        this.fastify.post('/abdm/hiu/data/transfer',
            { bodyLimit: 262144 },
            async (request: any, reply: any) => {
                if (!this.shareCallbackAllowed(`${request.ip || 'unknown'}:hiu-data`)) {
                    return reply.code(429).send({ error: 'Too many data pushes. Slow down and retry.' });
                }
                const liveCallbacks = !this.abdmServices().session.isMockMode();
                if (!this.dbService.callbackSecretMatches(request.headers?.['x-callback-token'], liveCallbacks)) {
                    return reply.code(401).send({ error: 'Callback authentication required.' });
                }
                try {
                    const { hiu } = this.abdmServices();
                    const body = (request.body || {}) as any;
                    const requestId = String(body.requestId || body.gatewayRequestId || '').trim();
                    // Consent-gated storage: unknown, missing, or non-granted
                    // requests never retain clinical data.
                    const consent = requestId ? this.dbService.getConsentByRequestId(requestId) : null;
                    if (!consent || consent.status !== 'granted') {
                        throw new Error('Push requires a matching granted consent.');
                    }
                    const records = Array.isArray(body.records) ? body.records : [body.envelope || body.record].filter(Boolean);
                    if (records.length === 0) throw new Error('No record envelopes in this push.');
                    const decrypted = [];
                    for (const envelope of records) {
                        decrypted.push({
                            consentId: consent.id,
                            patientId: consent.patient_id,
                            careContextRef: null,
                            bundleJson: JSON.stringify(hiu.decryptRecord(envelope)),
                            expiresAt: HiuService.retentionExpiry()
                        });
                    }
                    const stored = this.dbService.storeFetchedRecordBatch(decrypted);
                    return reply.code(202).send({ status: 'cached', received: stored.length });
                } catch (e: any) {
                    return reply.code(400).send({ error: e instanceof Error ? e.message : 'Invalid data push.' });
                }
            });

        // Protected Routes
        this.fastify.register(async (instance) => {
            instance.addHook('preValidation', this.authenticate.bind(this));
            instance.post('/api/ipc/:method', this.handleIpcCall.bind(this));
        });

        // SPA Fallback (prod: index.html; dev: proxy to ng serve for LAN access)
        this.fastify.setNotFoundHandler(async (req, reply) => {
            if (req.method === 'GET' && !req.url.startsWith('/api') && !req.url.startsWith('/oauth2callback')) {
                const raw = req.url || '/';
                const queryIndex = raw.indexOf('?');
                const pathOnly = queryIndex === -1 ? raw : raw.slice(0, queryIndex);
                const search = queryIndex === -1 ? '' : raw.slice(queryIndex);
                const hashed = hashUrlForPathname(pathOnly, search);
                if (hashed) {
                    return reply.redirect(hashed);
                }
                if (this.devUiProxyUrl) {
                    return this.proxyToDevUi(req, reply);
                }
                return reply.sendFile('index.html');
            }
            return reply.code(404).send({ message: 'Route ' + req.method + ':' + req.url + ' not found', error: 'Not Found', statusCode: 404 });
        });
    }

    /** In dev, LAN clients hit :3002 but UI is served by ng on :4200 — proxy GET requests. */
    private async proxyToDevUi(request: FastifyRequest, reply: FastifyReply): Promise<void> {
        if (!this.devUiProxyUrl) {
            reply.code(404).send({ error: 'Not Found' });
            return;
        }

        const target = new URL(request.url, this.devUiProxyUrl);

        await new Promise<void>((resolve) => {
            let settled = false;
            const finish = () => {
                if (settled) {
                    return;
                }
                settled = true;
                resolve();
            };

            const proxyReq = http.request(
                {
                    hostname: target.hostname,
                    port: target.port,
                    path: `${target.pathname}${target.search}`,
                    method: request.method,
                    headers: {
                        ...request.headers,
                        host: target.host,
                    },
                },
                (proxyRes) => {
                    reply.status(proxyRes.statusCode ?? 502);
                    for (const [key, value] of Object.entries(proxyRes.headers)) {
                        if (value !== undefined) {
                            reply.header(key, value);
                        }
                    }
                    reply.send(proxyRes);
                    finish();
                }
            );

            proxyReq.setTimeout(30_000, () => {
                proxyReq.destroy();
                console.error('[API Server] Dev UI proxy timed out');
                if (!reply.sent) {
                    reply.code(502).send({
                        error: 'Dev UI proxy timed out',
                        hint: 'Wait for ng serve, then refresh',
                    });
                }
                finish();
            });

            proxyReq.on('error', (err) => {
                console.error('[API Server] Dev UI proxy error:', err.message);
                if (!reply.sent) {
                    reply.code(502).send({
                        error: 'Dev UI server not ready',
                        hint: 'Wait for ng serve on port 4200, then refresh',
                    });
                }
                finish();
            });

            proxyReq.end();
        });
    }

    private setupCompleted = false;

    private async ensureSetup() {
        if (this.setupCompleted) {
            return;
        }
        await this.setup();
        this.setupCompleted = true;
    }

    async start(port: number = 3000, host: string = '0.0.0.0') {
        if (this._started) {
            console.warn('[API Server] Already started');
            return;
        }
        this._started = true;

        try {
            await this.ensureSetup();
            await this.fastify.listen({ port, host });
            console.log(`API Server running on http://${host}:${port}`);
        } catch (err) {
            this._started = false;
            console.error('[API Server] Failed to start:', err);
            throw err;
        }
    }

    /** Register routes without binding a port (HTTP IPC tests). */
    async inject(opts: InjectOptions | string) {
        await this.ensureSetup();
        await this.fastify.ready();
        return this.fastify.inject(opts);
    }

    async close() {
        try {
            await this.fastify.close();
        } finally {
            this._started = false;
            this.setupCompleted = false;
        }
    }

    /** Resolves when Google redirects to /oauth2callback on this API server. */
    waitForOAuthCallback(expectedState: string, timeoutMs = 60_000): Promise<string> {
        const existingReject = this.oauthRejecter;
        this.clearOAuthWait();
        if (existingReject) {
            existingReject(new Error('A new authentication attempt was started.'));
        }

        this.expectedOAuthState = expectedState;
        return new Promise((resolve, reject) => {
            this.oauthResolver = resolve;
            this.oauthRejecter = reject;
            this.oauthTimeout = setTimeout(() => {
                this.clearOAuthWait();
                reject(new Error('Authentication timed out. Please try again.'));
            }, timeoutMs);
        });
    }

    private clearOAuthWait(): void {
        if (this.oauthTimeout) {
            clearTimeout(this.oauthTimeout);
            this.oauthTimeout = null;
        }
        this.oauthResolver = null;
        this.oauthRejecter = null;
        this.expectedOAuthState = null;
    }

    // Middleware: Auth
    private async authenticate(request: FastifyRequest, reply: FastifyReply) {
        try {
            const authHeader = request.headers.authorization;
            if (!authHeader || !authHeader.startsWith('Bearer ')) {
                throw new Error('Missing or invalid token scheme');
            }
            const token = authHeader.split(' ')[1];
            const decoded = jwt.verify(token, JWT_SECRET) as any;
            (request as any).user = decoded;
        } catch (err) {
            reply.code(401).send({ error: 'Unauthorized' });
            return;
        }
    }

    // Login Handler
    private async handleLogin(request: FastifyRequest, reply: FastifyReply) {
        const body = request.body as any;
        if (!body || typeof body.username !== 'string' || typeof body.password !== 'string' || !body.username || !body.password) {
            return reply.code(400).send({ error: 'Invalid input' });
        }
        const { username, password } = body;
        try {
            this.dbService.beginWork();
        } catch (error: any) {
            if (error?.message === 'RESTORE_IN_PROGRESS') {
                return reply.code(503).send({ error: 'RESTORE_IN_PROGRESS' });
            }
            throw error;
        }
        try {
            let user;
            try {
                user = this.dbService.getUserByUsername(username);
            } catch (e) {
                return reply.code(503).send({ error: 'System initialization in progress. Please try again.' });
            }

            if (!user || user.active === 0) {
                return reply.code(401).send({ error: 'Invalid credentials' });
            }

            // Admin IP Restriction
            if (user.role === 'admin') {
                const ip = request.ip;
                if (process.env['STRICT_ADMIN_IP'] === 'true' && ip !== '127.0.0.1' && ip !== '::1') {
                    return reply.code(403).send({ error: 'Admin login restricted to Master System' });
                }
            }

            // Verify Password
            try {
                if (await argon2.verify(user.password, password)) {
                    const token = jwt.sign({ id: user.id, role: user.role, username: user.username }, JWT_SECRET, { expiresIn: '12h' });
                    return { token, user: { id: user.id, username: user.username, role: user.role, name: user.name } };
                } else {
                    return reply.code(401).send({ error: 'Invalid credentials' });
                }
            } catch (e) {
                return reply.code(500).send({ error: 'Auth error' });
            }
        } finally {
            this.dbService.endWork();
        }
    }

    // Generic IPC wrapper for DataService
    private async handleIpcCall(request: FastifyRequest, reply: FastifyReply) {
        const { method } = request.params as any;
        const args = request.body as any[];

        if (!Array.isArray(args)) {
            return reply.code(400).send({ error: 'Invalid args: expected array' });
        }

        const user = (request as any).user;

        // 1. Allowlist Check (Security)
        if (!ALLOWED_IPC_METHODS.includes(method)) {
            return reply.code(404).send({ error: 'Method not found or not allowed' });
        }

        try {
            this.dbService.beginWork();
        } catch (error: any) {
            if (error?.message === 'RESTORE_IN_PROGRESS') {
                return reply.code(503).send({ error: 'RESTORE_IN_PROGRESS' });
            }
            throw error;
        }
        try {
            // 2. RBAC Enforcement
            if (!this.checkPermission(user.role, method)) {
                return reply.code(403).send({ error: 'Forbidden' });
            }

            const dbAny = this.dbService as any;

            // 3. Execution: ABDM service methods first, then DatabaseService.
            // Same arg unpacking contract as Electron IPC.
            if (ABDM_SERVICE_METHODS.has(method)) {
                try {
                    return await this.invokeAbdmMethod(method, args, user);
                } catch (e: any) {
                    console.error(`[IPC Error] method: ${method}`, e);
                    return reply.code(500).send({ error: 'Internal server error' });
                }
            }
            if (typeof dbAny[method] === 'function') {
                try {
                    const result = await invokeDbMethod(dbAny, method, args, user.id);
                    return result;
                } catch (e: any) {
                    console.error(`[IPC Error] method: ${method}`, e);
                    return reply.code(500).send({ error: 'Internal server error' });
                }
            } else {
                return reply.code(404).send({ error: 'Method not implemented' });
            }
        } finally {
            this.dbService.endWork();
        }
    }

    private checkPermission(role: string, method: string): boolean {
        // Admin: All access
        if (role === 'admin') return true;

        // Dynamic DB-based RBAC
        try {
            const permissions = this.dbService.getPermissions(role);
            return permissions.includes(method);
        } catch (e) {
            console.error(`[RBAC] Permission check failed for role ${role}:`, e);
            return false;
        }
    }
}
