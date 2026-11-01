import { Component, OnInit } from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ServerConnectionService } from '../services/server-connection.service';
import { DialogService } from '../shared/services/dialog.service';

export interface JoinedComputer {
  id: string;
  name: string;
  joinedAt: number;
  lastSeenAt: number | null;
  lastIp: string | null;
  revokedAt: number | null;
}

interface IssuedCode {
  code: string;
  expiresAt: number;
  deviceName: string | null;
}

/**
 * Computers joined to the NalamDesk Server (#194): issue a one-time join
 * code, see who is connected, and remove a lost or retired computer.
 */
@Component({
  selector: 'app-joined-computers',
  standalone: true,
  imports: [CommonModule, FormsModule, DatePipe],
  template: `
    <div class="max-w-3xl">
      <h2 class="text-xl font-bold text-gray-800 mb-1">Computers</h2>
      <p class="text-sm text-gray-500 mb-6">
        Computers and browsers that may sign in to this server. Removing one signs it out at once.
      </p>

      <form class="bg-white border rounded-lg p-4 mb-6 flex flex-wrap items-end gap-3" (ngSubmit)="issueCode()">
        <div class="flex-1 min-w-[12rem]">
          <label for="join-device-name" class="block text-xs font-semibold text-gray-600 mb-1">Computer name (optional)</label>
          <input id="join-device-name" name="deviceName" [(ngModel)]="deviceName" maxlength="100" placeholder="Reception 2" class="input input-bordered input-sm w-full">
        </div>
        <button type="submit" class="btn btn-primary btn-sm" [disabled]="busy" data-testid="issue-join-code">Get a join code</button>
      </form>

      <div *ngIf="issued" class="alert alert-info mb-6" data-testid="issued-join-code">
        <div>
          <div class="font-mono text-lg tracking-wider select-all">{{ issued.code }}</div>
          <div class="text-xs">
            Works once, until {{ issued.expiresAt | date:'shortTime' }}<ng-container *ngIf="issued.deviceName"> for {{ issued.deviceName }}</ng-container>.
            Enter it on the new computer with this server's address.
          </div>
        </div>
      </div>

      <div *ngIf="error" class="alert alert-error mb-4 text-sm">{{ error }}</div>

      <table class="table table-sm bg-white border rounded-lg">
        <thead>
          <tr><th>Computer</th><th>Joined</th><th>Last seen</th><th></th></tr>
        </thead>
        <tbody>
          <tr *ngFor="let c of computers" [class.opacity-50]="c.revokedAt">
            <td>
              <div class="font-medium">{{ c.name }}</div>
              <div class="text-xs text-gray-500" *ngIf="c.lastIp">{{ c.lastIp }}</div>
            </td>
            <td class="text-xs">{{ c.joinedAt | date:'mediumDate' }}</td>
            <td class="text-xs">{{ c.lastSeenAt ? (c.lastSeenAt | date:'short') : '—' }}</td>
            <td class="text-right">
              <span *ngIf="c.revokedAt" class="text-xs text-gray-500">Removed</span>
              <button *ngIf="!c.revokedAt" type="button" class="btn btn-ghost btn-xs text-red-600" (click)="revoke(c)">Remove</button>
            </td>
          </tr>
          <tr *ngIf="computers.length === 0"><td colspan="4" class="text-center text-sm text-gray-500 py-6">No computers have joined yet.</td></tr>
        </tbody>
      </table>
    </div>
  `
})
export class JoinedComputersComponent implements OnInit {
  computers: JoinedComputer[] = [];
  issued: IssuedCode | null = null;
  deviceName = '';
  busy = false;
  error = '';

  constructor(private server: ServerConnectionService, private dialog: DialogService) { }

  ngOnInit(): void {
    void this.load();
  }

  async load(): Promise<void> {
    try {
      this.computers = await this.server.call<JoinedComputer[]>('GET', '/api/admin/devices');
    } catch {
      this.error = 'Could not load the computers list.';
    }
  }

  async issueCode(): Promise<void> {
    this.busy = true;
    this.error = '';
    try {
      this.issued = await this.server.call<IssuedCode>('POST', '/api/admin/join-codes', { deviceName: this.deviceName.trim() || undefined });
      this.deviceName = '';
    } catch {
      this.error = 'Could not issue a join code.';
    } finally {
      this.busy = false;
    }
  }

  async revoke(computer: JoinedComputer): Promise<void> {
    const confirmed = await this.dialog.open({
      title: `Remove ${computer.name}?`,
      message: 'It is signed out at once and needs a new join code to connect again.',
      type: 'confirm',
      confirmText: 'Remove',
      cancelText: 'Cancel'
    });
    if (!confirmed) return;
    try {
      await this.server.call('DELETE', `/api/admin/devices/${encodeURIComponent(computer.id)}`);
      await this.load();
    } catch {
      this.error = 'Could not remove that computer.';
    }
  }
}
