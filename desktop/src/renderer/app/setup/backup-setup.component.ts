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
        <div class="bg-gray-50 px-6 py-4 border-b border-gray-100">
          <h2 class="text-xl font-bold text-gray-800">Backup Configuration</h2>
          <p class="text-sm text-gray-500">Essential Data Safety Setup</p>
        </div>

        <!-- Body -->
        <div class="p-6 overflow-y-auto">
          <div class="mb-6 bg-blue-50 border border-blue-100 p-4 rounded-lg">
            <h3 class="font-bold text-blue-900 mb-2">Daily encrypted backups</h3>
            <p class="text-sm text-blue-800">
              NalamDesk backs up your data on this computer every day and keeps the last 30 days.
              Restoring a backup needs your recovery code.
            </p>
          </div>

          <label class="block text-sm font-medium text-gray-700 mb-2">Daily Backup Time</label>
          <input type="time" [(ngModel)]="localBackupTime"
            class="border-gray-300 rounded-md shadow-sm border p-2 text-sm font-mono mb-6">

          <label class="block text-sm font-medium text-gray-700 mb-2">Copy each backup to a folder (recommended)</label>
          <div class="flex gap-2">
            <input [value]="localPath || 'None: backups stay on this computer only'" disabled
              class="flex-1 bg-gray-100 border border-gray-300 rounded px-3 py-2 text-sm text-gray-600">
            <button (click)="selectPath()" class="btn btn-outline btn-sm">Choose</button>
          </div>
          <p class="text-xs text-gray-500 mt-2">
            If this computer fails, a copy elsewhere saves your data. Pick your Google Drive for desktop or
            OneDrive folder, a USB disk, or a network share.
          </p>
        </div>

        <!-- Footer -->
        <div class="bg-gray-50 px-6 py-4 border-t border-gray-100 flex justify-end gap-3">
          <button (click)="finish()" class="btn btn-primary">Finish Setup</button>
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

  /** The folder each backup is also copied to; empty for none. */
  localPath = '';
  localBackupTime = '13:00';

  isElectron = !!(globalThis as any).electron;
  private readonly dataService = inject(DataService);
  private readonly authService = inject(AuthService);

  constructor(private ngZone: NgZone, private dialogService?: DialogService) { }

  async ngOnInit() {
    if (!this.isElectron) return;
    try {
      if (!this.authService.getUser()) return; // Prevent unauthorized calls

      // Shown once: until backups have been set up (the folder setting is saved).
      const s = await this.dataService.invoke<any>('getSettings');
      this.ngZone.run(() => {
        if (s) {
          if (!s.local_backup_path) this.isVisible = true;
          if (s.backup_schedule) this.localBackupTime = s.backup_schedule;
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

  async finish() {
    try {
      // Without a chosen folder, the app's own backup folder is saved: it
      // marks setup as done and means "no copy folder".
      const folder = this.localPath || await (globalThis as any).electron.backup.useDefaultPath();
      await this.dataService.invoke('saveSettings', {
        local_backup_path: folder,
        backup_schedule: this.localBackupTime
      });
      this.ngZone.run(() => this.isVisible = false);
    } catch (e) {
      console.error(e);
      await this.dialogService?.open({
        title: 'Save failed',
        message: e instanceof Error ? e.message : 'Failed to save settings',
        type: 'error'
      });
    }
  }
}
