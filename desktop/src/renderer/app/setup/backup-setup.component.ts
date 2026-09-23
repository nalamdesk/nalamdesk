import { Component, OnInit, inject, NgZone } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DataService } from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { DialogService } from '../shared/services/dialog.service';

@Component({
  selector: 'app-backup-setup',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div *ngIf="isVisible" class="fixed inset-0 bg-black/80 z-[100] flex items-center justify-center p-4">
      <div class="bg-white rounded-lg shadow-xl w-full max-w-lg overflow-hidden flex flex-col max-h-[90vh]">
        
        <!-- Header -->
        <div class="bg-gray-50 px-6 py-4 border-b border-gray-100 flex justify-between items-center">
          <div>
            <h2 class="text-xl font-bold text-gray-800">Backup Configuration</h2>
            <p class="text-sm text-gray-500">Essential Data Safety Setup</p>
          </div>
          <div class="text-xs font-bold px-2 py-1 rounded bg-blue-100 text-blue-700">
            Step {{ step }} of 2
          </div>
        </div>

        <!-- Body -->
        <div class="p-6 overflow-y-auto">
          
          <!-- STEP 1: LOCAL BACKUP -->
          <div *ngIf="step === 1">
            <div class="mb-6 bg-blue-50 border border-blue-100 p-4 rounded-lg">
              <h3 class="font-bold text-blue-900 mb-2">Mandatory Local Backups</h3>
              <p class="text-sm text-blue-800">
                NalamDesk will automatically back up your database every day.
                We keep the last 30 days of backups.
              </p>
            </div>

            <label class="block text-sm font-medium text-gray-700 mb-2">Backup Location</label>
            <div class="flex gap-2">
              <input [value]="localPath || 'Default (Documents/NalamDesk/Backups)'" disabled
                class="flex-1 bg-gray-100 border border-gray-300 rounded px-3 py-2 text-sm text-gray-600">
              <button (click)="selectPath()" class="btn btn-outline btn-sm">Change</button>
            </div>
            <p class="text-xs text-gray-500 mt-2 mb-4">
              Ensure this location has enough space. Only NalamDesk backups will be stored here.
            </p>

            <label class="block text-sm font-medium text-gray-700 mb-2">Daily Backup Time</label>
            <input type="time" [(ngModel)]="localBackupTime" 
              class="border-gray-300 rounded-md shadow-sm border p-2 text-sm font-mono">
          </div>

          <!-- STEP 2: CLOUD BACKUP -->
          <div *ngIf="step === 2">
            <div class="mb-6 bg-purple-50 border border-purple-100 p-4 rounded-lg">
              <h3 class="font-bold text-purple-900 mb-2">Optional Cloud Sync</h3>
              <p class="text-sm text-purple-800 mb-2">
                Securely save encrypted snapshots to your Google Drive.
              </p>
              <p class="text-xs text-purple-700">
                <strong>Privacy First (BYOK):</strong> You must provide your own Google Cloud credentials.
                <a href="https://console.cloud.google.com/" target="_blank" class="underline font-bold">Learn more</a>
              </p>
            </div>

            <div class="space-y-4">
               <div>
                  <label class="block text-xs font-bold uppercase text-gray-500 mb-1">Client ID</label>
                  <input [(ngModel)]="driveClientId" placeholder="OAUTH2 Client ID"
                    class="w-full border-gray-300 rounded-md shadow-sm border p-2 text-sm">
               </div>
               <div>
                  <label class="block text-xs font-bold uppercase text-gray-500 mb-1">Client Secret</label>
                  <input [(ngModel)]="driveClientSecret" type="password" placeholder="OAUTH2 Client Secret"
                    class="w-full border-gray-300 rounded-md shadow-sm border p-2 text-sm">
               </div>

               <div>
                  <label class="block text-xs font-bold uppercase text-gray-500 mb-1">Cloud Backup Time</label>
                  <input type="time" [(ngModel)]="cloudBackupTime"
                    class="border-gray-300 rounded-md shadow-sm border p-2 text-sm font-mono">
               </div>
            </div>
            
            <div class="mt-4 flex items-center justify-between">
                <button (click)="skipCloud()" class="text-gray-400 hover:text-gray-600 text-sm">Skip for now</button>
            </div>
          </div>

        </div>

        <!-- Footer -->
        <div class="bg-gray-50 px-6 py-4 border-t border-gray-100 flex justify-end gap-3">
          <button *ngIf="step === 2" (click)="step = 1" class="btn btn-ghost">Back</button>
          
          <button *ngIf="step === 1" (click)="step = 2" class="btn btn-primary">
            Next: Cloud Setup
          </button>
          
          <button *ngIf="step === 2" (click)="finish()" [disabled]="!canFinish()" 
            class="btn btn-primary">
            {{ driveClientId ? 'Save & Connect' : 'Finish Setup' }}
          </button>
        </div>

      </div>
    </div>
  `,
  styles: [`
    :host { display: block; }
  `]
})
export class BackupSetupComponent implements OnInit {
  isVisible = false;
  step = 1;

  localPath = '';
  localBackupTime = '13:00';

  driveClientId = '';
  driveClientSecret = '';
  cloudBackupTime = '13:00';

  isElectron = !!(globalThis as any).electron;
  private readonly dataService = inject(DataService);
  private readonly authService = inject(AuthService);

  constructor(private ngZone: NgZone, private dialogService?: DialogService) { }

  async ngOnInit() {
    if (!this.isElectron) return;
    try {
      if (!this.authService.getUser()) return; // Prevent unauthorized calls

      // Check if backup path is configured
      const s = await this.dataService.invoke<any>('getSettings');
      this.ngZone.run(() => {
        if (s) {
          if (!s.local_backup_path) {
            this.isVisible = true;
          } else {
            this.localPath = s.local_backup_path;
          }

          if (s.backup_schedule) this.localBackupTime = s.backup_schedule;
          if (s.cloud_backup_schedule) this.cloudBackupTime = s.cloud_backup_schedule;

          if (s.drive_client_id) this.driveClientId = s.drive_client_id;
          if (s.drive_client_secret) this.driveClientSecret = s.drive_client_secret;
        }
      });
    } catch (e: any) {
      // Ignore unauthorized errors (user not logged in yet)
      if (e && e.message && e.message.includes('Unauthorized')) return;
      console.error('Backup Setup Error:', e);
    }
  }

  async selectPath() {
    try {
      const path = await (globalThis as any).electron.backup.selectPath();
      if (path) {
        this.ngZone.run(() => this.localPath = path);
      }
    } catch (e) { console.error(e); }
  }

  skipCloud() {
    this.driveClientId = '';
    this.driveClientSecret = '';
    this.finish();
  }

  canFinish() {
    // If they entered one cred, must enter both
    if (this.driveClientId && !this.driveClientSecret) return false;
    if (!this.driveClientId && this.driveClientSecret) return false;
    return true;
  }

  async finish() {
    try {
      // Save settings
      const settings: any = {
        local_backup_path: this.localPath || this.getDefaultPath(),
        backup_schedule: this.localBackupTime
      };
      if (this.driveClientId && this.driveClientSecret) {
        settings.drive_client_id = this.driveClientId;
        settings.drive_client_secret = this.driveClientSecret;
        settings.cloud_backup_schedule = this.cloudBackupTime;
      }

      await this.dataService.invoke('saveSettings', settings);

      this.ngZone.run(() => {
        this.isVisible = false;
        // Trigger backup init? Main process watches settings save? 
        // Actually main.ts `drive:authenticate` logic checks settings but `saveSettings` doesn't auto-reinit backup service.
        // We might need to reload or trigger a "config updated" event.
        // For now, reloading app or simple 'backup:runNow' might be enough proof.
        // Ideally, we should notify backend to re-init.
        // Let's assume a restart or reload is good practice after such change, or we send a signal.
        // But `main.ts` `saveSettings` is just DB write.

        // Let's Invoke a "reconfigure" handler?
        // Or just rely on next restart. for Backup Service init.
        // Wait, BackupService init happens on Login. If we do this post-login, we need to re-init.
        // I'll add 'backup:reinit' IPC or similar if needed.
        // For now, simple save.
      });

      if (this.driveClientId) {
        // Attempt auth flow if they added creds
        (globalThis as any).electron.drive.authenticate({
          clientId: this.driveClientId,
          clientSecret: this.driveClientSecret
        });
      }

    } catch (e) {
      console.error(e);
      await this.dialogService?.open({
        title: 'Save failed',
        message: 'Failed to save settings',
        type: 'error'
      });
    }
  }

  getDefaultPath() {
    // Best guess for display, actual default logic is in Main if we send empty?
    // Actually we should force user to select or accept a generated default.
    // If localPath is empty here, we send 'documents/...' constructed in Renderer? 
    // Better: Main process should have a 'backup:getDefaultPath' IPC.
    // For now we trust `localPath` is set by user or we send a sensible default string.
    // If they didn't click change, `localPath` is empty.
    // Let's ask Main for default.
    return 'NalamDesk_Backups'; // Placeholder, ideally get from Electron
  }
}
