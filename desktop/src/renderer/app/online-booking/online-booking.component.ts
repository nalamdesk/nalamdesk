import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { CloudService } from '../services/cloud.service';
import { DialogService } from '../shared/services/dialog.service';
import { ToastService } from '../shared/services/toast.service';

@Component({
  selector: 'app-online-booking',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="h-full w-full overflow-y-auto p-4 md:p-6 space-y-6">
      <div class="flex justify-between items-center">
        <h1 class="text-2xl font-bold text-gray-800">Online Booking Management</h1>
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
        
        <!-- Availability Manager -->
        <div class="bg-white rounded-xl shadow p-6">
           <h2 class="text-lg font-bold text-gray-800 mb-4">Manage Availability</h2>
           
           <div class="form-control mb-6">
             <label class="label">Step 1: Select Date</label>
             <input type="date" [(ngModel)]="selectedDate" (change)="onDateChange()" [min]="minDate" [max]="maxDate" class="input input-bordered w-full" />
             <label class="label text-xs text-gray-500">You can manage slots for the next 7 days.</label>
           </div>

           <div class="form-control mb-6">
              <label class="label">Step 2: Toggle Slots</label>
              
              <!-- Legend -->
              <div class="flex flex-wrap gap-2 md:gap-4 mb-2 text-xs">
                  <div class="flex items-center gap-1"><div class="w-3 h-3 bg-success rounded"></div> Published</div>
                  <div class="flex items-center gap-1"><div class="w-3 h-3 bg-info rounded"></div> New</div>
                  <div class="flex items-center gap-1"><div class="w-3 h-3 bg-error opacity-50 rounded"></div> Removing</div>
                  <div class="flex items-center gap-1"><div class="w-3 h-3 bg-base-200 border border-gray-300 rounded"></div> Available</div>
              </div>

              <div class="flex flex-wrap gap-2 max-h-60 overflow-y-auto p-1">
                 <button *ngFor="let time of timeSlots" 
                    (click)="toggleTime(time)"
                    [disabled]="isTimePast(time)"
                    [ngClass]="getSlotClass(time)"
                    class="btn btn-sm disabled:bg-base-200 disabled:text-gray-300 disabled:border-gray-200 min-w-[70px]">
                    {{ time }}
                 </button>
              </div>
           </div>

           <button (click)="publishSlots()" class="btn btn-primary w-full" [disabled]="!selectedDate">
             Update Availability
           </button>
        </div>

        <!-- Appointment Requests -->
        <div class="bg-white rounded-xl shadow p-6">
           <h2 class="text-lg font-bold text-gray-800 mb-4 flex items-center justify-between">
             Incoming Requests
             <div class="flex items-center gap-2">
                 <button (click)="loadRequests()" class="btn btn-sm btn-ghost btn-circle" title="Refresh">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="w-5 h-5 stroke-current" [class.animate-spin]="isRefreshing"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                 </button>
                 <span class="badge badge-error ml-2" *ngIf="requests.length > 0">{{ requests.length }} New</span>
             </div>
           </h2>
           
           <div *ngIf="requests.length === 0" class="text-center py-10 text-gray-400">
             <p>No pending requests.</p>
           </div>

           <div class="space-y-4 max-h-[500px] overflow-y-auto">
             <div *ngFor="let req of requests; trackBy: trackById" class="border rounded-lg p-4 hover:shadow-md transition-shadow">
               <div class="flex justify-between items-start mb-2">
                 <div>
                   <h3 class="font-bold text-gray-800">{{ req.patient_name }}</h3>
                   <p class="text-sm text-gray-500">{{ req.phone }}</p>
                 </div>
                 <div class="text-right" *ngIf="req.date; else callbackBadge">
                   <div class="badge badge-outline text-xs">{{ req.date }}</div>
                   <div class="text-lg font-bold text-blue-600">{{ req.time }}</div>
                 </div>
                 <ng-template #callbackBadge>
                   <div class="badge badge-warning text-xs">Callback request</div>
                 </ng-template>
               </div>

               <!-- No slot was chosen online: staff set the appointment time when accepting. -->
               <div *ngIf="!req.date" class="flex gap-2 mb-3">
                 <input type="date" [(ngModel)]="callbackSlot(req.id).date" [min]="minDate" class="input input-bordered input-sm flex-1" aria-label="Appointment date" />
                 <input type="time" [(ngModel)]="callbackSlot(req.id).time" class="input input-bordered input-sm w-32" aria-label="Appointment time" />
               </div>
               
               <p *ngIf="req.reason" class="text-sm text-gray-600 bg-gray-50 p-2 rounded mb-3">
                 "{{ req.reason }}"
               </p>

               <div class="flex gap-2 mt-2">
                 <button (click)="accept(req)" class="btn btn-sm btn-success flex-1 text-white">Accept</button>
                 <button (click)="reject(req)" class="btn btn-sm btn-error flex-1 text-white">Reject</button>
               </div>
             </div>
           </div>
        </div>
      </div>
    </div>
  `
})
export class OnlineBookingComponent implements OnInit, OnDestroy {
  activeTab: 'requests' | 'availability' = 'requests';
  requests: any[] = [];

  // Availability
  selectedDate: string = '';
  minDate: string = '';
  maxDate: string = '';

  timeSlots: string[] = [];

  // State Sets
  publishedSlots: Set<string> = new Set(); // Slots currently in DB (Green)
  selectedSlots: Set<string> = new Set();  // Slots currently selected (Blue/Green)

  private refreshInterval: any;
  // Date and time staff pick for callback requests, kept across list refreshes.
  private callbackSlots = new Map<string, { date: string; time: string }>();

  constructor(public cloud: CloudService, private dialogService?: DialogService, private toastService?: ToastService) {
    this.generateTimeSlots();
    this.setCalendarLimits();
  }

  async ngOnInit() {
    await this.loadRequests();
    // Poll every 30s locally for UI updates
    this.refreshInterval = setInterval(() => this.loadRequests(), 30000);
  }

  ngOnDestroy() {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
    }
  }

  setCalendarLimits() {
    const today = new Date();
    this.minDate = today.toISOString().split('T')[0];

    const nextWeek = new Date(today);
    nextWeek.setDate(today.getDate() + 7);
    this.maxDate = nextWeek.toISOString().split('T')[0];

    this.selectedDate = this.minDate;
    this.onDateChange();
  }

  generateTimeSlots() {
    const start = 9; // 9 AM
    const end = 20;  // 8 PM
    for (let i = start; i < end; i++) {
      const hour = String(i).padStart(2, '0');
      this.timeSlots.push(`${hour}:00`);
      this.timeSlots.push(`${hour}:30`);
    }
  }

  isTimePast(time: string): boolean {
    if (!this.selectedDate) return true;

    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];

    // Future date -> Not past
    if (this.selectedDate > todayStr) return false;

    // Past date -> All past (should shouldn't happen due to minDate)
    if (this.selectedDate < todayStr) return true;

    // Today -> Check time
    const [hours, minutes] = time.split(':').map(Number);
    const slotTime = new Date();
    slotTime.setHours(hours, minutes, 0, 0);

    return slotTime < now;
  }

  async onDateChange() {
    this.publishedSlots.clear();
    this.selectedSlots.clear();

    if (!this.selectedDate) return;

    console.log('[OnlineBooking] Fetching slots for:', this.selectedDate);
    try {
      const slots = await this.cloud.getPublishedSlots(this.selectedDate);
      console.log('[OnlineBooking] Received slots:', slots);
      if (slots && Array.isArray(slots)) {
        slots.forEach((s: any) => {
          this.publishedSlots.add(s.time);
          this.selectedSlots.add(s.time);
        });
        console.log('[OnlineBooking] Published Set:', this.publishedSlots);
      }
    } catch (e) {
      console.error('Failed to load slots', e);
    }
  }

  toggleTime(time: string) {
    if (this.selectedSlots.has(time)) {
      this.selectedSlots.delete(time);
    } else {
      this.selectedSlots.add(time);
    }
  }

  getSlotClass(time: string): string {
    const isPublished = this.publishedSlots.has(time);
    const isSelected = this.selectedSlots.has(time);

    if (isPublished && isSelected) return 'btn-success text-white'; // Green: Published & Kept
    if (isPublished && !isSelected) return 'btn-error text-white opacity-50'; // Red: Published & Removed (Visual feedback)
    if (!isPublished && isSelected) return 'btn-info text-white'; // Blue: New
    return 'bg-base-200 border-gray-300 hover:bg-base-300'; // Gray: Default
  }

  async publishSlots() {
    try {
      const slotsToPublish = Array.from(this.selectedSlots).map(time => ({
        date: this.selectedDate,
        time
      }));

      // Explicitly tell server we are updating this date
      await this.cloud.publishSlots(slotsToPublish, [this.selectedDate]);
      this.toastService?.success(`Slots for ${this.selectedDate} are now published.`, 'Availability updated');

      // Refresh state
      await this.onDateChange();
    } catch (e) {
      console.error(e);
      await this.dialogService?.open({
        title: 'Publish failed',
        message: 'Availability could not be updated. Please retry.',
        type: 'error'
      });
    }
  }

  isRefreshing = false;

  async loadRequests() {
    if (this.isRefreshing) return;

    this.isRefreshing = true;
    try {
      // Fetch from the cloud first; requests already saved here still show when that fails.
      try {
        await this.cloud.syncNow();
      } catch (e) {
        console.error('Failed to sync requests', e);
        this.toastService?.warning('Could not reach NalamDesk Cloud. Showing the requests already on this computer.', 'Not refreshed');
      }
      const allRequests = await this.cloud.getAppointmentRequests();
      this.requests = (allRequests || []).filter((r: any) => r.status === 'pending');
    } catch (e) {
      console.error('Failed to load requests', e);
    } finally {
      // ensure distinct animation time
      setTimeout(() => this.isRefreshing = false, 500);
    }
  }

  trackById(index: number, item: any) {
    return item.id;
  }



  callbackSlot(id: unknown): { date: string; time: string } {
    const key = String(id);
    let slot = this.callbackSlots.get(key);
    if (!slot) {
      slot = { date: '', time: '' };
      this.callbackSlots.set(key, slot);
    }
    return slot;
  }

  async accept(req: any) {
    // A callback request has no slot: the appointment needs the date and time staff set.
    const { date, time } = req.date ? { date: req.date, time: req.time } : this.callbackSlot(req.id);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !/^\d{2}:\d{2}$/.test(time || '')) {
      await this.dialogService?.open({
        title: 'Pick a date and time',
        message: `${req.patient_name} asked for a callback. Set the appointment date and time on the request before accepting it.`,
        type: 'error'
      });
      return;
    }
    const confirmed = await this.dialogService?.open({
      title: 'Accept booking?',
      message: `${req.patient_name} gets a confirmed appointment for ${date} at ${time}.`,
      type: 'confirm',
      confirmText: 'Accept',
      cancelText: 'Cancel'
    });
    if (!confirmed) return;
    // The cloud books the slot and updates the patient's status page first
    // (a lapsed or taken slot stops here); main then books the appointment
    // and marks the request accepted in one step, so a crash cannot leave
    // an accepted request without its appointment.
    try {
      await this.cloud.decide(req.id, 'accepted', { date, time });
    } catch (e) {
      await this.showDecisionError('Accept failed', e);
      await this.loadRequests();
      return;
    }
    this.callbackSlots.delete(String(req.id));
    await this.loadRequests();
    this.toastService?.success(`Appointment created for ${req.patient_name}.`, 'Booking accepted');
  }

  async reject(req: any) {
    const confirmed = await this.dialogService?.open({
      title: 'Reject booking?',
      message: req.date
        ? `${req.patient_name}'s request for ${req.date} at ${req.time} will be declined.`
        : `${req.patient_name}'s callback request will be declined.`,
      type: 'confirm',
      confirmText: 'Reject',
      cancelText: 'Keep'
    });
    if (!confirmed) return;
    try {
      await this.cloud.decide(req.id, 'declined');
    } catch (e) {
      await this.showDecisionError('Reject failed', e);
    }
    this.loadRequests();
  }

  /** Main's errors arrive as "Error invoking remote method ...: Error: <code>: <message>". */
  private async showDecisionError(title: string, e: unknown) {
    const raw = String((e as any)?.message || e || '');
    const message = raw.replace(/^.*?Error: /, '').replace(/^[a-z_]+: /, '') || 'Please retry.';
    await this.dialogService?.open({ title, message, type: 'error' });
  }
}
