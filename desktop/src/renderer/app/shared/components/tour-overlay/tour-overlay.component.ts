import { Component, NgZone, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Subscription, interval } from 'rxjs';
import { TourService } from '../../services/tour.service';

/**
 * Fullscreen spotlight for the guided tour. The highlight box tracks the
 * step target (re-queried on an interval so late-rendered tables resolve);
 * when the target is absent the card centers and the tour still advances.
 * Plain-blue theme: blue accents only, no status colors.
 */
@Component({
  selector: 'app-tour-overlay',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div *ngIf="step" class="fixed inset-0 z-[100]">
      <div class="absolute inset-0 bg-black/55" (click)="onBackdrop()"></div>
      <div *ngIf="rect" class="absolute rounded-lg border-2 border-blue-500 transition-all duration-300"
           [ngStyle]="{ top: rect.top + 'px', left: rect.left + 'px', width: rect.width + 'px', height: rect.height + 'px',
                        boxShadow: '0 0 0 4px rgba(37, 99, 235, 0.35)' }"></div>
      <div class="absolute w-[320px] max-w-[calc(100vw-2rem)] bg-white rounded-xl shadow-2xl border border-gray-200 p-5"
           [ngStyle]="cardStyle">
        <div class="text-[11px] font-bold uppercase tracking-wider text-blue-600 mb-1">
          Step {{ position + 1 }} of {{ total }} · {{ step.route }}
        </div>
        <h3 class="text-lg font-bold text-gray-800 mb-1">{{ step.title }}</h3>
        <p class="text-sm text-gray-600 mb-4">{{ step.body }}</p>
        <div class="flex items-center justify-between">
          <button (click)="skip()" class="text-xs text-gray-400 hover:text-gray-600 underline underline-offset-2">Skip tour</button>
          <div class="flex items-center gap-2">
            <button *ngIf="position > 0" (click)="back()"
                    class="px-3 py-1.5 text-sm rounded border border-gray-300 text-gray-700 hover:bg-gray-50">Back</button>
            <button (click)="next()"
                    class="px-4 py-1.5 text-sm font-medium rounded bg-blue-600 text-white hover:bg-blue-700">
              {{ position + 1 >= total ? 'Finish' : 'Next' }}
            </button>
          </div>
        </div>
        <div class="flex gap-1 mt-3">
          <span *ngFor="let _ of dots; let i = index" class="h-1 flex-1 rounded"
                [ngClass]="i <= position ? 'bg-blue-600' : 'bg-gray-200'"></span>
        </div>
      </div>
    </div>
  `,
  styles: []
})
export class TourOverlayComponent implements OnInit, OnDestroy {
  step: ReturnType<TourService['current']> = null;
  position = 0;
  total = 0;
  dots: unknown[] = [];
  rect: DOMRect | null = null;
  cardStyle: Record<string, string> = { top: '96px', left: 'calc(50% - 160px)' };
  private timer: Subscription | null = null;

  constructor(private tours: TourService, private ngZone: NgZone) { }

  ngOnInit() {
    this.timer = interval(250).subscribe(() => this.ngZone.run(() => this.refresh()));
    this.refresh();
  }

  ngOnDestroy() {
    this.timer?.unsubscribe();
  }

  refresh() {
    const active = this.tours.isActive();
    this.step = active ? this.tours.current() : null;
    if (!this.step) {
      this.rect = null;
      return;
    }
    this.position = this.tours.position();
    this.total = this.tours.stepCount();
    this.dots = new Array(this.total);
    const el = document.querySelector(this.step.selector) as HTMLElement | null;
    if (el) {
      try {
        el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      } catch { /* offscreen targets keep the centered card */ }
      const box = el.getBoundingClientRect();
      const pad = 8;
      this.rect = new DOMRect(box.left - pad, box.top - pad, box.width + pad * 2, box.height + pad * 2);
      const below = this.rect.bottom + 16;
      const cardH = 300;
      const top = below + cardH > window.innerHeight
        ? Math.max(16, this.rect.top - cardH - 16)
        : below;
      const left = Math.min(Math.max(16, this.rect.left), window.innerWidth - 336);
      this.cardStyle = { top: `${top}px`, left: `${left}px` };
    } else {
      this.rect = null;
      this.cardStyle = { top: '96px', left: 'calc(50% - 160px)' };
    }
  }

  next() { this.tours.next(); this.refresh(); }
  back() { this.tours.back(); this.refresh(); }
  skip() { this.tours.skip(); this.refresh(); }
  onBackdrop() { /* deliberate no-op: tours end via Skip/Finish, never a stray click */ }
}
