import type { DatabaseService } from '../../main/services/DatabaseService';
import type { DeviceKeyStore } from '../../main/services/DeviceKeyStore';
import { AbdmRelayService } from '../../main/services/AbdmRelayService';
import { AbdmAbhaService } from '../../main/services/AbdmAbhaService';
import { HiuService } from '../../main/services/HiuService';
import { HipService } from '../../main/services/HipService';
import type { ApiAbdmServices } from '../app';

/**
 * ABDM services for the headless server. Until Cloud pairing moves into the
 * server (#196) there is no relay, so they run against the mock gateway, as
 * an unpaired desktop does. Device-bound HIU keys use the server's key store
 * instead of Electron safeStorage.
 */
export function createServerAbdmServices(db: DatabaseService, keyStore: DeviceKeyStore): ApiAbdmServices {
    const database = db as any;
    const relay = new AbdmRelayService({ getSettings: () => database.getSettings() });
    const hiu = new HiuService({
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
        } as any,
        relay,
        hiuId: () => relay.status().hfr_id,
        requester: (actingUserId?: number) => database.getHiuRequester(actingUserId)
    } as any);
    return {
        relay,
        abha: new AbdmAbhaService({ relay }),
        hiu,
        hip: new HipService({ store: database, relay, hipId: () => relay.status().hfr_id })
    };
}
