import { Component, Input, NgZone, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { CloudService } from '../services/cloud.service';

/**
 * Pairing this computer with NalamDesk Cloud (#154), then listing the
 * clinic for online booking. Three steps for the admin: send a request with
 * the HFR ID, wait for NalamDesk to call the clinic's HFR-registered contact
 * with a code, type the code here.
 */
@Component({
    selector: 'app-cloud-link',
    standalone: true,
    imports: [CommonModule, FormsModule],
    template: `
    <div class="bg-white p-4 md:p-6 rounded-lg shadow-sm border border-gray-200 mt-6" data-testid="cloud-link">
      <h3 class="text-lg font-medium text-gray-800">NalamDesk Cloud</h3>
      <p class="text-sm text-gray-500 mb-4">Pairs this computer with your clinic's HFR ID, for ABDM and online booking. One computer per clinic.</p>

      <p *ngIf="error" class="text-sm text-red-600 mb-3" role="alert">{{ error }}</p>

      <ng-container *ngIf="status as s">
        <p *ngIf="!s.configured" class="text-sm text-gray-600">Cloud pairing is not available in this build.</p>

        <ng-container *ngIf="s.configured">
          <!-- Not paired -->
          <div *ngIf="s.state === 'unpaired'">
            <ng-container *ngIf="isAdmin; else adminOnly">
              <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label class="block text-sm font-medium text-gray-700 mb-1" for="cloud-hfr">HFR facility ID</label>
                  <input id="cloud-hfr" class="input input-bordered w-full font-mono" [(ngModel)]="hfrId" placeholder="IN2710000123" maxlength="12" autocomplete="off" />
                </div>
                <div>
                  <label class="block text-sm font-medium text-gray-700 mb-1" for="cloud-label">Name for this computer</label>
                  <input id="cloud-label" class="input input-bordered w-full" [(ngModel)]="label" placeholder="Reception PC" maxlength="60" />
                </div>
              </div>
              <p class="text-xs text-gray-500 mt-2">If another computer is paired for this HFR ID, it stops working once this one is paired.</p>
              <button type="button" class="btn btn-primary btn-sm mt-3" [disabled]="busy || !hfrId || !label" (click)="request()">Request pairing</button>
            </ng-container>
          </div>

          <!-- Waiting for NalamDesk's call -->
          <div *ngIf="s.state === 'requested'">
            <div class="bg-amber-50 border border-amber-200 rounded p-3 text-sm text-amber-900 mb-3">
              Request sent for <span class="font-mono">{{ s.hfrId }}</span>. NalamDesk will verify the facility and call the contact registered in HFR with an 8-character code.
              <span class="block mt-1">Key check: <span class="font-mono">{{ s.keyFingerprint }}</span> &middot; expires {{ s.requestExpiresAt | date:'medium' }}</span>
            </div>
            <ng-container *ngIf="isAdmin; else adminOnly">
              <label class="block text-sm font-medium text-gray-700 mb-1" for="cloud-code">Pairing code</label>
              <div class="flex flex-wrap gap-2">
                <input id="cloud-code" class="input input-bordered font-mono tracking-widest uppercase w-40" [(ngModel)]="code" placeholder="XXXX-XXXX" maxlength="9" autocomplete="off" />
                <button type="button" class="btn btn-primary btn-sm" [disabled]="busy || !code" (click)="activate()">Pair</button>
                <button type="button" class="btn btn-ghost btn-sm" [disabled]="busy" (click)="cancel()">Cancel request</button>
              </div>
            </ng-container>
          </div>

          <!-- Paired -->
          <div *ngIf="s.state === 'paired'">
            <div class="bg-green-50 border border-green-200 rounded p-3 text-sm text-green-900">
              Paired as <strong>{{ s.label }}</strong> for <span class="font-mono">{{ s.hfrId }}</span> since {{ s.pairedAt | date:'mediumDate' }}.
              <span class="block text-xs mt-1 text-green-800">To unpair, ask NalamDesk support, or pair the replacement computer.</span>
            </div>

            <div class="flex flex-wrap items-center gap-3 mt-3 text-sm text-gray-600" data-testid="cloud-mailbox">
              <span>
                <ng-container *ngIf="s.mailbox?.doorbell === 'live'; else polling">New ABDM messages and bookings arrive as they are sent.</ng-container>
                <ng-template #polling>Checking for new messages every 30 minutes.</ng-template>
                <span *ngIf="s.mailbox?.lastCheckedAt as checked" class="text-gray-500"> Last checked {{ checked | date:'shortTime' }}.</span>
              </span>
              <button type="button" class="btn btn-ghost btn-xs" [disabled]="checking" (click)="checkNow()">{{ checking ? 'Checking…' : 'Check now' }}</button>
            </div>

            <div class="mt-4 pt-4 border-t border-gray-100">
              <div class="flex items-center justify-between">
                <div>
                  <h4 class="font-medium text-gray-800">Online booking</h4>
                  <p class="text-sm text-gray-500">List the clinic so patients can request appointments online.</p>
                </div>
                <input type="checkbox" class="toggle toggle-primary" aria-label="Online booking" [checked]="s.listingEnabled" [disabled]="busy || !isAdmin" (change)="toggleListing($event)" />
              </div>
              <div *ngIf="showListingForm" class="grid grid-cols-1 md:grid-cols-3 gap-3 mt-3">
                <input class="input input-bordered input-sm" [(ngModel)]="listing.name" placeholder="Clinic name (public)" maxlength="80" />
                <input class="input input-bordered input-sm" [(ngModel)]="listing.city" placeholder="City" maxlength="40" />
                <input class="input input-bordered input-sm" [(ngModel)]="listing.specialty" placeholder="Specialty (optional)" maxlength="40" />
                <div class="md:col-span-3 flex gap-2">
                  <button type="button" class="btn btn-primary btn-sm" [disabled]="busy || !listing.name || !listing.city" (click)="enableListing()">List clinic</button>
                  <button type="button" class="btn btn-ghost btn-sm" [disabled]="busy" (click)="showListingForm = false">Cancel</button>
                </div>
              </div>
            </div>
          </div>

          <!-- Revoked, or keys unreadable -->
          <div *ngIf="s.state === 'revoked' || s.state === 'keys_unavailable'">
            <div class="bg-red-50 border border-red-200 rounded p-3 text-sm text-red-900 mb-3">
              <ng-container *ngIf="s.state === 'revoked'">This computer is no longer paired: another computer was paired for <span class="font-mono">{{ s.hfrId }}</span>, or NalamDesk revoked it.</ng-container>
              <ng-container *ngIf="s.state === 'keys_unavailable'">{{ s.message }}</ng-container>
            </div>
            <button *ngIf="isAdmin; else adminOnly" type="button" class="btn btn-outline btn-sm" [disabled]="busy" (click)="forget()">Start over</button>
          </div>
        </ng-container>
      </ng-container>

      <ng-template #adminOnly><p class="text-sm text-gray-500">Only an admin can change cloud pairing.</p></ng-template>
    </div>
  `
})
export class CloudLinkComponent implements OnInit, OnDestroy {
    @Input() isAdmin = false;

    status: CloudStatus | null = null;
    hfrId = '';
    label = '';
    code = '';
    busy = false;
    checking = false;
    error = '';
    showListingForm = false;
    listing = { name: '', city: '', specialty: '' };
    private unsubscribe: () => void = () => undefined;

    constructor(private cloud: CloudService, private ngZone: NgZone) { }

    async ngOnInit() {
        this.unsubscribe = this.cloud.onPairingChanged((status) => this.ngZone.run(() => { void this.refresh(); }));
        await this.refresh();
    }

    ngOnDestroy() {
        this.unsubscribe();
    }

    async refresh() {
        try {
            const status = await this.cloud.getStatus();
            this.ngZone.run(() => { this.status = status; });
        } catch (e) {
            this.ngZone.run(() => { this.error = messageOf(e); });
        }
    }

    request() {
        return this.run(() => this.cloud.requestPairing(this.hfrId.trim().toUpperCase(), this.label.trim()));
    }

    async activate() {
        await this.run(() => this.cloud.activatePairing(this.code));
        if (!this.error) this.code = '';
    }

    cancel() {
        return this.run(() => this.cloud.cancelPairing());
    }

    forget() {
        return this.run(() => this.cloud.forgetPairing());
    }

    /** Fetches the cloud mailbox now (the same as Refresh on Online Booking). */
    async checkNow() {
        this.checking = true;
        this.error = '';
        try {
            await this.cloud.syncNow();
        } catch (e) {
            this.ngZone.run(() => { this.error = messageOf(e); });
        } finally {
            this.ngZone.run(() => { this.checking = false; });
            await this.refresh();
        }
    }

    async toggleListing(event: Event) {
        const input = event.target as HTMLInputElement;
        if (input.checked) {
            input.checked = false;
            this.showListingForm = true;
            return;
        }
        await this.run(() => this.cloud.disableListing());
    }

    async enableListing() {
        await this.run(() => this.cloud.enableListing({
            name: this.listing.name.trim(),
            city: this.listing.city.trim(),
            specialty: this.listing.specialty.trim() || undefined
        }));
        if (!this.error) this.showListingForm = false;
    }

    private async run(action: () => Promise<CloudStatus>) {
        this.busy = true;
        this.error = '';
        try {
            const status = await action();
            this.ngZone.run(() => { this.status = status; });
        } catch (e) {
            this.ngZone.run(() => { this.error = messageOf(e); });
            await this.refresh();
        } finally {
            this.ngZone.run(() => { this.busy = false; });
        }
    }
}

/** Main's errors arrive as "Error invoking remote method 'x': Error: <message>". */
export function messageOf(e: unknown): string {
    const raw = String((e as any)?.message || e || 'Something went wrong.');
    return raw.replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '');
}
