import { Component, NgZone, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import type { Subscription } from 'rxjs';
import { DataService } from '../services/api.service';
import { ServerConnectionService } from '../services/server-connection.service';

export interface DisplayBoard {
  serving: number[];
  next: number[];
  waiting: number;
}

/**
 * Waiting-room board built from the queue: token numbers only. Names, ages
 * and urgency never leave the desk, because this screen faces the public.
 * Entries without a token (checked in before tokens existed) are counted but
 * not shown.
 */
export function buildDisplayBoard(queue: any[], nextCount = 5): DisplayBoard {
  const rows = Array.isArray(queue) ? queue : [];
  const token = (q: any) => (Number.isFinite(Number(q?.token_no)) && q?.token_no != null ? Number(q.token_no) : null);
  const serving = rows.filter((q) => q?.status === 'in-consult').map(token).filter((t): t is number => t != null);
  const waitingRows = rows.filter((q) => q?.status === 'waiting');
  const next = waitingRows.map(token).filter((t): t is number => t != null).slice(0, nextCount);
  return { serving, next, waiting: waitingRows.length };
}

@Component({
  selector: 'app-queue-display',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="min-h-screen w-full bg-slate-900 text-white flex flex-col select-none" data-testid="queue-display">
      <header class="flex items-center justify-between px-10 py-6 border-b border-white/10">
        <div>
          <p class="text-3xl font-semibold">{{ clinicName || 'Welcome' }}</p>
          <p class="text-lg text-white/60">Please wait for your token number</p>
        </div>
        <div class="flex items-center gap-6">
          <p class="text-4xl font-mono tabular-nums">{{ clock }}</p>
          <div class="flex gap-2 opacity-30 hover:opacity-100 focus-within:opacity-100 transition-opacity">
            <button type="button" class="btn btn-sm btn-ghost text-white" (click)="toggleFullscreen()">Full screen</button>
            <button type="button" class="btn btn-sm btn-ghost text-white" (click)="exit()">Exit</button>
          </div>
        </div>
      </header>

      <main class="flex-1 grid grid-cols-1 lg:grid-cols-2 gap-10 p-10">
        <section aria-live="polite" class="rounded-3xl bg-blue-600 flex flex-col items-center justify-center p-10">
          <p class="text-3xl uppercase tracking-widest text-white/80 mb-6">Now serving</p>
          <div *ngIf="board.serving.length; else none" class="flex flex-wrap justify-center gap-10">
            <span *ngFor="let t of board.serving" class="text-[10rem] leading-none font-bold tabular-nums" data-testid="serving-token">{{ t }}</span>
          </div>
          <ng-template #none><span class="text-5xl text-white/70">Please wait</span></ng-template>
        </section>

        <section class="rounded-3xl bg-white/5 flex flex-col p-10">
          <p class="text-3xl uppercase tracking-widest text-white/80 mb-8">Next</p>
          <div *ngIf="board.next.length; else empty" class="grid grid-cols-3 gap-6">
            <span *ngFor="let t of board.next" class="rounded-2xl bg-white/10 text-center text-7xl font-semibold py-6 tabular-nums" data-testid="next-token">{{ t }}</span>
          </div>
          <ng-template #empty><p class="text-3xl text-white/60">No one waiting</p></ng-template>
          <p class="mt-auto pt-8 text-2xl text-white/60">{{ board.waiting }} waiting</p>
        </section>
      </main>
    </div>
  `
})
export class QueueDisplayComponent implements OnInit, OnDestroy {
  board: DisplayBoard = { serving: [], next: [], waiting: 0 };
  clinicName = '';
  clock = '';
  private pollId: any;
  private clockId: any;
  private serverEvents: Subscription | null = null;

  constructor(
    private dataService: DataService,
    private router: Router,
    private ngZone: NgZone,
    private server?: ServerConnectionService
  ) { }

  ngOnInit(): void {
    this.tick();
    this.clockId = setInterval(() => this.tick(), 15000);
    void this.loadClinic();
    void this.refresh();
    // In the app a 5s poll; LAN browsers also get pushed queue events.
    this.pollId = setInterval(() => void this.refresh(), 5000);
    this.serverEvents = window.electron ? null : this.server?.events.subscribe((event) => {
      if (event.topic === 'queue' || event.topic === 'resync') void this.refresh();
    }) ?? null;
  }

  ngOnDestroy(): void {
    clearInterval(this.pollId);
    clearInterval(this.clockId);
    this.serverEvents?.unsubscribe();
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
  }

  async refresh(): Promise<void> {
    try {
      const queue = await this.dataService.invoke<any[]>('getQueue');
      this.ngZone.run(() => { this.board = buildDisplayBoard(queue || []); });
    } catch (e) {
      // Keep the last board on screen; a blank TV helps no one.
      console.error('[Display] queue refresh failed', e);
    }
  }

  private async loadClinic(): Promise<void> {
    try {
      const settings = await this.dataService.invoke<any>('getPublicSettings');
      this.ngZone.run(() => { this.clinicName = settings?.clinic_name || ''; });
    } catch { /* name is optional */ }
  }

  private tick(): void {
    this.clock = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  toggleFullscreen(): void {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else void document.documentElement.requestFullscreen?.().catch(() => undefined);
  }

  exit(): void {
    void this.router.navigate(['/queue']);
  }
}
