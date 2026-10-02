import { Component, NgZone, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';

import { DataService } from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { CloudService } from '../services/cloud.service';
import { PatientService } from '../services/patient.service';
import { DialogService } from '../shared/services/dialog.service';
import { ToastService } from '../shared/services/toast.service';
import { QueueCountService } from '../shared/services/queue-count.service';
import { TourService } from '../shared/services/tour.service';

/** Local wall-clock greeting. Morning < 12, afternoon < 17, else evening. */
export function greetingForLocalHour(hour: number): string {
  if (hour < 12) return 'Morning';
  if (hour < 17) return 'Afternoon';
  return 'Evening';
}

@Component({
  // ... (template omitted, same as before) 
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="h-full w-full overflow-y-auto p-4 md:p-8">
    <div class="w-full max-w-[1600px] mx-auto">
        <!-- Welcome Section -->
        <div class="flex justify-between items-center mb-8 mt-2">
            <div>
                <h1 class="text-3xl font-display font-bold text-base-content">
                    Good {{ getTimeOfDay() }}, <span class="text-primary">{{ currentUser?.name || doctorName || 'Doctor' }}</span>
                </h1>
                <p class="text-base-content/60 mt-1">Here's what's happening at {{ clinicName || 'your clinic' }} today.</p>
            </div>
        </div>

        <!-- First-run onboarding banner -->
        <div *ngIf="showWelcomeBanner" class="mb-8 rounded-2xl border border-blue-200 bg-blue-50/70 p-5 flex flex-col md:flex-row md:items-center gap-4">
          <div class="flex-1">
            <h2 class="text-lg font-bold text-gray-800" *ngIf="!demoSeeded">Welcome to NalamDesk</h2>
            <h2 class="text-lg font-bold text-gray-800" *ngIf="demoSeeded">You are exploring demo data</h2>
            <p class="text-sm text-gray-600 mt-1" *ngIf="!demoSeeded">
              Take a 2-minute guided tour of the queue, patients, visits, and settings — or load a demo clinic to click through with realistic data.
            </p>
            <p class="text-sm text-gray-600 mt-1" *ngIf="demoSeeded">
              5 demo patients with queue entries, vitals, and an appointment. Your own records stay untouched, and everything demo removes in one click.
            </p>
          </div>
          <div class="flex flex-wrap items-center gap-2 shrink-0">
            <button (click)="startTour()" class="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded hover:bg-blue-700 transition-colors">
              {{ demoSeeded ? 'Take the tour' : 'Start guided tour' }}
            </button>
            <button *ngIf="!demoSeeded && currentUser?.role === 'admin'" (click)="loadDemoData()" [disabled]="demoSeedLoading"
                    class="px-4 py-2 text-sm font-medium rounded border border-blue-300 text-blue-700 hover:bg-blue-100 disabled:opacity-50 transition-colors">
              {{ demoSeedLoading ? 'Loading...' : 'Load demo data' }}
            </button>
            <button *ngIf="demoSeeded && currentUser?.role === 'admin'" (click)="removeDemoData()" [disabled]="demoSeedLoading"
                    class="px-4 py-2 text-sm font-medium rounded border border-gray-300 text-gray-700 hover:bg-gray-100 disabled:opacity-50 transition-colors">
              {{ demoSeedLoading ? 'Working...' : 'Remove demo data' }}
            </button>
            <button *ngIf="!demoSeeded" (click)="dismissWelcomeBanner()" class="text-xs text-gray-400 hover:text-gray-600 underline underline-offset-2 px-1">
              Dismiss
            </button>
          </div>
        </div>

        <!-- Stats Grid -->
        <div class="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
          <!-- Total Patients -->
          <div class="stat bg-white shadow-sm border border-gray-200 rounded-2xl group hover:border-blue-500/20 transition-all duration-300">
            <div class="stat-figure text-blue-600 opacity-20 group-hover:opacity-100 transition-opacity">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="inline-block w-8 h-8 stroke-current"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0z"></path></svg>
            </div>
            <div class="stat-title text-gray-500 font-medium tracking-wide text-xs uppercase">Total Patients</div>
            <div class="stat-value text-blue-600 font-display">{{ stats.totalPatients }}</div>
            <div class="stat-desc text-gray-400">Registered in system</div>
          </div>

          <!-- Online Booking Status -->
          <div class="stat bg-white shadow-sm border border-gray-200 rounded-2xl group hover:border-sky-500/20 transition-all duration-300 relative overflow-hidden">
             <!-- Pulse effect if syncing -->
             <div *ngIf="isSyncing" class="absolute inset-0 bg-sky-50 opacity-20 animate-pulse"></div>

             <div class="stat-figure text-sky-500 opacity-20 group-hover:opacity-100 transition-opacity">
                <!-- Cloud Icon -->
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="inline-block w-8 h-8 stroke-current"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z" /></svg>
             </div>
             <div class="stat-title text-gray-500 font-medium tracking-wide text-xs uppercase">Online Booking</div>
             <div class="stat-value text-sky-600 font-display text-2xl mt-1">
                 <span *ngIf="requests.length > 0">{{ requests.length }} New</span>
                 <span *ngIf="requests.length === 0" class="text-gray-400 text-xl font-normal">All Caught Up</span>
             </div>
             <div class="stat-actions mt-2">
                 <button class="btn btn-xs btn-outline btn-info gap-1" (click)="refresh()" [disabled]="isSyncing">
                    <svg *ngIf="isSyncing" class="animate-spin h-3 w-3" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    {{ isSyncing ? 'Syncing...' : 'Sync Now' }}
                </button>
             </div>
          </div>

           <!-- Quick Action -->
           <div class="card bg-blue-600 text-white shadow-lg shadow-blue-600/20 rounded-2xl cursor-pointer hover:shadow-xl hover:shadow-blue-600/30 transition-all duration-300" (click)="goToPatients()">
            <div class="card-body p-6 relative overflow-hidden">
                <!-- Background decoration -->
                <div class="absolute -right-4 -bottom-4 opacity-20">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="w-32 h-32 stroke-current"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"></path></svg>
                </div>
                
                <div class="relative z-10">
                     <div class="font-medium tracking-wide text-xs uppercase opacity-80 mb-1">Quick Action</div>
                     <h3 class="text-2xl font-bold mb-4">New Visit</h3>
                     <button class="btn btn-sm btn-circle bg-white/20 hover:bg-white/30 text-white border-0">
                        <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14 5l7 7m0 0l-7 7m7-7H3" /></svg>
                     </button>
                </div>
            </div>
           </div>
        </div>

        <!-- Appointment Requests -->
        <div *ngIf="requests.length > 0" class="mb-8">
            <h2 class="text-xl font-bold mb-4 flex items-center gap-2">
                <span class="relative flex h-3 w-3">
                  <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-sky-400 opacity-75"></span>
                  <span class="relative inline-flex rounded-full h-3 w-3 bg-sky-500"></span>
                </span>
                Online Requests
            </h2>
            <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                <div *ngFor="let req of requests" class="card bg-white shadow-sm border border-l-4 border-l-sky-500 border-gray-200">
                    <div class="card-body p-4">
                        <div class="flex justify-between items-start">
                            <h3 class="font-bold text-lg">{{ req.patient_name }}</h3>
                            <span class="text-xs font-mono bg-gray-100 px-2 py-1 rounded">{{ req.time }}</span>
                        </div>
                        <p class="text-sm text-gray-500">{{ req.phone }}</p>
                        <p class="text-sm mt-2 italic text-gray-600" *ngIf="req.reason">"{{ req.reason }}"</p>
                        <div class="card-actions justify-end mt-4">
                            <button class="btn btn-sm btn-primary">Accept</button>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <!-- Today's Appointments: confirmed bookings waiting for check-in -->
        <div class="card bg-base-100 shadow-sm border border-base-200 mb-8">
            <div class="card-body">
                <h2 class="card-title text-lg font-bold">Today's Appointments
                    <span *ngIf="todayAppointments.length > 0" class="badge badge-primary badge-sm ml-1">{{ todayAppointments.length }}</span>
                </h2>
                <div *ngIf="todayAppointments.length === 0" class="text-gray-400 text-sm py-2">No confirmed appointments for today.</div>
                <div *ngFor="let appt of todayAppointments" class="flex items-center justify-between gap-3 border-b border-base-200 py-2.5 last:border-0">
                    <div class="min-w-0">
                        <div class="font-bold truncate">{{ appt.patient_name }}</div>
                        <div class="text-xs text-gray-500 font-mono">{{ appt.time }}</div>
                    </div>
                    <button (click)="checkIn(appt)" class="btn btn-sm btn-primary shrink-0">Check in</button>
                </div>
            </div>
        </div>
        
        <!-- Recent Visits -->
        <div class="card bg-base-100 shadow-sm border border-base-200 mb-8">
            <div class="card-body">
                <h2 class="card-title text-lg font-bold">Recent Visits</h2>
                <div class="overflow-x-auto">
                    <table class="table w-full">
                        <thead>
                            <tr>
                                <th>Date</th>
                                <th>Patient</th>
                                <th>Diagnosis</th>
                                <th>Status</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr *ngFor="let visit of visits" class="hover">
                                <td>{{ visit.date | date:'shortDate' }}</td>
                                <td class="font-bold">{{ visit.patient_name }}</td>
                                <td>{{ visit.diagnosis || 'No diagnosis' }}</td>
                                <td><span class="badge badge-success badge-outline">Completed</span></td>
                            </tr>
                            <tr *ngIf="visits.length === 0">
                                <td colspan="4" class="text-center text-gray-400 py-4">No recent visits</td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </div>
        </div>

        <!-- Secondary Actions -->
        <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div class="card bg-base-100 shadow-sm border border-base-200 hover:border-primary/30 transition-colors cursor-pointer" (click)="goToQueue()">
            <div class="card-body flex-row items-center gap-4">
                <div class="p-3 bg-secondary/10 rounded-xl text-secondary">
                    <svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                </div>
                <div>
                    <h2 class="card-title text-base font-bold">Patient Queue</h2>
                    <p class="text-sm text-base-content/60">Manage waiting list and consultations</p>
                </div>
                <div class="ml-auto" *ngIf="waitingCount > 0">
                    <span class="badge badge-error gap-1 font-bold">
                        {{ waitingCount }}
                        <span class="hidden sm:inline">Waiting</span>
                    </span>
                </div>
            </div>
          </div>

          <div *ngIf="currentUser?.role === 'admin'" class="card bg-base-100 shadow-sm border border-base-200 hover:border-primary/30 transition-colors cursor-pointer" (click)="goToSettings()">
            <div class="card-body flex-row items-center gap-4">
                <div class="p-3 bg-neutral/10 rounded-xl text-neutral">
                    <svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                </div>
                <div>
                     <h2 class="card-title text-base font-bold">Settings & Backup</h2>
                    <p class="text-sm text-base-content/60">Configure details and backups</p>
                </div>
            </div>
          </div>

          <div *ngIf="canSeeBilling" class="card bg-base-100 shadow-sm border border-base-200 hover:border-primary/30 transition-colors cursor-pointer" (click)="showCloseModal = true">
            <div class="card-body flex-row items-center gap-4">
                <div class="p-3 bg-green-500/10 rounded-xl text-green-600">
                    <svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 14l6-6m-5.5.5h.01m4.99 5h.01M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16l3.5-2 3.5 2 3.5-2 3.5 2zM10 8.5h.01M15 12h.01" /></svg>
                </div>
                <div>
                     <h2 class="card-title text-base font-bold">Daily Collection</h2>
                     <p class="text-sm text-base-content/60" *ngIf="dailyClose">₹{{ dailyClose.collected }} today · {{ dailyClose.review?.length || 0 }} to review</p>
                     <p class="text-sm text-base-content/60" *ngIf="!dailyClose">Today's receipts and reconciliation</p>
                </div>
                <div class="ml-auto" *ngIf="(dailyClose?.review?.length || 0) > 0">
                    <span class="badge badge-warning gap-1 font-bold">{{ dailyClose.review.length }} review</span>
                </div>
            </div>
          </div>
        </div>

        <!-- Daily close modal: ledger-derived reconciliation -->
        <div *ngIf="showCloseModal && dailyClose" class="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div class="bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col overflow-hidden">
            <div class="px-6 py-4 border-b bg-gray-50 flex justify-between items-center">
              <div>
                <h2 class="text-lg font-bold text-gray-800">Daily close — {{ dailyClose.date }}</h2>
                <p class="text-xs text-gray-500">Derived from payment transactions, not stored totals.</p>
              </div>
              <button (click)="showCloseModal = false" class="text-gray-500 hover:text-gray-600" aria-label="Close">
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="w-4 h-4"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
              </button>
            </div>
            <div class="flex-1 overflow-y-auto p-6 space-y-4">
              <div class="flex items-center justify-between bg-blue-50 border border-blue-200 rounded-lg px-4 py-3">
                <span class="text-sm font-bold text-gray-700 uppercase tracking-wider">Collected</span>
                <span class="text-2xl font-mono font-bold text-blue-700">₹{{ dailyClose.collected }}</span>
              </div>
              <div>
                <div class="text-xs font-bold text-gray-500 uppercase tracking-wider mb-1">By method</div>
                <div *ngFor="let entry of dailyClose.byMethod" class="flex justify-between text-sm py-1 border-b border-dashed border-gray-100">
                  <span class="text-gray-600">{{ entry.method }} <span class="text-gray-400">({{ entry.kind }} × {{ entry.count }})</span></span>
                  <span class="font-mono">{{ entry.kind === 'reversal' ? '−' : '' }}₹{{ entry.total }}</span>
                </div>
                <div *ngIf="!dailyClose.byMethod?.length" class="text-sm text-gray-400">No payments recorded today.</div>
              </div>
              <div>
                <div class="text-xs font-bold text-gray-500 uppercase tracking-wider mb-1">Invoices created</div>
                <div *ngFor="let row of dailyClose.invoices" class="flex justify-between text-sm py-1 border-b border-dashed border-gray-100">
                  <span class="text-gray-600">{{ row.status }} × {{ row.count }}</span>
                  <span class="font-mono">₹{{ row.total }}</span>
                </div>
                <div *ngIf="!dailyClose.invoices?.length" class="text-sm text-gray-400">None today.</div>
              </div>
              <div>
                <div class="text-xs font-bold text-gray-500 uppercase tracking-wider mb-1">Needs review ({{ dailyClose.review?.length || 0 }})</div>
                <div *ngFor="let r of dailyClose.review" class="text-xs py-1.5 border-b border-dashed border-gray-100 flex justify-between gap-2">
                  <span class="text-gray-700">{{ r.receipt_no || '#' + r.id }} · {{ r.kind }} ₹{{ r.amount }} ({{ r.method }}) → {{ r.invoice_number || '#' + r.invoice_id }}<span *ngIf="r.reason" class="text-gray-400"> — {{ r.reason }}</span></span>
                  <span *ngIf="!r.reference && r.method !== 'cash'" class="text-amber-600 font-bold shrink-0">missing ref</span>
                </div>
                <div *ngIf="!dailyClose.review?.length" class="text-sm text-green-600">Clean — nothing to review.</div>
              </div>
            </div>
          </div>
        </div>
    </div>
    </div>
  `,
  styles: []
})
export class DashboardComponent implements OnInit, OnDestroy {
  currentTime = new Date();
  timer: any;
  clinicName = '';
  doctorName = '';
  stats = { totalPatients: 0, todayVisits: 0 };
  waitingCount = 0;
  requests: any[] = [];
  visits: any[] = [];
  currentUser: any = null;
  isSyncing = false;
  todayAppointments: any[] = [];

  // First-run onboarding: demo seed state (admin-only IPC) and banner.
  demoSeeded = false;
  demoSeedLoading = false;
  showWelcomeBanner = false;

  // Daily close (billing roles)
  dailyClose: any = null;
  showCloseModal = false;

  get canSeeBilling(): boolean {
    return ['admin', 'doctor', 'receptionist'].includes(this.currentUser?.role);
  }

  constructor(
    private router: Router,
    private ngZone: NgZone,
    private dataService: DataService,
    private authService: AuthService,
    private cloudService: CloudService,
    private patientService: PatientService,
    private dialogService?: DialogService,
    private toastService?: ToastService,
    private queueCountService?: QueueCountService,
    private tourService?: TourService
  ) { }

  async refresh() {
    this.isSyncing = true;
    try {
      await this.cloudService.syncNow();
      await this.loadData();
    } catch (e) {
      console.error(e);
    } finally {
      this.isSyncing = false;
    }
  }

  ngOnInit() {
    this.currentUser = this.authService.getUser();
    void this.loadData();

    // Live Clock
    this.timer = setInterval(() => {
      this.currentTime = new Date();
    }, 1000);
  }

  ngOnDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  getTimeOfDay(): string {
    return greetingForLocalHour(this.currentTime.getHours());
  }

  async loadData() {
    try {
      const dashboardStats = await this.dataService.invoke<any>('getDashboardStats');
      this.ngZone.run(() => {
        this.stats = dashboardStats || { totalPatients: 0, todayVisits: 0 };
      });
      await this.loadOnboardingState();

      // Load Queue Count
      const queue = await this.dataService.invoke<any>('getQueue');
      const waiting = queue.filter((q: any) => q.status !== 'completed');
      this.waitingCount = waiting.length;

      // Load Settings for Clinic Name
      const settings = await this.dataService.invoke<any>('getPublicSettings');
      if (settings) {
        this.clinicName = settings.clinic_name;
        this.doctorName = settings.doctor_name;
      }

      // Load Requests
      const reqs = await this.dataService.invoke<any>('getAppointmentRequests');
      this.requests = (reqs || []).filter((r: any) => r.status === 'pending');

      // Load Recent Visits
      this.visits = await this.dataService.invoke<any>('getAllVisits', 5);

      // Load Today's Appointments
      await this.loadAppointments();

      // Daily close for billing roles (clinic-local day, matching the ledger)
      if (this.canSeeBilling) {
        try {
          const now = new Date();
          const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
          const close = await this.dataService.invoke<any>('getDailyClose', today);
          this.ngZone.run(() => { this.dailyClose = close || null; });
        } catch (e) {
          console.error('[Dashboard] Daily close unavailable', e);
        }
      }

    } catch (e) {
      console.error('Failed to load dashboard data', e);
    }
  }

  async loadAppointments() {
    const today = new Date().toISOString().split('T')[0];
    const appts = await this.cloudService.getAppointments(today);
    // Filter out Checked In?
    // Status: CONFIRMED, CHECKED_IN. We want to show CONFIRMED ones to check them in.
    this.todayAppointments = (appts || []).filter((a: any) => a.status === 'CONFIRMED');
  }

  // -- Onboarding -----------------------------------------------------
  private static readonly DEMO_BANNER_DISMISSED_KEY = 'nd.demo-banner.dismissed';

  private get isAdmin(): boolean {
    return this.currentUser?.role === 'admin';
  }

  async loadOnboardingState(): Promise<void> {
    let seeded = false;
    if (this.isAdmin) {
      try {
        const state = await this.dataService.invoke<any>('getDemoSeedState');
        seeded = !!state?.seeded;
      } catch (e) {
        console.error('[Dashboard] Demo seed state unavailable', e);
      }
    }
    let dismissed = false;
    try {
      dismissed = localStorage.getItem(DashboardComponent.DEMO_BANNER_DISMISSED_KEY) === '1';
    } catch { /* ignore */ }
    this.ngZone.run(() => {
      this.demoSeeded = seeded;
      // Seeded clinics always show the banner (the only remove path).
      // Empty clinics show it once until dismissed.
      this.showWelcomeBanner = seeded || ((this.stats?.totalPatients || 0) === 0 && !dismissed);
    });
  }

  startTour(): void {
    this.tourService?.start(this.currentUser?.role || '');
  }

  dismissWelcomeBanner(): void {
    try {
      localStorage.setItem(DashboardComponent.DEMO_BANNER_DISMISSED_KEY, '1');
    } catch { /* ignore */ }
    this.showWelcomeBanner = false;
  }

  async loadDemoData(): Promise<void> {
    await this.runDemoMutation({
      method: 'seedDemoData',
      confirmTitle: 'Load demo clinic data?',
      confirmMessage: 'Adds 5 demo patients, queue entries, vitals, and an appointment so you can explore every page. Only available while the clinic is empty, and removable in one click.',
      confirmText: 'Load demo data',
      cancelText: 'Cancel',
      successMessage: 'Demo clinic loaded.',
      successTitle: 'Welcome',
      failureTitle: 'Load failed',
      failureMessage: 'Could not load demo data.'
    });
  }

  async removeDemoData(): Promise<void> {
    await this.runDemoMutation({
      method: 'clearDemoData',
      confirmTitle: 'Remove demo data?',
      confirmMessage: 'Deletes exactly the demo patients, queue entries, vitals, and appointment created by the seed. Anything you added yourself stays.',
      confirmText: 'Remove',
      cancelText: 'Keep',
      successMessage: 'Demo data removed.',
      successTitle: 'Done',
      failureTitle: 'Remove failed',
      failureMessage: 'Could not remove demo data.'
    });
  }

  private async runDemoMutation(options: {
    method: string; confirmTitle: string; confirmMessage: string; confirmText: string; cancelText: string;
    successMessage: string; successTitle: string; failureTitle: string; failureMessage: string;
  }): Promise<void> {
    if (!this.isAdmin || this.demoSeedLoading) return;
    const confirmed = await this.dialogService?.open({
      title: options.confirmTitle,
      message: options.confirmMessage,
      type: 'confirm',
      confirmText: options.confirmText,
      cancelText: options.cancelText
    });
    if (!confirmed) return;
    this.demoSeedLoading = true;
    try {
      await this.dataService.invoke(options.method);
      this.toastService?.success(options.successMessage, options.successTitle);
      await this.loadData();
    } catch (e) {
      await this.dialogService?.open({
        title: options.failureTitle,
        message: e instanceof Error ? e.message : options.failureMessage,
        type: 'error'
      });
    } finally {
      this.ngZone.run(() => { this.demoSeedLoading = false; });
    }
  }

  async checkIn(appt: any) {
    const confirmed = await this.dialogService?.open({
      title: 'Check in patient?',
      message: `${appt.patient_name} joins the live queue for today.`,
      type: 'confirm',
      confirmText: 'Check in',
      cancelText: 'Cancel'
    });
    if (!confirmed) return;

    // Validate Patient
    // Map flatten appt fields to Patient object style for validation
    const patientObj = {
      id: appt.patient_id,
      name: appt.patient_name,
      mobile: appt.patient_mobile,
      age: appt.patient_age,
      gender: appt.patient_gender,
      // address? might be missing in join if not selected, but schema has it. 
      // DatabaseService.getAppointments selects p.* so it should be there.
      address: (appt as any).address
    };

    if (!this.patientService.isPatientComplete(patientObj as any)) {
      await this.dialogService?.open({
        title: 'Details needed',
        message: 'Some essentials are missing. Opened the patient chart to complete them before check-in.',
        type: 'warning'
      });
      void this.router.navigate(['/patients'], { queryParams: { editId: appt.patient_id } });
      return;
    }

    try {
      // Add to Queue
      await this.dataService.invoke('addToQueue', { patientId: appt.patient_id, priority: 1 });
      // Update Appointment Status
      await this.cloudService.saveAppointment({ id: appt.id, status: 'CHECKED_IN' });

      this.toastService?.success(`${appt.patient_name} is now in the live queue.`, 'Checked in');
      void this.queueCountService?.refresh();
      void this.loadData(); // Refresh list
    } catch (e: any) {
      console.error(e);
      if (e.message && e.message.includes('already in queue')) {
        // Just update status if already keyed
        await this.cloudService.saveAppointment({ id: appt.id, status: 'CHECKED_IN' });
        void this.loadData();
      } else {
        await this.dialogService?.open({
          title: 'Check-in failed',
          message: e.message ? `Could not check in: ${e.message}` : 'Could not check in.',
          type: 'error'
        });
      }
    }
  }

  goToPatients() {
    void this.router.navigate(['/patients']);
  }

  goToQueue() {
    void this.router.navigate(['/queue']);
  }

  goToSettings() {
    void this.router.navigate(['/settings']);
  }
}
