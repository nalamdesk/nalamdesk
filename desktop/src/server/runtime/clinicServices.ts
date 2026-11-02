import { CronJob } from 'cron';
import type { DatabaseService } from '../../main/services/DatabaseService';
import type { DeviceKeyStore } from '../../main/services/DeviceKeyStore';
import { AbdmRelayService } from '../../main/services/AbdmRelayService';
import { AbdmAbhaService } from '../../main/services/AbdmAbhaService';
import { HiuService } from '../../main/services/HiuService';
import { HipService } from '../../main/services/HipService';
import { CloudLink } from '../../main/cloud/CloudLink';
import { AbdmMailboxProcessor } from '../../main/cloud/AbdmMailboxProcessor';
import type { Audience } from '../../main/cloud/SignedCloudClient';
import { currentFacilityId, runWithContext } from '../../shared/request-context';

import type { EventTopic } from '../events';

/** Events the services raise for clients (renderer push or the server's events stream). */
export type ClinicServiceEvent = 'cloud:newRequests' | 'cloud:pairingChanged' | 'abdm:shareReceived';

/** The events-stream topic each service event maps to. */
export const CLINIC_EVENT_TOPICS: Readonly<Record<ClinicServiceEvent, EventTopic>> = {
    'cloud:newRequests': 'bookings',
    'cloud:pairingChanged': 'cloud',
    'abdm:shareReceived': 'abdm.inbox'
};

export interface ClinicServicesDeps {
    db: DatabaseService;
    /** Wraps the Cloud signing key and the HIU private key on this machine. */
    keyStore: DeviceKeyStore;
    appVersion: string;
    baseUrl: (audience: Audience) => string | null;
    notify?: (event: ClinicServiceEvent, payload: unknown) => void;
    warn?: (message: string) => void;
}

/**
 * Everything a clinic's data talks to outside this machine (ADR 0001, #196):
 * NalamDesk Cloud pairing, the sealed mailbox and doorbell, ABDM through the
 * relay, and the HIU retention sweep. The desktop's single-PC mode and
 * NalamDesk Server build the same set, so there is one wiring for both.
 */
export interface ClinicServices {
    /** The cloud link of the facility the caller acts in (the request's, or the desktop session's). */
    readonly cloudLink: CloudLink;
    /** Each facility pairs on its own HFR ID with its own keys and mailbox (#215). */
    cloudLinkFor(facilityId: number): CloudLink;
    relay: AbdmRelayService;
    abha: AbdmAbhaService;
    hiu: HiuService;
    hip: HipService;
    mailbox: AbdmMailboxProcessor;
    /** Pairing, listing and mailbox state for the admin screen; the caller's facility by default. */
    cloudStatus(facilityId?: number): CloudStatusView;
    /** Pairing state of every active facility, for the admin screen. */
    cloudFacilities(): FacilityCloudStatus[];
    /** Applies ABDM items saved by the mailbox reader. */
    drainAbdmMailbox(): void;
    /** Call once the database is open and migrated. */
    start(): void;
    stop(): void;
}

export type CloudStatusView = ReturnType<CloudLink['pairing']['status']> & {
    facilityId: number;
    listingEnabled: boolean;
    mailbox: ReturnType<CloudLink['mailboxStatus']>;
};

export interface FacilityCloudStatus {
    facilityId: number;
    code: string;
    name: string;
    state: CloudStatusView['state'];
    hfrId: string | null;
    label: string | null;
    listingEnabled: boolean;
}

/** Runs `run` as background work of `facilityId`: its reads and writes are that facility's. */
export function inFacility<T>(facilityId: number, run: () => T): T {
    return runWithContext({ userId: 0, facilityId }, run);
}

/**
 * `target` with each method run as `facilityId`, for work that runs on
 * timers and doorbell rings outside any request (#215).
 */
export function facilityScoped<T extends object>(target: T, facilityId: number): T {
    return new Proxy(target, {
        get(object, property) {
            const value = Reflect.get(object, property, object);
            if (typeof value !== 'function') return value;
            return (...args: unknown[]) => inFacility(facilityId, () => value.apply(object, args));
        }
    });
}

export function createHiuService(
    db: DatabaseService,
    keyStore: DeviceKeyStore,
    relay: AbdmRelayService,
    dataPushUrl?: () => string | null
): HiuService {
    const database = db as any;
    return new HiuService({
        getSettings: () => database.getSettings(),
        getHiuPrivateProtected: () => database.getHiuPrivateProtected(),
        saveHiuPrivateProtected: (value: string) => database.saveHiuPrivateProtected(value),
        saveSettingsPatch: (patch: Record<string, unknown>) => database.saveSettings(patch),
        saveHiuKeypair: (publicKey: string, protectedPrivate: string) => database.saveHiuKeypair(publicKey, protectedPrivate),
        keyStore,
        store: {
            createConsentRequest: (input: any, actingUserId?: number) => database.createConsentRequest(input, actingUserId),
            getConsentById: (id: number) => database.getConsentById(id),
            getConsentByRequestId: (requestId: string) => database.getConsentByRequestId(requestId),
            updateConsentStatus: (id: number, status: string, handle?: string | null, actingUserId?: number) =>
                database.updateConsentStatus(id, status, handle, actingUserId),
            storeFetchedRecord: (input: any, actingUserId?: number) => database.storeFetchedRecord(input, actingUserId),
            getPendingInbox: () => database.getPendingInbox(),
            setConsentRequestId: (id: number, consentRequestId: string) => database.setConsentRequestId(id, consentRequestId),
            failConsentRequest: (id: number, error: string) => database.failConsentRequest(id, error),
            discardConsentRequest: (id: number) => database.discardConsentRequest(id),
            saveHiuArtefacts: (consentId: number, ids: string[], status: string) => database.saveHiuArtefacts(consentId, ids, status),
            getHiuArtefacts: (consentId: number) => database.getHiuArtefacts(consentId),
            findHiuArtefact: (field: string, value: string) => database.findHiuArtefact(field, value),
            updateHiuArtefact: (id: number, patch: Record<string, unknown>) => database.updateHiuArtefact(id, patch)
        },
        relay,
        // Live consent goes out as the paired facility; HIPs push to the relay (#164).
        hiuId: () => relay.status().hfr_id,
        dataPushUrl,
        requester: (actingUserId?: number) => database.getHiuRequester(actingUserId)
    } as any);
}

/** Expired outside records and imported medications go at start and daily at 03:00. */
function sweepRetention(db: DatabaseService, warn: (message: string) => void): void {
    try {
        db.expireFetchedRecords();
        db.sweepExpiredMedications();
    } catch (error) {
        warn(`[HIU] Retention sweep failed: ${(error as Error).message}`);
    }
}

export function createClinicServices(deps: ClinicServicesDeps): ClinicServices {
    const { db } = deps;
    const warn = deps.warn ?? ((message: string) => console.warn(message));
    const notify = deps.notify ?? (() => undefined);
    const runWork = <T>(work: () => Promise<T>) => db.runWork(work);

    // One cloud link per facility (#215), made when a facility first needs
    // it. Its store runs as that facility, so its pairing row, booking
    // requests and mailbox items are the facility's own.
    const links = new Map<number, CloudLink>();
    let started = false;
    const linkFor = (facilityId: number): CloudLink => {
        let link = links.get(facilityId);
        if (!link) {
            link = createLink(facilityId);
            links.set(facilityId, link);
            if (started) link.start();
        }
        return link;
    };
    const currentLink = (): CloudLink => linkFor(currentFacilityId());

    // ABDM goes through the relay as the paired facility of the request
    // (#160, #215); this machine holds no ABDM credentials. Unpaired, the
    // flows run against the mock gateway.
    const relay = new AbdmRelayService({
        getSettings: () => db.getSettings(),
        relay: () => currentLink().abdmRelay(),
        pairedHfrId: () => currentLink().pairing.status().hfrId ?? null
    });
    const abha = new AbdmAbhaService({ relay });
    const hiu = createHiuService(db, deps.keyStore, relay, () => db.getCloudDevice(currentFacilityId())?.data_push_url ?? null);
    const hip = new HipService({ store: db as any, relay, hipId: () => relay.status().hfr_id });
    const mailbox = new AbdmMailboxProcessor({
        store: db as any,
        hiu,
        hip,
        relay: () => currentLink().abdmRelay(),
        onShare: () => notify('abdm:shareReceived', {}),
        runWork,
        inFacility
    });
    const drainAbdmMailbox = (): void => {
        mailbox.drain().catch((error) => warn(`[ABDM mailbox] Pass failed: ${(error as Error).message}`));
    };
    const cloudStatus = (facilityId: number = currentFacilityId()): CloudStatusView => {
        const link = linkFor(facilityId);
        return {
            ...link.pairing.status(),
            facilityId,
            listingEnabled: !!db.getSettings(facilityId)?.cloud_enabled,
            mailbox: link.mailboxStatus()
        };
    };
    const cloudFacilities = (): FacilityCloudStatus[] => db.listFacilitiesForCloud().map((facility) => {
        const status = cloudStatus(facility.id);
        return {
            facilityId: facility.id,
            code: facility.code,
            name: facility.name,
            state: status.state,
            hfrId: status.hfrId ?? null,
            label: status.label ?? null,
            listingEnabled: status.listingEnabled
        };
    });
    function createLink(facilityId: number): CloudLink {
        return new CloudLink({
            store: facilityScoped(db, facilityId) as any,
            keyStore: deps.keyStore,
            appVersion: deps.appVersion,
            baseUrl: deps.baseUrl,
            onNewRequests: (count) => notify('cloud:newRequests', { count, facilityId }),
            onPairingChange: (status) => {
                abha.invalidateCert();
                notify('cloud:pairingChanged', { ...status, facilityId });
            },
            onMailboxChange: () => notify('cloud:pairingChanged', cloudStatus(facilityId)),
            onAbdmItems: () => drainAbdmMailbox(),
            // A restore drains cloud work before replacing the database, and refuses it after.
            runWork
        });
    }

    let retentionJob: CronJob | null = null;
    return {
        get cloudLink() { return currentLink(); },
        cloudLinkFor: linkFor,
        relay, abha, hiu, hip, mailbox, cloudStatus, cloudFacilities, drainAbdmMailbox,
        start() {
            sweepRetention(db, warn);
            if (!retentionJob) {
                try {
                    retentionJob = new CronJob('0 3 * * *', () => sweepRetention(db, warn));
                    retentionJob.start();
                } catch (error) {
                    warn(`[HIU] Could not schedule the retention sweep: ${(error as Error).message}`);
                }
            }
            // Every facility with a cloud identity, and links already made.
            for (const facilityId of db.listCloudDeviceFacilities()) linkFor(facilityId);
            for (const link of links.values()) link.start();
            started = true;
            // Items saved before the last shutdown.
            drainAbdmMailbox();
        },
        stop() {
            retentionJob?.stop();
            retentionJob = null;
            started = false;
            for (const link of links.values()) link.stop();
        }
    };
}
