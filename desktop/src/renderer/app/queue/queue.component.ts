
import { Component, HostListener, OnInit, OnDestroy, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { DataService } from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { VitalsFormComponent } from '../visits/vitals/vitals-form.component';
import { newRequestId } from '../services/request-id';
import { DialogService } from '../shared/services/dialog.service';
import { DoctorPickService } from '../shared/services/doctor-pick.service';

@Component({
  selector: 'app-queue',
  standalone: true,
  imports: [CommonModule, FormsModule, VitalsFormComponent],
  template: `
    <div class="h-full bg-gray-50 p-4 md:p-8 font-sans flex flex-col overflow-hidden">
      <div class="w-full">
        <!-- Header -->
        <div class="flex justify-between items-center mb-8">
           <div class="flex items-center gap-4">
             <button (click)="goBack()" class="btn btn-circle btn-ghost">
               <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
             </button>
             <div>
               <h1 class="text-2xl font-bold text-gray-800">Patient Queue</h1>
               <p class="text-gray-600">Actionable clinical triage and consultations</p>
             </div>
           </div>
           
           <div class="stats shadow bg-white">
             <div class="stat place-items-center">
               <div class="stat-title">Waiting</div>
               <div class="stat-value text-blue-600">{{ queue().length }}</div>
             </div>
           </div>
        </div>

        <!-- Main Card (Flex child takes remaining height) -->
        <!-- Scan & Share dock: incoming ABHA tokens awaiting 1-click check-in -->
        <div *ngIf="shareTokens.length > 0" class="mb-4 rounded-lg border border-blue-200 bg-blue-50/60 p-3">
          <div class="flex items-center justify-between mb-2">
            <h3 class="text-sm font-bold text-blue-800">Incoming Scans ({{ shareTokens.length }})</h3>
            <span class="text-xs text-blue-600">Press Space or tap a token to check in</span>
          </div>
          <div class="flex flex-wrap gap-2">
            <button *ngFor="let t of shareTokens" (click)="acceptShareToken(t)"
                    [disabled]="acceptingTokenId != null"
                    class="bg-white border border-blue-200 hover:border-blue-500 hover:bg-blue-50 rounded-lg px-3 py-2 text-sm transition text-left shadow-sm disabled:opacity-50">
              <span class="font-bold text-blue-800">[Token #{{ t.token_no }}]</span>
              <span class="font-medium text-gray-800 ml-1">{{ t.patient_name }}</span>
              <span class="text-gray-500 text-xs ml-1">{{ t.age || '-' }}/{{ t.gender || '-' }}</span>
              <span *ngIf="t.abha_address" class="block font-mono text-xs text-blue-700 mt-0.5">{{ t.abha_address }}</span>
            </button>
          </div>
        </div>
        <div class="card bg-white shadow-sm border border-gray-200 flex-1 overflow-hidden flex flex-col">
          <div class="card-body p-0 flex-1 overflow-y-auto relative">
            <div class="overflow-x-auto">
              <table class="table table-lg">
                <thead class="bg-base-200/50 text-base-content/70 sticky top-0 z-10 backdrop-blur-sm">
                  <tr>
                    <th class="min-w-[120px]">Urgency / Triage</th>
                    <th class="min-w-[200px]">Patient Details</th>
                    <th class="min-w-[140px]">Check-in Time</th>
                    <th class="min-w-[120px]">Status</th>
                    <th class="text-right min-w-[180px]">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  <tr *ngFor="let item of queue()" 
                      class="hover:bg-base-200/50 transition-colors border-b border-base-200 last:border-0 group">
                    <td>
                      <div class="flex flex-col gap-1">
                        <div class="flex items-center gap-2">
                          <span class="badge badge-sm font-bold uppercase tracking-wider"
                                [ngClass]="{
                                  'badge-error text-white animate-pulse': item.urgency === 'immediate',
                                  'badge-warning': item.urgency === 'urgent',
                                  'badge-info': item.urgency === 'priority',
                                  'badge-ghost text-gray-700': item.urgency === 'routine' || !item.urgency
                                }">
                            {{ getItemUrgency(item) }}
                          </span>
                        </div>
                        <span *ngIf="item.triage_notes" class="text-xs text-gray-500 italic max-w-[160px] truncate" [title]="item.triage_notes">
                          {{ item.triage_notes }}
                        </span>
                      </div>
                    </td>
                    <td>
                      <div class="flex items-center gap-4">
                        <div class="avatar placeholder">
                          <div class="bg-neutral text-neutral-content rounded-full w-12">
                            <span class="text-lg">{{ item.patient_name.charAt(0) }}</span>
                          </div>
                        </div>
                        <div>
                          <div class="font-bold text-lg flex items-center gap-2">
                            {{ item.patient_name }}
                          </div>
                          <div class="text-sm opacity-60">{{ item.age }} years • {{ item.gender }}</div>
                          <div *ngIf="item.has_abnormal_vitals" 
                               class="badge badge-error badge-outline gap-1 text-xs cursor-help mt-1 font-semibold"
                               [title]="item.vitals_alerts?.join('\n')">
                            <svg xmlns="http://www.w3.org/2000/svg" class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
                            Abnormal Vitals
                          </div>
                        </div>
                      </div>
                    </td>
                    <td class="font-mono text-sm opacity-70">
                      <div class="flex flex-col">
                        <span>{{ item.check_in_time | date:'shortTime' }}</span>
                        <span class="text-xs text-secondary font-bold" *ngIf="item.status === 'waiting'">
                           {{ getWaitTime(item.check_in_time) }} wait
                        </span>
                      </div>
                    </td>
                    <td>
                      <div class="badge badge-lg gap-2" [ngClass]="{
                        'badge-primary': item.status === 'in-consult',
                        'badge-ghost': item.status === 'waiting'
                      }">
                        <div class="w-2 h-2 rounded-full bg-current"></div>
                        {{ item.status | titlecase }}
                      </div>
                    </td>
                    <td class="text-right">
                      <div class="join opacity-0 group-hover:opacity-100 transition-opacity">
                        <button *ngIf="item.status === 'waiting'" 
                                (click)="openTriageModal(item)"
                                class="btn btn-warning btn-outline btn-sm join-item">
                          Triage
                        </button>
                        <button *ngIf="item.status === 'waiting'" 
                                (click)="openVitals(item)"
                                class="btn btn-secondary btn-sm join-item">
                          Vitals
                        </button>
                        <button *ngIf="item.status === 'waiting'" 
                                (click)="startConsult(item)"
                                class="btn btn-primary btn-sm join-item">
                          {{ item.active_encounter_id ? 'Resume Consult' : 'Start Consult' }}
                        </button>
                        <button *ngIf="item.status === 'in-consult'"
                                (click)="startConsult(item)"
                                class="btn btn-primary btn-sm join-item">
                          Resume Consult
                        </button>
                        <button *ngIf="item.status === 'waiting'" (click)="remove(item.id)" class="btn btn-error btn-outline btn-sm join-item">
                          Remove
                        </button>
                      </div>
                      <!-- Mobile fallback or always visible action if hover isn't reliable -->
                      <button (click)="startConsult(item)" class="btn btn-circle btn-sm btn-primary md:hidden" aria-label="Start consultation">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="w-4 h-4"><path stroke-linecap="round" stroke-linejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" /></svg>
                      </button>
                    </td>
                  </tr>
                  
                  <!-- Empty State -->
                  <tr *ngIf="queue().length === 0">
                    <td colspan="5" class="py-20 text-center">
                       <div class="flex flex-col items-center gap-4 opacity-50">
                         <svg xmlns="http://www.w3.org/2000/svg" class="w-24 h-24" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" /></svg>
                         <h3 class="text-xl font-bold">All Clear!</h3>
                         <p>No patients currently in the queue.</p>
                       </div>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
      
      <!-- Reassess Triage Modal -->
      <div *ngIf="showTriageModal" class="modal modal-open">
        <div class="modal-box max-w-lg">
          <h3 class="font-bold text-lg flex items-center gap-2 text-gray-800">
            <svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5 text-warning" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
            Triage Reassessment: {{ selectedQueueItem?.patient_name }}
          </h3>
          <p class="text-sm text-gray-500 mt-1">Current Urgency: <span class="font-bold uppercase text-gray-700">{{ selectedQueueItem?.urgency }}</span></p>

          <div class="form-control mt-4">
            <label class="label"><span class="label-text font-semibold">Select New Urgency Tier</span></label>
            <div class="grid grid-cols-2 gap-2">
              <button type="button" 
                      (click)="selectedUrgency = 'immediate'" 
                      class="btn btn-sm"
                      [ngClass]="selectedUrgency === 'immediate' ? 'btn-error text-white' : 'btn-outline btn-error'">
                Immediate (Red)
              </button>
              <button type="button" 
                      (click)="selectedUrgency = 'urgent'" 
                      class="btn btn-sm"
                      [ngClass]="selectedUrgency === 'urgent' ? 'btn-warning' : 'btn-outline btn-warning'">
                Urgent (Orange)
              </button>
              <button type="button" 
                      (click)="selectedUrgency = 'priority'" 
                      class="btn btn-sm"
                      [ngClass]="selectedUrgency === 'priority' ? 'btn-info' : 'btn-outline btn-info'">
                Priority (Yellow)
              </button>
              <button type="button" 
                      (click)="selectedUrgency = 'routine'" 
                      class="btn btn-sm"
                      [ngClass]="selectedUrgency === 'routine' ? 'btn-neutral text-white' : 'btn-outline'">
                Routine (Green)
              </button>
            </div>
          </div>

          <div class="form-control mt-4">
            <label class="label"><span class="label-text font-semibold">Clinical Reason for Reassessment *</span></label>
            <textarea [(ngModel)]="triageReason" 
                      rows="2" 
                      placeholder="Enter clinical reason (e.g., patient condition worsening, chest pain onset...)" 
                      class="textarea textarea-bordered w-full"></textarea>
          </div>

          <!-- Triage History -->
          <div *ngIf="triageHistory.length > 0" class="mt-4 border-t pt-3">
            <h4 class="text-xs font-bold uppercase text-gray-500 mb-2">Triage Audit Trail</h4>
            <div class="max-h-32 overflow-y-auto space-y-2 text-xs">
              <div *ngFor="let h of triageHistory" class="p-2 bg-gray-100 rounded flex justify-between items-start">
                <div>
                  <span class="font-bold uppercase text-blue-700">{{ h.new_urgency || h.urgency_label }}</span>
                  <span class="text-gray-600 ml-1">- {{ h.reason }}</span>
                </div>
                <div class="text-gray-500 text-right shrink-0 ml-2">
                  <div>{{ h.assessor_name || 'Staff' }}</div>
                  <div>{{ h.created_at | date:'shortTime' }}</div>
                </div>
              </div>
            </div>
          </div>

          <div class="modal-action">
            <button type="button" class="btn btn-ghost" (click)="closeTriageModal()">Cancel</button>
            <button type="button" class="btn btn-primary" [disabled]="!triageReason.trim() || savingTriage" (click)="submitTriageReassessment()">
              {{ savingTriage ? 'Saving...' : 'Update Urgency' }}
            </button>
          </div>
        </div>
      </div>

      <!-- Vitals Modal -->
      <app-vitals-form *ngIf="showVitalsModal" 
        (closeDialog)="closeVitalsModal()" 
        (vitalsSaved)="onVitalsSaved($event)"
        [patientId]="selectedPatientIdForVitals"
        [queueEntryId]="selectedQueueEntryIdForVitals"
        [visitId]="selectedVisitIdForVitals">
      </app-vitals-form>
    </div>
  `
})
export class QueueComponent implements OnInit, OnDestroy {
  queue = signal<any[]>([]);
  refreshIntervalId: any;
  private readonly startRequestIds = new Map<number, string>();

  constructor(
    private router: Router,
    private dataService: DataService,
    private dialogService: DialogService,
    private authService?: AuthService,
    private doctorPick?: DoctorPickService
  ) { }

  ngOnInit() {
    this.refreshQueue();
    this.refreshShareTokens();
    // Poll every 30 seconds
    this.refreshIntervalId = setInterval(() => this.refreshQueue(), 30000);
    // Scan & Share dock refreshes faster so accepted scans appear at once.
    this.sharePollId = setInterval(() => this.refreshShareTokens(), 5000);
  }

  ngOnDestroy() {
    if (this.refreshIntervalId) clearInterval(this.refreshIntervalId);
    if (this.sharePollId) clearInterval(this.sharePollId);
  }

  shareTokens: any[] = [];
  sharePollId: any;
  acceptingTokenId: number | null = null;

  async refreshShareTokens() {
    try {
      const tokens = await this.dataService.invoke<any[]>('abdmGetShareTokens').catch(() => []);
      this.shareTokens = tokens || [];
    } catch (e) {
      console.error('Failed to load share tokens', e);
    }
  }

  @HostListener('document:keydown', ['$event'])
  onDocumentKeydown(event: KeyboardEvent) {
    this.acceptFirstTokenIfIdle(event);
  }

  // Spacebar accepts the oldest pending scan when the receptionist is not
  // typing, and no other modal owns the keyboard.
  acceptFirstTokenIfIdle(event: KeyboardEvent): boolean {
    if (event.key !== ' ') return false;
    const target = event.target as HTMLElement | null;
    const tag = (target?.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || target?.isContentEditable) return false;
    if (this.showTriageModal || this.showVitalsModal || this.shareTokens.length === 0 || this.acceptingTokenId != null) return false;
    event.preventDefault();
    void this.acceptShareToken(this.shareTokens[0]);
    return true;
  }

  async acceptShareToken(token: any) {
    if (!token || this.acceptingTokenId != null) return;
    this.acceptingTokenId = token.id;
    try {
      // One atomic server call: claim, match-or-create, and queue together.
      // Partial states (queued patient with a failed accept) are impossible.
      const result: any = await this.dataService.invoke(
        'abdmAcceptShareTokenAndCheckIn', { tokenId: token.id });
      if (result?.outcome === 'incomplete' && result?.patientId) {
        await this.dialogService.open({
          title: 'Details needed',
          message: 'Some essentials are missing. Opened the patient chart to complete them — the token stays pending.',
          type: 'info'
        });
        this.router.navigate(['/patients', result.patientId]);
      } else {
        await this.refreshQueue();
      }
      await this.refreshShareTokens();
    } catch (e) {
      console.error('Failed to accept share token', e);
      await this.dialogService.open({
        title: 'Could not check in',
        message: e instanceof Error && e.message ? e.message : 'Could not check in this token.',
        type: 'error'
      });
    } finally {
      this.acceptingTokenId = null;
    }
  }

  goBack() {
    this.router.navigate(['/dashboard']);
  }

  getItemUrgency(item: any): string {
    if (item?.urgency) return item.urgency;
    if (item?.priority >= 4) return 'immediate';
    if (item?.priority === 3) return 'urgent';
    if (item?.priority === 2) return 'priority';
    return 'routine';
  }

  async refreshQueue() {
    try {
      const data = await this.dataService.invoke<any>('getQueue');
      this.queue.set(data);
    } catch (e) {
      console.error('Failed to load queue', e);
    }
  }

  async startConsult(item: any) {
    try {
      let encounter: any;
      if (item.active_encounter_id) {
        encounter = await this.dataService.invoke<any>('resumeConsultation', { encounterId: item.active_encounter_id });
      } else {
        const startRequestId = this.startRequestIds.get(item.id) || newRequestId();
        this.startRequestIds.set(item.id, startRequestId);
        let doctorId: number | undefined;
        const currentUser = this.authService?.getUser();
        if (currentUser?.role === 'admin') {
          const doctors = await this.dataService.invoke<any[]>('getDoctors').catch(() => []);
          if (!doctors || doctors.length === 0) {
            await this.dialogService.open({
              title: 'No responsible doctor',
              message: 'No active doctor on file. An admin consultation needs a licensed practitioner attached.',
              type: 'warning'
            });
            return;
          }
          // One doctor -> deterministic; several -> the admin explicitly picks the attending.
          const picked = this.doctorPick ? await this.doctorPick.request(doctors) : doctors[0]?.id ?? null;
          if (picked == null) return;
          doctorId = picked;
        }
        encounter = await this.dataService.invoke<any>('beginConsultation', {
          patientId: item.patient_id,
          queueEntryId: item.id,
          startRequestId,
          ...(doctorId ? { doctorId } : {})
        });
        this.startRequestIds.delete(item.id);
      }
      await this.refreshQueue();
      this.router.navigate(['/visit', item.patient_id], {
        state: { isConsulting: true, encounterId: encounter.id, patientName: item.patient_name }
      });
    } catch (e) {
      console.error('Could not start consultation', e);
      const raw = e instanceof Error ? e.message : '';
      // Another practitioner's in-progress encounter: denial by design
      // (clinical responsibility), so explain instead of dumping IPC framing.
      const denied = /responsible practitioner|forbidden|unauthorized/i.test(raw);
      const cause = raw ? String(raw.split('Error: ').pop()).trim() : '';
      await this.dialogService.open({
        title: denied ? 'Consultation in progress' : 'Error',
        message: denied
          ? 'This consultation was started by another practitioner. Only they, or the staff member who started it, can resume it.'
          : cause ? `Failed to start consultation: ${cause}` : 'Failed to start consultation',
        type: denied ? 'warning' : 'error'
      });
    }
  }

  async remove(id: number) {
    if (confirm('Remove from queue?')) {
      try {
        await this.dataService.invoke<any>('removeFromQueue', id);
        this.refreshQueue();
      } catch (e) {
        console.error('Remove failed', e);
        await this.dialogService.open({
          title: 'Error',
          message: e instanceof Error && e.message
            ? `Failed to remove from queue: ${e.message}`
            : 'Failed to remove from queue',
          type: 'error'
        });
      }
    }
  }

  getWaitTime(dateStr: string): string {
    if (!dateStr) return '';
    // Normalize SQL date space to T for reliable parsing
    const normalized = dateStr.replace(' ', 'T');
    const timestampStr = normalized.endsWith('Z') ? normalized : normalized + 'Z';
    const start = new Date(timestampStr).getTime();
    const now = new Date().getTime();

    if (isNaN(start)) return '';

    // If date is future (clock skew), return 0m
    if (start > now) return '0m';

    const diff = Math.floor((now - start) / 60000); // minutes
    if (diff < 60) return `${diff}m`;
    const h = Math.floor(diff / 60);
    const m = diff % 60;
    return `${h}h ${m}m`;
  }

  // Vitals Logic
  showVitalsModal = false;
  selectedPatientIdForVitals: number | null = null;
  selectedQueueEntryIdForVitals: number | null = null;
  selectedVisitIdForVitals: number | null = null;

  openVitals(item: any) {
    if (typeof item === 'number') {
      this.selectedPatientIdForVitals = item;
      this.selectedQueueEntryIdForVitals = null;
      this.selectedVisitIdForVitals = null;
    } else if (item && typeof item === 'object') {
      this.selectedPatientIdForVitals = item.patient_id;
      this.selectedQueueEntryIdForVitals = item.id;
      this.selectedVisitIdForVitals = item.active_encounter_id || null;
    }
    this.showVitalsModal = true;
  }

  closeVitalsModal() {
    this.showVitalsModal = false;
    this.selectedPatientIdForVitals = null;
    this.selectedQueueEntryIdForVitals = null;
    this.selectedVisitIdForVitals = null;
  }

  onVitalsSaved(_data: any) {
    this.closeVitalsModal();
  }

  // Triage Reassessment Logic
  showTriageModal = false;
  selectedQueueItem: any = null;
  selectedUrgency = 'routine';
  triageReason = '';
  triageHistory: any[] = [];
  savingTriage = false;

  async openTriageModal(item: any) {
    this.selectedQueueItem = item;
    this.selectedUrgency = item.urgency || 'routine';
    this.triageReason = '';
    this.showTriageModal = true;
    try {
      this.triageHistory = await this.dataService.invoke('getQueueTriageHistory', item.id);
    } catch {
      this.triageHistory = [];
    }
  }

  closeTriageModal() {
    this.showTriageModal = false;
    this.selectedQueueItem = null;
    this.triageReason = '';
    this.triageHistory = [];
  }

  async submitTriageReassessment() {
    if (!this.selectedQueueItem || !this.triageReason.trim()) return;
    this.savingTriage = true;
    try {
      await this.dataService.invoke('reassessQueueTriage', {
        queueId: this.selectedQueueItem.id,
        urgency: this.selectedUrgency,
        reason: this.triageReason.trim()
      });
      this.closeTriageModal();
      await this.refreshQueue();
    } catch (e: any) {
      await this.dialogService.open({
        title: 'Triage Update Failed',
        message: e.message || 'Could not update triage urgency',
        type: 'error'
      });
    } finally {
      this.savingTriage = false;
    }
  }
}
