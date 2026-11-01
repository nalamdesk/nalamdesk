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
    cloudLink: CloudLink;
    relay: AbdmRelayService;
    abha: AbdmAbhaService;
    hiu: HiuService;
    hip: HipService;
    mailbox: AbdmMailboxProcessor;
    /** Pairing, listing and mailbox state for the admin screen. */
    cloudStatus(): CloudStatusView;
    /** Applies ABDM items saved by the mailbox reader. */
    drainAbdmMailbox(): void;
    /** Call once the database is open and migrated. */
    start(): void;
    stop(): void;
}

export type CloudStatusView = ReturnType<CloudLink['pairing']['status']> & {
    listingEnabled: boolean;
    mailbox: ReturnType<CloudLink['mailboxStatus']>;
};

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

    // ABDM goes through the relay as the paired facility (#160); this machine
    // holds no ABDM credentials. Unpaired, the flows run against the mock gateway.
    // The relay is wired before the link exists, so its getters read it lazily.
    let cloudLink: CloudLink;
    const relay = new AbdmRelayService({
        getSettings: () => db.getSettings(),
        relay: () => cloudLink.abdmRelay(),
        pairedHfrId: () => cloudLink.pairing.status().hfrId ?? null
    });
    const abha = new AbdmAbhaService({ relay });
    const hiu = createHiuService(db, deps.keyStore, relay, () => db.getCloudDevice()?.data_push_url ?? null);
    const hip = new HipService({ store: db as any, relay, hipId: () => relay.status().hfr_id });
    const mailbox = new AbdmMailboxProcessor({
        store: db as any,
        hiu,
        hip,
        relay: () => cloudLink.abdmRelay(),
        onShare: () => notify('abdm:shareReceived', {}),
        runWork
    });
    const drainAbdmMailbox = (): void => {
        mailbox.drain().catch((error) => warn(`[ABDM mailbox] Pass failed: ${(error as Error).message}`));
    };
    const cloudStatus = (): CloudStatusView => ({
        ...cloudLink.pairing.status(),
        listingEnabled: !!db.getSettings()?.cloud_enabled,
        mailbox: cloudLink.mailboxStatus()
    });
    cloudLink = new CloudLink({
        store: db as any,
        keyStore: deps.keyStore,
        appVersion: deps.appVersion,
        baseUrl: deps.baseUrl,
        onNewRequests: (count) => notify('cloud:newRequests', { count }),
        onPairingChange: (status) => {
            abha.invalidateCert();
            notify('cloud:pairingChanged', status);
        },
        onMailboxChange: () => notify('cloud:pairingChanged', cloudStatus()),
        onAbdmItems: () => drainAbdmMailbox(),
        // A restore drains cloud work before replacing the database, and refuses it after.
        runWork
    });

    let retentionJob: CronJob | null = null;
    return {
        cloudLink, relay, abha, hiu, hip, mailbox, cloudStatus, drainAbdmMailbox,
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
            cloudLink.start();
            // Items saved before the last shutdown.
            drainAbdmMailbox();
        },
        stop() {
            retentionJob?.stop();
            retentionJob = null;
            cloudLink.stop();
        }
    };
}
