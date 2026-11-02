import { Component, NgZone, OnInit } from '@angular/core';
import { Router, RouterModule } from '@angular/router';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../services/auth.service';
import { RuntimeService } from '../services/runtime.service';
import { ServerConnectionService } from '../services/server-connection.service';
import { DialogService } from '../shared/services/dialog.service';
import { FacilityService, roleLabel } from '../services/facility.service';

const JOIN_ERRORS: Record<string, string> = {
  INVALID_CODE: 'That join code is not valid or has expired. Ask an admin for a new one.',
  WRONG_SERVER: 'That join code is for a different NalamDesk Server.',
  TOO_MANY_ATTEMPTS: 'Too many wrong codes. Wait a few minutes and try again.',
  UNREACHABLE: 'Cannot reach the NalamDesk Server.'
};

export const NO_FACILITY_ACCESS_MESSAGE =
  'Your account is not set up for any facility yet. Ask an administrator to give you a role at a facility.';

export function joinErrorMessage(error: string): string {
  return JOIN_ERRORS[error] ?? 'Could not join this browser. Try again or ask an admin for a new code.';
}

function defaultBrowserName(): string {
  const ua = globalThis.navigator?.userAgent ?? '';
  const browser = ['Edg', 'Firefox', 'Chrome', 'Safari'].find((name) => ua.includes(name)) ?? 'Browser';
  return `${browser === 'Edg' ? 'Edge' : browser} browser`;
}

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule],
  template: `
    <div class="min-h-screen flex items-center justify-center bg-gray-900 text-white p-4">
      <div class="bg-gray-800 p-6 sm:p-8 rounded-lg shadow-xl w-full max-w-sm border border-gray-700">
        <h2 class="text-2xl font-bold mb-6 text-center text-blue-400">NalamDesk</h2>
        
        <div *ngIf="error" class="bg-red-900/50 border border-red-500 text-red-200 px-4 py-2 rounded mb-4 text-sm">
          {{ error }}
        </div>
        <div *ngIf="vaultNotice" class="bg-blue-950/60 border border-blue-600 text-blue-100 px-4 py-2 rounded mb-4 text-sm">
          {{ vaultNotice }}
        </div>

        <div *ngIf="pendingRecoveryCode" class="bg-amber-950 border border-amber-500 p-4 rounded mb-4 text-sm">
          <p class="font-bold text-amber-300 mb-2">Security upgrade complete</p>
          <p class="text-amber-100 mb-2">Save this new recovery code before continuing. The old vault password wrapper has been removed.</p>
          <code class="block bg-gray-950 p-2 rounded select-all break-all">{{ pendingRecoveryCode }}</code>
          <button type="button" (click)="acknowledgeMigration()" class="mt-3 w-full bg-amber-600 hover:bg-amber-700 py-2 rounded font-bold">
            I have saved this code
          </button>
        </div>

        <form *ngIf="needsJoin" (ngSubmit)="onJoin()" data-testid="join-browser-form">
          <p class="text-sm text-gray-300 mb-4">
            Join this browser to the NalamDesk Server. Ask an admin for a join code
            (Settings, or <code>nalamdesk-server join-code</code>).
          </p>
          <div class="mb-4">
            <label class="block text-gray-400 text-sm font-bold mb-2" for="joinCode">Join code</label>
            <input id="joinCode" name="joinCode" [(ngModel)]="joinCode" autocomplete="off" spellcheck="false"
              class="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white font-mono uppercase tracking-wider focus:outline-none focus:border-blue-500"
              placeholder="XXXXX-XXXXX-XXXXX-XXXXX" [disabled]="isLoading">
          </div>
          <div class="mb-4">
            <label class="block text-gray-400 text-sm font-bold mb-2" for="deviceName">Name for this computer</label>
            <input id="deviceName" name="deviceName" [(ngModel)]="deviceName" maxlength="100"
              class="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white focus:outline-none focus:border-blue-500"
              placeholder="Front desk" [disabled]="isLoading">
          </div>
          <button type="submit" [disabled]="isLoading || !joinCode"
            class="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded disabled:opacity-50 disabled:cursor-not-allowed">
            {{ isLoading ? 'Joining...' : 'Join' }}
          </button>
        </form>

        <form *ngIf="choosingFacility" (ngSubmit)="confirmFacility()" data-testid="facility-picker">
          <p class="text-sm text-gray-300 mb-4">Which facility are you working in?</p>
          <fieldset class="space-y-2 mb-4">
            <legend class="sr-only">Facility</legend>
            <label *ngFor="let f of facilities.facilities()"
                   class="flex items-center gap-3 px-3 py-2 rounded border cursor-pointer transition-colors"
                   [class.border-blue-500]="selectedFacilityId === f.id" [class.bg-gray-700]="selectedFacilityId === f.id"
                   [class.border-gray-600]="selectedFacilityId !== f.id">
              <input type="radio" name="facility" class="radio radio-sm radio-primary" [value]="f.id"
                     [(ngModel)]="selectedFacilityId" [disabled]="isLoading">
              <span class="flex-1">
                <span class="block font-medium">{{ f.name || f.code }}</span>
                <span class="block text-xs text-gray-400">{{ f.kind === 'hospital' ? 'Hospital' : 'Clinic' }} · {{ label(f.role) }}</span>
              </span>
            </label>
          </fieldset>
          <button type="submit" [disabled]="isLoading || !selectedFacilityId"
            class="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded disabled:opacity-50 disabled:cursor-not-allowed">
            {{ isLoading ? 'Opening...' : 'Continue' }}
          </button>
        </form>

        <form (ngSubmit)="onLogin()" *ngIf="!pendingRecoveryCode && !needsJoin && !choosingFacility">
          <div class="mb-4">
            <label class="block text-gray-400 text-sm font-bold mb-2" for="username">
              Username
            </label>
            <input
              type="text"
              id="username"
              [(ngModel)]="username"
              name="username"
              class="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white focus:outline-none focus:border-blue-500 transition-colors"
              placeholder="Enter username..."
              [disabled]="isLoading"
              autofocus
            >
          </div>

          <div class="mb-4">
            <label class="block text-gray-400 text-sm font-bold mb-2" for="password">
              Password
            </label>
            <input
              type="password"
              id="password"
              [(ngModel)]="password"
              name="password"
              class="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white focus:outline-none focus:border-blue-500 transition-colors"
              placeholder="Enter password..."
              [disabled]="isLoading"
            >
          </div>
          
      <button
            type="submit"
            [disabled]="isLoading || !password || !username"
            class="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded focus:outline-none focus:shadow-outline transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {{ isLoading ? 'Logging in...' : 'Login' }}
          </button>
        </form>
        
        <div class="mt-4 text-center flex justify-between text-xs text-gray-400">
            <a *ngIf="isElectron" routerLink="/recover" class="hover:text-blue-400">Recover Device</a>
            <div *ngIf="!isElectron" class="flex flex-col items-start gap-1" data-testid="server-connection-info">
                <span *ngIf="serverLabel">{{ serverLabel }}</span>
                <span *ngIf="deviceLabel" class="text-gray-500">{{ deviceLabel }}</span>
                <button *ngIf="server.isAppClient" type="button" (click)="disconnectComputer()" class="hover:text-red-400 underline">
                  Disconnect this computer
                </button>
            </div>
            <div class="flex flex-col items-end">
                <span>{{ isElectron ? 'Secure Local-First Access' : 'Secure server access' }}</span>
                <div *ngIf="runtime.lanAccessUrl" class="mt-1 flex items-center gap-1.5 bg-gray-700/50 px-2 py-0.5 rounded-md border border-gray-600/30">
                    <span class="relative flex h-1.5 w-1.5">
                      <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                      <span class="relative inline-flex rounded-full h-1.5 w-1.5 bg-green-500"></span>
                    </span>
                    <span class="font-mono text-[10px] text-gray-400">{{ runtime.lanAccessUrl }}</span>
                 </div>
            </div>
        </div>
      </div>
    </div>
  `,
  styles: []
})
export class LoginComponent implements OnInit {
  username = '';
  password = '';
  error = '';
  isLoading = false;
  pendingRecoveryCode = '';
  vaultNotice = '';
  private pendingRoute = '/dashboard';
  isElectron = !!(globalThis as any).electron;
  /** Browser client on a server that only accepts joined computers. */
  needsJoin = false;
  joinCode = '';
  deviceName = '';
  serverLabel = '';
  deviceLabel = '';
  /** Signed in with access to several facilities: pick one before going in (#211). */
  choosingFacility = false;
  selectedFacilityId: number | null = null;

  constructor(
    private router: Router,
    private ngZone: NgZone,
    private authService: AuthService,
    public runtime: RuntimeService,
    public server: ServerConnectionService,
    private dialog: DialogService,
    public facilities: FacilityService = new FacilityService(authService, server)
  ) { }

  async ngOnInit() {
    // Check if Setup is required
    const status = await this.authService.checkSetup();
    if (!status.isSetup) {
      this.router.navigate(['/setup']);
    } else if (status.vaultState && !['ready', 'not-setup'].includes(status.vaultState)) {
      this.vaultNotice = 'Additional security verification may be required. Sign in or use Recover Device if access is unavailable.';
    }

    if (this.isElectron) {
      this.runtime.init();
    } else {
      await this.loadServerInfo();
    }
  }

  /** Browser and client-mode app: who the server is and whether this computer joined. */
  private async loadServerInfo() {
    if (this.server.isAppClient) {
      const info = await this.server.bridge!.info();
      this.serverLabel = info?.serverUrl ? `Server: ${new URL(info.serverUrl).host}` : '';
      this.deviceLabel = info?.deviceName ? `This computer: ${info.deviceName}` : '';
      if (info?.error) this.error = 'This computer can no longer read its server credential. Disconnect it and join again.';
    }
    try {
      const hello = await this.server.hello();
      const device = this.server.browserDevice();
      this.ngZone.run(() => {
        if (!this.server.isAppClient) {
          this.needsJoin = hello.requireDevice && !device;
          this.deviceLabel = device ? `This browser: ${device.deviceName}` : '';
        }
        if (hello.serverVersion && !this.serverLabel) this.serverLabel = `NalamDesk Server ${hello.serverVersion}`;
      });
    } catch {
      // The connection banner explains an unreachable or outdated server.
    }
  }

  async onJoin() {
    if (!this.joinCode) return;
    this.isLoading = true;
    this.error = '';
    const name = this.deviceName.trim() || defaultBrowserName();
    const result = await this.server.joinBrowser(this.joinCode, name);
    this.ngZone.run(() => {
      this.isLoading = false;
      if (result.ok) {
        this.needsJoin = false;
        this.joinCode = '';
        this.deviceLabel = `This browser: ${result.device.deviceName}`;
      } else {
        this.error = joinErrorMessage(result.error);
      }
    });
  }

  async disconnectComputer() {
    const confirmed = await this.dialog.open({
      title: 'Disconnect this computer?',
      message: 'NalamDesk will forget this server and restart. You will need a new join code from an admin to connect again.',
      type: 'confirm',
      confirmText: 'Disconnect',
      cancelText: 'Cancel'
    });
    if (confirmed) await this.server.bridge?.disconnect();
  }

  async onLogin() {
    if (!this.password || !this.username) return;

    this.isLoading = true;
    this.error = '';

    try {
      const result = await this.authService.login(this.username, this.password);

      this.ngZone.run(() => {
        this.isLoading = false;
        if (result.success) {

          const user = this.authService.getUser();
          this.password = ''; // Clear sensitive data

          this.pendingRoute = user && user.password_reset_required ? '/change-password' : '/dashboard';
          this.facilities.seed(result.facilityId, result.facilities);
          if (result.pendingRecoveryCode) {
            this.pendingRecoveryCode = result.pendingRecoveryCode;
          } else {
            this.proceed();
          }
        } else {
          this.password = ''; // Clear sensitive data on failure too
          this.error = this.loginErrorMessage(result.error);
        }
      });
    } catch (e) {
      this.ngZone.run(() => {
        this.isLoading = false;
        this.error = 'Sign-in failed. Check your credentials or use Recover Device if access is unavailable.';
        console.error(e);
      });
    }
  }

  label(role: string): string {
    return roleLabel(role);
  }

  /** Goes in, or first asks which facility when the user works at several. */
  private proceed() {
    if (this.facilities.canSwitch()) {
      this.selectedFacilityId = this.facilities.lastUsed() ?? this.facilities.currentId();
      this.choosingFacility = true;
      return;
    }
    this.router.navigate([this.pendingRoute]);
  }

  async confirmFacility() {
    const chosen = Number(this.selectedFacilityId);
    if (!chosen) return;
    this.error = '';
    if (chosen !== this.facilities.currentId()) {
      this.isLoading = true;
      const result = await this.facilities.switchTo(chosen);
      if (!result.ok) {
        this.ngZone.run(() => {
          this.isLoading = false;
          this.selectedFacilityId = this.facilities.currentId();
          this.error = 'Could not open that facility. You may no longer have access to it.';
        });
        return;
      }
    } else {
      this.facilities.remember(chosen);
    }
    this.ngZone.run(() => {
      this.isLoading = false;
      this.choosingFacility = false;
      this.router.navigate([this.pendingRoute]);
    });
  }

  private loginErrorMessage(error?: string): string {
    if (error === 'NO_FACILITY_ACCESS') return NO_FACILITY_ACCESS_MESSAGE;
    if (this.isElectron) {
      return 'Sign-in failed. Check your credentials or use Recover Device if access is unavailable.';
    }
    if (error === 'TOO_MANY_ATTEMPTS') return 'Too many sign-in attempts. Wait a few minutes and try again.';
    if (error === 'DEVICE_NOT_JOINED') {
      if (!this.server.isAppClient) {
        this.server.forgetBrowserDevice();
        this.needsJoin = true;
        this.deviceLabel = '';
        return 'This browser is not joined to the server. Enter a join code from an admin.';
      }
      return 'The server no longer recognises this computer. Disconnect it and join again with a new code.';
    }
    if (error === 'Network Error') return 'Cannot reach the NalamDesk Server.';
    return 'Sign-in failed. Check your username and password.';
  }

  async acknowledgeMigration() {
    this.error = '';
    try {
      const result = await this.authService.acknowledgeRecoveryCode(this.pendingRecoveryCode);
      if (!result.success) {
        this.error = 'Could not confirm the recovery code. Please try again.';
        return;
      }
      this.pendingRecoveryCode = '';
      this.proceed();
    } catch (error) {
      this.error = 'Could not confirm the recovery code. Please try again.';
      console.error(error);
    }
  }
}
