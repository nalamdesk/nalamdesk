import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterOutlet } from '@angular/router';
import { ThemeService } from './services/theme.service';
import { DialogService } from './shared/services/dialog.service';
import { ToastService } from './shared/services/toast.service';

import { UniversalDialogComponent } from './shared/components/universal-dialog/universal-dialog.component';
import { UpdatePromptComponent } from './shared/components/update-prompt/update-prompt.component';

import { BackupSetupComponent } from './setup/backup-setup.component';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, RouterOutlet, UniversalDialogComponent, BackupSetupComponent, UpdatePromptComponent],
  template: `
    <router-outlet></router-outlet>
    <app-universal-dialog
      [isOpen]="dialogService.isOpen()"
      [title]="dialogService.options().title"
      [message]="dialogService.options().message"
      [icon]="dialogService.options().icon ?? true"
      [type]="dialogService.options().type ?? 'info'"
      (confirmDialog)="dialogService.confirm()"
      (cancelDialog)="dialogService.close()"
      (isOpenChange)="!$event ? dialogService.close() : null">

      <div actions #actions class="flex gap-2 w-full justify-end">
         <button *ngIf="dialogService.options().type === 'confirm'"
                 class="px-4 py-2 rounded text-blue-600 border border-blue-200 hover:bg-blue-50 transition" (click)="dialogService.close()">
           {{ dialogService.options().cancelText }}
         </button>
         <button class="px-4 py-2 rounded bg-blue-600 text-white hover:bg-blue-700 font-medium transition shadow-sm" (click)="dialogService.confirm()">
           {{ dialogService.options().confirmText }}
         </button>
      </div>
    </app-universal-dialog>

    <!-- Toasts: fire-and-forget confirmations, available on every route -->
    <div *ngIf="toastService.toasts().length > 0" class="fixed bottom-4 right-4 z-[200] flex flex-col gap-2 w-80 max-w-[calc(100vw-2rem)]" role="status" aria-live="polite">
      <div *ngFor="let t of toastService.toasts()"
           class="alert shadow-lg border text-sm py-2.5"
           [ngClass]="t.type === 'success' ? 'alert-success' : t.type === 'error' ? 'alert-error' : t.type === 'warning' ? 'alert-warning' : 'alert-info'">
        <div class="min-w-0 flex-1">
          <div *ngIf="t.title" class="font-bold">{{ t.title }}</div>
          <div class="truncate">{{ t.message }}</div>
        </div>
        <button (click)="toastService.dismiss(t.id)" class="btn btn-ghost btn-xs shrink-0" aria-label="Dismiss notification">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="w-4 h-4"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
        </button>
      </div>
    </div>

    <app-backup-setup></app-backup-setup>
    <app-update-prompt></app-update-prompt>
  `
})
export class AppComponent {
  // Inject ThemeService so it runs at app startup (sets `data-theme`).
  // Without this, DaisyUI theme tokens can look inconsistent depending on environment defaults.
  constructor(
    private _themeService: ThemeService,
    public dialogService: DialogService,
    public toastService: ToastService
  ) { }
}
