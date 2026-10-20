import { Injectable } from '@angular/core';

@Injectable({
    providedIn: 'root'
})
export class CloudService {

    async publishSlots(slots: { date: string, time: string }[], dates: string[]) {
        if ((window as any).electron) {
            return (window as any).electron.cloud.publishSlots(slots, dates);
        }
    }

    async getPublishedSlots(date: string) {
        if ((window as any).electron) {
            return (window as any).electron.cloud.getPublishedSlots(date);
        }
        return [];
    }

    async getAppointmentRequests() {
        if ((window as any).electron) {
            return (window as any).electron.db.getAppointmentRequests();
        }
        return [];
    }

    /**
     * Accepts or declines an online booking request. The cloud books or
     * releases the slot first; main records the decision locally after,
     * booking an accepted request's appointment for `slot` in the same step.
     */
    async decide(ref: string, decision: 'accepted' | 'declined', slot?: { date: string; time: string }) {
        if ((window as any).electron) {
            return (window as any).electron.cloud.decide({ ref, decision, ...slot });
        }
    }

    // ---- Pairing with NalamDesk Cloud (#154) ----

    async getStatus(): Promise<CloudStatus | null> {
        if ((window as any).electron) {
            return (window as any).electron.cloud.getStatus();
        }
        return null;
    }

    async requestPairing(hfrId: string, label: string): Promise<CloudStatus> {
        return (window as any).electron.cloud.requestPairing({ hfrId, label });
    }

    async activatePairing(code: string): Promise<CloudStatus> {
        return (window as any).electron.cloud.activatePairing({ code });
    }

    async cancelPairing(): Promise<CloudStatus> {
        return (window as any).electron.cloud.cancelPairing();
    }

    async forgetPairing(): Promise<CloudStatus> {
        return (window as any).electron.cloud.forgetPairing();
    }

    async enableListing(listing: { name: string; city: string; specialty?: string }): Promise<CloudStatus> {
        return (window as any).electron.cloud.enableListing(listing);
    }

    async disableListing(): Promise<CloudStatus> {
        return (window as any).electron.cloud.disableListing();
    }

    /** Subscribes to pairing changes pushed from main; returns the unsubscribe. */
    onPairingChanged(callback: (status: CloudStatus) => void): () => void {
        return (window as any).electron?.cloud?.onPairingChanged?.(callback) ?? (() => undefined);
    }

    async syncNow() {
        if ((window as any).electron) {
            return (window as any).electron.cloud.syncNow();
        }
    }

    async saveAppointment(appt: any) {
        if ((window as any).electron) {
            return (window as any).electron.db.saveAppointment(appt);
        }
    }

    async getAppointments(date: string) {
        if ((window as any).electron) {
            return (window as any).electron.db.getAppointments(date);
        }
        return [];
    }
}
