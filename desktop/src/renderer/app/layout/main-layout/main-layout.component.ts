import { Component, ViewChild, ElementRef, NgZone, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { NavigationEnd, NavigationStart, RouterOutlet, RouterModule, Router } from '@angular/router';
import { Subscription } from 'rxjs';
import { DialogService } from '../../shared/services/dialog.service';
import { DoctorPickService } from '../../shared/services/doctor-pick.service';
import { AuthService } from '../../services/auth.service';
import { QueueCountService } from '../../shared/services/queue-count.service';
import { RuntimeService } from '../../services/runtime.service';
import { TourService } from '../../shared/services/tour.service';
import { TourOverlayComponent } from '../../shared/components/tour-overlay/tour-overlay.component';

@Component({
  selector: 'app-main-layout',
  standalone: true,
  imports: [CommonModule, RouterOutlet, RouterModule, TourOverlayComponent],
  template: `
    <div class="drawer lg:drawer-open font-sans">
      <input #drawerCheckbox id="main-drawer" type="checkbox" class="drawer-toggle" />
      
      <div class="drawer-content flex flex-col min-h-screen bg-gray-100">
        <!-- Window Title Bar Spacer REMOVED to fix white space issue -->
        <!-- <div class="w-full h-8 bg-white flex-none sticky top-0 z-50" style="-webkit-app-region: drag"></div> -->

        <!-- Header -->
        <div class="navbar bg-white shadow-sm sticky top-0 z-30 h-16 border-b border-gray-200">
          <div class="flex-none lg:hidden">
            <label for="main-drawer" aria-label="open sidebar" class="btn btn-square btn-ghost">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="inline-block w-6 h-6 stroke-current"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16"></path></svg>
            </label>
          </div>
          <div class="flex-1 px-4 flex items-center gap-3">
             <!-- Mobile Logo -->
             <div class="w-8 h-8 rounded overflow-hidden lg:hidden bg-transparent">
                <img src="assets/logo.png" alt="NalamDesk" class="w-full h-full object-cover transform scale-125" />
             </div>
            <div class="text-sm breadcrumbs">
              <ul>
                <li class="font-medium text-blue-800">{{ currentRouteName }}</li>
              </ul>
            </div>
          </div>
          <div class="flex-none gap-4 px-4">
             <!-- Theme Toggle (Simplified for now) -->
                <!-- Local IP Indicator (Enterprise Style) -->
                 <div *ngIf="runtime.lanAccessUrl" class="hidden md:flex items-center gap-2 bg-blue-50/50 px-3 py-1.5 rounded-full border border-blue-100 hover:bg-blue-50 transition-colors group">
                    <span class="relative flex h-2 w-2">
                      <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                      <span class="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
                    </span>
                    <span class="font-mono text-xs text-blue-800 font-semibold tracking-wide">{{ runtime.lanAccessUrl }}</span>
                    
                    <!-- Copy Button -->
                    <button class="btn btn-circle btn-xs btn-ghost text-blue-400 hover:text-blue-700 hover:bg-blue-100/50 min-h-0 h-5 w-5 ml-1" 
                            (click)="copyIp()" 
                            [title]="isCopied ? 'Copied!' : 'Copy Address'">
                        <svg *ngIf="!isCopied" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                        <span *ngIf="isCopied" class="text-[10px] font-bold text-green-600">✓</span>
                    </button>
                 </div>

                 <!-- Theme Toggle (Simplified for now) -->
                 <div class="dropdown dropdown-end">
                    <div tabindex="0" role="button" class="btn btn-ghost btn-circle avatar placeholder">
                      <div class="bg-blue-800 text-white rounded-full w-10">
                        <span class="text-sm font-bold">{{ getUserInitials() }}</span>
                      </div>
                    </div>
    
                    <!-- Add closeDrawer() to dropdown links too just in case -->
                    <ul tabindex="0" class="mt-3 z-[1] p-2 shadow-menu menu menu-sm dropdown-content bg-white rounded-box w-52">
                      <li><a routerLink="/profile" (click)="closeDrawer()">Change password</a></li>
                      <li><a (click)="retakeTour(); closeDrawer()">Take a product tour</a></li>
                      <li *ngIf="currentUser?.role === 'admin'"><a routerLink="/settings" (click)="closeDrawer()">Manage Profile</a></li>
                      <li *ngIf="currentUser?.role === 'admin'"><a routerLink="/settings" (click)="closeDrawer()">Settings</a></li>
                      <li><a class="text-red-600" (click)="logout()">Logout</a></li>
                    </ul>
                 </div>
          </div>
        </div>

        <!-- Main Content -->
        <!-- Global Layout: Parent is overflow-hidden, Child views MUST handle scrolling -->
        <main class="flex-1 h-full w-full overflow-hidden relative flex flex-col">
           <router-outlet></router-outlet>
           <app-tour-overlay></app-tour-overlay>
        </main>
      </div> 
      
      <!-- Sidebar -->
      <div class="drawer-side z-40">
        <label for="main-drawer" aria-label="close sidebar" class="drawer-overlay"></label> 
        <ul class="menu p-4 w-72 min-h-full bg-white text-gray-800 border-r border-gray-200 gap-1">
          <!-- Logo Area -->
          <li class="mb-6 mt-2">
            <div class="flex items-center gap-3 px-2 hover:bg-transparent">
              <div class="w-10 h-10 rounded-xl overflow-hidden flex items-center justify-center bg-transparent relative group">
                 <div class="absolute inset-0 bg-blue-50 group-hover:bg-blue-100 transition-colors"></div>
                 <img src="assets/icon.png" alt="NalamDesk" class="w-[140%] h-[140%] max-w-none object-cover transform scale-125" />
              </div>
              <div>
                <div class="font-bold text-lg leading-tight tracking-tight text-blue-900">NalamDesk</div>
                <div class="text-xs opacity-50 font-medium tracking-wide">PRACTICE</div>
              </div>
            </div>
          </li>

          <!-- Navigation Items -->
          <li class="menu-title px-2 uppercase tracking-wider font-bold text-[11px] opacity-50 mt-2">Menu</li>
          
          <li>
            <a routerLink="/dashboard" routerLinkActive="active" class="group" (click)="closeDrawer()">
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="group-active:text-white"><rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/></svg>
              Dashboard
            </a>
          </li>
          
          <li class="menu-title px-2 uppercase tracking-wider font-bold text-[11px] opacity-50 mt-4">Patient Management</li>

          <li>
            <a routerLink="/queue" routerLinkActive="active" #queueRla="routerLinkActive" class="group" (click)="closeDrawer()">
               <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/></svg>
              Queue
              <span *ngIf="queueCount > 0" class="badge badge-sm ml-auto border-0 font-bold"
                    [ngClass]="queueRla.isActive ? 'bg-white/25 text-white' : 'bg-blue-100 text-blue-700'">{{ queueCount }}</span>
            </a>
          </li>
          <li>
            <a routerLink="/online-booking" routerLinkActive="active" class="group" (click)="closeDrawer()">
               <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>
              Online Booking
            </a>
          </li>
          <li>
            <a routerLink="/patients" routerLinkActive="active" class="group" (click)="closeDrawer()">
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
              Patients
            </a>
          </li>
          <li>
            <a routerLink="/visits" routerLinkActive="active" class="group" (click)="closeDrawer()">
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
              Visits
            </a>
          </li>

           <li class="menu-title px-2 uppercase tracking-wider font-bold text-[11px] opacity-50 mt-4" *ngIf="currentUser?.role === 'admin'">System</li>

          <li *ngIf="currentUser?.role === 'admin'">
            <a routerLink="/settings" routerLinkActive="active" class="group" (click)="closeDrawer()">
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.1a2 2 0 0 1-1-1.72v-.51a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>
              Settings
            </a>
          </li>
        </ul>
      </div>
    </div>
    
    <!-- Attending-doctor picker for admin-initiated consultations -->
    <div *ngIf="doctorPick?.open()" class="fixed inset-0 z-[100] flex items-center justify-center p-4"
         role="dialog" aria-modal="true" aria-label="Select responsible doctor">
      <div class="fixed inset-0 bg-black/50" (click)="doctorPick?.choose(null)"></div>
      <div class="relative w-full max-w-md rounded-lg bg-white p-6 shadow-lg border border-gray-200">
        <h3 class="text-lg font-bold text-gray-800">Select responsible doctor</h3>
        <p class="text-sm text-gray-500 mt-1">The consultation is recorded under their license. They remain clinically responsible.</p>
        <div class="mt-4 space-y-2 max-h-64 overflow-y-auto">
          <button *ngFor="let d of doctorPick?.doctors() ?? []" (click)="doctorPick?.choose(d.id)"
                  class="w-full text-left px-4 py-3 rounded-lg border border-gray-200 hover:border-blue-400 hover:bg-blue-50 transition flex items-center justify-between gap-3">
            <span>
              <span class="block font-semibold text-gray-800">{{ d.name }}</span>
              <span class="block text-xs text-gray-500">{{ d.specialty || 'General' }}<span *ngIf="d.license_number"> • {{ d.license_number }}</span></span>
            </span>
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="w-4 h-4 text-gray-400"><path stroke-linecap="round" stroke-linejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" /></svg>
          </button>
        </div>
        <div class="mt-4 flex justify-end">
          <button (click)="doctorPick?.choose(null)" class="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded border bg-white transition-colors">Cancel</button>
        </div>
      </div>
    </div>

  `,
  styles: [`
    .menu a {
        @apply rounded-lg font-medium text-gray-600 hover:text-primary hover:bg-base-200 transition-all duration-200 outline-none;
    }
    .menu a.active, .menu a.router-link-active {
        @apply !bg-primary !text-white;
    }
    /* Ensure active item hover state */
    .menu a.active:hover, .menu a.router-link-active:hover {
        @apply !bg-primary !text-white brightness-110;
    }
    /* Icon handling */
    .menu a svg {
        @apply stroke-current;
    }
  `]
})
export class MainLayoutComponent implements OnInit, OnDestroy {
  /** Sidebar badge: live count served by QueueCountService (0 pre-login). */
  get queueCount(): number {
    try {
      return this.queueCountService?.count() ?? 0;
    } catch {
      return 0;
    }
  }
  currentUser: any = null;
  private routerSub?: Subscription;

  @ViewChild('drawerCheckbox') drawerCheckbox!: ElementRef<HTMLInputElement>;

  constructor(
    public router: Router,
    public dialogService: DialogService,
    private authService: AuthService,
    private ngZone: NgZone,
    public runtime: RuntimeService,
    public tourService: TourService,
    public doctorPick?: DoctorPickService,
    private queueCountService?: QueueCountService
  ) {
    this.currentUser = this.authService.getUser();
  }

  retakeTour() {
    try {
      localStorage.removeItem('nd.tour.dismissed');
    } catch { /* ignore */ }
    this.tourService.start(this.currentUser?.role || '');
  }

  private badgeRefreshId: any;

  ngOnInit() {
    if (!!(globalThis as any).electron) {
      void this.runtime.init();
    }
    void this.queueCountService?.refresh();
    // Backup cadence for mutations that don't navigate (same 30s as the queue page).
    this.badgeRefreshId = setInterval(() => void this.queueCountService?.refresh(), 30000);
    this.routerSub = this.router.events.subscribe(event => {
      if (event instanceof NavigationStart) {
        this.dialogService.close();
      }
      if (event instanceof NavigationEnd) {
        void this.queueCountService?.refresh();
      }
    });
  }

  ngOnDestroy() {
    if (this.badgeRefreshId) clearInterval(this.badgeRefreshId);
    this.routerSub?.unsubscribe();
  }

  isCopied = false;

  copyIp() {
    if (!this.runtime.lanAccessUrl) return;

    const textToCopy = this.runtime.lanAccessUrl;

    // 1. Try Electron IPC (Reliable)
    if ((globalThis as any).electron && (globalThis as any).electron.clipboard) {
      (globalThis as any).electron.clipboard.writeText(textToCopy).then(() => {
        this.showCopyFeedback();
      });
    }
    // 2. Fallback to Browser API (Dev/Web)
    else {
      navigator.clipboard.writeText(textToCopy).then(() => {
        this.showCopyFeedback();
      }).catch(err => {
        console.error('Copy failed:', err);
        // Fallback: alert? No, just log for now.
      });
    }
  }

  showCopyFeedback() {
    this.ngZone.run(() => {
      this.isCopied = true;
      setTimeout(() => {
        this.isCopied = false;
      }, 2000);
    });
  }

  get currentRouteName(): string {
    // Simple extraction, can be enhanced
    const url = this.router.url.split('/')[1];
    if (!url) return 'Dashboard';
    return url.charAt(0).toUpperCase() + url.slice(1);
  }

  closeDrawer() {
    if (this.drawerCheckbox && this.drawerCheckbox.nativeElement.checked) {
      this.drawerCheckbox.nativeElement.checked = false;
    }
  }

  async logout() {
    try {
      await this.authService.logout();
    } catch (e) {
      console.error(e);
    }
  }

  getUserInitials(): string {
    if (!this.currentUser || !this.currentUser.name) return 'U';
    const names = this.currentUser.name.split(' ');
    if (names.length >= 2) {
      return (names[0][0] + names[1][0]).toUpperCase();
    }
    return names[0].substring(0, 2).toUpperCase();
  }
}
