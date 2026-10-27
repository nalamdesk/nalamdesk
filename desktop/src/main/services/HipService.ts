import * as crypto from 'node:crypto';
import * as dns from 'node:dns';
import * as https from 'node:https';
import * as net from 'node:net';
import { buildOpConsultRecord, type EncounterExportInput } from '../../shared/fhir/serializer';
import { FideliusService, parseKeyMaterial, type FideliusKeyMaterial } from './FideliusService';

// ABDM M2: this clinic as a Health Information Provider (#163). Gateway
// callbacks reach it through the relay's mailbox; answers go back through
// the relay. Records go straight to the requesting HIU's data push URL,
// Fidelius-encrypted to its key, with no relay in between. Paths and bodies
// follow the official ABDM v3 M2 document (M2_Document_16_02_2026) and the
// official Postman collections; strict v3 only.

export const HIP_DISCOVER_PATH = '/api/v3/hip/patient/care-context/discover';
export const HIP_LINK_INIT_PATH = '/api/v3/hip/link/care-context/init';
export const HIP_LINK_CONFIRM_PATH = '/api/v3/hip/link/care-context/confirm';
export const HIP_CONSENT_NOTIFY_PATH = '/api/v3/consent/request/hip/notify';
export const HIP_HI_REQUEST_PATH = '/api/v3/hip/health-information/request';
export const HIP_ON_GENERATE_TOKEN_PATH = '/api/v3/hip/token/on-generate-token';
export const HIP_ON_CARE_CONTEXT_PATH = '/api/v3/link/on_carecontext';
export const HIP_CONTEXT_NOTIFY_ACK_PATH = '/api/v3/links/context/on-notify';
export const HIP_SMS_NOTIFY_ACK_PATH = '/api/v3/patients/sms/on-notify';

const ON_DISCOVER = '/user-initiated-linking/v3/patient/care-context/on-discover';
const ON_LINK_INIT = '/user-initiated-linking/v3/link/care-context/on-init';
const ON_LINK_CONFIRM = '/user-initiated-linking/v3/link/care-context/on-confirm';
const CONSENT_ON_NOTIFY = '/consent/v3/request/hip/on-notify';
const HI_ON_REQUEST = '/data-flow/v3/health-information/hip/on-request';
const HI_NOTIFY = '/data-flow/v3/health-information/notify';
const GENERATE_TOKEN = '/v3/token/generate-token';
const LINK_CARE_CONTEXT = '/hip/v3/link/carecontext';
const CONTEXT_NOTIFY = '/hip/v3/link/context/notify';
const LINKED_CONTEXTS = '/hip/v3/link/patient/links';
const SMS_NOTIFY2 = '/hip/v3/link/patient/links/sms/notify2';

// The only record type this clinic writes: one OP consultation per visit.
const HI_TYPE = 'OPConsultation';
const OTP_TTL_MS = 10 * 60 * 1000;
const DISCOVERY_TTL_MS = 30 * 60 * 1000;
const MAX_OTP_ATTEMPTS = 3;
// Link tokens are reused for a while; a refused one is dropped and asked for again.
const LINK_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const PUSH_TIMEOUT_MS = 30_000;

export interface HipStore {
    findHipPatients(query: { abhaAddress?: string | null; abhaNumber?: string | null; mobile?: string | null; gender?: string | null; yearOfBirth?: number | null }): { matchedBy: string | null; patients: any[] };
    findHipPatientByReference(reference: string): any;
    getHipCareContexts(patientId: number): any[];
    getHipLinkedRefs(abhaAddress: string): string[];
    getHipLinkAddresses(refs: string[]): Record<string, string>;
    saveHipLinks(abhaAddress: string, patientId: number | null, refs: string[], via: 'patient' | 'clinic', actingUserId?: number): void;
    saveHipLinkRequest(row: { linkRef: string; transactionId: string | null; abhaAddress: string; patientId: number; refs: string[]; otpHash: string; expiresAt: number }): void;
    getHipLinkRequest(linkRef: string): any;
    closeHipLinkOtp(linkRef: string): void;
    saveHipDiscovery(row: { transactionId: string; abhaAddress: string; patientId: number; discoveredAt: number }): void;
    getHipDiscovery(transactionId: string): any;
    updateHipLinkRequest(linkRef: string, patch: { attempts?: number; status?: string }): void;
    saveHipConsent(row: { consentId: string; status: string; abhaAddress: string | null; hiTypes: string[]; refs: string[]; dateFrom: string | null; dateTo: string | null; dataEraseAt: string | null }): void;
    getHipConsent(consentId: string): any;
    saveHipRequest(row: { requestId: string; kind: 'token' | 'link'; abhaAddress: string; patientId: number | null; refs: string[] }): void;
    getHipRequest(requestId: string): any;
    updateHipRequest(requestId: string, status: string, error?: string | null): void;
    getHipEncounterExport(careContextRef: string): HipEncounter | null;
    getHipVisit(visitId: number): any;
    receiveInboxCallback(kind: string, payload: any, actingUserId?: number, requestId?: string): any;
}

export interface HipEncounter {
    visit: any;
    patient: any;
    doctor: any;
    clinic: { name: string; hfrId: string | null };
    allergies: any[];
    conditions: any[];
}

export interface HipDeps {
    store: HipStore;
    relay: {
        isMockMode: () => boolean;
        send: (upstream: 'gateway', method: 'POST', path: string, body: unknown, headers?: { 'request-id'?: string; 'x-link-token'?: string }) => Promise<any>;
    };
    /** The paired facility ID; it is this clinic's HIP ID. */
    hipId: () => string | null;
    /** Test seam for the push; production posts through `pinnedPost`. */
    fetchFn?: typeof fetch;
    /** Resolves a host name to its addresses; records only go to public ones. */
    lookupHost?: (host: string) => Promise<string[]>;
    nowMs?: () => number;
    newRequestId?: () => string;
    newOtp?: () => string;
}

export type HipCallbackResult = { followUp?: () => Promise<void> };

interface PushPage {
    careContextRef: string;
    bundle: unknown;
}

class HipRefusal extends Error {
    constructor(readonly code: number, message: string) {
        super(message);
    }
}

export class HipService {
    /**
     * Live linking codes, held in memory only so no copy reaches the
     * database or a backup. A restart drops them; the patient links again.
     */
    private readonly liveCodes = new Map<string, { otp: string; expiresAt: number }>();
    /** Link tokens by lowercased health ID, likewise held in memory only. */
    private readonly linkTokens = new Map<string, { token: string; expiresAt: number }>();

    constructor(private readonly deps: HipDeps) {}

    private nowMs(): number {
        return this.deps.nowMs ? this.deps.nowMs() : Date.now();
    }

    private newRequestId(): string {
        return this.deps.newRequestId ? this.deps.newRequestId() : crypto.randomUUID();
    }

    private async gateway(path: string, body: unknown, headers: { 'x-link-token'?: string } = {}, requestId = this.newRequestId()): Promise<void> {
        await this.deps.relay.send('gateway', 'POST', path, body, { 'request-id': requestId, ...headers });
    }

    private hipId(): string {
        const id = String(this.deps.hipId() ?? '').trim();
        if (!id) throw new Error('This computer is not paired with a facility.');
        return id;
    }

    /**
     * Applies an HIP callback from the mailbox. Returns null for a path this
     * service does not own; otherwise the gateway answer to send once the
     * database work is done. A request it must refuse is answered with an
     * error rather than thrown, so the gateway is never left waiting.
     */
    applyCallback(path: string | null, body: any, requestId: string | null): HipCallbackResult | null {
        switch (path) {
            case HIP_DISCOVER_PATH: return this.answer(ON_DISCOVER, requestId, body, () => this.discover(body));
            case HIP_LINK_INIT_PATH: return this.answer(ON_LINK_INIT, requestId, body, () => this.linkInit(body));
            case HIP_LINK_CONFIRM_PATH: return this.answer(ON_LINK_CONFIRM, requestId, body, () => this.linkConfirm(body));
            case HIP_CONSENT_NOTIFY_PATH: return this.consentNotify(body, requestId);
            case HIP_HI_REQUEST_PATH: return this.healthInformationRequest(body, requestId);
            case HIP_ON_GENERATE_TOKEN_PATH: return this.onGenerateToken(body);
            case HIP_ON_CARE_CONTEXT_PATH: return this.onCareContext(body);
            case HIP_CONTEXT_NOTIFY_ACK_PATH: return this.onContextNotifyAck(body);
            case HIP_SMS_NOTIFY_ACK_PATH: return this.onSmsNotifyAck(body);
            default: return null;
        }
    }

    private answer(path: string, requestId: string | null, body: any, build: () => Record<string, unknown>): HipCallbackResult {
        const transactionId = typeof body?.transactionId === 'string' ? body.transactionId : undefined;
        let reply: Record<string, unknown>;
        try {
            reply = build();
        } catch (error) {
            if (!(error instanceof HipRefusal)) throw error;
            reply = { ...(transactionId ? { transactionId } : {}), error: { code: error.code, message: error.message } };
        }
        const payload = { ...reply, response: { requestId: requestId ?? '' } };
        return { followUp: () => this.gateway(path, payload) };
    }

    // --- Discovery and linking from the patient's app ---------------------

    private discover(body: any): Record<string, unknown> {
        const patient = body?.patient ?? {};
        // Only identifiers the gateway verified may match a patient here.
        const identifiers = Array.isArray(patient.verifiedIdentifiers) ? patient.verifiedIdentifiers : [];
        const identifier = (type: string) => identifiers.find((item: any) => String(item?.type).toUpperCase() === type)?.value ?? null;
        const abhaAddress = typeof patient.id === 'string' ? patient.id.trim() : '';
        const found = this.deps.store.findHipPatients({
            abhaAddress,
            abhaNumber: identifier('ABHA_NUMBER'),
            mobile: identifier('MOBILE'),
            gender: patient.gender ?? null,
            yearOfBirth: Number(patient.yearOfBirth) || null
        });
        if (found.patients.length === 0) throw new HipRefusal(1000, 'No matching patient record at this facility.');
        if (found.patients.length > 1) throw new HipRefusal(1000, 'More than one patient matches; please visit the facility to link records.');
        const match = found.patients[0];
        const all = this.deps.store.getHipCareContexts(Number(match.id));
        // A visit already linked to any health ID is not offered again.
        const linked = this.deps.store.getHipLinkAddresses(all.map((row) => row.care_context_ref));
        const contexts = all.filter((row) => !linked[row.care_context_ref]);
        if (contexts.length === 0) throw new HipRefusal(1000, 'No new records to link at this facility.');
        const transactionId = typeof body?.transactionId === 'string' ? body.transactionId.trim() : '';
        if (transactionId && abhaAddress) {
            this.deps.store.saveHipDiscovery({ transactionId, abhaAddress, patientId: Number(match.id), discoveredAt: this.nowMs() });
        }
        return {
            transactionId: body?.transactionId,
            patient: [patientEntry(match, contexts)],
            matchedBy: [found.matchedBy]
        };
    }

    private linkInit(body: any): Record<string, unknown> {
        const abhaAddress = typeof body?.abhaAddress === 'string' ? body.abhaAddress.trim() : '';
        if (!abhaAddress) throw new HipRefusal(1000, 'The link request names no health ID.');
        const entries = Array.isArray(body?.patient) ? body.patient : [body?.patient].filter(Boolean);
        const references = new Set(entries.map((entry: any) => String(entry?.referenceNumber ?? '')));
        if (references.size !== 1) throw new HipRefusal(1000, 'A link request must name one patient.');
        const patient = this.deps.store.findHipPatientByReference([...references][0] as string);
        if (!patient) throw new HipRefusal(1000, 'Patient reference not found.');
        // Linking continues the discovery that matched this patient to this health ID.
        const discovery = typeof body?.transactionId === 'string' ? this.deps.store.getHipDiscovery(body.transactionId) : null;
        if (!discovery || Number(discovery.patient_id) !== Number(patient.id)
            || String(discovery.abha_address) !== abhaAddress.toLowerCase()
            || this.nowMs() - Number(discovery.discovered_at) > DISCOVERY_TTL_MS) {
            throw new HipRefusal(1000, 'Please search for your records at this facility again before linking.');
        }
        const known = new Set(this.deps.store.getHipCareContexts(Number(patient.id)).map((row) => row.care_context_ref));
        const refs: string[] = entries.flatMap((entry: any) => (Array.isArray(entry?.careContexts) ? entry.careContexts : []))
            .map((context: any) => String(context?.referenceNumber ?? ''));
        if (refs.length === 0 || refs.some((ref) => !known.has(ref))) throw new HipRefusal(1000, 'Care context reference not found.');
        this.refuseLinkedElsewhere(refs, abhaAddress);
        const otp = this.deps.newOtp ? this.deps.newOtp() : String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
        const linkRef = crypto.randomUUID();
        const expiresAt = this.nowMs() + OTP_TTL_MS;
        this.deps.store.saveHipLinkRequest({
            linkRef,
            transactionId: typeof body?.transactionId === 'string' ? body.transactionId : null,
            abhaAddress,
            patientId: Number(patient.id),
            refs: [...new Set(refs)],
            otpHash: otpHash(linkRef, otp),
            expiresAt
        });
        // This build sends no SMS: the desk reads the code to the patient at
        // the counter. The inbox entry says who is waiting; the code itself
        // stays in memory (see linkCode).
        this.liveCodes.set(linkRef, { otp, expiresAt });
        this.deps.store.receiveInboxCallback('hip-link-otp', {
            patientName: patient.name ?? null,
            mobile: patient.mobile ?? null,
            abhaAddress,
            expiresAt: new Date(expiresAt).toISOString()
        }, undefined, linkRef);
        return {
            transactionId: body?.transactionId,
            link: {
                referenceNumber: linkRef,
                authenticationType: 'DIRECT',
                meta: { communicationMedium: 'MOBILE', communicationHint: 'OTP', communicationExpiry: new Date(expiresAt).toISOString() }
            }
        };
    }

    /** The code the desk reads to the patient, while the attempt is live. */
    linkCode(linkRef: string): string | null {
        const live = this.liveCodes.get(String(linkRef || ''));
        if (!live) return null;
        if (live.expiresAt <= this.nowMs()) {
            this.liveCodes.delete(String(linkRef));
            return null;
        }
        return live.otp;
    }

    /** A link token still valid for this health ID, if one is held. */
    linkToken(abhaAddress: string): string | null {
        const held = this.linkTokens.get(String(abhaAddress || '').trim().toLowerCase());
        return held && held.expiresAt > this.nowMs() ? held.token : null;
    }

    private endLinkAttempt(linkRef: string): void {
        this.liveCodes.delete(linkRef);
        this.deps.store.closeHipLinkOtp(linkRef);
    }

    private refuseLinkedElsewhere(refs: string[], abhaAddress: string): void {
        const owners = this.deps.store.getHipLinkAddresses(refs);
        if (refs.some((ref) => owners[ref] && owners[ref] !== abhaAddress.toLowerCase())) {
            throw new HipRefusal(1000, 'A record here is already linked to another health ID.');
        }
    }

    private linkConfirm(body: any): Record<string, unknown> {
        const linkRef = String(body?.confirmation?.linkRefNumber ?? '').trim();
        const token = String(body?.confirmation?.token ?? '').trim();
        const request = linkRef ? this.deps.store.getHipLinkRequest(linkRef) : null;
        if (!request || request.status !== 'pending') throw new HipRefusal(1000, 'Link request not found.');
        if (Number(request.expires_at) <= this.nowMs()) {
            this.deps.store.updateHipLinkRequest(linkRef, { status: 'expired' });
            this.endLinkAttempt(linkRef);
            throw new HipRefusal(1000, 'The code has expired. Please start linking again.');
        }
        const attempts = Number(request.attempts) + 1;
        if (!sameHash(request.otp_hash, otpHash(linkRef, token))) {
            this.deps.store.updateHipLinkRequest(linkRef, { attempts, status: attempts >= MAX_OTP_ATTEMPTS ? 'failed' : 'pending' });
            if (attempts >= MAX_OTP_ATTEMPTS) this.endLinkAttempt(linkRef);
            throw new HipRefusal(1000, 'The code does not match.');
        }
        const refs: string[] = JSON.parse(request.care_context_refs || '[]');
        this.refuseLinkedElsewhere(refs, request.abha_address);
        // Links first: if saving them fails, the request stays open for a retry.
        this.deps.store.saveHipLinks(request.abha_address, Number(request.patient_id), refs, 'patient');
        this.deps.store.updateHipLinkRequest(linkRef, { attempts, status: 'linked' });
        this.endLinkAttempt(linkRef);
        const contexts = this.deps.store.getHipCareContexts(Number(request.patient_id)).filter((row) => refs.includes(row.care_context_ref));
        const patient = this.deps.store.findHipPatientByReference(String(request.patient_id));
        return { patient: [patientEntry(patient ?? { id: request.patient_id }, contexts)] };
    }

    // --- Linking a visit from the clinic (HIP-initiated) ------------------

    /**
     * Links a finished visit to the patient's health ID. Asks for a link
     * token first when none is held; the link itself then follows the
     * token's callback.
     */
    async linkVisit(visitId: number): Promise<{ status: 'linking' | 'token-requested' }> {
        if (this.deps.relay.isMockMode()) throw new Error('Linking records needs this computer paired with NalamDesk Cloud.');
        const visit = this.deps.store.getHipVisit(Number(visitId));
        if (!visit) throw new Error('Visit not found.');
        if (visit.status !== 'finished' || !visit.care_context_ref) throw new Error('Only a finished visit can be linked.');
        const abhaAddress = String(visit.abha_address ?? '').trim();
        if (!abhaAddress) throw new Error('Link the patient\'s health ID first.');
        const owner = this.deps.store.getHipLinkAddresses([visit.care_context_ref])[visit.care_context_ref];
        if (owner && owner !== abhaAddress.toLowerCase()) throw new Error('This visit is already linked to another health ID.');
        const token = this.linkToken(abhaAddress);
        if (token) {
            await this.sendCareContextLink(abhaAddress, Number(visit.patient_id), [visit.care_context_ref], token);
            return { status: 'linking' };
        }
        const requestId = this.newRequestId();
        this.deps.store.saveHipRequest({ requestId, kind: 'token', abhaAddress, patientId: Number(visit.patient_id), refs: [visit.care_context_ref] });
        const year = visit.dob ? Number(String(visit.dob).slice(0, 4)) : visit.age != null ? new Date(this.nowMs()).getFullYear() - Number(visit.age) : null;
        await this.gateway(GENERATE_TOKEN, {
            ...(visit.abha_number ? { abhaNumber: String(visit.abha_number).replace(/\D/g, '') } : {}),
            abhaAddress,
            name: visit.name,
            gender: genderCode(visit.gender),
            ...(year ? { yearOfBirth: year } : {})
        }, {}, requestId);
        return { status: 'token-requested' };
    }

    private async sendCareContextLink(abhaAddress: string, patientId: number, refs: string[], linkToken: string): Promise<void> {
        const patient = this.deps.store.findHipPatientByReference(String(patientId));
        const contexts = this.deps.store.getHipCareContexts(patientId).filter((row) => refs.includes(row.care_context_ref));
        if (!patient || contexts.length === 0) throw new Error('Nothing to link for this visit.');
        const requestId = this.newRequestId();
        this.deps.store.saveHipRequest({ requestId, kind: 'link', abhaAddress, patientId, refs });
        await this.gateway(LINK_CARE_CONTEXT, {
            ...(patient.abha_number ? { abhaNumber: String(patient.abha_number).replace(/\D/g, '') } : {}),
            abhaAddress,
            patient: [patientEntry(patient, contexts)]
        }, { 'x-link-token': linkToken }, requestId);
    }

    private onGenerateToken(body: any): HipCallbackResult {
        const requestId = String(body?.response?.requestId ?? '').trim();
        const request = requestId ? this.deps.store.getHipRequest(requestId) : null;
        if (!request || request.kind !== 'token') throw new Error('Link token request not found.');
        const token = typeof body?.linkToken === 'string' ? body.linkToken : '';
        if (body?.error || !token) {
            this.deps.store.updateHipRequest(requestId, 'failed', errorText(body?.error));
            return {};
        }
        this.deps.store.updateHipRequest(requestId, 'done');
        this.linkTokens.set(String(request.abha_address).trim().toLowerCase(), { token, expiresAt: this.nowMs() + LINK_TOKEN_TTL_MS });
        const refs: string[] = JSON.parse(request.care_context_refs || '[]');
        return { followUp: () => this.sendCareContextLink(request.abha_address, Number(request.patient_id), refs, token) };
    }

    private onCareContext(body: any): HipCallbackResult {
        const requestId = String(body?.response?.requestId ?? body?.resp?.requestId ?? '').trim();
        const request = requestId ? this.deps.store.getHipRequest(requestId) : null;
        if (!request || request.kind !== 'link') throw new Error('Care context link request not found.');
        if (body?.error) {
            // A refused token is not reused; the next attempt asks for a new one.
            this.linkTokens.delete(String(request.abha_address).trim().toLowerCase());
            this.deps.store.updateHipRequest(requestId, 'failed', errorText(body.error));
            return {};
        }
        this.deps.store.updateHipRequest(requestId, 'done');
        this.deps.store.saveHipLinks(request.abha_address, Number(request.patient_id), JSON.parse(request.care_context_refs || '[]'), 'clinic');
        return {};
    }

    private onContextNotifyAck(body: any): HipCallbackResult {
        const status = String(body?.acknowledgement?.status ?? '').toUpperCase();
        if (status && status !== 'OK' && status !== 'SUCCESS') {
            throw new Error(`Context notify not acknowledged: ${status}`);
        }
        return {};
    }

    private onSmsNotifyAck(body: any): HipCallbackResult {
        const status = String(body?.status ?? body?.acknowledgement?.status ?? '').toUpperCase();
        if (status && status !== 'OK' && status !== 'SUCCESS') {
            throw new Error(`SMS notify not acknowledged: ${status}`);
        }
        return {};
    }

    /**
     * Notifies subscribed HIUs that a linked care context has new data
     * (official M2: POST /hip/v3/link/context/notify).
     */
    async notifyContextUpdate(refs: string[], hiTypes: string[]): Promise<void> {
        const addresses = this.deps.store.getHipLinkAddresses(refs);
        const abhaAddress = refs.map((ref) => addresses[ref]).find(Boolean);
        if (!abhaAddress) throw new Error('None of these visits are linked to a health ID.');
        await this.gateway(CONTEXT_NOTIFY, {
            patient: { id: abhaAddress },
            careContext: refs.map((ref) => ({ referenceNumber: ref })),
            hiTypes,
            date: new Date(this.nowMs()).toISOString(),
            hip: { id: this.hipId() }
        });
    }

    /** Returns the linked care contexts for an ABHA address (official M2: GET links). */
    linkedContexts(abhaAddress: string): string[] {
        return this.deps.store.getHipLinkedRefs(String(abhaAddress || '').trim());
    }

    // --- Consent and data transfer ----------------------------------------

    private consentNotify(body: any, requestId: string | null): HipCallbackResult {
        const notification = body?.notification ?? {};
        const consentId = String(notification.consentId ?? notification.consentDetail?.consentId ?? '').trim();
        if (!consentId) {
            const refusal = { error: { code: 1000, message: 'Consent notification names no consent.' }, response: { requestId: requestId ?? '' } };
            return { followUp: () => this.gateway(CONSENT_ON_NOTIFY, refusal) };
        }
        const status = String(notification.status ?? '').toUpperCase();
        const detail = notification.consentDetail ?? {};
        const existing = this.deps.store.getHipConsent(consentId);
        this.deps.store.saveHipConsent({
            consentId,
            status,
            abhaAddress: stringOrNull(detail.patient?.id) ?? existing?.abha_address ?? null,
            hiTypes: Array.isArray(detail.hiTypes) ? detail.hiTypes.map(String) : [],
            refs: Array.isArray(detail.careContexts)
                ? detail.careContexts.map((context: any) => String(context?.careContextReference ?? '')).filter(Boolean)
                : [],
            dateFrom: stringOrNull(detail.permission?.dateRange?.from),
            dateTo: stringOrNull(detail.permission?.dateRange?.to),
            dataEraseAt: stringOrNull(detail.permission?.dataEraseAt)
        });
        const payload = { acknowledgement: { status: 'ok', consentId }, response: { requestId: requestId ?? '' } };
        return { followUp: () => this.gateway(CONSENT_ON_NOTIFY, payload) };
    }

    private healthInformationRequest(body: any, requestId: string | null): HipCallbackResult {
        const transactionId = String(body?.transactionId ?? '').trim();
        const hiRequest = body?.hiRequest ?? {};
        const consentId = String(hiRequest.consent?.id ?? '').trim();
        const respond = (extra: Record<string, unknown>) => ({
            ...extra, response: { requestId: requestId ?? '' }
        });
        let pages: PushPage[];
        let keyMaterial: FideliusKeyMaterial;
        let dataPushUrl: string;
        try {
            const consent = consentId ? this.deps.store.getHipConsent(consentId) : null;
            if (!consent) throw new HipRefusal(1000, 'Consent not found at this facility.');
            if (consent.status !== 'GRANTED') throw new HipRefusal(1000, 'Consent is not active.');
            if (consent.data_erase_at && Date.parse(consent.data_erase_at) <= this.nowMs()) {
                throw new HipRefusal(1000, 'Consent has expired.');
            }
            keyMaterial = parseKeyMaterial(hiRequest.keyMaterial);
            dataPushUrl = checkedPushUrl(hiRequest.dataPushUrl);
            const range = clampRange(hiRequest.dateRange, consent.date_from, consent.date_to);
            pages = JSON.parse(consent.hi_types || '[]').includes(HI_TYPE)
                ? this.pagesFor(JSON.parse(consent.care_context_refs || '[]'), range)
                : [];
        } catch (error) {
            const message = error instanceof HipRefusal ? error.message : `Invalid request: ${(error as Error).message}`;
            const payload = respond({ hiRequest: { transactionId, sessionStatus: 'ERROR' }, error: { code: 1000, message } });
            return { followUp: () => this.gateway(HI_ON_REQUEST, payload) };
        }
        const ack = respond({ hiRequest: { transactionId, sessionStatus: 'ACKNOWLEDGED' } });
        return {
            followUp: async () => {
                await this.gateway(HI_ON_REQUEST, ack);
                await this.transfer(consentId, transactionId, dataPushUrl, keyMaterial, pages);
            }
        };
    }

    /** True when every address the host resolves to is public. */
    private async publicHost(host: string): Promise<boolean> {
        const lookup = this.deps.lookupHost
            ?? (async (name: string) => (await dns.promises.lookup(name, { all: true })).map((entry) => entry.address));
        const addresses = await lookup(host);
        return addresses.length > 0 && addresses.every(isPublicAddress);
    }

    /** One FHIR document per care context the consent names and the date range covers. */
    private pagesFor(refs: string[], range: { from: number; to: number }): PushPage[] {
        const pages: PushPage[] = [];
        for (const ref of refs) {
            const encounter = this.deps.store.getHipEncounterExport(ref);
            if (!encounter) continue;
            const when = Date.parse(toIso(encounter.visit.date));
            if (Number.isFinite(when) && (when < range.from || when > range.to)) continue;
            pages.push({ careContextRef: ref, bundle: buildOpConsultRecord(exportInput(encounter)).bundle });
        }
        return pages;
    }

    /**
     * Pushes each document as its own page, each sealed with a fresh sender
     * key (one key per page keeps every AES-GCM nonce unique), then tells the
     * gateway how the transfer went.
     */
    private async transfer(consentId: string, transactionId: string, url: string, requester: FideliusKeyMaterial, pages: PushPage[]): Promise<void> {
        const fidelius = new FideliusService({ nowMs: () => this.nowMs() });
        const reachable = await this.publicHost(new URL(url).hostname).catch(() => false);
        const statuses: Array<{ careContextReference: string; hiStatus: string; description: string }> = [];
        for (const [index, page] of pages.entries()) {
            const plaintext = JSON.stringify(page.bundle);
            const envelope = fidelius.encryptBundle(page.bundle, requester);
            let ok = false;
            try {
                if (!reachable) throw new Error('The data push host is not public.');
                const body = JSON.stringify({
                    pageNumber: index + 1,
                    pageCount: pages.length,
                    transactionId,
                    entries: [{
                        content: envelope.encryptedData,
                        media: 'application/fhir+json',
                        // ABDM asks for an MD5 of the plain FHIR bundle; an integrity tag, not a security control.
                        checksum: crypto.createHash('md5').update(plaintext, 'utf8').digest('hex'), // NOSONAR
                        careContextReference: page.careContextRef
                    }],
                    keyMaterial: envelope.keyMaterial
                });
                ok = this.deps.fetchFn
                    ? (await this.deps.fetchFn(url, {
                        method: 'POST',
                        redirect: 'error',
                        headers: { 'content-type': 'application/json' },
                        body,
                        signal: AbortSignal.timeout(PUSH_TIMEOUT_MS)
                    })).ok
                    : await pinnedPost(url, body, PUSH_TIMEOUT_MS);
            } catch {
                ok = false;
            }
            statuses.push({
                careContextReference: page.careContextRef,
                hiStatus: ok ? 'DELIVERED' : 'ERRORED',
                description: ok ? 'Delivered' : 'Could not deliver to the requester'
            });
        }
        const hipId = this.hipId();
        await this.gateway(HI_NOTIFY, {
            notification: {
                consentId,
                transactionId,
                doneAt: new Date(this.nowMs()).toISOString(),
                notifier: { type: 'HIP', id: hipId },
                statusNotification: {
                    sessionStatus: statuses.every((status) => status.hiStatus === 'DELIVERED') ? 'TRANSFERRED' : 'FAILED',
                    hipId,
                    statusResponses: statuses
                }
            }
        });
    }
}

function patientEntry(patient: any, contexts: any[]): Record<string, unknown> {
    return {
        referenceNumber: String(patient?.mrn || patient?.uuid || patient?.id),
        display: String(patient?.name || 'Patient'),
        careContexts: contexts.map((row) => ({
            referenceNumber: row.care_context_ref,
            display: `Outpatient visit on ${String(row.date ?? '').slice(0, 10)}`
        })),
        hiType: HI_TYPE,
        count: contexts.length
    };
}

/** The serializer's input for one visit, as the chart export builds it. */
export function exportInput(encounter: HipEncounter): EncounterExportInput {
    const { visit, patient, doctor, clinic } = encounter;
    const units = visit.vitals?.units || {};
    return {
        patient: {
            id: patient.id, name: patient.name, mobile: patient.mobile, age: patient.age, gender: patient.gender,
            dob: patient.dob, address: patient.address, abhaAddress: patient.abha_address
        },
        practitioner: {
            id: doctor.id, name: doctor.name || 'Doctor', licenseNumber: doctor.license_number || undefined,
            specialty: doctor.specialty || undefined, registryId: doctor.abdm_hpr_id || undefined
        },
        clinic: { name: clinic.name, registryId: clinic.hfrId || undefined },
        encounter: {
            id: visit.id, date: visit.date, diagnosis: visit.diagnosis, diagnosisType: visit.diagnosis_type,
            symptoms: visit.symptoms, examinationNotes: visit.examination_notes, careContextRef: visit.care_context_ref || null
        },
        prescriptions: (visit.prescription || []).map((item: any) => ({
            medicine: item.medicine, dosage: item.dosage, route: item.route, frequency: item.frequency,
            duration: item.duration, instruction: item.instruction || item.instructions
        })),
        allergies: encounter.allergies.map((a) => ({
            substance: a.substance, criticality: a.criticality, severity: a.severity, reaction: a.reaction, status: a.status
        })),
        conditions: encounter.conditions.map((c) => ({
            name: c.condition_name, code: c.code, status: c.clinical_status, onsetDate: c.onset_date
        })),
        vitals: visit.vitals ? {
            systolic_bp: visit.vitals.systolic_bp, diastolic_bp: visit.vitals.diastolic_bp, pulse: visit.vitals.pulse,
            temperature: visit.vitals.temperature, temperatureUnits: units.temperature, spo2: visit.vitals.spo2,
            weight: visit.vitals.weight, weightUnits: units.weight, height: visit.vitals.height
        } : null
    };
}

function otpHash(linkRef: string, otp: string): string {
    return crypto.createHash('sha256').update(`${linkRef}:${otp}`, 'utf8').digest('hex');
}

function sameHash(a: string, b: string): boolean {
    const left = Buffer.from(String(a), 'hex');
    const right = Buffer.from(String(b), 'hex');
    return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function genderCode(gender: unknown): string {
    const first = String(gender ?? '').trim().charAt(0).toUpperCase();
    return first === 'M' || first === 'F' ? first : 'O';
}

function stringOrNull(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function errorText(error: any): string {
    return String(error?.message || (error?.code != null ? `Error ${error.code}` : 'Refused by the gateway.')).slice(0, 500);
}

/** SQLite `YYYY-MM-DD HH:MM:SS` (UTC) or ISO, as ISO. */
function toIso(value: unknown): string {
    const text = String(value ?? '').trim();
    return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(text) ? `${text.replace(' ', 'T')}Z` : text;
}

/** The requested range, kept inside what the consent allows. */
function clampRange(requested: any, consentFrom: string | null, consentTo: string | null): { from: number; to: number } {
    const pick = (values: unknown[], choose: (a: number, b: number) => number, fallback: number) => {
        const times = values.map((value) => Date.parse(String(value ?? ''))).filter(Number.isFinite);
        return times.reduce((a, b) => choose(a, b), fallback);
    };
    const from = pick([requested?.from, consentFrom], Math.max, Number.NEGATIVE_INFINITY);
    const to = pick([requested?.to, consentTo], Math.min, Number.POSITIVE_INFINITY);
    if (from > to) throw new HipRefusal(1000, 'The requested dates fall outside the consent.');
    return { from, to };
}

const PRIVATE_RANGES = (() => {
    const list = new net.BlockList();
    for (const [prefix, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
        ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3]] as const) {
        list.addSubnet(prefix, bits, 'ipv4');
    }
    for (const [prefix, bits] of [['::', 127], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) {
        list.addSubnet(prefix, bits, 'ipv6');
    }
    return list;
})();

type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;
type Resolver = (host: string, callback: (error: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void) => void;

/**
 * A socket lookup that only ever connects to public addresses: the check and
 * the connection use the same answer, so a host cannot pass the check and
 * then rebind to a private address.
 */
export function publicLookup(resolve: Resolver = (host, callback) => dns.lookup(host, { all: true }, callback)) {
    return (host: string, options: { all?: boolean }, callback: LookupCallback) => {
        resolve(host, (error, addresses) => {
            if (error) return callback(error, []);
            if (addresses.length === 0 || !addresses.every((entry) => isPublicAddress(entry.address))) {
                return callback(Object.assign(new Error(`${host} does not resolve to a public address.`), { code: 'ENOTPUBLIC' }), []);
            }
            return options?.all ? callback(null, addresses) : callback(null, addresses[0].address, addresses[0].family);
        });
    };
}

/** POSTs JSON over HTTPS to a public address; never follows a redirect. Resolves true on a 2xx. */
export function pinnedPost(url: string, body: string, timeoutMs: number, lookup = publicLookup()): Promise<boolean> {
    return new Promise((resolve) => {
        const request = https.request(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
            lookup: lookup as any,
            timeout: timeoutMs
        }, (response) => {
            response.resume();
            const status = response.statusCode ?? 0;
            resolve(status >= 200 && status < 300);
        });
        request.on('timeout', () => request.destroy(new Error('Push timed out.')));
        request.on('error', () => resolve(false));
        request.end(body);
    });
}

function isPublicAddress(address: string): boolean {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    const ip = mapped ? mapped[1] : address;
    const family = net.isIPv4(ip) ? 'ipv4' : net.isIPv6(ip) ? 'ipv6' : null;
    return family != null && !PRIVATE_RANGES.check(ip, family);
}

/** Records only ever go to an HTTPS address on a public host name. */
function checkedPushUrl(value: unknown): string {
    let url: URL;
    try {
        url = new URL(String(value ?? ''));
    } catch {
        throw new HipRefusal(1000, 'The data push URL is not valid.');
    }
    const host = url.hostname.toLowerCase();
    const literal = /^[\d.]+$/.test(host) || host.startsWith('[');
    if (url.protocol !== 'https:' || literal || host === 'localhost' || !host.includes('.') || url.username || url.password) {
        throw new HipRefusal(1000, 'The data push URL must be an HTTPS address on a public host.');
    }
    return url.toString();
}
