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
import { DEFAULT_FACILITY_ID, runWithContext } from '../shared/request-context';
import { chooseFacility } from '../main/services/FacilitySession';
import { FacilityAdminError } from '../main/services/FacilityAdmin';
import { FACILITY_ADMIN_METHODS } from '../shared/access';
import { hashUrlForPathname } from '../shared/hash-app-path';
import { AbdmRelayService, abdmConfigView } from '../main/services/AbdmRelayService';
import { AbdmAbhaService } from '../main/services/AbdmAbhaService';
import { HiuService } from '../main/services/HiuService';
import { HipService } from '../main/services/HipService';
import { AccessPolicy } from '../main/services/AccessPolicy';
import { parseClinicalBundle } from '../shared/fhir/parser';
import { FideliusService, parseKeyMaterial } from '../main/services/FideliusService';
import { ElectronSafeStorageDeviceKeyStore } from '../main/services/DeviceKeyStore';
import { auditContext } from '../main/services/AuditContext';
import { AuthStoreNotReady, DEFAULT_SESSION_POLICY, JoinedDevice, ServerAuthStore, ServerSession, SIGNING_KEY_SECRET } from './auth-store';
import { EventHub } from './events';
import { ApiServerOptions, DEFAULT_JOIN_CODE_TTL_MS, issueJoinCode, joinFingerprint } from './network';
import { LoginLimiter, SlidingWindowLimiter } from './rate-limit';
import { parseJoinCode, fingerprintPrefix } from '../shared/join-code';
import {
    checkClientProtocol, DEVICE_HEADER, MIN_SUPPORTED_PROTOCOL, PROTOCOL_HEADER, PROTOCOL_VERSION, SERVER_VERSION_HEADER
} from '../shared/protocol';
import { serverReleaseVersion } from './release-version';
import { assertMethodAccess, MethodAccessError, type ClinicMethod } from './runtime/clinicMethods';

loadDevelopmentEnv();
dotenv.config();

/** Legacy in-app LAN server: a 12h token, since its browser UI never refreshes. */
const LEGACY_ACCESS_TTL_SEC = 12 * 60 * 60;
/** NalamDesk Server: short access tokens, renewed with the refresh token. */
const SERVER_ACCESS_TTL_SEC = 15 * 60;

const ABDM_SERVICE_METHODS = new Set([
    'abdmGetConfig', 'abdmSaveConfig', 'abdmTestConnectivity',
    'abdmSimulateShare', 'abdmAbhaLookup', 'abdmAbhaRequestOtp',
    'abdmAbhaConfirmOtp', 'abdmAbhaRequestLoginOtp', 'abdmAbhaConfirmLoginOtp',
    'abdmAbhaCard', 'abdmLinkAbha', 'abdmTransferBundle', 'abdmHiuGetPublicKey',
    'abdmHiuRequestConsent', 'abdmHiuGetConsents', 'abdmHiuFetchRecords',
    'abdmHiuGetExternalRecords', 'abdmHiuClearExternalRecords', 'abdmHiuImportMedication', 'abdmHipLinkVisit'
]);

/** Allowlisted LAN methods; the conformance spec pins allow/deny per role. */
export const ALLOWED_IPC_METHODS = [
    'getQueue', 'addToQueue', 'reassessQueueTriage', 'getQueueTriageHistory', 'updateQueueStatus', 'updateQueueStatusByPatientId', 'removeFromQueue',
    'getAuditLogs',
    'getAppointmentRequests', 'updateAppointmentRequestStatus',
    'getAppointments', 'getAppointmentsByPatient', 'saveAppointment', 'transitionAppointment', 'getAppointmentHistory', 'getAppointmentByVisit', 'detectConflicts', 'checkInAppointment', 'fulfillAppointment',
    'validateUser', 'getPermissions',
    'getDashboardStats',
    'getPatients', 'getPatientById', 'savePatient', 'deletePatient',
    'findDuplicateCandidates', 'previewPatientMerge', 'mergePatients', 'unmergePatients',
    'getInvoice', 'getVisitInvoices', 'createInvoice', 'recordPayment', 'refundPayment', 'voidInvoice',
    'getDailyClose',
    'getVisits', 'getAllVisits', 'saveVisit', 'deleteVisit',
    'getVisitPrescriptions', 'cancelPrescription', 'recordPrescriptionPrint',
    'beginConsultation', 'getActiveConsultation', 'saveConsultationProgress',
    'completeConsultation', 'postponeConsultation', 'resumeConsultation', 'beginNextConsultation',
    'getVitals', 'saveVitals', 'getEncounterVitals', 'getVitalsHistory',
    'getAllergies', 'saveAllergy', 'deleteAllergy',
    'getConditions', 'saveCondition', 'deleteCondition',
    'getMedications', 'saveMedication', 'deleteMedication',
    'getPatientSafetyContext',
    'abdmGetShareTokens', 'findPatientByAbha', 'abdmAcceptShareToken',
    'abdmAcceptShareTokenAndCheckIn', 'abdmGetInbox', 'abdmAckInbox', 'abdmTransferBundle',
    'abdmGetConfig', 'abdmSaveConfig', 'abdmTestConnectivity',
    'abdmSimulateShare', 'abdmAbhaLookup', 'abdmAbhaRequestOtp',
    'abdmAbhaConfirmOtp', 'abdmAbhaRequestLoginOtp', 'abdmAbhaConfirmLoginOtp',
    'abdmAbhaCard', 'abdmLinkAbha', 'abdmHiuGetPublicKey', 'abdmHiuRequestConsent',
    'abdmHiuGetConsents', 'abdmHiuFetchRecords', 'abdmHiuGetExternalRecords',
    'abdmHiuClearExternalRecords', 'abdmHiuImportMedication', 'abdmHipLinkVisit',
    'getUserOverrides', 'saveUserOverride', 'deleteUserOverride',
    'getSettings', 'getPublicSettings', 'saveSettings',
    'getDoctors',
    'getUsers', 'saveUser', 'deleteUser', 'updateUserPassword', 'getAllRoles',
    ...FACILITY_ADMIN_METHODS,
    'saveRole', 'deleteRole', 'getDemoSeedState', 'seedDemoData', 'clearDemoData',
    'archivePatient', 'unarchivePatient', 'getArchivedPatients', 'markVisitEnteredInError', 'purgeUser',
    'getIdentifiers', 'saveIdentifier', 'deleteIdentifier',
    'searchConditions', 'searchMedicines', 'createCondition', 'createMedicine',
    'getConditionMedPresets', 'listConditions', 'listMedicines',
    'updateCondition', 'updateMedicine', 'retireCondition', 'retireMedicine',
    'replaceConditionMedPresets'
];

interface RequestAuth {
    session: ServerSession | null;
    device: JoinedDevice | null;
}

export interface ApiAbdmServices {
    relay: AbdmRelayService;
    abha: AbdmAbhaService;
    hiu: HiuService;
    hip?: HipService;
}

export class ApiServer {
    private abdm: ApiAbdmServices | null;
    // Cloud, booking and backup methods (#196), with their own access rules.
    private readonly serviceMethods = new Map<string, ClinicMethod>();
    private afterDbMethod: ((method: string, args: unknown[]) => void) | null = null;

    /**
     * Adds methods served beside the database allowlist. `afterDbMethod`
     * runs after each database method succeeds (e.g. to reschedule backups
     * when settings change).
     */
    registerServiceMethods(methods: Record<string, ClinicMethod>, afterDbMethod?: (method: string, args: unknown[]) => void): void {
        for (const [name, method] of Object.entries(methods)) {
            if (ALLOWED_IPC_METHODS.includes(name)) throw new Error(`${name} is already a database method.`);
            this.serviceMethods.set(name, method);
        }
        if (afterDbMethod) this.afterDbMethod = afterDbMethod;
    }

    private async handleServiceMethod(method: ClinicMethod, name: string, args: unknown[], tokenUser: any, reply: FastifyReply) {
        // The role comes from the user's grant in the request's facility, never the token (#195).
        const facilityId = Number(tokenUser?.facility_id) || DEFAULT_FACILITY_ID;
        const context = { userId: Number(tokenUser?.id), facilityId };
        let user: any = tokenUser;
        try {
            const role = tokenUser ? this.dbService.getFacilityRole(Number(tokenUser.id), facilityId) : null;
            if (tokenUser) user = { ...tokenUser, role: role ?? 'no-access' };
            assertMethodAccess(method.access, user);
        } catch (error) {
            const status = error instanceof MethodAccessError ? error.status : 403;
            if (status === 403) {
                try {
                    runWithContext(context, () => (this.dbService as any).auditDenial({ user, method: name, channel: 'lan' }));
                } catch { /* audit must not mask the denial */ }
            }
            return reply.code(status).send({ error: status === 401 ? 'Unauthorized' : 'Forbidden' });
        }
        const run = async () => runWithContext(context, () => method.run(args, user));
        try {
            const result = await (method.selfFenced ? run() : this.dbService.runWork(run));
            this.events.publishForMethod(name);
            return result;
        } catch (error: any) {
            if (error?.message === 'RESTORE_IN_PROGRESS') return reply.code(503).send({ error: 'RESTORE_IN_PROGRESS' });
            console.error(`[IPC Error] method: ${name}`, error);
            // These methods serve admin screens; their messages are written for people.
            return reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal server error' });
        }
    }

    // Without services from the desktop (tests, the standalone server) ABDM
    // runs against the mock gateway, built lazily so tests that never touch
    // ABDM never pay for (or need) keychain access.
    private abdmServices(): ApiAbdmServices {
        if (!this.abdm) {
            const db = this.dbService as any;
            const relay = new AbdmRelayService({ getSettings: () => db.getSettings() });
            this.abdm = {
                relay,
                abha: new AbdmAbhaService({ relay }),
                hiu: new HiuService({
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
                    relay
                }),
                hip: new HipService({ store: db, relay, hipId: () => relay.status().hfr_id })
            };
        }
        return this.abdm;
    }

    private async invokeAbdmMethod(method: string, args: unknown[], user: any): Promise<unknown> {
        const { relay, abha, hiu, hip } = this.abdmServices();
        const payload = ((args || [])[0] || {}) as Record<string, any>;
        const db = this.dbService as any;
        switch (method) {
            case 'abdmGetConfig':
                return abdmConfigView(db.getSettings(), relay);
            case 'abdmSaveConfig': {
                const patch: Record<string, unknown> = {};
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
                        patch['abdm_recipient_key'] = JSON.stringify(parseKeyMaterial(key));
                    }
                }
                if (payload['mock'] !== undefined) patch['abdm_mock'] = payload['mock'] ? 1 : 0;
                return db.saveSettings(patch);
            }
            case 'abdmTestConnectivity':
                return relay.testConnectivity();
            case 'abdmSimulateShare': {
                if (!relay.isMockMode()) {
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
            case 'abdmHipLinkVisit':
                if (!hip) throw new Error('Linking records is not available here.');
                return hip.linkVisit(Number(payload['visitId']));
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
    private staticPath: string;
    private _started = false;
    private oauthResolver: ((code: string) => void) | null = null;
    private oauthRejecter: ((err: Error) => void) | null = null;
    private oauthTimeout: ReturnType<typeof setTimeout> | null = null;
    private expectedOAuthState: string | null = null;
    private devUiProxyUrl?: string;
    private readonly options: ApiServerOptions;
    private readonly now: () => number;
    private readonly envSigningKey: string | undefined;
    // Without a vault (tests, or a DatabaseService stand-in) tokens are signed
    // with a per-process key and carry no server session.
    private readonly processSigningKey = crypto.randomBytes(64).toString('hex');
    private store: ServerAuthStore | null | undefined;
    private readonly loginLimiter: LoginLimiter;
    private readonly joinIpLimiter: SlidingWindowLimiter;
    private readonly joinFailureLimiter: SlidingWindowLimiter;
    private readonly accessTtlSec: number;
    /** Live events stream for clients; the desktop also publishes here. */
    readonly events: EventHub;

    constructor(dbService: DatabaseService, staticPath: string, devUiProxyUrl?: string, abdm?: ApiAbdmServices, options: ApiServerOptions = {}) {
        this.abdm = abdm ?? null;
        this.dbService = dbService;
        this.staticPath = staticPath;
        this.devUiProxyUrl = devUiProxyUrl;
        this.options = options;
        this.now = options.now ?? Date.now;
        // JWT_SECRET pins the signing key for development and tests; otherwise
        // the key lives in the vault so restarts keep users signed in.
        this.envSigningKey = process.env['JWT_SECRET'] || undefined;
        this.loginLimiter = options.loginLimiter ?? new LoginLimiter({ now: this.now });
        this.joinIpLimiter = new SlidingWindowLimiter(10, 15 * 60_000, this.now);
        this.joinFailureLimiter = new SlidingWindowLimiter(20, 15 * 60_000, this.now);
        this.accessTtlSec = options.accessTokenTtlSec
            ?? (options.requireDevice ? SERVER_ACCESS_TTL_SEC : LEGACY_ACCESS_TTL_SEC);
        this.events = new EventHub({ now: this.now });
        this.events.sessionCheck = (sessionId, deviceId) => this.streamStillValid(sessionId, deviceId);
        const fastifyOptions: Record<string, unknown> = { logger: true };
        if (options.tls) fastifyOptions['https'] = { key: options.tls.key, cert: options.tls.cert };
        if (options.behindProxy) fastifyOptions['trustProxy'] = true;
        this.fastify = Fastify(fastifyOptions as any) as unknown as FastifyInstance;
    }

    /** Server-side auth state, or null when the database has no vault handle (tests). */
    get authStore(): ServerAuthStore | null {
        if (this.store === undefined) {
            const db = this.dbService as any;
            this.store = typeof db?.rawDb === 'function'
                ? new ServerAuthStore(() => db.rawDb(), this.now, this.options.sessionPolicy ?? DEFAULT_SESSION_POLICY)
                : null;
        }
        return this.store;
    }

    /** Issues a join code for a computer (admin API and `join-code` CLI). */
    issueJoinCode(input: { createdBy: number | null; deviceName?: string | null; ttlMs?: number }) {
        const store = this.requireStore();
        return issueJoinCode(store, this.options, { ttlMs: this.options.joinCodeTtlMs ?? DEFAULT_JOIN_CODE_TTL_MS, ...input });
    }

    /** Revokes a joined computer, signs out its sessions and ends its event streams. */
    revokeDevice(deviceId: string, revokedBy: number | null): boolean {
        const revoked = this.requireStore().revokeDevice(deviceId, revokedBy);
        if (revoked) {
            this.events.disconnect({ deviceId });
            this.audit('DEVICE_REVOKE', revokedBy, `Revoked computer ${deviceId}`);
        }
        return revoked;
    }

    private requireStore(): ServerAuthStore {
        const store = this.authStore;
        if (!store) throw new AuthStoreNotReady();
        store.assertReady();
        return store;
    }

    private signingKey(): string {
        if (this.envSigningKey) return this.envSigningKey;
        const store = this.authStore;
        return store ? store.getOrCreateSecret(SIGNING_KEY_SECRET) : this.processSigningKey;
    }

    private audit(action: string, userId: number | null, details: string, deviceId: string | null = null): void {
        try {
            auditContext.run({ deviceId }, () => (this.dbService as any).logAudit?.(action, 'server_auth', null, userId, details));
        } catch { /* audit must not block auth */ }
    }

    private streamStillValid(sessionId: string | null, deviceId: string | null): boolean {
        const store = this.authStore;
        if (!store) return true;
        try {
            if (sessionId && !store.getActiveSession(sessionId)) return false;
            if (deviceId && store.getDevice(deviceId)?.revokedAt != null) return false;
            return true;
        } catch {
            return false;
        }
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

        // Protocol handshake (#193): every API response names the server's
        // protocol and release; a client outside the supported window gets
        // 426 and is told which side needs the upgrade.
        this.fastify.addHook('onRequest', async (request, reply) => {
            if (!request.url.startsWith('/api/')) return;
            reply.header(PROTOCOL_HEADER, String(PROTOCOL_VERSION));
            reply.header(SERVER_VERSION_HEADER, serverReleaseVersion());
            const verdict = checkClientProtocol(request.headers[PROTOCOL_HEADER]);
            if (!verdict.ok) {
                return reply.code(426).send({
                    error: verdict.error,
                    upgrade: verdict.upgrade,
                    protocol: PROTOCOL_VERSION,
                    minProtocol: MIN_SUPPORTED_PROTOCOL,
                    serverVersion: serverReleaseVersion()
                });
            }
        });

        // Store not ready (vault still locked) is a 503, never a 500.
        this.fastify.setErrorHandler((error, _request, reply) => {
            if (error instanceof AuthStoreNotReady) {
                return reply.code(503).send({ error: 'SERVER_STARTING' });
            }
            return reply.send(error);
        });

        // API Routes
        this.fastify.get('/api/server/hello', this.handleHello.bind(this));
        this.fastify.post('/api/devices/join', this.handleJoin.bind(this));
        this.fastify.post('/api/auth/login', this.handleLogin.bind(this));
        this.fastify.post('/api/auth/refresh', this.handleRefresh.bind(this));

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

        // ABDM callbacks and HIU data pushes reach this computer through the
        // relay's sealed mailbox (#160), never as public routes here.

        // Protected Routes
        this.fastify.register(async (instance) => {
            instance.addHook('preValidation', this.authenticate.bind(this));
            instance.post('/api/ipc/:method', this.handleIpcCall.bind(this));
            instance.post('/api/auth/logout', this.handleLogout.bind(this));
            instance.get('/api/auth/facilities', async (request) => {
                const user = (request as any).user;
                return {
                    facilityId: Number(user.facility_id) || DEFAULT_FACILITY_ID,
                    facilities: this.dbService.getUserFacilities(Number(user.id))
                };
            });
            instance.post('/api/auth/facility', this.handleSwitchFacility.bind(this));
            instance.get('/api/events', (request, reply) => {
                const auth = (request as any).auth as RequestAuth;
                this.events.stream(request, reply, { sessionId: auth.session?.id ?? null, deviceId: auth.device?.id ?? null });
            });

            // Joined computers (admin only).
            instance.post('/api/admin/join-codes', this.adminOnly(async (request) => {
                const body = (request.body ?? {}) as { deviceName?: unknown };
                const user = (request as any).user;
                const issued = this.issueJoinCode({
                    createdBy: user.id,
                    deviceName: typeof body.deviceName === 'string' ? body.deviceName : null
                });
                this.audit('JOIN_CODE_ISSUE', user.id,
                    `Issued a join code${issued.deviceName ? ` for ${issued.deviceName}` : ''}`, this.deviceIdOf(request));
                return issued;
            }));
            instance.get('/api/admin/devices', this.adminOnly(async () => this.requireStore().listDevices()));
            instance.delete('/api/admin/devices/:id', this.adminOnly(async (request, reply) => {
                const { id } = request.params as { id: string };
                if (!this.revokeDevice(id, (request as any).user.id)) {
                    return reply.code(404).send({ error: 'Not found' });
                }
                return { revoked: true };
            }));
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
            console.log(`API Server running on ${this.options.tls ? 'https' : 'http'}://${host}:${port}`);
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
            this.events.close();
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
        let decoded: any;
        try {
            const authHeader = request.headers.authorization;
            if (!authHeader || !authHeader.startsWith('Bearer ')) {
                throw new Error('Missing or invalid token scheme');
            }
            const token = authHeader.split(' ')[1];
            decoded = jwt.verify(token, this.signingKey(), { algorithms: ['HS256'] }) as any;
        } catch (err) {
            if (err instanceof AuthStoreNotReady) {
                return reply.code(503).send({ error: 'SERVER_STARTING' });
            }
            return reply.code(401).send({ error: 'Unauthorized' });
        }

        const auth: RequestAuth = { session: null, device: null };
        if (decoded.sid) {
            // A server session: still active, same user, and (when bound)
            // presented from the computer it was issued to.
            const store = this.authStore;
            const session = store?.getActiveSession(String(decoded.sid)) ?? null;
            // A role change since the token was minted needs a refresh.
            if (!store || !session || session.userId !== decoded.id || session.role !== decoded.role) {
                return reply.code(401).send({ error: 'Unauthorized' });
            }
            if (session.deviceId) {
                const device = store.authenticateDevice(request.headers[DEVICE_HEADER], request.ip);
                if (!device || device.id !== session.deviceId) {
                    return reply.code(401).send({ error: 'Unauthorized' });
                }
                auth.device = device;
            }
            auth.session = session;
        } else if (this.options.requireDevice) {
            return reply.code(401).send({ error: 'Unauthorized' });
        }
        (request as any).user = decoded;
        (request as any).auth = auth;
    }

    private deviceIdOf(request: FastifyRequest): string | null {
        return ((request as any).auth as RequestAuth | undefined)?.device?.id ?? null;
    }

    private adminOnly(handler: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>) {
        return async (request: FastifyRequest, reply: FastifyReply) => {
            if ((request as any).user?.role !== 'admin') {
                return reply.code(403).send({ error: 'Forbidden' });
            }
            return handler(request, reply);
        };
    }

    /** Mints an access token for a user, from their server session when there is one. */
    private issueAccessToken(user: { id: number; role: string; username: string }, session: ServerSession | null,
        facilityId: number | null = null): string {
        const claims: Record<string, unknown> = { id: user.id, role: user.role, username: user.username };
        if (session) {
            claims['sid'] = session.id;
            if (session.deviceId) claims['dev'] = session.deviceId;
        }
        // Facility the session is working in (#195); absent means facility 1.
        const facility = session?.facilityId ?? facilityId;
        if (facility != null) claims['facility_id'] = facility;
        return jwt.sign(claims, this.signingKey(), { algorithm: 'HS256', expiresIn: this.accessTtlSec });
    }

    /** The calling computer, from its device credential; required on NalamDesk Server. */
    private resolveDevice(request: FastifyRequest): JoinedDevice | null {
        const header = request.headers[DEVICE_HEADER];
        if (!header) return null;
        return this.authStore?.authenticateDevice(header, request.ip) ?? null;
    }

    private async handleHello() {
        return {
            product: 'nalamdesk-server',
            protocol: PROTOCOL_VERSION,
            minProtocol: MIN_SUPPORTED_PROTOCOL,
            serverVersion: serverReleaseVersion(),
            requireDevice: !!this.options.requireDevice,
            tls: this.options.tls
                ? { selfSigned: this.options.tls.selfSigned, fingerprint256: this.options.tls.fingerprint256 }
                : null
        };
    }

    // Join: a computer trades a one-time code from an admin for a device credential.
    private async handleJoin(request: FastifyRequest, reply: FastifyReply) {
        const ip = request.ip;
        const limited = this.joinIpLimiter.check(ip);
        if (!limited.allowed) {
            return reply.code(429).header('retry-after', String(limited.retryAfterSec)).send({ error: 'TOO_MANY_ATTEMPTS' });
        }
        const store = this.requireStore();
        const body = (request.body ?? {}) as { code?: unknown; name?: unknown };
        const parsed = typeof body.code === 'string' ? parseJoinCode(body.code) : null;
        const deviceName = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 100) : 'Unnamed computer';
        const fail = (status: number, error: string) => {
            this.joinIpLimiter.record(ip);
            this.joinFailureLimiter.record('all');
            if (!this.joinFailureLimiter.check('all').allowed) {
                // Too many wrong codes across the network: void every
                // outstanding code so guessing cannot succeed.
                const voided = store.revokeOutstandingJoinCodes();
                this.joinFailureLimiter.reset('all');
                this.audit('JOIN_CODES_VOIDED', null, `Voided ${voided} outstanding join code(s) after repeated wrong attempts`);
            }
            return reply.code(status).send({ error });
        };
        if (!parsed) return fail(400, 'INVALID_CODE');
        if (parsed.fingerprintPrefix !== fingerprintPrefix(joinFingerprint(this.options))) {
            return fail(400, 'WRONG_SERVER');
        }
        const joined = store.redeemJoinCode(parsed.secret, { deviceName, ip });
        if (!joined) return fail(401, 'INVALID_CODE');
        this.audit('DEVICE_JOIN', null, `Computer "${joined.device.name}" joined from ${ip}`, joined.device.id);
        return {
            deviceId: joined.device.id,
            deviceName: joined.device.name,
            deviceToken: joined.token,
            protocol: PROTOCOL_VERSION,
            serverVersion: serverReleaseVersion(),
            tls: this.options.tls
                ? { selfSigned: this.options.tls.selfSigned, fingerprint256: this.options.tls.fingerprint256 }
                : null
        };
    }

    private async handleRefresh(request: FastifyRequest, reply: FastifyReply) {
        const store = this.requireStore();
        const body = (request.body ?? {}) as { refreshToken?: unknown };
        let deviceId: string | null = null;
        if (request.headers[DEVICE_HEADER]) {
            const device = this.resolveDevice(request);
            if (!device) return reply.code(401).send({ error: 'DEVICE_NOT_JOINED' });
            deviceId = device.id;
        } else if (this.options.requireDevice) {
            return reply.code(401).send({ error: 'DEVICE_NOT_JOINED' });
        }
        const result = store.refreshSession(body.refreshToken, deviceId, request.ip);
        if ('error' in result) {
            if (result.error === 'reused') {
                this.audit('SESSION_REFRESH_REUSED', null, 'A used refresh token was presented again; the session was ended', deviceId);
            }
            return reply.code(401).send({ error: 'SESSION_EXPIRED' });
        }
        // Current role and status, so changes apply at the next refresh.
        const user = store.getUser(result.session.userId);
        if (!user || user.active !== 1) {
            store.revokeSession(result.session.id, 'user_inactive');
            return reply.code(401).send({ error: 'SESSION_EXPIRED' });
        }
        // Access to the session's facility can be withdrawn too (#195).
        const facilityId = result.session.facilityId ?? DEFAULT_FACILITY_ID;
        const facilityRole = this.dbService.getFacilityRole(user.id, facilityId);
        if (!facilityRole) {
            store.revokeSession(result.session.id, 'facility_access_removed');
            return reply.code(401).send({ error: 'SESSION_EXPIRED' });
        }
        if (user.role === 'admin' && process.env['STRICT_ADMIN_IP'] === 'true'
            && request.ip !== '127.0.0.1' && request.ip !== '::1') {
            return reply.code(403).send({ error: 'Admin login restricted to Master System' });
        }
        return {
            token: this.issueAccessToken(user, result.session),
            refreshToken: result.refreshToken,
            expiresIn: this.accessTtlSec,
            facilityId,
            user: { id: user.id, username: user.username, role: facilityRole, name: user.name }
        };
    }

    /** Moves the session to another facility the user holds a role at, and reissues the token. */
    private async handleSwitchFacility(request: FastifyRequest, reply: FastifyReply) {
        const auth = (request as any).auth as RequestAuth;
        const user = (request as any).user;
        const body = (request.body ?? {}) as { facilityId?: unknown };
        if (body.facilityId === undefined || body.facilityId === null || body.facilityId === '') {
            return reply.code(400).send({ error: 'facilityId is required' });
        }
        const facility = chooseFacility(this.dbService.getUserFacilities(Number(user.id)), body.facilityId);
        if (!facility) return reply.code(403).send({ error: 'NO_FACILITY_ACCESS' });
        if (auth.session && !this.requireStore().setSessionFacility(auth.session.id, facility.id)) {
            return reply.code(401).send({ error: 'SESSION_EXPIRED' });
        }
        const session = auth.session ? { ...auth.session, facilityId: facility.id } : null;
        this.audit('FACILITY_SWITCH', Number(user.id), `Switched to facility ${facility.code}`, auth.device?.id ?? null);
        return {
            token: this.issueAccessToken({ id: Number(user.id), role: user.role, username: user.username }, session, facility.id),
            expiresIn: this.accessTtlSec,
            facilityId: facility.id,
            role: facility.role
        };
    }

    private async handleLogout(request: FastifyRequest) {
        const auth = (request as any).auth as RequestAuth;
        if (auth.session && this.authStore) {
            this.authStore.revokeSession(auth.session.id, 'logout');
            this.events.disconnect({ sessionId: auth.session.id });
            this.audit('LOGOUT', auth.session.userId, 'Signed out', auth.device?.id ?? null);
        }
        return { ok: true };
    }

    // Login Handler
    private async handleLogin(request: FastifyRequest, reply: FastifyReply) {
        const body = request.body as any;
        if (!body || typeof body.username !== 'string' || typeof body.password !== 'string' || !body.username || !body.password) {
            return reply.code(400).send({ error: 'Invalid input' });
        }
        const { username, password } = body;
        const ip = request.ip;

        // Joined computers only on NalamDesk Server; elsewhere a credential,
        // when sent, still binds the session to the computer.
        let device: JoinedDevice | null = null;
        if (request.headers[DEVICE_HEADER] || this.options.requireDevice) {
            device = this.resolveDevice(request);
            if (!device) return reply.code(401).send({ error: 'DEVICE_NOT_JOINED' });
        }

        const limited = this.loginLimiter.check(ip, username);
        if (!limited.allowed) {
            return reply.code(429).header('retry-after', String(limited.retryAfterSec))
                .send({ error: 'TOO_MANY_ATTEMPTS', retryAfterSec: limited.retryAfterSec });
        }
        const failed = (userId: number | null) => {
            if (this.loginLimiter.recordFailure(ip, username)) {
                this.audit('LOGIN_LOCKED', userId, `Sign-in locked for "${String(username).slice(0, 50)}" after repeated failures from ${ip}`, device?.id ?? null);
            } else if (userId != null) {
                this.audit('LOGIN_FAILED', userId, `Wrong password from ${ip}`, device?.id ?? null);
            }
            return reply.code(401).send({ error: 'Invalid credentials' });
        };

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
                return failed(null);
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
                if (!(await argon2.verify(user.password, password))) {
                    return failed(user.id);
                }
            } catch (e) {
                return reply.code(500).send({ error: 'Auth error' });
            }
            this.loginLimiter.recordSuccess(ip, username);
            // Sign-in starts in one facility: the one asked for, or the
            // user's default. No facility means no access (#195).
            const facilities = this.dbService.getUserFacilities(user.id);
            const facility = chooseFacility(facilities, body.facilityId);
            if (!facility) {
                this.audit('LOGIN_NO_FACILITY', user.id, 'Signed in without access to the requested facility', device?.id ?? null);
                return reply.code(403).send({ error: 'NO_FACILITY_ACCESS' });
            }
            const created = this.authStore
                ? this.authStore.createSession({ userId: user.id, deviceId: device?.id ?? null, ip, facilityId: facility.id })
                : null;
            if (created) {
                this.audit('LOGIN', user.id, `Signed in${device ? ` on "${device.name}"` : ''} from ${ip}`, device?.id ?? null);
            }
            return {
                token: this.issueAccessToken(user, created?.session ?? null, facility.id),
                ...(created ? { refreshToken: created.refreshToken } : {}),
                expiresIn: this.accessTtlSec,
                facilityId: facility.id,
                facilities,
                user: { id: user.id, username: user.username, role: facility.role, name: user.name }
            };
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

        const serviceMethod = this.serviceMethods.get(method);
        if (serviceMethod) return this.handleServiceMethod(serviceMethod, method, args, user, reply);

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
            // 2. The request runs in one facility: the session's, or facility 1
            // for sessions minted before facilities. The role checked is the
            // user's role there, never the one carried in the token (#195).
            const facilityId = Number(user.facility_id) || DEFAULT_FACILITY_ID;
            const context = { userId: Number(user.id), facilityId };
            // Denials are audited in the request's facility, with the role checked there.
            const auditDenied = (role: string) => {
                try {
                    runWithContext(context, () => (this.dbService as any).auditDenial({ user: { ...user, role }, method, channel: 'lan' }));
                } catch { /* audit must not mask the denial */ }
            };
            const role = this.dbService.getFacilityRole(Number(user.id), facilityId);
            if (!role) {
                auditDenied('no-access');
                return reply.code(403).send({ error: 'Forbidden' });
            }

            // 3. RBAC Enforcement (single Cedar engine, shared with Electron IPC)
            if (!this.checkPermission(role, method, user.id)) {
                auditDenied(role);
                return reply.code(403).send({ error: 'Forbidden' });
            }

            const dbAny = this.dbService as any;

            // 4. Execution: ABDM service methods first, then DatabaseService.
            // Same arg unpacking contract as Electron IPC.
            const deviceId = this.deviceIdOf(request);
            if (ABDM_SERVICE_METHODS.has(method)) {
                try {
                    const result = await auditContext.run({ deviceId }, () => runWithContext(context, () => this.invokeAbdmMethod(method, args, user)));
                    this.events.publishForMethod(method);
                    return result;
                } catch (e: any) {
                    console.error(`[IPC Error] method: ${method}`, e);
                    return reply.code(500).send({ error: 'Internal server error' });
                }
            }
            if (typeof dbAny[method] === 'function') {
                try {
                    const result = await auditContext.run({ deviceId }, () => invokeDbMethod(dbAny, method, args, context));
                    this.events.publishForMethod(method);
                    if (method === 'saveUserOverride' || method === 'deleteUserOverride'
                        || method === 'saveRole' || method === 'deleteRole') {
                        this.refreshAccessPolicy();
                    }
                    this.notifyDbMethod(method, args);
                    return result;
                } catch (e: any) {
                    // Organisation admin refusals carry a message the admin can act on (#214).
                    if (e instanceof FacilityAdminError) return reply.code(400).send({ error: e.message });
                    if (e?.message === 'Forbidden') {
                        auditDenied(role);
                        return reply.code(403).send({ error: 'Forbidden' });
                    }
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

    private notifyDbMethod(method: string, args: unknown[]): void {
        try {
            this.afterDbMethod?.(method, args);
        } catch (e) {
            console.error(`[API Server] After ${method} hook failed:`, e);
        }
    }

    private checkPermission(role: string, method: string, userId?: number): boolean {
        // Admin: All access (mirrors the Electron path bypass).
        if (role === 'admin') return true;

        // Single engine, same as Electron IPC: roles baseline plus
        // per-user overrides, default deny. Rebuilt on every check so
        // desktop Settings mutations (separate Electron handlers) are
        // visible to LAN immediately; the tables are tiny and LAN
        // request rates are low, so the re-read cost is negligible.
        try {
            const policy = this.getAccessPolicy();
            policy.rebuild();
            return policy.isAuthorized({
                user: { id: userId ?? 0, role },
                action: method
            }).allow;
        } catch (e) {
            console.error(`[RBAC] Permission check failed for role ${role}:`, e);
            return false;
        }
    }

    private accessPolicy: AccessPolicy | null = null;

    private getAccessPolicy(): AccessPolicy {
        if (!this.accessPolicy) {
            const db = this.dbService as any;
            this.accessPolicy = new AccessPolicy({
                getRoles: () => db.getAllRoles(),
                getAllOverrides: () => db.getAllOverrides()
            });
        }
        return this.accessPolicy;
    }

    private refreshAccessPolicy(): void {
        try {
            this.getAccessPolicy().rebuild();
        } catch (e) {
            console.error('[Access] Policy rebuild failed:', e);
        }
    }
}
