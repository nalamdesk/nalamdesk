import { Component, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { ServerConnectionService } from '../../../services/server-connection.service';
import { AuthService } from '../../../services/auth.service';
import type { ConnectionState } from '../../../../../shared/server-client';

export interface BannerView {
  tone: 'warning' | 'error';
  title: string;
  detail: string;
}

/** What the banner says for a connection state; null hides it. */
export function bannerFor(state: ConnectionState, isAppClient: boolean): BannerView | null {
  switch (state.kind) {
    case 'unreachable':
      return {
        tone: 'warning',
        title: 'Cannot reach the NalamDesk Server',
        detail: 'Waiting for it to come back. Your work continues as soon as it reconnects.'
      };
    case 'upgrade':
      if (state.side === 'client') {
        return {
          tone: 'error',
          title: 'This NalamDesk is older than the server',
          detail: isAppClient
            ? 'Update NalamDesk on this computer, then restart it.'
            : 'Reload this page to get the server’s version.'
        };
      }
      return {
        tone: 'error',
        title: 'The NalamDesk Server needs an update',
        detail: `Ask whoever runs the server to upgrade it${state.serverVersion ? ` (it runs ${state.serverVersion})` : ''}.`
      };
    case 'device-revoked':
      return {
        tone: 'error',
        title: 'This computer was removed from the server',
        detail: isAppClient
          ? 'Disconnect it on the sign-in screen and join again with a new code from an admin.'
          : 'Join this browser again with a new code from an admin.'
      };
    default:
      return null;
  }
}

/**
 * Connection banner for server clients (#194): clients do not work offline,
 * they stop, say why, and reconnect on their own. Hidden in the single-PC app.
 */
@Component({
  selector: 'app-connection-banner',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div *ngIf="view() as v" role="alert" data-testid="connection-banner"
         class="fixed top-0 inset-x-0 z-[300] px-4 py-2 text-sm flex items-center gap-3 shadow"
         [ngClass]="v.tone === 'error' ? 'bg-red-700 text-white' : 'bg-amber-500 text-gray-900'">
      <span *ngIf="v.tone === 'warning'" class="loading loading-spinner loading-xs"></span>
      <span class="font-semibold">{{ v.title }}</span>
      <span class="opacity-90">{{ v.detail }}</span>
    </div>
  `
})
export class ConnectionBannerComponent {
  private readonly active = !(globalThis as any).electron;

  constructor(private server: ServerConnectionService, private auth: AuthService, private router: Router) {
    effect(() => {
      const state = this.server.state();
      if (this.active && state.kind === 'device-revoked' && !this.server.isAppClient) this.server.forgetBrowserDevice();
      // The server ended the session (expired, signed out elsewhere, role
      // changed or computer revoked): back to sign-in.
      if (this.active && (state.kind === 'signed-out' || state.kind === 'device-revoked') && this.auth.getUser()) {
        this.server.stopEvents();
        this.auth.forgetSession();
        void this.router.navigate(['/login']);
      }
    });
  }

  view(): BannerView | null {
    return this.active ? bannerFor(this.server.state(), this.server.isAppClient) : null;
  }
}
