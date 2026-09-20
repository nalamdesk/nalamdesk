
import { Component, HostListener, OnInit, OnDestroy, signal } from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { DataService } from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { VitalsFormComponent } from '../visits/vitals/vitals-form.component';
import { newRequestId } from '../services/request-id';
import { DialogService } from '../shared/services/dialog.service';
import { SharedTableComponent } from '../shared/components/table/table.component';
import { ColDef } from 'ag-grid-community';
import { DoctorPickService } from '../shared/services/doctor-pick.service';

@Component({
  selector: 'app-queue',
  standalone: true,
  imports: [CommonModule, FormsModule, VitalsFormComponent, SharedTableComponent],
  template: `
    <div class="h-full bg-gray-50 p-4 md:p-8 font-sans flex flex-col overflow-hidden">
      <div class="w-full">
        <!-- Header -->
        <div class="flex justify-between items-center mb-4">
          <div class="flex items-center gap-4">
            <button (click)="goBack()" class="btn btn-circle btn-ghost" aria-label="Back">
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
            </button>
            <div>
              <h1 class="text-2xl font-bold text-gray-800">Patient Queue</h1>
              <p class="text-gray-600">Actionable clinical triage and consultations</p>
            </div>
          </div>
        </div>

        <!-- Standard AG Grid (shared-table, cf. Settings and Patient Chart) -->
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
        <div class="h-[calc(100vh-15rem)] min-h-[320px]">
          <app-shared-table [rowData]="queue()" [columnDefs]="queueColumnDefs" [pagination]="false" [pageSize]="50">
            <div toolbar-left class="flex items-center gap-2">
              <span class="text-xs text-gray-500">{{ queue().length }} in queue</span>
            </div>
          </app-shared-table>
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

  private escHtml(value: unknown): string {
    const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return String(value ?? '').replace(/[&<>"']/g, (c) => map[c]);
  }

  // Standard AG Grid columns (shared-table). Same clinical chrome as the
  // previous hand table: urgency badges, patient identity with vitals alerts,
  // check-in times, status, and per-row actions. All row buttons stay visible
  // (no hover reveal) so touch and keyboard users get the same actions.
  queueColumnDefs: ColDef[] = [
    {
      headerName: 'Urgency / Triage', flex: 1.2, minWidth: 150,
      valueGetter: (params: any) => this.getItemUrgency(params.data),
      // Clinical severity order, not lexical: immediate > urgent > priority > routine.
      comparator: (a: any, b: any) => this.urgencyRank(a) - this.urgencyRank(b),
      cellRenderer: (params: any) => {
        const level = String(params.value || 'routine');
        const badge = level === 'immediate' ? 'badge-error text-white animate-pulse'
          : level === 'urgent' ? 'badge-warning'
          : level === 'priority' ? 'badge-info' : 'badge-ghost text-gray-700';
        const notes = params.data?.triage_notes
          ? `<div class="text-xs text-gray-500 italic" title="${this.escHtml(params.data.triage_notes)}">${this.escHtml(params.data.triage_notes)}</div>`
          : '';
        return `<span class="badge badge-sm font-bold uppercase tracking-wider ${badge}">${this.escHtml(level)}</span>${notes}`;
      }
    },
    {
      headerName: 'Patient Details', field: 'patient_name', flex: 2, minWidth: 220,
      cellRenderer: (params: any) => {
        const item = params.data;
        if (!item) return '';
        const initial = this.escHtml(String(item.patient_name || '?').charAt(0).toUpperCase());
        const alerts = (item.vitals_alerts || []).map((a: string) => this.escHtml(a)).join('\n');
        const vitalsBadge = item.has_abnormal_vitals
          ? `<div class="badge badge-error badge-outline gap-1 text-xs mt-1 font-semibold" title="${alerts}">Abnormal Vitals</div>`
          : '';
        return `<div class="flex items-center gap-3">
            <div class="w-10 h-10 rounded-full bg-neutral text-neutral-content flex items-center justify-center font-bold">` +
              `${initial}</div>
            <div>
              <div class="font-bold text-gray-800">${this.escHtml(item.patient_name)}</div>
              <div class="text-xs text-gray-500">${this.escHtml(item.age)} years • ${this.escHtml(item.gender)}</div>
              ${vitalsBadge}
            </div>
          </div>`;
      }
    },
    {
      headerName: 'Check-in Time', flex: 1, minWidth: 140,
      valueGetter: (params: any) => params.data?.check_in_time || '',
      cellRenderer: (params: any) => {
        const time = params.value ? new DatePipe('en-US').transform(params.value, 'shortTime') || '' : '';
        const wait = params.data?.status === 'waiting' && params.value
          ? `<div class="text-xs text-secondary font-bold">${this.escHtml(this.getWaitTime(params.value))} wait</div>`
          : '';
        return `<span class="font-mono text-sm text-gray-600">${this.escHtml(time)}</span>${wait}`;
      }
    },
    {
      headerName: 'Status', flex: 0.8, minWidth: 120,
      valueGetter: (params: any) => params.data?.status || '',
      cellRenderer: (params: any) => {
        const status = String(params.value || '');
        const label = status.charAt(0).toUpperCase() + status.slice(1);
        const badge = status === 'in-consult' ? 'badge-primary' : 'badge-ghost';
        return `<span class="badge badge-lg gap-2 ${badge}"><span class="w-2 h-2 rounded-full bg-current"></span>${this.escHtml(label)}</span>`;
      }
    },
    {
      headerName: 'Actions', flex: 1.6, minWidth: 280, sortable: false, filter: false,
      cellRenderer: (params: any) => {
        const item = params.data;
        if (!item) return '';
        const consultLabel = item.active_encounter_id ? 'Resume Consult' : 'Start Consult';
        const waiting = `<button data-action="triage" class="btn btn-warning btn-outline btn-sm">Triage</button>
          <button data-action="vitals" class="btn btn-secondary btn-sm">Vitals</button>
          <button data-action="consult" class="btn btn-primary btn-sm">${consultLabel}</button>
          <button data-action="remove" class="btn btn-error btn-outline btn-sm">Remove</button>`;
        const inConsult = `<button data-action="consult" class="btn btn-primary btn-sm">Resume Consult</button>`;
        return `<div class="flex flex-wrap gap-1">${item.status === 'in-consult' ? inConsult : waiting}</div>`;
      },
      onCellClicked: (params: any) => {
        const action = (params.event?.target as HTMLElement)?.closest?.('[data-action]')?.getAttribute('data-action');
        const item = params.data;
        if (!action || !item) return;
        if (action === 'triage') this.openTriageModal(item);
        else if (action === 'vitals') this.openVitals(item);
        else if (action === 'consult') this.startConsult(item);
        else if (action === 'remove') this.remove(item.id);
      }
    }
  ];

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

  private urgencyRank(level: unknown): number {
    switch (String(level || '').toLowerCase()) {
      case 'immediate': return 4;
      case 'urgent': return 3;
      case 'priority': return 2;
      default: return 1;
    }
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
