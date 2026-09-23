import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterModule } from '@angular/router';
import { AuthService } from '../services/auth.service';
import { DialogService } from '../shared/services/dialog.service';
import { ToastService } from '../shared/services/toast.service';

/**
 * Self-service login-password change for every authenticated role.
 * Lives outside /settings (admin-only) so doctors, nurses, and
 * receptionists keep the password operation the IPC layer supports.
 */
@Component({
  selector: 'app-profile',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule],
  template: `
    <div class="h-full bg-gray-100 p-4 md:p-8 flex flex-col overflow-hidden">
      <div class="w-full max-w-xl">
        <h1 class="text-2xl font-bold text-gray-800">My Profile</h1>
        <p class="text-sm text-gray-500 mb-4">Signed in as {{ userName }}</p>
        <div class="bg-white rounded-lg border border-gray-200 shadow-sm p-4 md:p-6">
          <h2 class="text-lg font-bold text-gray-800 mb-4">Change login password</h2>
          <div class="form-control mb-3">
            <label class="label" for="profile-current"><span class="label-text font-semibold">Current password</span></label>
            <input id="profile-current" type="password" [(ngModel)]="currentPassword" autocomplete="current-password"
                   class="input input-bordered w-full" />
          </div>
          <div class="form-control mb-3">
            <label class="label" for="profile-new"><span class="label-text font-semibold">New password (min 6 characters)</span></label>
            <input id="profile-new" type="password" [(ngModel)]="newPassword" autocomplete="new-password"
                   class="input input-bordered w-full" />
          </div>
          <div class="form-control mb-4">
            <label class="label" for="profile-confirm"><span class="label-text font-semibold">Confirm new password</span></label>
            <input id="profile-confirm" type="password" [(ngModel)]="confirmPassword" autocomplete="new-password"
                   class="input input-bordered w-full" />
          </div>
          <p *ngIf="formError" class="text-sm text-red-600 mb-3">{{ formError }}</p>
          <div class="flex justify-end gap-2">
            <button (click)="goBack()" class="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded border bg-white transition-colors">Cancel</button>
            <button (click)="changePassword()" [disabled]="saving" class="px-6 py-2 bg-blue-600 text-white font-medium rounded hover:bg-blue-700 disabled:opacity-50 transition-colors">
              {{ saving ? 'Saving...' : 'Change password' }}
            </button>
          </div>
        </div>
      </div>
    </div>
  `
})
export class ProfileComponent {
  currentPassword = '';
  newPassword = '';
  confirmPassword = '';
  formError = '';
  saving = false;

  constructor(
    private authService: AuthService,
    private router: Router,
    private dialogService?: DialogService,
    private toastService?: ToastService
  ) { }

  get userName(): string {
    try {
      return this.authService?.getUser()?.name || this.authService?.getUser()?.username || '';
    } catch {
      return '';
    }
  }

  goBack(): void {
    void this.router.navigate(['/dashboard']);
  }

  async changePassword(): Promise<void> {
    this.formError = '';
    if (!this.currentPassword || this.newPassword.length < 6) {
      this.formError = 'Enter the current password and a new password of at least 6 characters.';
      return;
    }
    if (this.newPassword !== this.confirmPassword) {
      this.formError = 'The new passwords do not match.';
      return;
    }
    this.saving = true;
    try {
      const result = await this.authService.changeLoginPassword(this.currentPassword, this.newPassword);
      if (result?.success) {
        this.currentPassword = '';
        this.newPassword = '';
        this.confirmPassword = '';
        this.toastService?.success('Use it the next time you sign in.', 'Password changed');
      } else {
        await this.dialogService?.open({
          title: 'Change failed',
          message: result?.error || 'Failed to change login password',
          type: 'error'
        });
      }
    } catch (e: any) {
      await this.dialogService?.open({
        title: 'Change failed',
        message: e?.message || 'Failed to change login password',
        type: 'error'
      });
    } finally {
      this.saving = false;
    }
  }
}
