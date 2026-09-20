import { Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DataService } from '../services/api.service';

type AbhaStep = 'lookup' | 'enroll' | 'otp' | 'card';

/**
 * Health ID (ABHA) linking modal: verify an existing address, enroll with an
 * OTP code, and show a printable card. Strictly voluntary: the modal only
 * opens from the explicit Link button and every path can be closed untouched.
 */
@Component({
    selector: 'app-abha-modal',
    standalone: true,
    imports: [CommonModule, FormsModule],
    styles: [`
        @media print {
            /* Print only the health ID card, never the dialog chrome. */
            .print-scope-abha {
                position: static !important;
                background: white !important;
                display: block !important;
                padding: 0 !important;
            }
            .print-scope-abha > div {
                box-shadow: none !important;
                max-width: 100% !important;
                border: none !important;
            }
            .print-scope-abha .no-print {
                display: none !important;
            }
        }
    `],
    template: `
    <div class="fixed inset-0 z-50 flex items-center justify-center p-4 print-scope-abha" role="dialog" aria-modal="true" aria-label="Link health ID">
      <div class="fixed inset-0 bg-black/50 no-print" (click)="close.emit()"></div>
      <div class="relative bg-white rounded-lg w-full max-w-md shadow-lg border border-gray-200 overflow-hidden">
        <div class="px-6 py-4 border-b bg-gray-50 flex justify-between items-center no-print">
          <div>
            <h3 class="text-lg font-bold text-gray-800">Health ID (ABHA)</h3>
            <p class="text-xs text-gray-500">Optional. Skipping changes nothing about this visit.</p>
          </div>
          <button (click)="close.emit()" class="text-gray-500 hover:text-gray-600" aria-label="Close">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="w-4 h-4"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
          </button>
        </div>

        <div class="p-6 space-y-4">
          <div *ngIf="mockHint" class="p-3 rounded-lg border border-blue-200 bg-blue-50 text-blue-800 text-xs no-print">
            {{ mockHint }}
          </div>

          <!-- Step 1: look up an existing address -->
          <div *ngIf="step === 'lookup'">
            <label class="block text-sm font-medium text-gray-700 mb-1">Health ID address</label>
            <input [ngModel]="address" (ngModelChange)="onAddressInput($event)" placeholder="name@abdm"
                class="w-full border p-2 rounded text-sm outline-none focus:ring-2 focus:ring-blue-500 font-mono">
            <div class="mt-3 flex gap-2">
              <button (click)="lookup()" [disabled]="busy || !address.trim()" class="btn btn-primary btn-sm flex-1">
                {{ busy ? 'Checking...' : 'Verify' }}
              </button>
              <button (click)="step = 'enroll'" class="btn btn-ghost btn-sm">New ID instead</button>
            </div>
            <div *ngIf="foundName" class="mt-4 p-3 rounded-lg border border-green-200 bg-green-50 text-sm">
              <p class="font-bold text-green-800">{{ foundName }}</p>
              <p class="text-green-700 text-xs mt-1">This health ID exists. Link it to {{ patientName || 'this patient' }}?</p>
              <button (click)="link(foundName)" [disabled]="busy" class="btn btn-primary btn-sm mt-3 w-full">Link Health ID</button>
            </div>
            <p *ngIf="lookupMiss" class="mt-3 text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-3">
              No health ID found with that address. Check the spelling, or create a new one.
            </p>
          </div>

          <!-- Step 2: enrollment details -->
          <div *ngIf="step === 'enroll'">
            <label class="block text-sm font-medium text-gray-700 mb-1">Verify with</label>
            <div class="inline-flex rounded-md shadow-sm text-xs mb-3" role="group">
              <button type="button" (click)="via = 'aadhaar'"
                      [class.bg-blue-600]="via === 'aadhaar'" [class.text-white]="via === 'aadhaar'"
                      [class.bg-gray-100]="via !== 'aadhaar'" [class.text-gray-700]="via !== 'aadhaar'"
                      class="px-3 py-1.5 rounded-l border border-gray-300 font-medium transition">Aadhaar</button>
              <button type="button" (click)="via = 'mobile'"
                      [class.bg-blue-600]="via === 'mobile'" [class.text-white]="via === 'mobile'"
                      [class.bg-gray-100]="via !== 'mobile'" [class.text-gray-700]="via !== 'mobile'"
                      class="px-3 py-1.5 rounded-r border-t border-b border-r border-gray-300 font-medium transition">Mobile</button>
            </div>
            <label class="block text-sm font-medium text-gray-700 mb-1">{{ via === 'mobile' ? 'Mobile number' : 'Aadhaar number' }}</label>
            <input [(ngModel)]="identifier" [placeholder]="via === 'mobile' ? '10-digit mobile number' : '12-digit Aadhaar number'"
                inputmode="numeric" class="w-full border p-2 rounded text-sm outline-none focus:ring-2 focus:ring-blue-500 font-mono">
            <div class="mt-3 flex gap-2">
              <button (click)="requestOtp()" [disabled]="busy || !identifier.trim()" class="btn btn-primary btn-sm flex-1">
                {{ busy ? 'Sending...' : 'Send Code' }}
              </button>
              <button (click)="step = 'lookup'" class="btn btn-ghost btn-sm">Back</button>
            </div>
          </div>

          <!-- Step 3: OTP code -->
          <div *ngIf="step === 'otp'">
            <label class="block text-sm font-medium text-gray-700 mb-1">6-digit code</label>
            <input [(ngModel)]="otp" maxlength="6" inputmode="numeric" placeholder="Enter the code sent to the patient"
                class="w-full border p-2 rounded text-sm outline-none focus:ring-2 focus:ring-blue-500 font-mono tracking-widest text-center text-lg">
            <div class="mt-3 flex gap-2">
              <button (click)="confirmOtp()" [disabled]="busy || otp.trim().length !== 6" class="btn btn-primary btn-sm flex-1">
                {{ busy ? 'Verifying...' : 'Verify & Create ID' }}
              </button>
              <button (click)="step = 'enroll'" class="btn btn-ghost btn-sm">Back</button>
            </div>
          </div>

          <!-- Step 4: printable card -->
          <div *ngIf="step === 'card' && card">
            <div class="rounded-lg border border-gray-200 bg-gray-50 p-5 text-center">
              <p class="text-xs font-bold uppercase tracking-widest text-gray-500">Health ID Card</p>
              <p class="text-xl font-bold text-gray-900 mt-2">{{ card.name || patientName }}</p>
              <p class="font-mono text-blue-700 mt-1">{{ card.abhaAddress }}</p>
              <p *ngIf="card.dateOfBirth || card.gender" class="text-xs text-gray-500 mt-2">
                {{ card.dateOfBirth || '' }}{{ card.dateOfBirth && card.gender ? ' • ' : '' }}{{ card.gender || '' }}
              </p>
              <img *ngIf="card.imageBase64" [src]="'data:' + (card.mimeType || 'image/png') + ';base64,' + card.imageBase64"
                   alt="Health ID card" class="mx-auto mt-4 max-h-48 rounded border border-gray-200">
            </div>
            <div class="mt-4 flex gap-2 no-print">
              <button *ngIf="!linkedDone" (click)="link(card.name)" [disabled]="busy" class="btn btn-primary btn-sm flex-1">Link to Patient</button>
              <button (click)="printCard()" class="btn btn-outline btn-sm flex-1">Print Card</button>
              <button (click)="close.emit()" class="btn btn-ghost btn-sm">Done</button>
            </div>
          </div>

          <p *ngIf="error" class="p-2 bg-red-100 text-red-700 rounded text-sm no-print">{{ error }}</p>
        </div>
      </div>
    </div>
  `
})
export class AbhaModalComponent {
    @Input() patientId: number | null = null;
    @Input() patientName = '';
    @Output() close = new EventEmitter<void>();
    @Output() linked = new EventEmitter<{ abhaAddress: string; abhaName: string }>();

    step: AbhaStep = 'lookup';
    busy = false;
    error = '';
    mockHint = '';
    address = '';
    verifiedAddress = '';
    foundName = '';
    lookupMiss = false;
    via: 'aadhaar' | 'mobile' = 'mobile';
    identifier = '';
    txnId = '';
    otp = '';
    linkedDone = false;
    card: { abhaAddress: string; name: string; gender?: string; dateOfBirth?: string; imageBase64?: string; mimeType?: string } | null = null;

    constructor(private dataService: DataService) { }

    async lookup(): Promise<void> {
        if (this.busy || !this.address.trim()) return;
        this.busy = true;
        this.error = '';
        this.lookupMiss = false;
        this.foundName = '';
        this.verifiedAddress = '';
        try {
            const result = await this.dataService.invoke<any>('abdmAbhaLookup', { abhaAddress: this.address.trim() });
            if (result?.exists) {
                this.foundName = result.name || '';
                this.verifiedAddress = this.address.trim();
                this.noteMock(result);
            } else {
                this.lookupMiss = true;
            }
        } catch (e) {
            this.error = e instanceof Error ? e.message : 'Verification failed.';
        } finally {
            this.busy = false;
        }
    }

    onAddressInput(next: string): void {
        this.address = next;
        // Any edit after verification voids it: the Link button must never
        // persist an address that was not the one just verified.
        if (next.trim() !== this.verifiedAddress) {
            this.verifiedAddress = '';
            this.foundName = '';
            this.lookupMiss = false;
        }
    }

    async requestOtp(): Promise<void> {
        if (this.busy || !this.identifier.trim()) return;
        this.busy = true;
        this.error = '';
        try {
            const result = await this.dataService.invoke<any>('abdmAbhaRequestOtp', {
                via: this.via,
                identifier: this.identifier.trim()
            });
            this.txnId = result?.txnId || '';
            this.otp = '';
            this.step = 'otp';
            this.noteMock(result);
        } catch (e) {
            this.error = e instanceof Error ? e.message : 'Could not send the code.';
        } finally {
            this.busy = false;
        }
    }

    async confirmOtp(): Promise<void> {
        if (this.busy || this.otp.trim().length !== 6) return;
        this.busy = true;
        this.error = '';
        try {
            const result = await this.dataService.invoke<any>('abdmAbhaConfirmOtp', {
                txnId: this.txnId,
                otp: this.otp.trim()
            });
            this.noteMock(result);
            await this.showCard(result?.abhaAddress || '', result?.name || '');
        } catch (e) {
            this.error = e instanceof Error ? e.message : 'Verification failed.';
        } finally {
            this.busy = false;
        }
    }

    async showCard(abhaAddress: string, name: string): Promise<void> {
        if (!abhaAddress) return;
        this.busy = true;
        this.error = '';
        try {
            const card = await this.dataService.invoke<any>('abdmAbhaCard', { abhaAddress });
            this.card = {
                abhaAddress,
                name: card?.name || name || '',
                gender: card?.gender,
                dateOfBirth: card?.dateOfBirth,
                imageBase64: card?.imageBase64,
                mimeType: card?.mimeType
            };
            this.noteMock(card);
            this.step = 'card';
        } catch (e) {
            this.error = e instanceof Error ? e.message : 'Could not load the card.';
        } finally {
            this.busy = false;
        }
    }

    async link(name: string): Promise<void> {
        if (this.busy || !this.patientId) return;
        const abhaAddress = this.step === 'card' && this.card
            ? this.card.abhaAddress
            : this.verifiedAddress;
        if (!abhaAddress) return;
        this.busy = true;
        this.error = '';
        try {
            await this.dataService.invoke('abdmLinkAbha', {
                patientId: this.patientId,
                abhaAddress,
                abhaName: name || ''
            });
            this.linked.emit({ abhaAddress, abhaName: name || '' });
            this.linkedDone = true;
            this.close.emit();
        } catch (e) {
            this.error = e instanceof Error ? e.message : 'Could not link the health ID.';
        } finally {
            this.busy = false;
        }
    }

    printCard(): void {
        window.print();
    }

    private noteMock(result: any): void {
        if (result?.mock && !this.mockHint) {
            this.mockHint = result?.hint || 'Mock gateway: demo data, nothing leaves this device.';
        }
    }
}
