import { Component, OnInit, NgZone } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../services/auth.service';
import { DialogService } from '../shared/services/dialog.service';
import { ToastService } from '../shared/services/toast.service';
import { jsPDF } from 'jspdf';

@Component({
  selector: 'app-setup',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="min-h-screen flex items-center justify-center bg-gray-900 text-white p-6">
      <div class="bg-gray-800 rounded-lg shadow-2xl w-full max-w-2xl border border-gray-700 overflow-hidden">
        
        <!-- Header -->
        <div class="bg-gray-800 p-6 border-b border-gray-700">
          <h2 class="text-2xl font-bold text-blue-400">NalamDesk Setup</h2>
          <div class="flex flex-wrap mt-4 items-center gap-x-2 gap-y-1 text-sm text-gray-400">
            <div [class.text-blue-500]="step >= 1" [class.font-bold]="step === 1">1. Welcome</div>
            <div>&rsaquo;</div>
            <div [class.text-blue-500]="step >= 2" [class.font-bold]="step === 2">2. Secure Vault</div>
            <div>&rsaquo;</div>
            <div [class.text-blue-500]="step >= 3" [class.font-bold]="step === 3">3. Clinic Info</div>
             <div>&rsaquo;</div>
            <div [class.text-blue-500]="step >= 4" [class.font-bold]="step === 4">4. Recovery</div>
          </div>
        </div>

        <!-- Body -->
        <div class="p-8">
          
          <!-- Step 1: Welcome / Recvoery -->
          <div *ngIf="step === 1">
            <div *ngIf="hasBackups && !showCloudRestore; else freshSetup">
                <div class="bg-blue-900/30 border border-blue-700 p-4 rounded mb-6">
                    <h3 class="text-xl font-bold text-blue-400 flex items-center gap-2">
                        <svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                           <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                        </svg>
                        Recovery Available
                    </h3>
                    <p class="text-gray-300 mt-2 text-sm">
                        We detected existing backups on this computer. You can restore your data or start fresh.
                    </p>
                </div>

                <div class="mb-4">
                    <button (click)="selectExternalBackup()"
                        class="mb-4 px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded text-white text-sm">
                        Choose Backup File…
                    </button>
                    <label for="restore-recovery-code" class="block text-gray-300 text-sm mb-1">Recovery Code</label>
                    <input id="restore-recovery-code" type="password" [(ngModel)]="restoreRecoveryCode" autocomplete="off"
                        placeholder="Required to validate and restore the encrypted vault"
                        class="w-full bg-gray-700 border border-gray-600 rounded px-3 py-2 text-white">
                    <p *ngIf="restoreError" aria-live="polite" class="text-red-400 text-sm mt-2">{{restoreError}}</p>
                </div>

                <div class="space-y-3 mb-8 max-h-60 overflow-y-auto pr-2">
                    <div *ngFor="let b of localBackups" class="flex items-center justify-between p-3 bg-gray-700 rounded border border-gray-600 hover:bg-gray-650 transition-colors">
                        <div>
                            <div class="font-medium text-white text-sm">{{b.name}}</div>
                            <div class="text-xs text-gray-400">{{b.createdTime | date:'medium'}} &bull; {{ (b.size / 1024 / 1024) | number:'1.1-2' }} MB</div>
                            <div *ngIf="b.warning" class="text-xs text-amber-400 mt-1">{{b.warning}}</div>
                        </div>
                        <button (click)="restoreLocal(b.path)" 
                            [disabled]="isRestoring || !restoreRecoveryCode || !b.recoverable"
                            class="px-3 py-1 bg-green-600 hover:bg-green-700 text-white text-xs rounded font-medium disabled:opacity-50">
                            {{ isRestoring ? 'Restoring...' : 'Restore' }}
                        </button>
                    </div>
                </div>
                
                <div class="flex justify-between items-center border-t border-gray-700 pt-4">
                    <button (click)="hasBackups = false" class="text-gray-400 hover:text-white text-sm">
                        Ignore & Start Fresh
                    </button>
                    <!-- <button (click)="showCloudRestore = true" class="text-blue-400 hover:text-blue-300 text-sm">
                        Recover from Cloud?
                    </button> -->
                </div>
            </div>

            <ng-template #freshSetup>
                <h3 class="text-xl font-semibold mb-4 text-white">Welcome to NalamDesk!</h3>
                <p class="text-gray-300 mb-4">
                Thank you for choosing NalamDesk for your practice.
                </p>
                <p class="text-gray-300 mb-6">
                This setup wizard will help you:
                </p>
                <ul class="list-disc list-inside text-gray-400 mb-8 space-y-2">
                <li>Create the administrator login and a device-protected local vault.</li>
                <li>Configure your Clinic details.</li>
                <li>Generate a Recovery Code for restoring the encrypted vault on a new device.</li>
                </ul>
                <div class="flex gap-3">
                  <button (click)="step = 2" class="px-6 py-2 bg-blue-600 hover:bg-blue-700 rounded text-white font-medium">
                    Get Started
                  </button>
                  <button (click)="selectExternalBackup()" class="px-6 py-2 bg-gray-700 hover:bg-gray-600 border border-gray-600 rounded text-white font-medium">
                    Restore Backup File…
                  </button>
                </div>
            </ng-template>
          </div>

          <!-- Step 2: Administrator password -->
          <div *ngIf="step === 2">
            <h3 class="text-xl font-semibold mb-4 text-white">Create Administrator Password</h3>
            <div class="bg-yellow-900/30 border border-yellow-700 text-yellow-200 p-4 rounded mb-6 text-sm">
              <span class="font-bold">IMPORTANT:</span> This password signs in the administrator.
              The local vault is protected by this device, and recovery uses the separate Recovery Code generated in Step 4.
            </div>

            <div class="space-y-4">
              <div>
                <label class="block text-gray-400 text-sm mb-1">Administrator Password</label>
                <input type="password" [(ngModel)]="password" class="w-full bg-gray-700 border border-gray-600 rounded px-3 py-2 text-white">
              </div>
              <div>
                <label class="block text-gray-400 text-sm mb-1">Confirm Password</label>
                <input type="password" [(ngModel)]="confirmPassword" class="w-full bg-gray-700 border border-gray-600 rounded px-3 py-2 text-white">
              </div>
            </div>
            
            <div class="mt-8 flex justify-between">
              <button (click)="step = 1" class="text-gray-400 hover:text-white">Back</button>
              <button 
                (click)="step = 3" 
                [disabled]="!password || password !== confirmPassword || password.length < 6"
                class="px-6 py-2 bg-blue-600 hover:bg-blue-700 rounded text-white font-medium disabled:opacity-50 disabled:cursor-not-allowed">
                Next
              </button>
            </div>
          </div>

          <!-- Step 3: Clinic Details -->
          <div *ngIf="step === 3">
            <h3 class="text-xl font-semibold mb-4 text-white">Clinic Details</h3>
            
            <div class="space-y-4">
              <div>
                <label class="block text-gray-400 text-sm mb-1">Clinic Name</label>
                <input type="text" [(ngModel)]="clinicName" class="w-full bg-gray-700 border border-gray-600 rounded px-3 py-2 text-white">
              </div>
              <div>
                <label class="block text-gray-400 text-sm mb-1">Doctor Name</label>
                <input type="text" [(ngModel)]="doctorName" class="w-full bg-gray-700 border border-gray-600 rounded px-3 py-2 text-white">
              </div>
              <div>
                <span class="block text-gray-400 text-sm mb-1">Practice standards</span>
                <div class="grid grid-cols-2 gap-2">
                  <button type="button" (click)="standardsMode = 'india_abdm'"
                          [class.ring-2]="standardsMode === 'india_abdm'"
                          class="text-left bg-gray-700 border border-gray-600 rounded px-3 py-2 ring-blue-500">
                    <span class="block text-white text-sm font-medium">India · ABDM</span>
                    <span class="block text-gray-400 text-xs mt-0.5">1-0-1 · °F · ABHA first</span>
                  </button>
                  <button type="button" (click)="standardsMode = 'international'"
                          [class.ring-2]="standardsMode === 'international'"
                          class="text-left bg-gray-700 border border-gray-600 rounded px-3 py-2 ring-blue-500">
                    <span class="block text-white text-sm font-medium">International</span>
                    <span class="block text-gray-400 text-xs mt-0.5">BID · °C · MRN first</span>
                  </button>
                </div>
                <p class="text-gray-500 text-xs mt-1">Display and export lens only. Records stay canonical; changeable later in Settings.</p>
              </div>
            </div>

            <div class="mt-8 flex justify-between">
              <button (click)="step = 2" class="text-gray-400 hover:text-white">Back</button>
              <button 
                (click)="finishSetup()" 
                [disabled]="!clinicName || !doctorName || isSubmitting"
                class="px-6 py-2 bg-blue-600 hover:bg-blue-700 rounded text-white font-medium disabled:opacity-50 disabled:cursor-not-allowed">
                {{ isSubmitting ? 'Securing Vault...' : 'Save & Secure' }}
              </button>
            </div>
          </div>

           <!-- Step 4: Recovery Code (Success) -->
          <div *ngIf="step === 4">
            <h3 class="text-xl font-semibold mb-4 text-green-400 flex items-center gap-2">
              <svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              Setup Complete!
            </h3>

            <div class="bg-gray-700 p-6 rounded-lg text-center mb-6 border border-gray-600">
               <p class="text-gray-400 text-sm mb-2">YOUR RECOVERY CODE</p>
               <div class="text-2xl font-mono text-white tracking-widest font-bold select-all bg-gray-900 p-4 rounded border border-gray-500">
                 {{ recoveryCode }}
               </div>
               <p class="text-red-400 text-xs mt-3">
                 SAVE THIS CODE! It is required to recover the encrypted vault on a new or reset device.
               </p>
            </div>

            <div class="flex gap-4 justify-center">
                 <button (click)="downloadRecoveryPDF()" class="flex items-center gap-2 px-4 py-2 bg-gray-600 hover:bg-gray-500 rounded text-white">
                    <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                    </svg>
                    Download PDF
                 </button>
                 <button (click)="goToDashboard()" class="px-6 py-2 bg-blue-600 hover:bg-blue-700 rounded text-white font-medium">
                    Go to Dashboard
                 </button>
            </div>
          </div>

        </div>
      </div>
    </div>
  `
})
export class SetupComponent implements OnInit {
  step = 1;

  password = '';
  confirmPassword = '';
  clinicName = '';
  doctorName = '';
  standardsMode: 'india_abdm' | 'international' = 'india_abdm';

  isSubmitting = false;
  recoveryCode = '';

  // Recovery State
  hasBackups = false;
  showCloudRestore = false;
  localBackups: any[] = [];
  isRestoring = false;
  restoreRecoveryCode = '';
  restoreError = '';

  constructor(private authService: AuthService, private router: Router, private ngZone: NgZone, private dialogService?: DialogService, private toastService?: ToastService) { }

  ngOnInit() {
    this.checkRecovery();
  }

  async checkRecovery() {
    // Only electron has recovery capability
    if ((globalThis as any).electron) {
      try {
        const status = await (window as any).electron.getRecoveryStatus();
        this.ngZone.run(() => {
          if (status.hasBackups && !status.isSetup) {
            this.hasBackups = true;
            this.localBackups = status.backups || [];
          }
        });
      } catch (e) {
        console.error('Failed to check recovery status', e);
      }
    }
  }

  async restoreLocal(path: string) {
    if (!this.restoreRecoveryCode) {
      this.restoreError = 'Enter the Recovery Code for this backup.';
      return;
    }
    const confirmed = await this.dialogService?.open({
      title: 'Restore this backup?',
      message: 'The backup will be validated first. The current vault will be snapshotted before replacement.',
      type: 'confirm',
      confirmText: 'Restore',
      cancelText: 'Cancel'
    });
    if (!confirmed) return;

    this.isRestoring = true;
    this.restoreError = '';
    try {
      const result = await window.electron.restoreSystemBackup({ path, recoveryCode: this.restoreRecoveryCode });
      this.restoreRecoveryCode = '';
      if (!result.success) throw new Error(result.error || 'Restore failed');
    } catch (e: any) {
      console.error(e);
      this.isRestoring = false;
      const code = e?.message || 'Restore failed';
      this.restoreError = code === 'LEGACY_DATABASE_ONLY_BACKUP'
        ? 'This legacy database-only backup is missing recovery metadata and cannot be restored on a clean device.'
        : code === 'INVALID_RECOVERY_CODE'
          ? 'The Recovery Code is incorrect for this backup.'
          : `Restore failed: ${code}`;
    }
  }

  async selectExternalBackup() {
    try {
      const selected = await window.electron.backup.selectRestoreBundle();
      if (!selected) return;
      const legacy = selected.name.toLowerCase().endsWith('.db');
      this.localBackups = [{
        name: selected.name,
        path: selected.path,
        createdTime: new Date(),
        size: 0,
        format: legacy ? 'legacy-database-only' : 'bundle-v1',
        recoverable: !legacy,
        warning: legacy
          ? 'Legacy database-only backup: wrapped-key metadata is missing; clean-machine recovery is unavailable.'
          : undefined
      }, ...this.localBackups.filter(item => item.path !== selected.path)];
      this.hasBackups = true;
      this.restoreError = legacy
        ? 'This legacy backup can be identified, but cannot recover a clean device.'
        : '';
    } catch (e: any) {
      this.restoreError = e?.message || 'Unable to select the backup file.';
    }
  }

  async finishSetup() {
    this.isSubmitting = true;
    try {
      const result = await this.authService.setup({
        password: this.password,
        clinicDetails: {
          clinic_name: this.clinicName,
          doctor_name: this.doctorName,
          standards_mode: this.standardsMode,
          cloud_enabled: 0
        },
        adminDetails: {}
      });

      if (result.success && result.recoveryCode) {
        this.recoveryCode = result.recoveryCode;
        this.step = 4;
      } else {
        console.error(result.error);
        await this.dialogService?.open({
          title: 'Setup failed',
          message: result.error ? `Setup Failed: ${result.error}` : 'Setup Failed',
          type: 'error'
        });
      }
    } catch (e) {
      console.error(e);
      await this.dialogService?.open({
        title: 'Setup failed',
        message: 'Setup Failed',
        type: 'error'
      });
    } finally {
      this.isSubmitting = false;
    }
  }

  downloadRecoveryPDF() {
    const doc = new jsPDF();

    doc.setFontSize(22);
    doc.setTextColor(41, 128, 185); // Blue
    doc.text("NalamDesk Recovery Code", 20, 20);

    doc.setFontSize(12);
    doc.setTextColor(50, 50, 50);
    doc.text("Keep this document safe. This code restores access to your encrypted clinic vault.", 20, 40);

    doc.setDrawColor(200, 200, 200);
    doc.setFillColor(245, 245, 245);
    doc.roundedRect(20, 50, 170, 30, 3, 3, 'FD'); // Box

    doc.setFont("courier", "bold");
    doc.setFontSize(16);
    doc.setTextColor(0, 0, 0);
    doc.text(this.recoveryCode, 105, 68, { align: "center" });

    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.setTextColor(150, 150, 150);
    doc.text("Generated on: " + new Date().toLocaleString(), 20, 90);

    doc.save("nalamdesk-recovery-code.pdf");
  }

  async goToDashboard() {
    // Setup automatically calls ensureAdminUser which sets up DB.
    // But we are not technically "logged in" via session service yet in the Renderer (AuthService).
    // We should probably auto-login or redirect to login page (but nicely).
    // Let's redirect to login for security, merging into the new flow.
    // OR, since we just made the password, we can auto-login behind the scenes.

    // Auto-login attempt
    const res = await this.authService.login('admin', this.password);
    if (res.success) {
      try {
        const acknowledgement = await this.authService.acknowledgeRecoveryCode(this.recoveryCode);
        if (acknowledgement.success) {
          this.router.navigate(['/dashboard']);
        } else {
          await this.dialogService?.open({
            title: 'Confirmation failed',
            message: 'Could not confirm the recovery code. Please try again.',
            type: 'error'
          });
        }
      } catch (error) {
        console.error(error);
        await this.dialogService?.open({
          title: 'Confirmation failed',
          message: 'Could not confirm the recovery code. Please try again.',
          type: 'error'
        });
      }
    } else {
      this.router.navigate(['/login']);
    }
  }
}
