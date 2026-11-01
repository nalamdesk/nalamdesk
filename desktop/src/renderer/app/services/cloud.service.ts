import { Injectable } from '@angular/core';
import { DataService } from './api.service';

/**
 * NalamDesk Cloud pairing and online booking. In the desktop app these go
 * over IPC; in a browser they call the server, which owns Cloud (#196).
 */
@Injectable({
    providedIn: 'root'
})
export class CloudService {
    constructor(private readonly data: DataService) { }

    private get bridge(): any {
        return (window as any).electron?.cloud;
    }

    /** IPC in the desktop app, otherwise the server method of the same name. */
    private call<T>(name: string, serverMethod: string, ...args: unknown[]): Promise<T> {
        const bridge = this.bridge;
        if (bridge) return bridge[name](...args);
        return this.data.invoke<T>(serverMethod, ...args);
    }

    async publishSlots(slots: { date: string, time: string }[], dates: string[]) {
        return this.call('publishSlots', 'cloudPublishSlots', slots, dates);
    }

    async getPublishedSlots(date: string) {
        return this.call('getPublishedSlots', 'cloudGetPublishedSlots', date);
    }

    async getAppointmentRequests() {
        if ((window as any).electron) {
            return (window as any).electron.db.getAppointmentRequests();
        }
        return this.data.invoke('getAppointmentRequests');
    }

    /**
     * Accepts or declines an online booking request. The cloud books or
     * releases the slot first; main records the decision locally after,
     * booking an accepted request's appointment for `slot` in the same step.
     */
    async decide(ref: string, decision: 'accepted' | 'declined', slot?: { date: string; time: string }) {
        return this.call('decide', 'cloudDecide', { ref, decision, ...slot });
    }

    // ---- Pairing with NalamDesk Cloud (#154) ----

    async getStatus(): Promise<CloudStatus | null> {
        return this.call('getStatus', 'cloudGetStatus');
    }

    async requestPairing(hfrId: string, label: string): Promise<CloudStatus> {
        return this.call('requestPairing', 'cloudRequestPairing', { hfrId, label });
    }

    async activatePairing(code: string): Promise<CloudStatus> {
        return this.call('activatePairing', 'cloudActivatePairing', { code });
    }

    async cancelPairing(): Promise<CloudStatus> {
        return this.call('cancelPairing', 'cloudCancelPairing');
    }

    async forgetPairing(): Promise<CloudStatus> {
        return this.call('forgetPairing', 'cloudForgetPairing');
    }

    async enableListing(listing: { name: string; city: string; specialty?: string }): Promise<CloudStatus> {
        return this.call('enableListing', 'cloudEnableListing', listing);
    }

    async disableListing(): Promise<CloudStatus> {
        return this.call('disableListing', 'cloudDisableListing');
    }

    /** Subscribes to pairing changes pushed from main; returns the unsubscribe. */
    onPairingChanged(callback: (status: CloudStatus) => void): () => void {
        return this.bridge?.onPairingChanged?.(callback) ?? (() => undefined);
    }

    /** Fetches the cloud mailbox now; resolves with new booking requests saved. */
    async syncNow() {
        return this.call('syncNow', 'cloudSyncNow');
    }

    async saveAppointment(appt: any) {
        if ((window as any).electron) {
            return (window as any).electron.db.saveAppointment(appt);
        }
        return this.data.invoke('saveAppointment', appt);
    }

    async getAppointments(date: string) {
        if ((window as any).electron) {
            return (window as any).electron.db.getAppointments(date);
        }
        return this.data.invoke('getAppointments', date);
    }
}
