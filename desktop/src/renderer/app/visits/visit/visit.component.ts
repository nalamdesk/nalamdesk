import { Component, NgZone, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule, ReactiveFormsModule, FormBuilder, FormGroup, FormArray, Validators } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';

import { PdfService } from '../../services/pdf.service';
import { PrescriptionComponent } from '../../visits/prescription/prescription.component';
import { CatalogTypeaheadComponent } from '../../shared/components/catalog-typeahead/catalog-typeahead.component';
import { AuthService } from '../../services/auth.service';
import { DataService } from '../../services/api.service';
import { DialogService } from '../../shared/services/dialog.service';
import { ToastService } from '../../shared/services/toast.service';
import { DoctorPickService } from '../../shared/services/doctor-pick.service';
import { newRequestId } from '../../services/request-id';
import { combineLatest } from 'rxjs';
import { VitalsFormComponent } from '../vitals/vitals-form.component';

interface PrescriptionItem {
  medicine: string;
  frequency: string;
  duration?: string;
  instructions?: string;
}

interface Visit {
  id: number;
  date: string;
  diagnosis: string;
  diagnosis_type?: string;
  symptoms?: string;
  examination_notes?: string;
  prescription: PrescriptionItem[];
  amount_paid: number;
  patient_id?: number;
  doctor_id?: number;
}

@Component({
  selector: 'app-visit',
  standalone: true,
  imports: [CommonModule, FormsModule, ReactiveFormsModule, PrescriptionComponent, CatalogTypeaheadComponent, VitalsFormComponent],
  template: `
    <div class="flex h-full bg-gray-50 font-sans overflow-hidden relative">
      
      <!-- Mobile Backdrop -->
      <div *ngIf="showMobileHistory" (click)="showMobileHistory = false" class="fixed inset-0 bg-black/50 z-40 md:hidden"></div>

      <!-- Left Panel: History & Context (Responsive Drawer) -->
      <div class="fixed inset-y-0 left-0 z-50 w-80 bg-white border-r border-gray-200 flex flex-col h-full shadow-lg transition-transform duration-300 md:relative md:translate-x-0 md:shadow-none"
           [class.translate-x-0]="showMobileHistory"
           [class.-translate-x-full]="!showMobileHistory">
        
        <!-- Back & Header -->
        <div class="p-4 border-b bg-gray-50 flex justify-between items-start">
          <div>
            <button (click)="goBack()" class="text-xs text-gray-500 hover:text-blue-600 mb-2 flex items-center gap-1 font-medium">
                <span class="text-lg">‹</span> Back to Queue
            </button>
            <div *ngIf="patient">
                <h2 class="font-bold text-lg text-gray-800 leading-tight">{{ patient.name }}</h2>
                <p class="text-xs text-gray-500 font-medium mt-1">{{ patient.age }} / {{ patient.gender }} • {{ patient.mobile }}</p>
            </div>
          </div>
          <!-- Close Drawer Button (Mobile Only) -->
           <button (click)="showMobileHistory = false" class="md:hidden text-gray-500 p-1" aria-label="Close history">
             <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="w-5 h-5"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
           </button>
        </div>

        <!-- Scrollable History List -->
        <div class="flex-1 overflow-y-auto p-3 space-y-3 bg-gray-100/50">
           
           <!-- Last Visit PINNED CARD -->
           <div *ngIf="history.length > 0; else noHistory" class="bg-blue-50 border border-blue-200 rounded-lg p-3 shadow-sm relative group">
              <div class="flex justify-between items-start mb-2">
                 <span class="text-xs font-bold text-blue-800 uppercase tracking-wider">Last Visit</span>
                 <span class="text-xs text-blue-600">{{ history[0].date | date:'mediumDate' }}</span>
              </div>
              
              <div class="text-sm text-gray-800 font-medium mb-1 line-clamp-2" title="{{ history[0].diagnosis }}">
                {{ history[0].diagnosis || 'No Diagnosis' }}
              </div>
              
              <div class="text-xs text-gray-600 space-y-1 mb-3">
                 <div *ngFor="let med of history[0].prescription | slice:0:3">
                    • {{ med.medicine }}
                 </div>
                 <div *ngIf="(history[0].prescription?.length || 0) > 3" class="text-gray-500 italic">+ more</div>
              </div>

              <!-- COPY ACTION -->
              <button *ngIf="canEditChart" (click)="copyLastVisit()" class="w-full py-1.5 bg-white border border-blue-300 text-blue-700 text-xs font-bold rounded hover:bg-blue-100 hover:text-blue-900 transition flex items-center justify-center gap-2 shadow-sm">
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-4 h-4"><path stroke-linecap="round" stroke-linejoin="round" d="M15.666 3.888A2.25 2.25 0 0 0 13.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 0 1-.75.75H9a.75.75 0 0 1-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 0 1-2.25 2.25H6.75A2.25 2.25 0 0 1 4.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.472 48.472 0 0 1 1.927-.184" /></svg><span>Copy to Current</span>
              </button>
           </div>
           <ng-template #noHistory>
              <div class="text-center py-8 text-gray-500 text-sm italic">No previous visits.</div>
           </ng-template>

           <!-- Divider -->
           <div *ngIf="history.length > 1" class="text-xs font-bold text-gray-500 uppercase tracking-wider mt-4 mb-2 px-1">Older History</div>

           <!-- Older items -->
           <div *ngFor="let visit of history | slice:1" (click)="editVisit(visit)"
                class="bg-white border rounded p-3 transition shadow-sm"
                [class.hover:border-blue-400]="!isConsulting && !activeEncounterReadOnly" [class.cursor-pointer]="!isConsulting && !activeEncounterReadOnly"
                [class.opacity-60]="isConsulting || activeEncounterReadOnly"
                [class.ring-2]="editingVisitId === visit.id" [class.ring-blue-500]="editingVisitId === visit.id">
              <p class="text-xs text-gray-500 mb-1">{{ visit.date | date:'mediumDate' }}</p>
              <p class="text-sm font-medium text-gray-800 truncate">{{ visit.diagnosis }}</p>
           </div>
        </div>
      </div>

      <!-- Main Panel: The "Chart" (Vertical Document) -->
      <div class="flex-1 flex flex-col h-full bg-white relative overflow-hidden">
        <div *ngIf="consultationLoadError" class="m-3 rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 flex items-center justify-between gap-3">
          <span>{{ consultationLoadError }}</span>
          <button type="button" (click)="retryConsultationLoad()" class="rounded bg-amber-700 px-3 py-1.5 font-semibold text-white hover:bg-amber-800">Retry</button>
        </div>
        
        <!-- Header / Toolbar -->
        <div class="min-h-16 py-2 border-b flex flex-col md:flex-row md:items-center justify-between px-4 md:px-8 bg-white z-20 sticky top-0 gap-2">
           <div class="flex items-center gap-3">
               <!-- Mobile Toggle -->
               <button (click)="showMobileHistory = !showMobileHistory" class="md:hidden btn btn-circle btn-sm btn-ghost">
                   <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-6 h-6">
                     <path stroke-linecap="round" stroke-linejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25H12" />
                   </svg>
               </button>

                <h1 class="text-lg md:text-xl font-bold text-gray-800 truncate">
                  {{ headerTitle }}
                </h1>
           </div>

           <div class="flex flex-wrap gap-2 items-center justify-end">
              <button *ngIf="editingVisitId && !isViewMode && currentUser?.role === 'admin'" (click)="deleteVisit()" class="border border-red-200 text-red-600 bg-white hover:bg-red-50 px-3 py-1 rounded text-sm font-medium transition">Delete</button>
              <button *ngIf="editingVisitId && !isViewMode" (click)="resetForm()" class="border border-blue-200 text-blue-600 bg-white hover:bg-blue-50 px-3 py-1 rounded text-sm font-medium transition">New Visit</button>
              <div class="text-right flex items-center gap-2" *ngIf="isViewMode">
                  <div class="bg-gray-100 text-gray-700 px-2 py-1 rounded-full text-xs font-bold">VIEW</div>
              </div>
              <div class="text-right flex items-center gap-2" *ngIf="isLiveConsultation">
                  <div class="hidden md:block text-xs text-gray-500 uppercase tracking-wider font-bold">Status</div>
                  <div class="bg-green-100 text-green-800 px-2 py-1 rounded-full text-xs font-bold gap-1 flex items-center">
                    <span class="w-2 h-2 bg-green-500 rounded-full animate-pulse"></span> LIVE
                  </div>
              </div>
           </div>
        </div>

        <!-- SCROLLABLE DOCUMENT BODY -->
        <div class="flex-1 overflow-y-auto bg-gray-50/50">
           <div class="w-full px-4 md:px-8 py-8">
              <form [formGroup]="visitForm" class="space-y-6">
                 
                 <!-- PATIENT CLINICAL SAFETY CONTEXT BANNER -->
                 <div class="rounded-lg border p-4 shadow-sm"
                      [ngClass]="patientSafetyContext?.has_active_allergies ? 'bg-red-50/70 border-red-200' : 'bg-white border-gray-200'">
                     <div class="flex flex-wrap items-center justify-between gap-2">
                         <div class="flex items-center gap-2">
                             <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-4 h-4"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75 11.25 15 15 9.75m-3-7.036A11.959 11.959 0 0 1 3.598 6 11.99 11.99 0 0 0 3 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285Z" /></svg>
                             <span class="font-bold text-xs text-gray-700 uppercase tracking-wider">Patient Safety Context</span>
                         </div>
                         <div class="flex items-center gap-2">
                             <span *ngIf="patientSafetyContext?.has_active_allergies" 
                                   class="px-2.5 py-0.5 rounded-full text-xs font-bold bg-red-600 text-white flex items-center gap-1 shadow-sm">
                                 <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="w-3.5 h-3.5"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" /></svg>
                                 <span>{{ patientSafetyContext.active_allergies.length }} Active {{ patientSafetyContext.active_allergies.length === 1 ? 'Allergy' : 'Allergies' }}</span>
                                 <span *ngIf="patientSafetyContext.has_life_threatening_allergies" class="ml-1 uppercase text-[10px] bg-red-900 text-red-100 px-1 rounded">High Risk</span>
                             </span>
                             <span *ngIf="patientSafetyContext && !patientSafetyContext.has_active_allergies" 
                                   class="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-green-100 text-green-800 flex items-center gap-1">
                                 <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor" class="w-3.5 h-3.5"><path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5" /></svg><span>No Known Allergies</span>
                             </span>
                         </div>
                     </div>

                     <!-- Active Safety Details: flat groups on the banner surface, dividers not boxes -->
                     <div class="mt-3 pt-3 border-t border-gray-200 grid grid-cols-1 gap-4 md:grid-cols-3 md:gap-0 md:divide-x md:divide-gray-200 text-xs">
                         <!-- Active Allergies List -->
                         <div class="md:pr-4">
                             <div class="font-bold text-gray-700 uppercase tracking-wider text-[10px] mb-1.5">Known Allergies</div>
                             <div *ngIf="patientSafetyContext?.active_allergies?.length; else noActiveAllergies" class="flex flex-wrap gap-1">
                                 <span *ngFor="let a of patientSafetyContext.active_allergies"
                                       class="px-2 py-0.5 rounded text-[11px] font-semibold bg-red-100 text-red-800 border border-red-200"
                                       [title]="(a.reaction ? 'Reaction: ' + a.reaction : '') + (a.criticality ? ' (' + a.criticality + ' criticality)' : '')">
                                     {{ a.substance }}
                                 </span>
                             </div>
                             <ng-template #noActiveAllergies>
                                 <div class="text-gray-500 italic">None recorded</div>
                             </ng-template>
                         </div>

                         <!-- Active Problem List -->
                         <div class="md:px-4">
                             <div class="font-bold text-gray-700 uppercase tracking-wider text-[10px] mb-1.5">Active Problems</div>
                             <div *ngIf="patientSafetyContext?.active_conditions?.length; else noActiveConditions" class="flex flex-wrap gap-1">
                                 <span *ngFor="let c of patientSafetyContext.active_conditions"
                                       class="px-2 py-0.5 rounded text-[11px] font-medium bg-amber-50 text-amber-900 border border-amber-200">
                                     {{ c.condition_name }}
                                 </span>
                             </div>
                             <ng-template #noActiveConditions>
                                 <div class="text-gray-500 italic">None recorded</div>
                             </ng-template>
                         </div>

                         <!-- Current Medications -->
                         <div class="md:pl-4">
                             <div class="font-bold text-gray-700 uppercase tracking-wider text-[10px] mb-1.5">Current Medications</div>
                             <div *ngIf="patientSafetyContext?.active_medications?.length; else noActiveMeds" class="flex flex-wrap gap-1">
                                 <span *ngFor="let m of patientSafetyContext.active_medications"
                                       class="px-2 py-0.5 rounded text-[11px] font-medium bg-blue-50 text-blue-900 border border-blue-200">
                                     {{ m.medicine_name }} <span *ngIf="m.dosage" class="text-[10px] text-blue-700">({{ m.dosage }})</span>
                                 </span>
                             </div>
                             <ng-template #noActiveMeds>
                                 <div class="text-gray-500 italic">None recorded</div>
                             </ng-template>
                         </div>
                     </div>
                 </div>

                 <!-- SECTION 1: SUBJECTIVE -->
                 <div class="bg-white p-4 md:p-6 rounded-lg shadow-sm border border-gray-200">
                    <div class="flex items-center gap-3 mb-4 text-gray-800">
                        <div class="w-8 h-8 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center font-bold text-sm">S</div>
                        <h3 class="text-lg font-bold">Subjective</h3>
                    </div>
                    <textarea formControlName="symptoms" rows="3" placeholder="Chief complaints, history of present illness..." 
                        class="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition text-gray-700 placeholder-gray-400"></textarea>
                 </div>

                 <!-- SECTION 2: OBJECTIVE -->
                 <div class="bg-white p-4 md:p-6 rounded-lg shadow-sm border border-gray-200">
                    <div class="flex flex-col md:flex-row justify-between items-start md:items-center mb-4 gap-2">
                        <div class="flex items-center gap-3 text-gray-800">
                            <div class="w-8 h-8 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center font-bold text-sm">O</div>
                            <h3 class="text-lg font-bold">Objective</h3>
                        </div>
                        <!-- Vitals Pill & Actions -->
                        <div class="flex items-center gap-2 flex-wrap">
                            <div *ngIf="hasVitalsToDisplay(patientVitals)" 
                                 (click)="openVitalsModal()"
                                 title="Click to view or amend vitals"
                                 class="bg-blue-50 text-blue-800 text-xs px-3 py-1.5 rounded-full font-medium border border-blue-200 flex flex-wrap items-center gap-2.5 cursor-pointer hover:bg-blue-100 transition">
                                <span *ngIf="hasBp(patientVitals)">BP: <b>{{ patientVitals.systolic_bp }}/{{ patientVitals.diastolic_bp }}</b></span>
                                <span *ngIf="isVitalPresent(patientVitals.pulse)">Pulse: <b>{{ patientVitals.pulse }}</b></span>
                                <span *ngIf="isVitalPresent(patientVitals.temperature)">Temp: <b>{{ patientVitals.temperature }}</b></span>
                                <span *ngIf="isVitalPresent(patientVitals.spo2)">SpO2: <b>{{ patientVitals.spo2 }}%</b></span>
                                <span *ngIf="patientVitals.status === 'amended'" class="text-[10px] bg-blue-200 text-blue-900 px-1.5 py-0.5 rounded font-bold">Amended</span>
                            </div>

                            <button *ngIf="!hasVitalsToDisplay(patientVitals) && canEditChart" 
                                    type="button" 
                                    (click)="openVitalsModal()"
                                    class="text-xs text-blue-700 hover:text-blue-900 border border-blue-200 hover:border-blue-400 bg-blue-50 px-2.5 py-1 rounded-full flex items-center gap-1 font-medium transition">
                                <span>+ Record Vitals</span>
                            </button>
                        </div>
                    </div>
                    <textarea formControlName="examination_notes" rows="3" placeholder="Physical exam findings, labs, observations..." 
                        class="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition text-gray-700 placeholder-gray-400"></textarea>
                 </div>

                 <!-- SECTION 3: ASSESSMENT -->
                 <div class="bg-white p-4 md:p-6 rounded-lg shadow-sm border border-gray-200">
                    <div class="flex items-center gap-3 mb-4 text-gray-800">
                        <div class="w-8 h-8 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center font-bold text-sm">A</div>
                        <h3 class="text-lg font-bold">Assessment</h3>
                    </div>
                    <div class="grid grid-cols-1 md:grid-cols-4 gap-4">
                        <div class="md:col-span-3">
                             <label class="block text-xs font-bold text-gray-500 uppercase mb-1">Diagnosis <span class="text-red-500">*</span></label>
                             <app-catalog-typeahead
                                [value]="visitForm.get('diagnosis')?.value || ''"
                                [disabled]="!canEditChart"
                                placeholder="Primary Diagnosis"
                                testId="diagnosis-input"
                                [searchFn]="searchConditions"
                                [createFn]="createCondition"
                                (valueChange)="onDiagnosisTyped($event)"
                                (picked)="onConditionPicked($event)">
                             </app-catalog-typeahead>
                             <p *ngIf="visitForm.get('diagnosis')?.invalid && (visitForm.get('diagnosis')?.dirty)" class="text-xs text-red-500 mt-1">Diagnosis is required</p>
                        </div>
                        <div class="md:col-span-1">
                             <label class="block text-xs font-bold text-gray-500 uppercase mb-1">Type</label>
                             <select formControlName="diagnosis_type" class="w-full p-2.5 border border-gray-300 rounded bg-white">
                                <option value="">Select</option>
                                <option value="Provisional">Provisional</option>
                                <option value="Final">Final</option>
                             </select>
                        </div>
                    </div>
                 </div>

                 <!-- SECTION 4: PLAN (Rx) -->
                 <div class="bg-white p-4 md:p-6 rounded-lg shadow-sm border border-gray-200">
                    <div class="flex items-center gap-3 mb-4 text-gray-800">
                        <div class="w-8 h-8 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center font-bold text-sm">P</div>
                        <h3 class="text-lg font-bold">Plan & Rx</h3>
                    </div>
                    
                    <app-prescription 
                        [initialData]="currentPrescription"
                        [disabled]="!canEditChart"
                        (changed)="updatePrescription($event)">
                    </app-prescription>

                    <div class="mt-6 pt-4 border-t w-full md:w-1/3">
                         <label class="block text-xs font-bold text-gray-500 uppercase mb-1">Total Fee (₹)</label>
                         <input type="number" formControlName="amount_paid" class="w-full p-2 border border-gray-300 rounded font-mono font-bold text-gray-700">
                    </div>
                 </div>
                 
                 <!-- Spacer for footer -->
                 <div class="h-24"></div>

                 <!-- SECTION 5: BILLING -->
                 <div *ngIf="canBill && billingVisitId" class="bg-white p-4 md:p-6 rounded-lg shadow-sm border border-gray-200">
                    <div class="flex items-center gap-3 mb-4 text-gray-800">
                        <div class="w-8 h-8 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center font-bold text-sm">₹</div>
                        <h3 class="text-lg font-bold">Billing</h3>
                    </div>

                    <div *ngIf="billingLoading && invoices.length === 0" class="text-sm text-gray-500">Loading invoices…</div>

                    <div *ngFor="let invoice of invoices" class="border border-gray-200 rounded-lg mb-3 overflow-hidden">
                        <div class="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 bg-gray-50">
                            <div class="flex items-center gap-2">
                                <span class="font-mono font-bold text-sm text-gray-800">{{ invoice.number }}</span>
                                <span class="px-2 py-0.5 rounded uppercase text-[10px] font-bold"
                                      [ngClass]="invoice.status === 'paid' ? 'bg-green-100 text-green-700' : invoice.status === 'voided' ? 'bg-gray-200 text-gray-500' : invoice.status === 'refunded' ? 'bg-red-100 text-red-700' : invoice.status === 'partial' ? 'bg-amber-100 text-amber-700' : 'bg-blue-100 text-blue-700'">{{ invoice.status }}</span>
                            </div>
                            <div class="text-sm text-gray-600">Total <span class="font-mono font-bold text-gray-800">₹{{ invoice.total }}</span>
                                · Paid <span class="font-mono text-gray-800">₹{{ invoice.balance?.paid }}</span>
                                · Due <span class="font-mono font-bold" [ngClass]="invoice.balance?.due > 0 ? 'text-red-600' : 'text-green-600'">₹{{ invoice.balance?.due }}</span></div>
                        </div>
                        <div class="px-4 py-2 text-xs text-gray-600">
                            <div *ngFor="let item of invoice.items" class="flex justify-between py-0.5">
                                <span>{{ item.description }} × {{ item.quantity }}</span>
                                <span class="font-mono">₹{{ item.amount }}</span>
                            </div>
                            <div *ngIf="invoice.discount > 0" class="flex justify-between py-0.5"><span>Discount</span><span class="font-mono">−₹{{ invoice.discount }}</span></div>
                            <div *ngIf="invoice.tax > 0" class="flex justify-between py-0.5"><span>Tax</span><span class="font-mono">+₹{{ invoice.tax }}</span></div>
                        </div>
                        <div class="px-4 py-2 border-t border-gray-100">
                            <div *ngFor="let payment of invoice.payments" class="flex flex-wrap items-center justify-between gap-2 py-1.5 text-xs border-b border-dashed border-gray-100 last:border-0">
                                <div>
                                    <span class="font-mono font-bold text-gray-700">{{ payment.receipt_no }}</span>
                                    <span class="ml-2 px-1.5 py-0.5 rounded uppercase text-[10px] font-bold"
                                          [ngClass]="payment.kind === 'reversal' ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'">{{ payment.kind }}</span>
                                    <span class="ml-2 font-mono">₹{{ payment.amount }}</span>
                                    <span class="ml-2 text-gray-500">{{ payment.method }}<span *ngIf="payment.reference"> · {{ payment.reference }}</span></span>
                                    <span *ngIf="payment.reason" class="ml-2 text-gray-400 italic">{{ payment.reason }}</span>
                                </div>
                                <div class="flex items-center gap-2">
                                    <button *ngIf="payment.kind === 'payment'" (click)="openReceipt(invoice, payment, true)" class="text-blue-600 hover:underline">Receipt</button>
                                    <button *ngIf="payment.kind === 'payment'" (click)="refundPayment(payment)" class="text-gray-500 hover:text-red-600 hover:underline">{{ refundForm.paymentId === payment.id ? 'Cancel' : 'Refund' }}</button>
                                </div>
                            </div>
                            <div *ngIf="isRefunding(invoice)"
                                 class="flex flex-wrap items-end gap-2 py-2 bg-red-50/50 rounded px-2 mt-1">
                                <div>
                                    <label class="block text-[11px] font-bold text-gray-500 uppercase">Refund amount</label>
                                    <input type="number" [(ngModel)]="refundForm.amount" [ngModelOptions]="{standalone: true}" min="0" step="0.01" class="border p-1.5 rounded text-sm font-mono w-28" />
                                </div>
                                <div class="flex-1 min-w-[180px]">
                                    <label class="block text-[11px] font-bold text-gray-500 uppercase">Reason (required)</label>
                                    <input [(ngModel)]="refundForm.reason" [ngModelOptions]="{standalone: true}" placeholder="Why is this refunded?" class="w-full border p-1.5 rounded text-sm" />
                                </div>
                                <button (click)="refundPayment(refundingPayment(invoice))" class="px-3 py-1.5 text-sm bg-red-600 text-white rounded hover:bg-red-700">Confirm refund</button>
                            </div>
                            <div *ngIf="invoice.status !== 'paid' && invoice.status !== 'voided'" class="flex flex-wrap items-end gap-2 pt-2">
                                <div>
                                    <label class="block text-[11px] font-bold text-gray-500 uppercase">Amount</label>
                                    <input type="number" [(ngModel)]="payFormFor(invoice.id).amount" [ngModelOptions]="{standalone: true}" min="0" step="0.01" placeholder="0.00" class="border p-1.5 rounded text-sm font-mono w-28" />
                                </div>
                                <div>
                                    <label class="block text-[11px] font-bold text-gray-500 uppercase">Method</label>
                                    <select [(ngModel)]="payFormFor(invoice.id).method" [ngModelOptions]="{standalone: true}" class="border p-1.5 rounded text-sm bg-white">
                                        <option value="cash">Cash</option>
                                        <option value="upi">UPI</option>
                                        <option value="card">Card</option>
                                    </select>
                                </div>
                                <div class="flex-1 min-w-[140px]">
                                    <label class="block text-[11px] font-bold text-gray-500 uppercase">Reference</label>
                                    <input [(ngModel)]="payFormFor(invoice.id).reference" [ngModelOptions]="{standalone: true}" placeholder="Txn / bill no." class="w-full border p-1.5 rounded text-sm font-mono" />
                                </div>
                                <button (click)="recordPayment(invoice)" class="px-4 py-1.5 text-sm bg-blue-600 text-white font-medium rounded hover:bg-blue-700">Record payment</button>
                            </div>
                            <div class="flex flex-wrap items-center justify-between gap-2 pt-2">
                                <button (click)="openReceipt(invoice, invoice.payments?.[invoice.payments.length - 1] || null, true)" [disabled]="!invoice.payments?.length" class="text-xs text-blue-600 hover:underline disabled:opacity-40">Print last receipt</button>
                                <div *ngIf="invoice.status !== 'voided'" class="flex items-center gap-2">
                                    <input [(ngModel)]="voidReason[invoice.id]" [ngModelOptions]="{standalone: true}" placeholder="Void reason" class="border p-1.5 rounded text-xs w-40" />
                                    <button (click)="voidInvoice(invoice)" [disabled]="!(voidReason[invoice.id] || '').trim()" class="text-xs text-red-600 border border-red-200 hover:bg-red-50 px-2.5 py-1 rounded disabled:opacity-40">Void</button>
                                </div>
                                <span *ngIf="invoice.status === 'voided'" class="text-xs text-gray-400 italic">Voided: {{ invoice.void_reason }}</span>
                            </div>
                        </div>
                    </div>

                    <div class="border-t pt-3 mt-1">
                        <div class="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">New invoice for this visit</div>
                        <div *ngFor="let line of newChargeItems; let i = index" class="flex flex-wrap items-end gap-2 mb-2">
                            <div class="flex-1 min-w-[180px]">
                                <input [(ngModel)]="line.description" [ngModelOptions]="{standalone: true}" placeholder="Charge description" class="w-full border p-1.5 rounded text-sm" />
                            </div>
                            <div>
                                <input type="number" [(ngModel)]="line.quantity" [ngModelOptions]="{standalone: true}" min="1" step="1" placeholder="Qty" class="border p-1.5 rounded text-sm font-mono w-20" />
                            </div>
                            <div>
                                <input type="number" [(ngModel)]="line.rate" [ngModelOptions]="{standalone: true}" min="0" step="0.01" placeholder="Rate ₹" class="border p-1.5 rounded text-sm font-mono w-28" />
                            </div>
                            <button (click)="removeChargeLine(i)" class="text-gray-400 hover:text-red-600 text-sm px-2" aria-label="Remove line">✕</button>
                        </div>
                        <div class="flex flex-wrap items-center gap-2">
                            <button (click)="addChargeLine()" class="text-sm text-blue-600 border border-blue-200 hover:bg-blue-50 px-3 py-1.5 rounded">+ Charge line</button>
                            <button (click)="createInvoice()" [disabled]="billingLoading" class="px-4 py-1.5 text-sm bg-blue-600 text-white font-medium rounded hover:bg-blue-700 disabled:opacity-50">Create invoice</button>
                            <span class="text-[11px] text-gray-400">Consultation fee auto-added per clinic settings.</span>
                        </div>
                    </div>
                 </div>

                 <!-- Spacer for footer -->
                 <div class="h-24"></div>
              </form>
           </div>
        </div>

        <!-- STICKY FOOTER ACTION BAR -->
        <div class="min-h-20 bg-white border-t px-4 md:px-8 flex flex-col md:flex-row items-center justify-between z-30 py-3 gap-3">
            <div class="flex gap-3 w-full md:w-auto justify-center md:justify-start">
               <button *ngIf="isViewMode" type="button" (click)="downloadVisitPdf()" [disabled]="!viewedVisit" class="px-4 py-2 rounded bg-gray-800 text-white hover:bg-gray-900 font-medium transition flex-1 md:flex-none justify-center disabled:opacity-50">
                 Download PDF
               </button>
               <button *ngIf="!isViewMode" type="button" (click)="printPrescription()" class="px-4 py-2 rounded text-gray-600 hover:bg-gray-100 font-medium transition flex-1 md:flex-none justify-center">
                 Print
               </button>
               <button *ngIf="isLiveConsultation" type="button" (click)="postponeConsult()" class="px-4 py-2 rounded text-blue-600 border border-transparent hover:border-blue-200 hover:bg-blue-50 font-medium transition flex-1 md:flex-none justify-center">
                  Postpone
               </button>
            </div>

            <div class="flex flex-col md:flex-row gap-3 items-center w-full md:w-auto">
               <ng-container *ngIf="canEditChart; else noConsult">
                  <!-- Classic Save -->
                   <button type="submit" (click)="saveVisit()" [disabled]="!visitForm.valid || actionInFlight" class="hidden md:block px-4 py-2 rounded border border-gray-300 text-gray-600 hover:bg-gray-50 hover:text-gray-800 transition disabled:opacity-50 font-medium">
                     Save Progress
                   </button>
                   
                   <!-- Finish & Exit -->
                   <button *ngIf="isLiveConsultation" type="button" (click)="endConsult()" [disabled]="!visitForm.valid || actionInFlight" class="hidden md:block px-4 py-2 rounded border border-blue-200 text-blue-700 hover:bg-blue-50 transition disabled:opacity-50 font-medium">
                     Finish & Exit
                   </button>

                   <!-- HERO ACTION: FINISH & NEXT -->
                   <button *ngIf="isLiveConsultation" type="button" (click)="finishAndNext()" [disabled]="!visitForm.valid || actionInFlight" class="w-full md:w-auto px-6 py-2 rounded bg-blue-600 hover:bg-blue-700 text-white font-bold shadow-sm transition disabled:opacity-50 flex items-center justify-center gap-2">
                     <span>Finish & Next</span> 
                   </button>
                   
                   <button *ngIf="editingVisitId" (click)="saveVisit()" [disabled]="!visitForm.valid" class="w-full md:w-auto px-6 py-2 rounded bg-blue-600 text-white font-bold hover:bg-blue-700 transition disabled:opacity-50 shadow-sm">
                      Update Record
                   </button>
               </ng-container>

                <ng-template #noConsult>
                    <div class="text-sm text-gray-500 italic">Read-only mode</div>
                </ng-template>
             </div>
         </div>

      </div>

      <!-- Vitals Modal -->
      <app-vitals-form *ngIf="showVitalsModal"
          [patientId]="patientId"
          [visitId]="encounterId"
          [existingVitals]="patientVitals"
          (closeDialog)="closeVitalsModal()"
          (vitalsSaved)="onVitalsSaved($event)">
      </app-vitals-form>

      <!-- Allergy Conflict Modal -->
      <div *ngIf="showAllergyOverrideModal" class="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
        <div class="bg-white rounded-lg shadow-lg w-full max-w-lg overflow-hidden flex flex-col border border-red-200">
            <div class="bg-red-50 border-b border-red-100 px-6 py-4 flex items-center justify-between">
                <div class="flex items-center gap-2">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-5 h-5 text-red-700"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" /></svg>
                    <h3 class="text-base font-bold text-red-800">Prescribing Allergy Alert</h3>
                </div>
                <button (click)="cancelAllergyOverride()" class="text-gray-500 hover:text-gray-600" aria-label="Close"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="w-4 h-4"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg></button>
            </div>
            <div class="p-6 space-y-4">
                <p class="text-sm text-gray-700">
                    One or more prescribed medications conflict with the patient's recorded allergies:
                </p>
                <div class="space-y-2">
                    <div *ngFor="let conflict of activeAllergyConflicts" class="p-3 bg-red-50/70 border border-red-200 rounded-lg text-xs space-y-1">
                        <div class="font-bold text-red-900 flex justify-between">
                            <span>Prescribed: {{ conflict.medicine }}</span>
                            <span class="uppercase px-1.5 py-0.5 rounded bg-red-200 text-red-800 text-[10px]">{{ conflict.criticality }} risk</span>
                        </div>
                        <div class="text-red-700">Patient Allergy: <b>{{ conflict.substance }}</b></div>
                        <div *ngIf="conflict.reaction" class="text-red-600 italic">Reaction: {{ conflict.reaction }}</div>
                    </div>
                </div>
                <div>
                    <label class="block text-xs font-bold text-gray-700 uppercase mb-1">
                        Clinical Override Rationale <span class="text-red-500">*</span>
                    </label>
                    <textarea [(ngModel)]="overrideReasonInput" rows="3" 
                              placeholder="e.g. Desensitization complete, patient tolerated previously, or emergency benefit outweighs risk..."
                              class="w-full border p-2.5 rounded text-sm outline-none focus:ring-2 focus:ring-red-500 border-gray-300"></textarea>
                    <p class="text-[11px] text-gray-500 mt-1">An override reason is required by clinical safety policy to prescribe this medication.</p>
                </div>
            </div>
            <div class="bg-gray-50 border-t px-6 py-3 flex justify-between items-center">
                <button (click)="cancelAllergyOverride()" class="px-4 py-2 text-sm text-gray-600 hover:bg-gray-200 rounded border bg-white">
                    Cancel & Modify Rx
                </button>
                <button (click)="confirmAllergyOverride()" 
                        [disabled]="!overrideReasonInput.trim()"
                        class="px-5 py-2 text-sm bg-red-600 text-white font-bold rounded hover:bg-red-700 disabled:opacity-50 shadow-sm transition">
                    Acknowledge & Override
                </button>
            </div>
        </div>
      </div>
    </div>

    <!-- Receipt modal (print-scoped; maps to stored transactions) -->
    <div *ngIf="showReceipt && receiptInvoice" class="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4 print-scope-receipt">
      <div class="bg-white rounded-lg shadow-xl w-full max-w-md max-h-[90vh] overflow-y-auto">
        <div class="p-8 relative">
          <div *ngIf="receiptReprint" class="absolute inset-0 flex items-center justify-center pointer-events-none">
            <span class="text-6xl font-black text-gray-200 rotate-[-20deg] tracking-widest">DUPLICATE</span>
          </div>
          <div class="text-center border-b pb-4 mb-4">
            <h2 class="text-xl font-bold text-gray-900">{{ clinicName || 'Clinic' }}</h2>
            <p class="text-xs text-gray-500">Payment receipt{{ receiptReprint ? ' (reprint)' : '' }}</p>
          </div>
          <div class="text-sm space-y-1 mb-4">
            <div class="flex justify-between"><span class="text-gray-500">Invoice</span><span class="font-mono font-bold">{{ receiptInvoice.number }}</span></div>
            <div class="flex justify-between"><span class="text-gray-500">Receipt</span><span class="font-mono font-bold">{{ receiptPayment?.receipt_no || '—' }}</span></div>
            <div class="flex justify-between"><span class="text-gray-500">Patient</span><span class="font-medium">{{ patient?.name }}</span></div>
            <div class="flex justify-between"><span class="text-gray-500">Date</span><span>{{ (receiptPayment?.created_at || receiptInvoice.created_at) | date:'medium' }}</span></div>
          </div>
          <table class="w-full text-sm mb-4">
            <thead><tr class="text-left text-xs text-gray-500 border-b"><th class="py-1">Charge</th><th class="py-1 text-right">Qty</th><th class="py-1 text-right">Amount</th></tr></thead>
            <tbody>
              <tr *ngFor="let item of receiptInvoice.items" class="border-b border-gray-100">
                <td class="py-1">{{ item.description }}</td><td class="py-1 text-right">{{ item.quantity }}</td><td class="py-1 text-right font-mono">₹{{ item.amount }}</td>
              </tr>
            </tbody>
          </table>
          <div class="text-sm space-y-1 mb-4">
            <div class="flex justify-between"><span class="text-gray-500">Subtotal</span><span class="font-mono">₹{{ receiptInvoice.subtotal }}</span></div>
            <div *ngIf="receiptInvoice.discount > 0" class="flex justify-between"><span class="text-gray-500">Discount</span><span class="font-mono">−₹{{ receiptInvoice.discount }}</span></div>
            <div *ngIf="receiptInvoice.tax > 0" class="flex justify-between"><span class="text-gray-500">Tax</span><span class="font-mono">+₹{{ receiptInvoice.tax }}</span></div>
            <div class="flex justify-between font-bold text-base border-t pt-1"><span>Total</span><span class="font-mono">₹{{ receiptInvoice.total }}</span></div>
            <div *ngIf="receiptPayment" class="flex justify-between text-green-700 font-bold"><span>Paid ({{ receiptPayment.method }})</span><span class="font-mono">₹{{ receiptPayment.amount }}</span></div>
            <div class="flex justify-between text-gray-600"><span>Balance due</span><span class="font-mono">₹{{ receiptInvoice.balance?.due }}</span></div>
          </div>
          <div class="flex justify-end gap-2">
            <button (click)="showReceipt = false" class="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded border">Close</button>
            <button (click)="printReceipt()" class="px-4 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-700">Print</button>
          </div>
        </div>
      </div>
    </div>
  `,
  styles: [`
    @media print {
      body * { visibility: hidden; }
      .print-scope-receipt, .print-scope-receipt * { visibility: visible; }
      .print-scope-receipt { position: absolute !important; inset: 0 !important; background: white !important; }
    }
  `]
})
export class VisitComponent implements OnInit {
  patientId!: number;
  patient: any;
  history: Visit[] = [];
  visitForm: FormGroup;
  editingVisitId: number | null = null;
  encounterId: number | null = null;
  isConsulting = false;
  activeEncounterReadOnly = false;
  consultationLoadError: string | null = null;
  actionInFlight = false;
  chartWritable = false;
  private consultationStartPending = false;
  private startRequestId: string | null = null;
  private nextStartRequestId: string | null = null;
  currentUser: any;
  get canBill(): boolean {
    return ['admin', 'doctor', 'receptionist'].includes(this.currentUser?.role);
  }

  // Billing ledger (visit chart)
  invoices: any[] = [];
  billingLoading = false;
  clinicName = '';
  newChargeItems: { description: string; quantity: number | null; rate: number | null }[] = [];
  newChargeDiscount: number | null = null;
  newChargeTax: number | null = null;
  payForm: { [invoiceId: number]: { amount: number | null; method: string; reference: string } } = {};
  refundForm: { paymentId: number | null; amount: number | null; reason: string } = { paymentId: null, amount: null, reason: '' };
  voidReason: { [invoiceId: number]: string } = {};
  receiptPayment: any = null;
  receiptInvoice: any = null;
  receiptReprint = false;
  showReceipt = false;
  patientVitals: any;
  showMobileHistory = false;
  showVitalsModal = false;

  // Clinical Safety Context & Allergy Conflict Modal
  patientSafetyContext: any = null;
  showAllergyOverrideModal = false;
  activeAllergyConflicts: Array<{ medicine: string; substance: string; criticality: string; reaction?: string }> = [];
  overrideReasonInput = '';
  pendingActionAfterOverride: (() => Promise<boolean>) | null = null;
  // Outer workflow (navigation / next-patient advance) deferred while the
  // override modal is open. completeConsult resolves false immediately on
  // conflict, so the caller stashes its post-completion step here and the
  // confirm handler replays it after the deferred completion succeeds.
  private pendingFlowAfterOverride: (() => void) | null = null;
  // JSON snapshot of the prescription lines a recorded override rationale was
  // given for; used to detect stale rationales after later edits.
  private overriddenPrescriptionJson: string | null = null;

  currentPrescription: any[] = [];
  private conditionPresetGeneration = 0;
  viewMode = false;
  viewVisitId: number | null = null;
  viewedVisit: Visit | null = null;

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private fb: FormBuilder,
    private ngZone: NgZone,
    private pdfService: PdfService,
    private dataService: DataService,
    private authService: AuthService,
    private doctorPick?: DoctorPickService,
    private dialogService?: DialogService,
    private toastService?: ToastService
  ) {
    const nav = this.router.getCurrentNavigation();
    const state = nav?.extras?.state || {};
    if (state['isConsulting']) {
      this.isConsulting = true;
    }
    if (state['encounterId']) {
      this.encounterId = Number(state['encounterId']);
    }
    this.applyViewIntent(state);

    this.visitForm = this.fb.group({
      symptoms: [''],
      examination_notes: [''],
      diagnosis: [''],
      diagnosis_type: [''],
      prescription: [[]],
      amount_paid: [0],
      allergy_override_reason: ['']
    });
  }

  ngOnInit() {
    this.currentUser = this.authService.getUser();
    combineLatest([this.route.params, this.route.queryParams]).subscribe(([params, queryParams]) => {
      this.patientId = +params['id'];
      this.applyViewIntent(queryParams);
      this.loadData();
    });
  }

  get isViewMode(): boolean {
    return this.viewMode && !this.isLiveConsultation;
  }

  get isLiveConsultation(): boolean {
    return this.chartWritable && this.isConsulting && this.encounterId != null && !this.activeEncounterReadOnly;
  }

  get headerTitle(): string {
    if (this.isViewMode) return 'View Visit';
    if (this.editingVisitId) return 'Editing Past Visit';
    if (this.isLiveConsultation) return 'Current Consultation';
    return 'Visit';
  }

  get canEditChart(): boolean {
    return this.chartWritable && !this.activeEncounterReadOnly && (this.isConsulting || this.editingVisitId != null);
  }

  // Admins consult as scribes: the encounter is attributed to them (author_id)
  // while clinical responsibility stays with a licensed doctor (doctor_id),
  // preserving practitioner provenance and the license snapshot.
  // Returns undefined for non-admins (no doctorId needed), a doctor id when
  // resolved, or null when the admin cancelled or none exists (abort).
  private async resolveResponsibleDoctorId(): Promise<number | null | undefined> {
    if (this.currentUser?.role !== 'admin') return undefined;
    const doctors = await this.dataService.invoke<any[]>('getDoctors').catch(() => []);
    if (!doctors || doctors.length === 0) {
      await this.dialogService?.open({
        title: 'No responsible doctor',
        message: 'No active doctor on file. An admin consultation needs a licensed practitioner attached.',
        type: 'warning'
      });
      return null;
    }
    if (doctors.length === 1 || !this.doctorPick) return doctors[0]?.id ?? null;
    return this.doctorPick.request(doctors);
  }

  private setChartWritable(writable: boolean) {
    this.chartWritable = writable;
    if (writable) {
      this.visitForm.enable();
    } else {
      this.visitForm.disable();
    }
  }

  editVisit(visit: any) {
    // Historical editing and active completion are deliberately separate modes.
    if (this.isViewMode) {
      this.viewVisitId = visit.id;
      this.patchVisitSnapshot(visit);
      this.setChartWritable(false);
      this.showMobileHistory = false;
      return;
    }
    if (this.isConsulting || this.encounterId || this.activeEncounterReadOnly) return;
    this.editingVisitId = visit.id;
    this.visitForm.patchValue({
      symptoms: visit.symptoms,
      examination_notes: visit.examination_notes,
      diagnosis: visit.diagnosis,
      diagnosis_type: visit.diagnosis_type,
      amount_paid: visit.amount_paid
    });
    void this.loadInvoices();

    if (visit.prescription && visit.prescription.length > 0) {
      this.currentPrescription = visit.prescription;
      this.visitForm.patchValue({ prescription: visit.prescription });
    } else {
      this.currentPrescription = [];
      this.visitForm.patchValue({ prescription: [] });
    }
    this.setChartWritable(true);

    // On mobile, close drawer after selection
    this.showMobileHistory = false;
  }

  resetForm() {
    this.editingVisitId = null;
    this.visitForm.reset({ amount_paid: 0, prescription: [] });
    this.currentPrescription = [];
    if (!this.isConsulting || this.activeEncounterReadOnly) {
      this.setChartWritable(false);
    }
  }

  // -- Billing ledger -------------------------------------------------
  get billingVisitId(): number | null {
    return this.editingVisitId ?? this.viewedVisit?.id ?? null;
  }

  async loadInvoices(): Promise<void> {
    if (!this.billingVisitId || !this.canBill) {
      this.invoices = [];
      return;
    }
    this.billingLoading = true;
    try {
      const [rows, settings] = await Promise.all([
        this.dataService.invoke<any[]>('getVisitInvoices', this.billingVisitId),
        this.dataService.invoke<any>('getPublicSettings').catch(() => null)
      ]);
      this.ngZone.run(() => {
        this.invoices = rows || [];
        if (settings?.clinic_name) this.clinicName = settings.clinic_name;
        this.billingLoading = false;
      });
    } catch (e) {
      console.error(e);
      this.ngZone.run(() => { this.billingLoading = false; });
    }
  }

  addChargeLine(): void {
    this.newChargeItems.push({ description: '', quantity: 1, rate: null });
  }

  removeChargeLine(index: number): void {
    this.newChargeItems.splice(index, 1);
  }

  async createInvoice(): Promise<void> {
    if (!this.billingVisitId || this.billingLoading) return;
    const items = this.newChargeItems
      .filter((l) => l.description.trim())
      .map((l) => ({ description: l.description.trim(), quantity: Number(l.quantity) || 1, rate: Number(l.rate) || 0 }));
    try {
      await this.dataService.invoke('createInvoice', {
        visitId: this.billingVisitId,
        items,
        discount: 0,
        tax: 0
      });
      this.ngZone.run(() => {
        this.newChargeItems = [];
        this.newChargeDiscount = null;
        this.newChargeTax = null;
      });
      this.toastService?.success('Invoice created.', 'Billing');
      await this.loadInvoices();
    } catch (e) {
      await this.dialogService?.open({
        title: 'Invoice failed',
        message: e instanceof Error ? e.message : 'Could not create the invoice.',
        type: 'error'
      });
    }
  }

  payFormFor(invoiceId: number): { amount: number | null; method: string; reference: string } {
    return this.payForm[invoiceId] ?? (this.payForm[invoiceId] = { amount: null, method: 'cash', reference: '' });
  }

  async recordPayment(invoice: any): Promise<void> {
    const form = this.payFormFor(invoice.id);
    if (form.amount == null || Number(form.amount) <= 0 || this.billingLoading) return;
    this.billingLoading = true;
    try {
      const payment: any = await this.dataService.invoke('recordPayment', {
        invoiceId: invoice.id,
        amount: Number(form.amount),
        method: form.method,
        reference: form.reference.trim(),
        clientKey: crypto.randomUUID()
      });
      this.ngZone.run(() => { this.payForm[invoice.id] = { amount: null, method: 'cash', reference: '' }; });
      this.toastService?.success(`Payment recorded (${payment.receipt_no}).`, 'Billing');
      await this.loadInvoices();
    } catch (e) {
      await this.dialogService?.open({
        title: 'Payment failed',
        message: e instanceof Error ? e.message : 'Could not record the payment.',
        type: 'error'
      });
    } finally {
      this.ngZone.run(() => { this.billingLoading = false; });
    }
  }

  async refundPayment(payment: any): Promise<void> {
    if (this.refundForm.paymentId !== payment.id) {
      this.refundForm = { paymentId: payment.id, amount: payment.amount, reason: '' };
      return;
    }
    if (!this.refundForm.reason.trim()) return;
    try {
      await this.dataService.invoke('refundPayment', {
        paymentId: payment.id,
        amount: this.refundForm.amount ?? undefined,
        reason: this.refundForm.reason.trim()
      });
      this.ngZone.run(() => {
        this.refundForm = { paymentId: null, amount: null, reason: '' };
      });
      this.toastService?.success('Refund recorded.', 'Billing');
      await this.loadInvoices();
    } catch (e) {
      await this.dialogService?.open({
        title: 'Refund failed',
        message: e instanceof Error ? e.message : 'Could not record the refund.',
        type: 'error'
      });
    }
  }

  async voidInvoice(invoice: any): Promise<void> {
    const reason = (this.voidReason[invoice.id] || '').trim();
    if (!reason) return;
    const confirmed = await this.dialogService?.open({
      title: `Void invoice ${invoice.number}?`,
      message: 'The invoice stays in history marked voided. Reverse or refund payments first.',
      type: 'confirm',
      confirmText: 'Void invoice',
      cancelText: 'Keep'
    });
    if (!confirmed) return;
    try {
      await this.dataService.invoke('voidInvoice', { invoiceId: invoice.id, reason });
      this.toastService?.success('Invoice voided.', 'Billing');
      await this.loadInvoices();
    } catch (e) {
      await this.dialogService?.open({
        title: 'Void failed',
        message: e instanceof Error ? e.message : 'Could not void the invoice.',
        type: 'error'
      });
    }
  }

  openReceipt(invoice: any, payment: any, reprint: boolean): void {
    this.receiptInvoice = invoice;
    this.receiptPayment = payment;
    this.receiptReprint = reprint;
    this.showReceipt = true;
  }

  printReceipt(): void {
    window.print();
  }

  isRefunding(invoice: any): boolean {
    if (!this.refundForm.paymentId || !invoice?.payments) return false;
    return invoice.payments.some((p: any) => p.id === this.refundForm.paymentId);
  }

  refundingPayment(invoice: any): any {
    return invoice?.payments?.find((p: any) => p.id === this.refundForm.paymentId) ?? null;
  }

  async loadData() {
    this.consultationLoadError = null;
    try {
      this.setChartWritable(false);
      if (this.viewMode) {
        await this.loadFinishedVisitView();
        return;
      }
      let activeEncounterReadDenied = false;
      const activeEncounterRequest = this.dataService.invoke<any>('getActiveConsultation', this.patientId)
        .catch(error => {
          if (this.isAuthorizationError(error)) {
            activeEncounterReadDenied = true;
            return null;
          }
          throw error;
        });
      const [visits, allPatients, vitals, activeEncounter, safetyContext] = await Promise.all([
        this.dataService.invoke<any[]>('getVisits', this.patientId),
        this.dataService.invoke<any[]>('getPatients', ''),
        this.dataService.invoke<any>('getVitals', this.patientId),
        activeEncounterRequest,
        this.dataService.invoke<any>('getPatientSafetyContext', this.patientId).catch(() => null)
      ]);
      const p = allPatients.find((patient: any) => patient.id === this.patientId);
      let resumedEncounter: any = null;
      let resumeDenied = false;
      if (activeEncounter) {
        try {
          resumedEncounter = await this.dataService.invoke<any>('resumeConsultation', { encounterId: activeEncounter.id });
        } catch (e) {
          resumeDenied = this.isAuthorizationError(e);
          if (!resumeDenied) {
            this.consultationLoadError = 'Could not resume this consultation. Retry when the connection is available.';
          }
          console.warn(resumeDenied ? 'Active encounter is read-only for this user' : 'Could not resume active encounter', e);
        }
      }

      this.ngZone.run(() => {
        this.patient = p;
        this.history = visits.filter((visit: any) => visit.status !== 'in-progress');
        this.patientVitals = vitals;
        this.patientSafetyContext = safetyContext;

        if (resumedEncounter) {
          this.consultationStartPending = false;
          this.startRequestId = null;
          this.activeEncounterReadOnly = false;
          this.encounterId = resumedEncounter.id;
          this.isConsulting = true;
          this.editingVisitId = null;
          this.patchEncounter(resumedEncounter);
        } else if ((activeEncounter && resumeDenied) || activeEncounterReadDenied) {
          this.activeEncounterReadOnly = true;
          this.encounterId = null;
          this.isConsulting = false;
          this.editingVisitId = null;
        } else if (activeEncounter && this.consultationLoadError) {
          this.activeEncounterReadOnly = false;
          this.encounterId = null;
          this.isConsulting = false;
          this.editingVisitId = null;
        } else {
          this.activeEncounterReadOnly = false;
        }

        // Enable only after the exact linked queue entry has been reclaimed.
        if (resumedEncounter) {
          this.setChartWritable(true);

          // Auto-Fill Vitals into Objective if empty
          if (this.patientVitals && !this.visitForm.get('examination_notes')?.value) {
            const formatted = this.formatVitalsObjective(this.patientVitals);
            if (formatted) {
              this.visitForm.patchValue({ examination_notes: formatted });
            }
          }
        }
      });

      if (this.isConsulting && !activeEncounter && !activeEncounterReadDenied) {
        const queue = await this.dataService.invoke<any[]>('getQueue');
        const queueEntry = queue.find(item => item.patient_id === this.patientId && item.status === 'waiting');
        if (!queueEntry) throw new Error('Patient does not have a waiting queue entry');
        this.startRequestId ||= newRequestId();
        const doctorId = await this.resolveResponsibleDoctorId();
        if (this.currentUser?.role === 'admin' && doctorId == null) {
          this.consultationStartPending = false;
          this.isConsulting = false;
          this.setChartWritable(false);
          return;
        }
        const encounter = await this.dataService.invoke<any>('beginConsultation', {
          patientId: this.patientId,
          queueEntryId: queueEntry.id,
          startRequestId: this.startRequestId,
          ...(doctorId ? { doctorId } : {})
        });
        this.consultationStartPending = false;
        this.startRequestId = null;

        let linkedVitals: any = null;
        try {
          linkedVitals = await this.dataService.invoke<any>('getEncounterVitals', encounter.id);
        } catch { }

        this.ngZone.run(() => {
          this.encounterId = encounter.id;
          if (linkedVitals) {
            this.patientVitals = linkedVitals;
          }
          this.patchEncounter(encounter);
          this.setChartWritable(true);
        });
      } else if (!resumedEncounter && !this.editingVisitId) {
        this.setChartWritable(false);
      }
    } catch (e) {
      console.error(e);
      this.ngZone.run(() => {
        if (this.isConsulting && !this.encounterId) {
          this.consultationStartPending = true;
          this.isConsulting = false;
          this.consultationLoadError = 'Could not start this consultation. Open the patient from the queue or retry.';
        } else {
          this.consultationLoadError = 'Could not load the consultation. Retry when the connection is available.';
        }
        this.setChartWritable(false);
      });
    }
  }

  retryConsultationLoad(): Promise<void> {
    if (this.consultationStartPending) this.isConsulting = true;
    return this.loadData();
  }

  updatePrescription(items: any[]) {
    if (!this.canEditChart) return;
    this.visitForm.patchValue({ prescription: items });
    this.invalidateStaleOverride(items);
  }

  // A recorded override rationale belongs to the exact prescription lines it
  // was given for. If the lines change afterwards, the rationale is stale and
  // must not silently cover the new conflict: clear it so the next save
  // re-runs the allergy check and the modal when still conflicting.
  private invalidateStaleOverride(nextItems: any[]): void {
    const reason = this.visitForm.value?.allergy_override_reason;
    if (typeof reason === 'string' && reason.trim() && this.overriddenPrescriptionJson != null
        && JSON.stringify(nextItems || []) !== this.overriddenPrescriptionJson) {
      this.visitForm.patchValue({ allergy_override_reason: '' });
      if (this.visitForm.value) this.visitForm.value.allergy_override_reason = '';
      this.overriddenPrescriptionJson = null;
    }
  }

  searchConditions = (query: string) => this.dataService.invoke('searchConditions', query);

  createCondition = (name: string) => this.dataService.invoke('createCondition', { name });

  onDiagnosisTyped(name: string) {
    if (!this.canEditChart) return;
    this.conditionPresetGeneration += 1;
    this.visitForm.patchValue({ diagnosis: name });
    this.visitForm.get('diagnosis')?.markAsDirty?.();
  }

  async onConditionPicked(hit: { id: number; name: string }) {
    if (!this.canEditChart) return;
    this.visitForm.patchValue({ diagnosis: hit.name });
    const generation = ++this.conditionPresetGeneration;
    try {
      const presets = await this.dataService.invoke<any[]>('getConditionMedPresets', hit.id);
      if (generation !== this.conditionPresetGeneration) return;
      if (presets && presets.length > 0) {
        const lines = presets.map((line) => ({ ...line }));
        this.currentPrescription = lines;
        this.visitForm.patchValue({ prescription: lines });
        this.invalidateStaleOverride(lines);
      }
    } catch (e) {
      if (generation !== this.conditionPresetGeneration) return;
      console.warn('Could not apply condition presets', e);
    }
  }

  checkForAllergyConflicts(): Array<{ medicine: string; substance: string; criticality: string; reaction?: string }> {
    if (!this.patientSafetyContext?.active_allergies?.length) return [];
    let rxItems: any[] = [];
    if (Array.isArray(this.currentPrescription) && this.currentPrescription.length > 0) {
      rxItems = this.currentPrescription;
    } else {
      rxItems = this.visitForm.value?.prescription || this.visitForm.get?.('prescription')?.value || [];
    }
    if (!Array.isArray(rxItems) || rxItems.length === 0) return [];

    const conflicts: Array<{ medicine: string; substance: string; criticality: string; reaction?: string }> = [];
    for (const item of rxItems) {
      const medName = String(item.medicine || '').toLowerCase().trim();
      if (!medName) continue;
      for (const allergy of this.patientSafetyContext.active_allergies) {
        const substance = String(allergy.substance || '').toLowerCase().trim();
        if (substance && (medName.includes(substance) || substance.includes(medName))) {
          conflicts.push({
            medicine: item.medicine,
            substance: allergy.substance,
            criticality: allergy.criticality || 'low',
            reaction: allergy.reaction
          });
        }
      }
    }
    return conflicts;
  }

  private verifyAllergySafety(continuation: () => Promise<boolean>): Promise<boolean> {
    const conflicts = this.checkForAllergyConflicts();
    const rawReason = this.visitForm.value?.allergy_override_reason || this.visitForm.get?.('allergy_override_reason')?.value || '';
    const existingReason = typeof rawReason === 'string' ? rawReason.trim() : '';
    if (conflicts.length > 0 && !existingReason) {
      this.activeAllergyConflicts = conflicts;
      this.pendingActionAfterOverride = continuation;
      this.overrideReasonInput = '';
      this.showAllergyOverrideModal = true;
      return Promise.resolve(false);
    }
    return continuation();
  }

  confirmAllergyOverride() {
    if (!this.overrideReasonInput?.trim()) return;
    const reason = this.overrideReasonInput.trim();
    this.visitForm.patchValue({ allergy_override_reason: reason });
    if (this.visitForm.value) {
      this.visitForm.value.allergy_override_reason = reason;
    }
    this.overriddenPrescriptionJson = JSON.stringify(this.visitForm.value?.prescription || []);
    this.showAllergyOverrideModal = false;
    const run = this.pendingActionAfterOverride;
    this.pendingActionAfterOverride = null;
    const resume = this.pendingFlowAfterOverride;
    this.pendingFlowAfterOverride = null;
    if (run) {
      // Start the deferred completion on this tick (callers historically
      // observe its side effects synchronously); replay the outer workflow
      // once it settles.
      let started: Promise<boolean>;
      try {
        started = Promise.resolve(run());
      } catch {
        started = Promise.resolve(false);
      }
      started.then((ok) => { if (ok && resume) resume(); }).catch(() => undefined);
    } else if (resume) {
      resume();
    }
  }

  cancelAllergyOverride() {
    this.showAllergyOverrideModal = false;
    this.pendingActionAfterOverride = null;
    this.pendingFlowAfterOverride = null;
  }

  async saveVisit(): Promise<boolean> {
    if (this.visitForm.invalid) {
      this.visitForm.markAllAsTouched();
      return false;
    }

    return this.verifyAllergySafety(() => this.executeSaveVisit());
  }

  private async executeSaveVisit(): Promise<boolean> {
    const visitData = this.currentVisitData();

    try {
      if (this.editingVisitId) {
        await this.dataService.invoke('saveVisit', { id: this.editingVisitId, ...visitData });
      } else {
        if (!this.encounterId) throw new Error('No active encounter');
        await this.dataService.invoke('saveConsultationProgress', {
          encounterId: this.encounterId,
          visit: visitData
        });
      }
      this.ngZone.run(() => {
        if (this.editingVisitId) {
          this.resetForm();
        }
        // Reload history
        this.dataService.invoke<any[]>('getVisits', this.patientId)
          .then(visits => this.history = visits.filter(visit => visit.status !== 'in-progress'));
      });
      return true;
    } catch (e) {
      console.error('Save failed', e);
      return false;
    }
  }

  async deleteVisit() {
    if (!this.editingVisitId) return;
    const confirmed = await this.dialogService?.open({
      title: 'Delete this visit?',
      message: 'The visit record will be permanently removed.',
      type: 'confirm',
      confirmText: 'Delete',
      cancelText: 'Keep'
    });
    if (!confirmed) return;
    try {
      await this.dataService.invoke('deleteVisit', this.editingVisitId);
      this.ngZone.run(() => {
        this.resetForm();
        this.loadData();
      });
    } catch (e) {
      console.error(e);
      await this.dialogService?.open({
        title: 'Delete failed',
        message: 'The visit could not be deleted.',
        type: 'error'
      });
    }
  }

  async printPrescription() {
    try {
      await this.generateVisitPdf({ ...this.visitForm.value, date: new Date() });
    } catch (e) {
      console.error('Print failed', e);
    }
  }

  async downloadVisitPdf() {
    if (!this.viewedVisit) return;
    try {
      await this.generateVisitPdf(this.viewedVisit);
    } catch (e) {
      console.error('PDF download failed', e);
    }
  }

  // --- New Logic: Finish & Next ---

  async endConsult() {
    // Just end, go to queue (Old behavior)
    if (await this.completeConsult()) {
      this.router.navigate(['/queue']);
    } else if (this.showAllergyOverrideModal) {
      this.pendingFlowAfterOverride = () => {
        this.router.navigate(['/queue']);
      };
    }
  }

  async finishAndNext() {
    if (this.actionInFlight) return;
    this.actionInFlight = true;
    try {
      if (await this.completeConsult(false)) {
        await this.advanceToNext();
      } else if (this.showAllergyOverrideModal) {
        // Completion deferred until the override is confirmed; replay the
        // advance step then (completeConsult resolves true on the retry).
        this.pendingFlowAfterOverride = () => {
          void this.advanceToNext();
        };
      }
    } catch (e) {
      console.error('Failed to start the next consultation', e);
      await this.dialogService?.open({
        title: 'Handoff failed',
        message: 'The current consultation is finished, but the next patient could not be opened. Retry to resume safely.',
        type: 'error'
      });
    } finally {
      this.actionInFlight = false;
    }
  }

  private async advanceToNext(): Promise<void> {
    this.nextStartRequestId ||= newRequestId();
    const nextDoctorId = await this.resolveResponsibleDoctorId();
    if (this.currentUser?.role === 'admin' && nextDoctorId == null) {
      this.router.navigate(['/queue']);
      return;
    }
    try {
      const nextEncounter = await this.dataService.invoke<any>('beginNextConsultation', {
        startRequestId: this.nextStartRequestId,
        ...(nextDoctorId ? { doctorId: nextDoctorId } : {})
      });
      this.nextStartRequestId = null;
      if (nextEncounter) {
        this.ngZone.run(() => {
          this.patientId = nextEncounter.patient_id;
          this.encounterId = nextEncounter.id;
          this.editingVisitId = null;
          this.visitForm.reset({ amount_paid: 0, prescription: [] });
          this.currentPrescription = [];
          this.isConsulting = true;
          this.router.navigate(['/visit', nextEncounter.patient_id], {
            state: { isConsulting: true, encounterId: nextEncounter.id }
          });
        });
      } else {
        this.isConsulting = false;
        // Null means no actionable row: distinguish a truly empty queue from
        // entries blocked behind active (e.g. postponed) consultations.
        const remaining = await this.dataService.invoke<any[]>('getQueue').catch(() => []);
        const waitingCount = (remaining || []).filter((q: any) => q.status === 'waiting').length;
        if (waitingCount > 0) {
          this.toastService?.info(`${waitingCount} patient(s) still in queue, but each has an active consultation pending. Resume them from the queue.`, 'Queue blocked');
        } else if ((remaining || []).length > 0) {
          this.toastService?.info('Consultations are still in progress elsewhere. The queue has nothing waiting to auto-start.', 'Nothing to start');
        } else {
          this.toastService?.success('All consultations are complete.', 'Queue is empty');
        }
        this.router.navigate(['/queue']);
      }
    } catch (e) {
      console.error('Failed to start the next consultation', e);
      await this.dialogService?.open({
        title: 'Handoff failed',
        message: 'The current consultation is finished, but the next patient could not be opened. Retry to resume safely.',
        type: 'error'
      });
    }
  }

  async completeConsult(manageActionLock = true): Promise<boolean> {
    if (this.visitForm.invalid) {
      this.visitForm.markAllAsTouched();
      this.toastService?.warning('Add a diagnosis before finishing the consultation.', 'Incomplete chart');
      return false;
    }

    if (!this.encounterId || (manageActionLock && this.actionInFlight)) return false;

    return this.verifyAllergySafety(() => this.executeCompleteConsult(manageActionLock));
  }

  private async executeCompleteConsult(manageActionLock: boolean): Promise<boolean> {
    try {
      if (manageActionLock) this.actionInFlight = true;
      await this.dataService.invoke('completeConsultation', {
        encounterId: this.encounterId,
        visit: this.currentVisitData()
      });
      if (manageActionLock) this.isConsulting = false;
      return true;
    } catch (e) {
      console.error('Failed to end consult', e);
      await this.dialogService?.open({
        title: 'Finish failed',
        message: 'The consultation could not be finished. Your encounter remains open.',
        type: 'error'
      });
      return false;
    } finally {
      if (manageActionLock) this.actionInFlight = false;
    }
  }

  copyLastVisit() {
    if (!this.canEditChart || this.history.length === 0) return;
    this.conditionPresetGeneration += 1;
    const last = this.history[0];
    this.visitForm.patchValue({
      diagnosis: last.diagnosis,
      diagnosis_type: last.diagnosis_type,
      prescription: last.prescription
    });
    this.currentPrescription = last.prescription || [];
    this.invalidateStaleOverride(this.currentPrescription);
  }

  async postponeConsult() {
    if (!this.encounterId || this.actionInFlight) return;
    try {
      this.actionInFlight = true;
      await this.dataService.invoke('postponeConsultation', {
        encounterId: this.encounterId,
        visit: this.visitForm.valid ? this.currentVisitData() : undefined
      });
      this.router.navigate(['/queue']);
    } catch (e) {
      console.error(e);
      await this.dialogService?.open({
        title: 'Postpone failed',
        message: 'The consultation could not be postponed.',
        type: 'error'
      });
    } finally {
      this.actionInFlight = false;
    }
  }

  private currentVisitData() {
    return { ...this.visitForm.value };
  }

  private applyViewIntent(source: Record<string, any> | null | undefined) {
    const isViewMode = source?.['mode'] === 'view';
    const visitId = source?.['visitId'];
    this.viewMode = isViewMode;
    this.viewVisitId = isViewMode && visitId != null && visitId !== ''
      ? Number(visitId)
      : null;
    if (!isViewMode) this.viewedVisit = null;
  }

  private async loadFinishedVisitView() {
    const [visits, allPatients, vitals, safetyContext] = await Promise.all([
      this.dataService.invoke<any[]>('getVisits', this.patientId),
      this.dataService.invoke<any[]>('getPatients', ''),
      this.dataService.invoke<any>('getVitals', this.patientId),
      this.dataService.invoke<any>('getPatientSafetyContext', this.patientId).catch(() => null)
    ]);
    const patient = allPatients.find((item: any) => item.id === this.patientId);
    const finished = (visits || []).filter((visit: any) => visit.status !== 'in-progress');
    const target = this.viewVisitId != null
      ? finished.find((visit: any) => Number(visit.id) === Number(this.viewVisitId))
      : undefined;

    this.ngZone.run(() => {
      this.patient = patient;
      this.history = finished;
      this.patientVitals = vitals;
      this.patientSafetyContext = safetyContext;
      this.activeEncounterReadOnly = false;
      this.encounterId = null;
      this.isConsulting = false;
      this.editingVisitId = null;
      this.viewedVisit = target || null;
      if (target) {
        this.patchVisitSnapshot(target);
      } else if (this.viewVisitId != null) {
        this.consultationLoadError = 'Could not load this visit.';
      }
      this.setChartWritable(false);
    });
    void this.loadInvoices();
  }

  private async generateVisitPdf(visit: any) {
    const settings = await this.dataService.invoke<any>('getPublicSettings');
    const currentUser = this.authService.getUser();
    const doctor = {
      name: currentUser?.name || settings?.doctor_name || 'Doctor',
      specialty: currentUser?.specialty || 'General',
      license_number: currentUser?.license_number || settings?.license_key || ''
    };
    await this.pdfService.generatePrescription(
      { ...visit, date: visit.date || new Date() },
      this.patient,
      doctor
    );
  }

  private patchVisitSnapshot(visit: any) {
    this.viewedVisit = visit;
    this.visitForm.patchValue({
      symptoms: visit.symptoms || '',
      examination_notes: visit.examination_notes || '',
      diagnosis: visit.diagnosis || '',
      diagnosis_type: visit.diagnosis_type || '',
      prescription: visit.prescription || [],
      amount_paid: visit.amount_paid || 0,
      allergy_override_reason: visit.allergy_override_reason || ''
    });
    this.currentPrescription = visit.prescription || [];
  }

  private patchEncounter(encounter: any) {
    this.visitForm.patchValue({
      symptoms: encounter.symptoms || '',
      examination_notes: encounter.examination_notes || '',
      diagnosis: encounter.diagnosis || '',
      diagnosis_type: encounter.diagnosis_type || '',
      prescription: encounter.prescription || [],
      amount_paid: encounter.amount_paid || 0,
      allergy_override_reason: encounter.allergy_override_reason || ''
    });
    this.currentPrescription = encounter.prescription || [];
  }

  private isAuthorizationError(error: unknown): boolean {
    const message = String((error as Error)?.message ?? error ?? '');
    return /responsible practitioner|forbidden|unauthorized/i.test(message);
  }

  openVitalsModal(): void {
    if (!this.canEditChart) return;
    this.showVitalsModal = true;
  }

  closeVitalsModal(): void {
    this.showVitalsModal = false;
  }

  onVitalsSaved(vitals: any): void {
    this.patientVitals = vitals;
    this.closeVitalsModal();
  }

  hasBp(v: any): boolean {
    return Boolean(v && this.isVitalPresent(v.systolic_bp) && this.isVitalPresent(v.diastolic_bp));
  }

  isVitalPresent(val: unknown): boolean {
    return val !== null && val !== undefined && val !== '' && !Number.isNaN(val);
  }

  hasVitalsToDisplay(v: any): boolean {
    if (!v) return false;
    return this.hasBp(v) ||
      this.isVitalPresent(v.pulse) ||
      this.isVitalPresent(v.temperature) ||
      this.isVitalPresent(v.spo2) ||
      this.isVitalPresent(v.weight) ||
      this.isVitalPresent(v.height);
  }

  formatVitalsObjective(v: any): string {
    if (!v) return '';
    const parts: string[] = [];
    if (this.hasBp(v)) parts.push(`BP: ${v.systolic_bp}/${v.diastolic_bp} mmHg`);
    if (this.isVitalPresent(v.pulse)) parts.push(`Pulse: ${v.pulse} bpm`);
    if (this.isVitalPresent(v.temperature)) parts.push(`Temp: ${v.temperature} ${v.units?.temperature || '°F'}`);
    if (this.isVitalPresent(v.spo2)) parts.push(`SpO2: ${v.spo2}%`);
    if (this.isVitalPresent(v.respiratory_rate)) parts.push(`RR: ${v.respiratory_rate} bpm`);
    if (this.isVitalPresent(v.weight)) parts.push(`Weight: ${v.weight} ${v.units?.weight || 'kg'}`);
    if (this.isVitalPresent(v.height)) parts.push(`Height: ${v.height} cm`);
    if (this.isVitalPresent(v.bmi)) parts.push(`BMI: ${v.bmi}`);
    return parts.join('\n');
  }

  goBack() {
    this.router.navigate(['/patients']);
  }
}
