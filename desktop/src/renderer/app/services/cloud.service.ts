import { Injectable, Optional } from '@angular/core';
import { DataService } from './api.service';
import { ServerConnectionService } from './server-connection.service';
import type { ServerEventMessage } from '../../../shared/server-client';

/**
 * NalamDesk Cloud pairing and online booking. In the desktop app these go
 * over IPC; in a browser they call the server, which owns Cloud (#196).
 */
@Injectable({
    providedIn: 'root'
})
export class CloudService {
    constructor(private readonly data: DataService, @Optional() private readonly server?: ServerConnectionService) { }

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

    /** Admin: the pairing state of every facility (#215). */
    async listFacilities(): Promise<FacilityCloudStatus[]> {
        return this.call('listFacilities', 'cloudListFacilities');
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

    /**
     * Subscribes to pairing and listing changes; returns the unsubscribe.
     * The desktop app pushes the new status over IPC; server clients get a
     * `cloud` event (#216) and refetch, so the callback has no status then.
     */
    onPairingChanged(callback: (status?: CloudStatus) => void): () => void {
        const bridge = this.bridge;
        if (bridge) return bridge.onPairingChanged?.(callback) ?? (() => undefined);
        return this.onServerTopic('cloud', () => callback());
    }

    /** Subscribes to new or decided online booking requests; returns the unsubscribe. */
    onRequestsChanged(callback: () => void): () => void {
        const bridge = this.bridge;
        if (bridge) return bridge.onNewRequests?.(() => callback()) ?? (() => undefined);
        return this.onServerTopic('bookings', callback);
    }

    private onServerTopic(topic: ServerEventMessage['topic'], callback: () => void): () => void {
        if (!this.server || (window as any).electron) return () => undefined;
        const sub = this.server.events.subscribe((event) => {
            if (event.topic === topic || event.topic === 'resync') callback();
        });
        return () => sub.unsubscribe();
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
