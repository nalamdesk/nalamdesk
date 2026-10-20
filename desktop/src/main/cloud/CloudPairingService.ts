import type * as crypto from 'node:crypto';
import type { DeviceKeyStore } from '../services/DeviceKeyStore';
import type { ClinicSealingKey } from '../booking/BookingInboxService';
import {
    keyFingerprint, newSealingKey, newSigningKey, protectPrivateKey, rawPublicKey, unprotectPrivateKey,
    type CloudDeviceRow, type CloudDeviceStore
} from './DeviceIdentity';
import { normalizePairingCode, pairingMessages, signMessage } from './requestSigning';
import type { CloudResponse, SignedCloudClient, SigningIdentity } from './SignedCloudClient';

// Pairing this computer with NalamDesk Cloud (#154). The admin enters the
// clinic's HFR ID; NalamDesk staff verify the facility, approve it and read
// a one-time code to the HFR-registered contact; the admin types the code
// here. The relay then issues a device ID and revokes any other computer
// paired for that HFR ID. Nothing in the cloud works for this computer
// until then.

export const HFR_ID = /^IN\d{10}$/;
const CODE = /^[0-9A-HJKMNP-TV-Z]{8}$/;
/** The signing key is replaced after this long (the sealing key stays). */
export const SIGNING_KEY_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;
/** How long the relay keeps a pairing request open. */
const REQUEST_TTL_MS = 24 * 60 * 60 * 1000;

export interface DoorbellIdentity {
    endpoint: string;
    clientId: string;
    topic: string;
    certificatePem: string;
    privateKeyPem: string;
}

export type PairingState = 'unpaired' | 'requested' | 'paired' | 'revoked' | 'keys_unavailable';

export interface PairingStatus {
    state: PairingState;
    /** False when this build has no cloud address; pairing is then off. */
    configured: boolean;
    hfrId?: string;
    label?: string;
    requestExpiresAt?: number;
    deviceId?: string;
    clinicId?: string;
    pairedAt?: number;
    revokedReason?: string;
    /** Staff see the same fingerprint next to the request in the ops console. */
    keyFingerprint?: string;
    message?: string;
}

export class PairingError extends Error {
    constructor(readonly code: string, message: string, readonly extra: Record<string, unknown> = {}) {
        super(message);
    }
}

export interface CloudPairingDeps {
    store: CloudDeviceStore;
    keyStore: DeviceKeyStore;
    client: SignedCloudClient;
    appVersion: string;
    /** Called once the computer is paired or unpaired, so cloud work can start or stop. */
    onChange?: (status: PairingStatus) => void;
    /**
     * Runs a call that reads the pairing row, waits on the cloud and writes
     * the row back. A restore drains this work before replacing the database
     * and refuses new work, so no reply lands in the restored one.
     */
    runWork?: <T>(work: () => Promise<T>) => Promise<T>;
    nowMs?: () => number;
}

interface LoadedKeys {
    row: CloudDeviceRow;
    signing: crypto.KeyObject;
    sealing: crypto.KeyObject;
    /** The confirmed signing key while a rotation waits for the relay. */
    previous?: crypto.KeyObject;
}

const MESSAGES: Record<string, string> = {
    bad_hfr_id: 'Enter the HFR facility ID: IN followed by 10 digits.',
    pending_exists: 'Another computer has already asked to pair this HFR ID. Ask NalamDesk support to reject that request first.',
    rate_limited: 'Too many pairing requests from this network. Try again in an hour.',
    no_request: 'There is no pairing request for this computer any more. It may have expired after 24 hours; send a new one.',
    not_approved: 'NalamDesk staff have not approved this request yet. They will call the clinic\'s registered contact with the code.',
    code_expired: 'This code has expired. Ask NalamDesk support to approve the request again for a new code.',
    request_voided: 'Too many wrong codes, so the request was cancelled. Send a new pairing request.',
    bad_code_format: 'The code has 8 letters and digits, like ABCD-1234.',
    bad_signature: 'This computer\'s key did not match the request. Send a new pairing request.',
    clock_skew: 'This computer\'s clock is wrong. Correct the date and time, then try again.'
};

function failure(response: CloudResponse): PairingError {
    const code = String(response.body?.error || `http_${response.status}`);
    const message = code === 'bad_code'
        ? `That code is not right. ${Number(response.body?.attemptsLeft ?? 0)} attempt(s) left.`
        : MESSAGES[code] ?? `NalamDesk Cloud refused the request (${code}).`;
    return new PairingError(code, message, code === 'bad_code' ? { attemptsLeft: Number(response.body?.attemptsLeft ?? 0) } : {});
}

export class CloudPairingService {
    private cache: LoadedKeys | null = null;
    private readonly nowMs: () => number;

    constructor(private readonly deps: CloudPairingDeps) {
        this.nowMs = deps.nowMs ?? Date.now;
    }

    private work<T>(task: () => Promise<T>): Promise<T> {
        return this.deps.runWork ? this.deps.runWork(task) : task();
    }

    // ---- State ----

    status(): PairingStatus {
        const configured = this.deps.client.configured('relay');
        const row = this.deps.store.getCloudDevice();
        if (!row) return { state: 'unpaired', configured };
        const base: PairingStatus = {
            state: row.state,
            configured,
            hfrId: row.hfr_id,
            label: row.label,
            keyFingerprint: keyFingerprint(row.signing_public)
        };
        // request_expires_at is kept on this computer's clock (see request()).
        if (row.state === 'requested' && (row.request_expires_at ?? 0) <= this.nowMs()) return { state: 'unpaired', configured, hfrId: row.hfr_id };
        if (!this.keys()) {
            return { state: 'keys_unavailable', configured, hfrId: row.hfr_id, message: 'This computer cannot read its cloud keys (restored from another computer, or the system keyring changed). Pair it again.' };
        }
        if (row.state === 'requested') return { ...base, requestExpiresAt: row.request_expires_at ?? undefined };
        return {
            ...base,
            deviceId: row.device_id ?? undefined,
            clinicId: row.clinic_id ?? undefined,
            pairedAt: row.paired_at ?? undefined,
            revokedReason: row.revoked_reason ?? undefined
        };
    }

    isPaired(): boolean {
        return this.status().state === 'paired';
    }

    /**
     * For SignedCloudClient: the paired device's signing key. While a
     * rotation is unconfirmed this is still the old key, which the relay
     * accepts until it registers the new one and for 10 minutes after.
     */
    signingIdentity(): SigningIdentity | null {
        const keys = this.keys();
        if (!keys || keys.row.state !== 'paired' || !keys.row.device_id) return null;
        return { deviceId: keys.row.device_id, hipId: keys.row.hfr_id, privateKey: keys.previous ?? keys.signing };
    }

    /** For BookingInboxService: the X25519 key patients' browsers seal to. */
    sealingKey(): ClinicSealingKey {
        const keys = () => {
            const loaded = this.keys();
            if (!loaded || loaded.row.state !== 'paired' || !loaded.row.clinic_id) throw new PairingError('not_paired', 'This computer is not paired.');
            return loaded;
        };
        return {
            clinicId: () => keys().row.clinic_id as string,
            publicKeyRaw: () => keys().row.sealing_public,
            privateKey: () => keys().sealing
        };
    }

    // ---- Doorbell identity (#155) ----

    /** The stored doorbell certificate and key, if issued for the current device. */
    doorbellIdentity(): DoorbellIdentity | null {
        const row = this.deps.store.getCloudDevice();
        if (!row || row.state !== 'paired' || !row.device_id || row.iot_client_id !== row.device_id) return null;
        if (!row.iot_private_protected || !row.iot_public || !row.iot_certificate_pem || !row.iot_endpoint || !row.iot_topic) return null;
        try {
            const key = unprotectPrivateKey(this.deps.keyStore, row.iot_private_protected, row.iot_public);
            return {
                endpoint: row.iot_endpoint,
                clientId: row.iot_client_id,
                topic: row.iot_topic,
                certificatePem: row.iot_certificate_pem,
                privateKeyPem: key.export({ type: 'pkcs8', format: 'pem' }) as string
            };
        } catch {
            return null;
        }
    }

    saveDoorbellIdentity(key: crypto.KeyObject, issued: { certificatePem: string; endpoint: string; clientId: string; topic: string }): void {
        const row = this.deps.store.getCloudDevice();
        if (!row || row.state !== 'paired' || row.device_id !== issued.clientId) throw new PairingError('not_paired', 'This computer is not paired.');
        this.save({
            ...row,
            iot_private_protected: protectPrivateKey(this.deps.keyStore, key),
            iot_public: rawPublicKey(key),
            iot_certificate_pem: issued.certificatePem,
            iot_endpoint: issued.endpoint,
            iot_topic: issued.topic,
            iot_client_id: issued.clientId,
            updated_at: this.nowMs()
        });
    }

    /** Forgets the doorbell certificate, so the next connection asks for a new one. */
    clearDoorbellIdentity(): void {
        const row = this.deps.store.getCloudDevice();
        if (!row || !row.iot_client_id) return;
        this.save({
            ...row,
            iot_private_protected: null, iot_public: null, iot_certificate_pem: null, iot_endpoint: null, iot_topic: null, iot_client_id: null,
            updated_at: this.nowMs()
        });
    }

    private keys(): LoadedKeys | null {
        const row = this.deps.store.getCloudDevice();
        if (!row) return null;
        if (this.cache && this.cache.row.signing_public === row.signing_public && this.cache.row.updated_at === row.updated_at) return this.cache;
        try {
            this.cache = {
                row,
                signing: unprotectPrivateKey(this.deps.keyStore, row.signing_private_protected, row.signing_public),
                sealing: unprotectPrivateKey(this.deps.keyStore, row.sealing_private_protected, row.sealing_public),
                ...(row.previous_signing_public && row.previous_signing_private_protected
                    ? { previous: unprotectPrivateKey(this.deps.keyStore, row.previous_signing_private_protected, row.previous_signing_public) }
                    : {})
            };
            return this.cache;
        } catch {
            this.cache = null;
            return null;
        }
    }

    private save(row: CloudDeviceRow): void {
        this.deps.store.saveCloudDevice(row);
        this.cache = null;
    }

    private changed(): PairingStatus {
        const status = this.status();
        this.deps.onChange?.(status);
        return status;
    }

    // ---- Pairing ----

    /**
     * Sends a pairing request with fresh keys. A repeat for the same HFR ID
     * while the request is open reuses its keys, so the relay answers with
     * the same request instead of `pending_exists`. The keys are saved
     * before sending, so a request whose answer was lost is repeated with
     * them; a refusal puts back what was there before.
     */
    request(input: { hfrId: string; label: string }): Promise<PairingStatus> {
        return this.work(() => this.requestNow(input));
    }

    private async requestNow(input: { hfrId: string; label: string }): Promise<PairingStatus> {
        const hfrId = String(input.hfrId || '').trim().toUpperCase();
        const label = String(input.label || '').replace(/\s+/g, ' ').trim().slice(0, 60);
        if (!HFR_ID.test(hfrId)) throw new PairingError('bad_hfr_id', MESSAGES['bad_hfr_id'] as string);
        if (!label) throw new PairingError('bad_label', 'Give this computer a name, such as "Reception PC".');
        const current = this.deps.store.getCloudDevice();
        if (current?.state === 'paired' && this.keys()) {
            throw new PairingError('already_paired', 'This computer is already paired. Unpair it first.');
        }

        const reuse = current?.state === 'requested' && current.hfr_id === hfrId && (current.request_expires_at ?? 0) > this.nowMs() ? this.keys() : null;
        const signing = reuse ? { publicKey: reuse.row.signing_public, privateKey: reuse.signing } : newSigningKey();
        const sealing = reuse ? { publicKey: reuse.row.sealing_public, privateKey: reuse.sealing } : newSealingKey();
        // Wrap before anything leaves the computer: without the keychain there is nothing to pair.
        const signingWrapped = reuse ? reuse.row.signing_private_protected : protectPrivateKey(this.deps.keyStore, signing.privateKey);
        const sealingWrapped = reuse ? reuse.row.sealing_private_protected : protectPrivateKey(this.deps.keyStore, sealing.privateKey);

        const send = () => {
            const timestamp = String(Math.round(this.deps.client.now()));
            const signature = signMessage(signing.privateKey, pairingMessages.request({
                hfrId, signingPublicKey: signing.publicKey, sealingPublicKey: sealing.publicKey, label, appVersion: this.deps.appVersion, timestamp
            }));
            return this.deps.client.plain('relay', 'POST', '/pairing/request', {
                hfrId, signingPublicKey: signing.publicKey, sealingPublicKey: sealing.publicKey, label, appVersion: this.deps.appVersion, timestamp, signature
            });
        };
        const now = this.nowMs();
        const requested = (requestId: string, expiresAt: number): CloudDeviceRow => ({
            state: 'requested',
            hfr_id: hfrId,
            request_id: requestId,
            request_expires_at: expiresAt,
            device_id: null,
            clinic_id: null,
            data_push_url: null,
            label,
            signing_public: signing.publicKey,
            signing_private_protected: signingWrapped,
            signing_created_at: reuse ? reuse.row.signing_created_at : now,
            previous_signing_public: null,
            previous_signing_private_protected: null,
            sealing_public: sealing.publicKey,
            sealing_private_protected: sealingWrapped,
            paired_at: null,
            revoked_reason: null,
            updated_at: now
        });
        if (!reuse) this.save(requested('', now + REQUEST_TTL_MS));

        let response = await send();
        if (this.deps.client.adjustClock(response)) response = await send();
        if (response.status !== 202) {
            if (!reuse) {
                if (current) this.save(current);
                else {
                    this.deps.store.clearCloudDevice();
                    this.cache = null;
                }
            }
            throw failure(response);
        }
        // The relay's expiry is on its clock; keep it on this computer's, which may be off.
        const expiresAt = Number(response.body?.expiresAt);
        const localExpiry = Number.isFinite(expiresAt) ? expiresAt - (this.deps.client.now() - this.nowMs()) : now + REQUEST_TTL_MS;
        this.save({ ...requested(String(response.body?.requestId ?? ''), localExpiry), updated_at: this.nowMs() });
        return this.changed();
    }

    /** Withdraws an open request. The local request is dropped even if the cloud has already let it lapse. */
    cancel(): Promise<PairingStatus> {
        return this.work(() => this.cancelNow());
    }

    private async cancelNow(): Promise<PairingStatus> {
        const keys = this.keys();
        if (!keys || keys.row.state !== 'requested') throw new PairingError('no_request', 'There is no pairing request to cancel.');
        const hfrId = keys.row.hfr_id;
        const send = () => {
            const timestamp = String(Math.round(this.deps.client.now()));
            return this.deps.client.plain('relay', 'DELETE', '/pairing/request', {
                hfrId, timestamp, signature: signMessage(keys.signing, pairingMessages.cancel({ hfrId, timestamp }))
            });
        };
        let response = await send();
        if (this.deps.client.adjustClock(response)) response = await send();
        if (response.status !== 204 && response.status !== 404) throw failure(response);
        this.deps.store.clearCloudDevice();
        this.cache = null;
        return this.changed();
    }

    /** Spends the code NalamDesk staff read to the clinic. */
    activate(input: { code: string }): Promise<PairingStatus> {
        return this.work(() => this.activateNow(input));
    }

    private async activateNow(input: { code: string }): Promise<PairingStatus> {
        const code = normalizePairingCode(input.code);
        if (!CODE.test(code)) throw new PairingError('bad_code_format', MESSAGES['bad_code_format'] as string);
        const keys = this.keys();
        if (!keys || keys.row.state !== 'requested') throw new PairingError('no_request', MESSAGES['no_request'] as string);
        const { row } = keys;
        const send = () => {
            const timestamp = String(Math.round(this.deps.client.now()));
            const signature = signMessage(keys.signing, pairingMessages.activate({
                hfrId: row.hfr_id, code, signingPublicKey: row.signing_public, sealingPublicKey: row.sealing_public, timestamp
            }));
            return this.deps.client.plain('relay', 'POST', '/pairing/activate', { hfrId: row.hfr_id, code, timestamp, signature });
        };
        let response = await send();
        if (this.deps.client.adjustClock(response)) response = await send();
        if (response.status !== 200) {
            const error = failure(response);
            // The relay has dropped the request; so does this computer.
            if (error.code === 'request_voided' || error.code === 'no_request') {
                this.deps.store.clearCloudDevice();
                this.cache = null;
                this.changed();
            }
            throw error;
        }
        const body = response.body ?? {};
        if (typeof body.deviceId !== 'string' || typeof body.clinicId !== 'string' || body.hipId !== row.hfr_id) {
            throw new PairingError('bad_response', 'NalamDesk Cloud sent an unexpected answer. Try again.');
        }
        const now = this.nowMs();
        this.save({
            ...row,
            state: 'paired',
            request_id: null,
            request_expires_at: null,
            device_id: body.deviceId,
            clinic_id: body.clinicId,
            data_push_url: typeof body.dataPushUrl === 'string' ? body.dataPushUrl : null,
            paired_at: now,
            revoked_reason: null,
            updated_at: now
        });
        return this.changed();
    }

    /**
     * Called by the signed client when the cloud says this device is revoked
     * or unknown: another computer was paired for the HFR ID, or staff
     * revoked it. Cloud work stops until the admin pairs again. A late reply
     * for a device that is no longer the stored one (a restore installed
     * another) changes nothing, and the write is drained by a restore.
     */
    markRevoked(reason: string, deviceId?: string): Promise<void> {
        return this.work(async () => {
            const row = this.deps.store.getCloudDevice();
            if (!row || row.state !== 'paired') return;
            if (deviceId !== undefined && row.device_id !== deviceId) return;
            this.save({ ...row, state: 'revoked', revoked_reason: reason, updated_at: this.nowMs() });
            this.changed();
        });
    }

    /**
     * Forgets this computer's cloud identity locally. Used after a
     * revocation, or when the keys can no longer be read. A paired computer
     * is unpaired by NalamDesk staff (or by pairing its replacement), so the
     * cloud never trusts a key this computer merely says it dropped.
     */
    forget(): PairingStatus {
        const state = this.status().state;
        if (state === 'paired') throw new PairingError('still_paired', 'This computer is still paired. Ask NalamDesk support to revoke it, or pair its replacement.');
        this.deps.store.clearCloudDevice();
        this.cache = null;
        return this.changed();
    }

    // ---- Key rotation ----

    /**
     * Replaces the signing key once it is a year old. The new key is saved
     * first, with the old one kept beside it, so a crash mid-rotation can be
     * finished on the next start. The relay call is signed by the old key and
     * carries the new key's proof over the rotation message; the relay keeps
     * the old key valid for 10 minutes for calls in flight.
     */
    rotateSigningKeyIfDue(): Promise<boolean> {
        return this.work(() => this.rotateSigningKeyIfDueNow());
    }

    private async rotateSigningKeyIfDueNow(): Promise<boolean> {
        const keys = this.keys();
        if (!keys || keys.row.state !== 'paired' || !keys.row.device_id) return false;
        if (keys.row.previous_signing_public) return this.finishRotation(keys);
        if (this.nowMs() - keys.row.signing_created_at < SIGNING_KEY_MAX_AGE_MS) return false;
        const next = newSigningKey();
        const now = this.nowMs();
        this.save({
            ...keys.row,
            signing_public: next.publicKey,
            signing_private_protected: protectPrivateKey(this.deps.keyStore, next.privateKey),
            signing_created_at: now,
            previous_signing_public: keys.row.signing_public,
            previous_signing_private_protected: keys.row.signing_private_protected,
            updated_at: now
        });
        const saved = this.keys();
        if (!saved) throw new PairingError('keys_unavailable', 'The new signing key could not be read back.');
        return this.finishRotation(saved);
    }

    private async finishRotation(keys: LoadedKeys): Promise<boolean> {
        const { row } = keys;
        const deviceId = row.device_id as string;
        const oldKey = row.previous_signing_public as string;
        const old = unprotectPrivateKey(this.deps.keyStore, row.previous_signing_private_protected as string, oldKey);
        const proof = signMessage(keys.signing, pairingMessages.rotate({ deviceId, oldKey, newKey: row.signing_public }));
        const client = this.deps.client.withIdentity({ deviceId, hipId: row.hfr_id, privateKey: old });
        const response = await client.signed('relay', 'POST', '/device/rotate-key', { signingPublicKey: row.signing_public, proof });
        // 204: rotated now. same_key: an earlier attempt got through. bad_signature:
        // the old key's overlap has passed, which only happens once the relay holds the new key.
        const done = response.status === 204
            || (response.status === 400 && response.body?.error === 'same_key')
            || (response.status === 401 && response.body?.error === 'bad_signature');
        if (!done) throw failure(response);
        // Re-read the row: the doorbell certificate (or a revocation) may have
        // been saved while the relay call was out, and must not be written over.
        const current = this.deps.store.getCloudDevice();
        if (current && current.signing_public === row.signing_public && current.previous_signing_public === oldKey) {
            this.save({ ...current, previous_signing_public: null, previous_signing_private_protected: null, updated_at: this.nowMs() });
        }
        return true;
    }
}
