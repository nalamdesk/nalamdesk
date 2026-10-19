import type { ClinicStore } from './ports.js';

/** The fields NalamDesk reads from an AWS IoT Core lifecycle event. */
export interface IotLifecycleEvent {
    clientId: string;
    eventType: string;
    /** Epoch ms. */
    timestamp: number;
}

/**
 * Turns an IoT Core connected/disconnected event into the clinic's
 * Online/Offline flag. The client ID is the device ID (fixed by the IoT
 * policy in #155), so `clinicOfDevice` is the device registry lookup from
 * #154. Out-of-order events are dropped by the store's timestamp check.
 */
export async function applyPresenceEvent(
    clinics: ClinicStore,
    clinicOfDevice: (deviceId: string) => Promise<string | null>,
    event: IotLifecycleEvent
): Promise<boolean> {
    if (event.eventType !== 'connected' && event.eventType !== 'disconnected') return false;
    if (typeof event.clientId !== 'string' || !Number.isFinite(event.timestamp)) return false;
    const clinicId = await clinicOfDevice(event.clientId);
    if (!clinicId) return false;
    await clinics.setPresence(clinicId, event.eventType === 'connected', event.timestamp);
    return true;
}
