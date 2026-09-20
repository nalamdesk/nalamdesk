import { Component, inject, NgZone, OnInit } from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DataService } from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { Router } from '@angular/router';
import { SharedTableComponent } from '../shared/components/table/table.component';
import { ActionRendererComponent } from '../shared/components/table/renderers/action-renderer.component';
import { ColDef, ValueGetterParams } from 'ag-grid-community';
import { DatePickerComponent } from '../shared/components/date-picker/date-picker.component';
import { CatalogSettingsComponent } from './catalog-settings.component';
import { AppUpdateService } from '../services/update.service';

@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [CommonModule, FormsModule, SharedTableComponent, ActionRendererComponent, DatePickerComponent, CatalogSettingsComponent],
  templateUrl: './settings.component.html',
  styles: [`
    :host { display: block; height: 100%; }
    .ng-dirty.ng-invalid { border-color: #ef4444; }
  `]
})
export class SettingsComponent implements OnInit {
  activeTab = 'users'; // users | audit
  currentUser: any = null;
  users: any[] = [];
  auditLogs: any[] = [];

  // UI State for Mobile Drawer
  isMobileMenuOpen = false;

  // Validation State
  formSubmitted = false;

  // Filter State
  staffFilter = 'all';

  appVersion = '';
  updateBusy = false;

  // General Settings
  settings = {
    clinic_name: '',
    drive_client_id: '',
    drive_client_secret: '',
    local_backup_path: '',
    backup_schedule: '13:00',
    cloud_backup_schedule: '13:00'
  };
  settingsSaved = false;
  isElectron = !!(window as any).electron;

  // ABDM gateway (separate tab; secret handled via its own IPC, never in settings)
  abdmConfig: { gateway_env: string; client_id: string; has_secret: boolean; mock: boolean; hip_id: string; counter_id: string } =
    { gateway_env: 'sandbox', client_id: '', has_secret: false, mock: true, hip_id: '', counter_id: '' };
  abdmSecret = '';
  abdmTest: { ok: boolean; mode: string; detail: string; latencyMs?: number } | null = null;
  abdmBusy = false;
  abdmSaved = false;
  qrDataUrl: string | null = null;
  abdmSimResult: string | null = null;

  // Cloud
  cloudEnabled = false;
  cloudClinicId: string | null = null;
  showCloudModal = false;
  cloudForm = { name: '', city: '' };
  cloudLoading = false;

  // Editing
  editingUser: any = null;

  // Security / Backup
  showRecoveryModal = false;
  showLoginPasswordModal = false;
  showDeviceRotationModal = false;
  showUserResetModal = false;
  confirmPassword = '';
  currentLoginPassword = '';
  newLoginPassword = '';
  confirmLoginPassword = '';
  currentDevicePassword = '';
  resetTarget: any = null;
  resetAdminPassword = '';
  resetTemporaryPassword = '';
  resetConfirmPassword = '';
  newRecoveryCode: string | null = null;
  isCopied = false;
  isLoading = false;
  isBackupLoading = false;
  message = '';
  success = false;
  backups: any[] = [];
  restoreBundle: { path: string; name: string } | null = null;
  restoreRecoveryCode = '';
  restoreAdminPassword = '';
  restoreError = '';
  isRestoring = false;


  // Audit Log Column Definitions
  auditColumnDefs: ColDef[] = [
    {
      headerName: 'Time',
      field: 'timestamp',
      flex: 1,
      minWidth: 160,
      valueFormatter: (params: any) => {
        if (!params.value) return '-';
        return new DatePipe('en-US').transform(params.value, 'short') || '-';
      }
    },
    {
      headerName: 'Action By',
      field: 'actor_name', // Joined from users table
      flex: 1,
      minWidth: 150,
      cellRenderer: (params: any) => {
        return params.value ? `<span class="font-medium text-gray-700">${params.value}</span>` : '<span class="text-gray-400 italic">Unknown</span>';
      }
    },
    {
      headerName: 'Action',
      field: 'action',
      flex: 1,
      minWidth: 150,
      cellRenderer: (params: any) => {
        const action = params.value || '';
        let colorClass = 'text-gray-600';
        if (action.includes('UPDATE')) colorClass = 'text-blue-600';
        if (action.includes('INSERT') || action.includes('CREATE')) colorClass = 'text-green-600';
        if (action.includes('DELETE')) colorClass = 'text-red-600';
        return `<span class="font-medium ${colorClass}">${action}</span>`;
      }
    },
    { headerName: 'Table', field: 'table_name', flex: 1, minWidth: 160 },
    { headerName: 'Record ID', field: 'record_id', flex: 1, minWidth: 150, cellClass: 'font-mono text-xs text-gray-500' },
    { headerName: 'Details', field: 'details', flex: 2, minWidth: 250, wrapText: true, autoHeight: true }
  ];

  // User Column Definitions
  userColumnDefs: ColDef[] = [
    {
      headerName: 'Employee',
      field: 'name',
      flex: 1.5,
      minWidth: 220,
      cellRenderer: (params: any) => {
        const u = params.data;
        if (!u) return '';
        const initial = u.name ? u.name.charAt(0).toUpperCase() : '?';
        const colorClass = u.role === 'admin' ? 'bg-purple-100 text-purple-600' : 'bg-blue-100 text-blue-600';
        const isMe = params.data.id === this.currentUser?.id ? '<span class="px-1.5 py-0.5 rounded text-[10px] bg-green-100 text-green-700 font-medium ml-1">YOU</span>' : '';

        return `
          <div class="flex items-center gap-3">
             <div class="w-8 h-8 rounded-full ${colorClass} flex items-center justify-center font-bold text-xs ring-2 ring-white shadow-sm">
                ${initial}
             </div>
             <div class="flex flex-col">
                 <span class="font-semibold text-gray-900 leading-tight">${u.name}</span>
                 <div class="text-[10px] text-gray-400 leading-tight">@${u.username} ${isMe}</div>
             </div>
          </div>
        `;
      }
    },
    {
      headerName: 'Role',
      field: 'role',
      flex: 1,
      minWidth: 150,
      cellClass: 'flex items-center',
      cellRenderer: (params: any) => {
        if (!params.value) return '-';
        const role = params.value.toUpperCase();
        let badgeClass = 'bg-gray-100 text-gray-800';
        if (role === 'ADMIN') badgeClass = 'bg-purple-100 text-purple-800';
        if (role === 'DOCTOR') badgeClass = 'bg-green-100 text-green-800';
        if (role === 'NURSE') badgeClass = 'bg-yellow-100 text-yellow-800';
        if (role === 'RECEPTIONIST') badgeClass = 'bg-blue-100 text-blue-800';

        const designation = params.data.designation ? `<span class="text-[10px] text-gray-400 ml-2">${params.data.designation}</span>` : '';

        return `
            <div class="flex items-center">
                <span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${badgeClass}">
                  ${role}
                </span>
                ${designation}
            </div>
          `;
      }
    },
    {
      headerName: 'Contact',
      field: 'contact',
      flex: 1.5,
      minWidth: 180,
      valueGetter: (params: ValueGetterParams) => {
        const u = params.data;
        if (!u) return '';
        return u.mobile || u.email || 'No contact info';
      },
      cellRenderer: (params: any) => {
        const u = params.data;
        if (!u) return '';
        let html = '<div class="flex flex-col justify-center h-full text-xs text-gray-600">';
        if (u.mobile) html += `<div>📱 ${u.mobile}</div>`;
        if (u.email) html += `<div>✉️ ${u.email}</div>`;
        if (!u.mobile && !u.email) html += `<div class="text-gray-400 italic">No contact info</div>`;
        html += '</div>';
        return html;
      }
    },
    {
      headerName: 'DOB',
      field: 'dob',
      flex: 1,
      minWidth: 130,
      valueFormatter: (params: any) => {
        if (!params.value) return '-';
        return new DatePipe('en-US').transform(params.value, 'mediumDate') || '-';
      }
    },
    {
      headerName: 'Joined',
      field: 'joining_date',
      flex: 1,
      minWidth: 130,
      valueFormatter: (params: any) => {
        if (!params.value) return '-';
        return new DatePipe('en-US').transform(params.value, 'mediumDate') || '-';
      }
    },
    {
      headerName: 'Actions',
      flex: 1,
      minWidth: 120,
      cellRenderer: ActionRendererComponent,
      cellRendererParams: {
        onEdit: (data: any) => this.editUser(data),
        onDelete: (data: any) => this.deleteUser(data.id),
        canDelete: (data: any) => data.username !== 'admin'
      }
    }
  ];

  // Table State
  searchTerm = '';
  pageSize = 20;
  filteredUsers: any[] = [];

  setFilter(role: string) {
    this.staffFilter = role.toLowerCase();
    this.applyFilter();
  }

  applyFilter() {
    if (this.staffFilter !== 'all') {
      this.filteredUsers = this.users.filter(u => u.role && u.role.toLowerCase() === this.staffFilter);
    } else {
      this.filteredUsers = [...this.users];
    }
  }

  // Navigation Helper
  switchTab(tab: string) {
    this.activeTab = tab;
    this.isMobileMenuOpen = false;

    // Additional logic if needed per tab
    if (tab === 'audit') {
      this.loadAuditLogs();
    }
    if (tab === 'abdm') {
      this.loadAbdmConfig();
    }
  }

  private dataService = inject(DataService);
  private authService = inject(AuthService);
  private router = inject(Router);
  private updates = inject(AppUpdateService, { optional: true });
  constructor(private ngZone: NgZone) { }

  ngOnInit() {
    this.currentUser = this.authService.getUser();
    this.loadSettings();
    this.loadAppVersion();
    if (this.isElectron) {
      this.listBackups();
      this.checkDriveStatus();
      this.loadCloudStatus();
    }
    if (this.currentUser?.role === 'admin') {
      this.loadUsers();
    }
  }

  async loadAppVersion() {
    if (!this.isElectron) return;
    try {
      const info = await window.electron.getAppVersion();
      this.ngZone.run(() => {
        this.appVersion = info?.display || info?.version || '';
      });
    } catch (e) {
      console.error('[Settings] Failed to load packaged app version', e);
    }
  }

  async checkForUpdates(): Promise<void> {
    if (!this.isElectron || this.updateBusy) return;
    this.updateBusy = true;
    try {
      if (this.updates) {
        await this.updates.check('manual');
        return;
      }
      await window.electron.updates.check({ source: 'manual' });
    } catch (e) {
      console.error('[Settings] Update check failed', e);
    } finally {
      this.updateBusy = false;
    }
  }

  async loadSettings() {
    try {
      const s = await this.dataService.invoke<any>('getSettings');
      this.ngZone.run(() => {
        if (s) {
          this.settings.clinic_name = s.clinic_name || '';
          this.settings.drive_client_id = s.drive_client_id || '';
          this.settings.drive_client_secret = s.drive_client_secret || '';
          this.settings.local_backup_path = s.local_backup_path || '';
          this.settings.backup_schedule = s.backup_schedule || '13:00';
          this.settings.cloud_backup_schedule = s.cloud_backup_schedule || '13:00';
        }
      });
    } catch (e) { console.error(e); }
  }

  async selectBackupPath() {
    if (!this.isElectron) return;
    try {
      const path = await window.electron.backup.selectPath();
      if (path) {
        this.ngZone.run(() => this.settings.local_backup_path = path);
        this.saveSettings(); // Auto-save
      }
    } catch (e) { console.error(e); }
  }

  async useDefaultBackupPath() {
    if (!this.isElectron) return;
    try {
      const path = await window.electron.backup.useDefaultPath();
      if (path) {
        this.ngZone.run(() => this.settings.local_backup_path = path); // Update UI
        // We should also clear it in the DB settings so it falls back to default logic? 
        // Or explicitly save the default path? The requirement says "Use Default Location".
        // Saving the explicit default path is safer to ensure consistency.
        this.saveSettings();
      }
    } catch (e) { console.error(e); }
  }

  async saveSettings() {
    try {
      await this.dataService.invoke('saveSettings', this.settings);
      this.ngZone.run(() => { this.settingsSaved = true; setTimeout(() => this.settingsSaved = false, 3000); });
    } catch (e) { console.error(e); }
  }

  async loadAbdmConfig() {
    try {
      const config = await this.dataService.invoke<any>('abdmGetConfig');
      this.ngZone.run(() => {
        if (config) {
          this.abdmConfig = {
            gateway_env: config.gateway_env || 'sandbox',
            client_id: config.client_id || '',
            has_secret: !!config.has_secret,
            mock: config.mock !== false,
            hip_id: config.hip_id || '',
            counter_id: config.counter_id || ''
          };
          void this.generateQr();
        }
      });
    } catch (e) { console.error(e); }
  }

  async saveAbdmConfig() {
    if (this.abdmBusy) return;
    this.abdmBusy = true;
    try {
      await this.dataService.invoke('abdmSaveConfig', {
        gateway_env: this.abdmConfig.gateway_env,
        client_id: this.abdmConfig.client_id,
        hip_id: this.abdmConfig.hip_id || '',
        counter_id: this.abdmConfig.counter_id || '',
        mock: this.abdmConfig.mock !== false
      });
      this.ngZone.run(() => {
        this.abdmSaved = true;
        setTimeout(() => this.abdmSaved = false, 3000);
      });
      await this.loadAbdmConfig();
    } catch (e) { console.error(e); }
    finally { this.abdmBusy = false; }
  }

  async saveAbdmSecret() {
    if (this.abdmBusy || !this.abdmSecret) return;
    this.abdmBusy = true;
    try {
      await this.dataService.invoke('abdmSetSecret', { secret: this.abdmSecret });
      this.ngZone.run(() => {
        this.abdmSecret = '';
        this.abdmSaved = true;
        setTimeout(() => this.abdmSaved = false, 3000);
      });
      await this.loadAbdmConfig();
    } catch (e) { console.error(e); }
    finally { this.abdmBusy = false; }
  }

  async testAbdm() {
    if (this.abdmBusy) return;
    this.abdmBusy = true;
    try {
      const result = await this.dataService.invoke<any>('abdmTestConnectivity');
      this.ngZone.run(() => { this.abdmTest = result; });
    } catch (e) {
      const detail = e instanceof Error ? e.message : 'Connectivity test failed.';
      this.ngZone.run(() => { this.abdmTest = { ok: false, mode: 'error', detail }; });
    } finally { this.abdmBusy = false; }
  }

  // Counter QR encodes the facility identity patients scan. Shape is
  // documented in DEVELOPER_GUIDE alongside the tunnel setup.
  async generateQr(): Promise<void> {
    const hip = (this.abdmConfig.hip_id || '').trim();
    const counter = (this.abdmConfig.counter_id || '').trim();
    if (!hip || !counter) {
      this.qrDataUrl = null;
      return;
    }
    try {
      const { default: QRCode } = await import('qrcode');
      const payload = JSON.stringify({ app: 'NalamDesk Scan & Share', v: 1, hipId: hip, counterId: counter });
      const url = await QRCode.toDataURL(payload, { width: 220, margin: 1 });
      this.ngZone.run(() => { this.qrDataUrl = url; });
    } catch (e) { console.error(e); }
  }

  async simulateShare() {
    if (this.abdmBusy) return;
    this.abdmBusy = true;
    try {
      const token: any = await this.dataService.invoke('abdmSimulateShare');
      this.ngZone.run(() => {
        this.abdmSimResult = `Demo scan queued as Token #${token?.token_no ?? '?'}. Check the Queue page.`;
      });
    } catch (e) {
      this.ngZone.run(() => {
        this.abdmSimResult = e instanceof Error ? e.message : 'Demo scan failed.';
      });
    } finally { this.abdmBusy = false; }
  }

  async loadUsers() {
    try {
      const u = await this.dataService.invoke<any>('getUsers');
      this.ngZone.run(() => {
        this.users = u;
        this.applyFilter();
      });
    } catch (e) { console.error(e); }
  }

  editUser(user: any) {
    this.editingUser = {
      active: 1,
      role: 'nurse',
      password_reset_required: 1,
      ...user
    };
    this.formSubmitted = false;
  }

  validateUser(user: any): string[] {
    const errors = [];
    if (!user.username || user.username.length < 3) errors.push('Username must be at least 3 characters.');
    if (!user.name || user.name.length < 2) errors.push('Full Name is required.');
    if (!user.role) errors.push('Role is required.');

    if (user.mobile && !/^\d{10}$/.test(user.mobile)) {
      errors.push('Mobile number must be exactly 10 digits.');
    }

    if (user.email && !/^[^\s@]{1,64}@[^\s@]{1,253}\.[^\s@]{1,63}$/.test(user.email)) {
      errors.push('Invalid email format.');
    }

    if (!user.id && (!user.password || user.password.length < 6)) {
      errors.push('Password must be at least 6 characters.');
    }

    return errors;
  }

  async saveUser() {
    this.formSubmitted = true;

    const errors = this.validateUser(this.editingUser);
    if (errors.length > 0) {
      alert(errors.join('\\n'));
      return;
    }

    try {
      await this.dataService.invoke('saveUser', this.editingUser);
      this.ngZone.run(() => {
        this.editingUser = null;
        this.loadUsers();
        alert('Profile Saved');
      });
    } catch (e: any) {
      console.error(e);
      const msg = e.toString();
      if (msg.includes('UNIQUE constraint failed: users.username')) {
        alert('Username already exists. Please choose another.');
      } else {
        alert('Error saving user: ' + msg);
      }
    }
  }

  openLoginPasswordModal() {
    this.currentLoginPassword = '';
    this.newLoginPassword = '';
    this.confirmLoginPassword = '';
    this.showLoginPasswordModal = true;
  }

  async changeLoginPassword() {
    if (!this.currentLoginPassword || this.newLoginPassword.length < 6 ||
      this.newLoginPassword !== this.confirmLoginPassword) return;
    this.isLoading = true;
    try {
      const result = await this.authService.changeLoginPassword(
        this.currentLoginPassword, this.newLoginPassword
      );
      if (result.success) {
        this.showLoginPasswordModal = false;
        alert('Administrator login password changed. Vault and recovery keys were not changed.');
      } else alert(result.error || 'Failed to change login password');
    } catch (error: any) {
      alert(error?.message || 'Failed to change login password');
    } finally {
      this.currentLoginPassword = '';
      this.newLoginPassword = '';
      this.confirmLoginPassword = '';
      this.isLoading = false;
    }
  }

  openUserResetModal(user: any) {
    this.resetTarget = user;
    this.resetAdminPassword = '';
    this.resetTemporaryPassword = '';
    this.resetConfirmPassword = '';
    this.showUserResetModal = true;
  }

  async resetUserPassword() {
    if (!this.resetTarget || !this.resetAdminPassword || this.resetTemporaryPassword.length < 6 ||
      this.resetTemporaryPassword !== this.resetConfirmPassword) return;
    this.isLoading = true;
    try {
      const result = await this.authService.resetUserPassword(
        this.resetTarget.id, this.resetAdminPassword, this.resetTemporaryPassword
      );
      if (result.success) {
        this.showUserResetModal = false;
        this.editingUser = null;
        alert('Temporary login password set. The user must change it after signing in.');
      } else alert(result.error || 'Failed to reset login password');
    } catch (error: any) {
      alert(error?.message || 'Failed to reset login password');
    } finally {
      this.resetAdminPassword = '';
      this.resetTemporaryPassword = '';
      this.resetConfirmPassword = '';
      this.isLoading = false;
    }
  }

  openDeviceRotationModal() {
    this.currentDevicePassword = '';
    this.showDeviceRotationModal = true;
  }

  async rotateDeviceEnvelope() {
    if (!this.currentDevicePassword) return;
    this.isLoading = true;
    try {
      const result = await this.authService.rotateDeviceEnvelope(this.currentDevicePassword);
      if (result.success) {
        this.showDeviceRotationModal = false;
        alert('This device key envelope was rotated. Login passwords and recovery code were not changed.');
      } else alert(result.error || 'Failed to rotate this device key envelope');
    } catch (error: any) {
      alert(error?.message || 'Failed to rotate this device key envelope');
    } finally {
      this.currentDevicePassword = '';
      this.isLoading = false;
    }
  }

  async deleteUser(id: number) {
    if (!confirm('Are you sure? This will remove access for this user.')) return;
    try {
      await this.dataService.invoke('deleteUser', id);
      this.ngZone.run(() => this.loadUsers());
    } catch (e) { console.error(e); }
  }

  // Batch Selection
  selectedUsers: any[] = [];

  async deleteSelectedUsers() {
    if (this.selectedUsers.length === 0) return;
    if (!confirm(`Are you sure you want to delete ${this.selectedUsers.length} users? This cannot be undone.`)) return;

    try {
      // Execute in parallel or sequential? 
      // SQLite handles concurrency poorly if not managed, but dataService.invoke should handle it.
      // Better to do sequential to avoid locking if the main process handles one by one.
      for (const user of this.selectedUsers) {
        await this.dataService.invoke('deleteUser', user.id);
      }
      this.ngZone.run(() => {
        this.selectedUsers = [];
        this.loadUsers();
        alert('Users deleted successfully');
      });
    } catch (e) { console.error(e); alert('Error deleting users'); }
  }

  async loadAuditLogs() {
    try {
      const logs = await this.dataService.invoke<any>('getAuditLogs', 100);
      this.ngZone.run(() => this.auditLogs = logs);
    } catch (e) { console.error(e); }
  }

  openRecoveryModal() {
    this.confirmPassword = '';
    this.newRecoveryCode = null;
    this.showRecoveryModal = true;
  }
  async closeRecoveryModal() {
    if (!this.newRecoveryCode) {
      this.showRecoveryModal = false;
      return;
    }
    this.isLoading = true;
    try {
      await this.authService.acknowledgeRecoveryCode(this.newRecoveryCode);
      this.newRecoveryCode = null;
      this.showRecoveryModal = false;
    } catch (error: any) {
      alert(error?.message || 'Could not confirm the recovery code. It will be shown again after the next administrator login.');
    } finally {
      this.isLoading = false;
    }
  }
  async generateRecoveryCode() {
    if (!this.confirmPassword) return;
    this.isLoading = true;
    try {
      const res = await this.authService.regenerateRecoveryCode(this.confirmPassword) as any;
      this.ngZone.run(() => {
        if (res.success && res.recoveryCode) this.newRecoveryCode = res.recoveryCode;
        else alert(res.error || 'Failed');
      });
    } catch (error: any) {
      alert(error?.message || 'Failed to rotate recovery code');
    } finally {
      this.confirmPassword = '';
      this.isLoading = false;
    }
  }
  async copyRecoveryCode() {
    if (this.newRecoveryCode) {
      if (window.electron) await window.electron.clipboard.writeText(this.newRecoveryCode);
      else navigator.clipboard.writeText(this.newRecoveryCode);
      this.ngZone.run(() => { this.isCopied = true; setTimeout(() => this.isCopied = false, 2000); });
    }
  }

  async connectDrive() {
    if (!this.isElectron) return;
    this.isLoading = true;
    this.message = '';
    try {
      const res = await window.electron.drive.authenticate({
        clientId: this.settings.drive_client_id,
        clientSecret: this.settings.drive_client_secret
      }) as any;
      this.ngZone.run(() => {
        this.isLoading = false;
        if (res && res.success) {
          this.success = true;
          this.message = 'Connected successfully';
          this.listBackups();
        } else {
          this.success = false;
          this.message = res.error || 'Connection failed';
        }
      });
    } catch (error: any) {
      this.ngZone.run(() => {
        this.isLoading = false;
        this.success = false;
        this.message = error.message || 'An unexpected error occurred';
      });
    }
  }

  async disconnectDrive() {
    if (!confirm('Are you sure you want to disconnect Google Drive? Automated backups will stop.')) return;
    // We should probably have a backend method to clear tokens, but for now we can just clear local state 
    // and maybe save empty tokens to settings? 
    // Ideally, we should add a drive:disconnect IPC. 
    // For now, let's just clear the success flag and maybe warn user?
    // Actually, let's just clear the settings on backend if possible, or just UI for now.
    // Wait, let's add a proper disconnect IPC handler in the next step.
    // For now, I'll just add the method stub to be filled.

    try {
      await window.electron.drive.disconnect(); // Need to add this
      this.ngZone.run(() => {
        this.success = false;
        this.message = 'Disconnected';
        this.backups = [];
      });
    } catch (e) {
      console.error('Disconnect failed', e);
    }
  }
  async listBackups() {
    if (!this.isElectron) return;
    const files = await window.electron.drive.listBackups();
    this.ngZone.run(() => this.backups = files || []);
  }
  async backupNow() {
    if (!this.isElectron) return;
    this.isBackupLoading = true;
    try {
      const res = await window.electron.drive.backup() as any;
      this.ngZone.run(() => {
        this.isBackupLoading = false;
        if (res.success) { alert('Backup Complete'); this.listBackups(); }
        else alert('Failed: ' + res.error);
      });
    } catch { this.isBackupLoading = false; }
  }
  async restore(id: string) {
    if (!confirm('OVERWRITE WARNING: This will replace your current database with the backup. This action cannot be undone. Are you sure?')) return;

    this.isBackupLoading = true; // Use existing loading flag or add new one
    this.message = 'Restoring backup... The app will restart automatically.';

    try {
      const res = await window.electron.drive.restore(id);
      if (res.success && res.restartRequired) {
        this.ngZone.run(() => {
          alert('Restore Successful! The application will now restart.');
          // In case main process doesn't kill it immediately (though it should)
        });
      } else {
        this.ngZone.run(() => {
          this.isBackupLoading = false;
          alert('Restore Failed: ' + (res.error || 'Unknown Error'));
        });
      }
    } catch (e: any) {
      this.ngZone.run(() => {
        this.isBackupLoading = false;
        alert('Restore Error: ' + e.message);
      });
    }
  }

  async selectRestoreBundle() {
    if (!this.isElectron) return;
    try {
      const selected = await window.electron.backup.selectRestoreBundle();
      if (!selected) return;
      const legacy = selected.name.toLowerCase().endsWith('.db');
      this.ngZone.run(() => {
        this.restoreBundle = selected;
        this.restoreError = legacy
          ? 'This legacy backup can be identified, but cannot recover a live vault.'
          : '';
      });
    } catch (e: any) {
      this.ngZone.run(() => {
        this.restoreError = e?.message || 'Unable to select the backup file.';
      });
    }
  }

  async restoreLocalBackup() {
    if (!this.isElectron || !this.restoreBundle) return;
    if (this.restoreBundle.name.toLowerCase().endsWith('.db')) {
      this.restoreError = 'This legacy database-only backup is missing recovery metadata and cannot be restored on a live vault.';
      return;
    }
    if (!this.restoreRecoveryCode) {
      this.restoreError = 'Enter the Recovery Code for this backup.';
      return;
    }
    if (!this.restoreAdminPassword) {
      this.restoreError = 'Enter the current administrator password.';
      return;
    }
    if (!confirm('The backup will be validated first. Your current vault will be snapshotted before replacement. Continue?')) return;

    this.isRestoring = true;
    this.restoreError = '';
    try {
      const result = await window.electron.restoreSystemBackup({
        path: this.restoreBundle.path,
        recoveryCode: this.restoreRecoveryCode,
        currentAdminPassword: this.restoreAdminPassword
      });
      this.restoreRecoveryCode = '';
      this.restoreAdminPassword = '';
      if (!result.success) throw new Error(result.error || 'Restore failed');
    } catch (e: any) {
      this.isRestoring = false;
      const code = e?.message || 'Restore failed';
      this.restoreError = code === 'LEGACY_DATABASE_ONLY_BACKUP'
        ? 'This legacy database-only backup is missing recovery metadata and cannot be restored on a live vault.'
        : code === 'INVALID_RECOVERY_CODE'
          ? 'The Recovery Code is incorrect for this backup.'
          : code === 'INVALID_ADMIN_CREDENTIAL'
            ? 'The administrator password is incorrect.'
            : `Restore failed: ${code}`;
    }
  }

  async checkDriveStatus() {
    if (!this.isElectron) return;
    try {
      const isAuth = await window.electron.drive.isAuthenticated();
      this.ngZone.run(() => {
        if (isAuth) {
          this.success = true;
          this.message = 'Connected successfully';
          this.listBackups();
        }
      });
    } catch (e) {
      console.error('Failed to check drive status', e);
    }
  }

  async loadCloudStatus() {
    if (!this.isElectron) return;
    const s = await window.electron.cloud.getStatus();
    this.ngZone.run(() => { this.cloudEnabled = s.enabled; this.cloudClinicId = s.clinicId; });
  }
  async toggleCloud(e: any) {
    if (!this.isElectron) return;
    const enabled = e.target.checked;
    if (enabled && !this.cloudClinicId) {
      this.showCloudModal = true;
      e.target.checked = false;
    } else {
      await window.electron.cloud.toggle(enabled);
      this.loadCloudStatus();
    }
  }
  async submitCloudOnboard() {
    // ... existing ...
  }

  openDriveConsole(e: Event) {
    e.preventDefault();
    if (window.electron && window.electron.utils) {
      window.electron.utils.openExternal('https://console.cloud.google.com/');
    }
  }

  openSetupGuide(e: Event) {
    e.preventDefault();
    if (window.electron && window.electron.utils) {
      // Link to local doc or online wiki? Using prompt's request for "User Guide"
      // Since we don't have a hosted wiki yet, I'll point to the repo docs or a placeholder.
      // User asked to "create a new page in nalamdesk documentation user guide... and add a link".
      // I should probably link to the hosted version of that doc. 
      // For now, I'll link to the repository documentation folder.
      window.electron.utils.openExternal('https://github.com/sankara-sabapathy/nalamdesk/blob/main/cloud/documentation/user-guide/backups.md');
    }
  }
}
