import { Component, NgZone, OnInit, inject } from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';
import { FormsModule, ReactiveFormsModule, FormBuilder, FormGroup, Validators } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';

import { DataService } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { DialogService } from '../../shared/services/dialog.service';
import { DatePickerComponent } from '../../shared/components/date-picker/date-picker.component';
import { SharedTableComponent } from '../../shared/components/table/table.component';
import { AbhaModalComponent } from '../abha-modal.component';
import { buildOpConsultRecord } from '../../../../shared/fhir/serializer';
import { ColDef } from 'ag-grid-community';
import { newRequestId } from '../../services/request-id';

@Component({
    selector: 'app-patient-details',
    standalone: true,
    imports: [CommonModule, FormsModule, ReactiveFormsModule, DatePickerComponent, SharedTableComponent, AbhaModalComponent],
    styles: [`
        @media print {
            /* Hide everything by default */
            div.min-h-screen > div:first-child, /* Header */
            div.min-h-screen > div:nth-child(2) { /* Main Content */
                display: none !important;
            }

            /* Show ONLY the receipt modal content */
            .print-scope-receipt {
                position: static !important;
                background: white !important;
                display: block !important;
            }
            .print-scope-receipt > div {
                box-shadow: none !important;
                max-width: 100% !important;
                max-height: none !important;
                border-radius: 0 !important;
            }

            /* Hide modal close button & actions */
            .print-scope-receipt button,
            .print-scope-receipt .border-t {
                display: none !important;
            }

            /* Ensure body is visible and formatted */
            .p-8 { padding: 0 !important; }
            .overflow-y-auto { overflow: visible !important; }
            
            /* Typography for Print */
            body { font-family: serif; font-size: 12pt; color: black; }
            h1 { font-size: 18pt; margin-bottom: 0.5rem; }
            p { margin-bottom: 0.25rem; }
            table { width: 100%; border-collapse: collapse; margin-top: 1rem; }
            th, td { border-bottom: 1px solid #ddd; padding: 4px; text-align: left; }
            th { font-weight: bold; }
        }
    `],
    template: `
    <div class="min-h-screen bg-gray-50 flex flex-col">
      <!-- Header / Breadcrumbs -->
      <div class="bg-white border-b px-4 md:px-6 py-3 flex justify-between items-center sticky top-0 z-10">
        <div class="flex items-center gap-2 text-sm text-gray-500">
          <span class="hover:text-blue-600 cursor-pointer" (click)="goBack()">Patients</span>
          <span>/</span>
          <span class="font-medium text-gray-800">{{ patient?.name || 'Loading...' }}</span>
        </div>
        <div class="flex gap-3">
             <button *ngIf="currentUser?.role === 'admin'" (click)="deletePatient()" class="text-red-500 hover:bg-red-50 px-3 py-1 rounded text-sm font-medium transition border border-transparent hover:border-red-100">Delete Patient</button>
             <button *ngIf="currentUser?.role === 'admin' || currentUser?.role === 'doctor'" (click)="startConsult()" [disabled]="startingConsult" class="bg-blue-600 text-white px-6 py-2 rounded hover:bg-blue-700 font-bold shadow-sm flex items-center gap-2 transition disabled:opacity-50">
                Start Consultation
             </button>
        </div>
      </div>

      <div class="flex-1 w-full p-4 md:p-6 grid grid-cols-12 gap-4 md:gap-6">
        
        <!-- LEFT COL: Profile & Vitals -->
        <div class="col-span-12 md:col-span-4 space-y-4">
            <!-- Profile Card -->
            <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-6 relative overflow-hidden">
                <div class="absolute top-0 left-0 w-full h-1 bg-blue-600"></div>
                <div class="flex justify-between items-start mb-4">
                    <div class="w-16 h-16 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center text-2xl font-bold">
                        {{ patient?.name?.charAt(0) || '?' }}
                    </div>
                    <button class="text-gray-500 hover:text-blue-600 font-bold text-sm" (click)="openEditModal()">EDIT</button>
                </div>
                <h1 class="text-2xl font-bold text-gray-800 mb-1">{{ patient?.name }}</h1>
                <p class="text-sm text-gray-500 font-medium mb-4">{{ patient?.age }} Years / {{ patient?.gender }}</p>
                
                <div class="space-y-3 pt-4 border-t border-gray-100">
                    <div class="flex items-center gap-3 text-sm text-gray-600">
                        {{ patient?.mobile }}
                    </div>
                    <div class="flex items-center justify-between gap-3 text-sm" *ngIf="currentUser?.role !== 'nurse'">
                        <span class="text-gray-600 truncate">{{ patient?.abha_address || 'No health ID linked' }}</span>
                        <button class="text-blue-600 hover:underline font-medium text-xs shrink-0" (click)="showAbhaModal = true">
                            {{ patient?.abha_address ? 'Manage' : 'Link Health ID' }}
                        </button>
                    </div>
                    <div class="flex items-center gap-3 text-sm text-gray-600">
                        {{ patient?.address || 'No address' }}
                    </div>
                    <div class="flex items-center gap-3 text-sm text-gray-600">
                        {{ patient?.blood_group || '-' }}
                    </div>
                </div>
            </div>

            <!-- Vitals Snapshot -->
            <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
                <h3 class="font-bold text-gray-800 mb-4">Last Vitals</h3>
                <div *ngIf="hasVitalsToDisplay(vitals); else noVitals" class="grid grid-cols-2 gap-4">
                    <div class="p-3 bg-gray-50 rounded border border-gray-100">
                        <div class="text-xs text-gray-500 uppercase font-bold">BP</div>
                        <div class="text-lg font-mono font-bold text-gray-800">
                            {{ hasBp(vitals) ? (vitals.systolic_bp + '/' + vitals.diastolic_bp) : '--' }}
                        </div>
                    </div>
                     <div class="p-3 bg-gray-50 rounded border border-gray-100">
                        <div class="text-xs text-gray-500 uppercase font-bold">Pulse</div>
                        <div class="text-lg font-mono font-bold text-gray-800">
                            {{ isVitalPresent(vitals.pulse) ? vitals.pulse : '--' }}
                            <span *ngIf="isVitalPresent(vitals.pulse)" class="text-xs font-normal">bpm</span>
                        </div>
                    </div>
                     <div class="p-3 bg-gray-50 rounded border border-gray-100">
                        <div class="text-xs text-gray-500 uppercase font-bold">Temp</div>
                        <div class="text-lg font-mono font-bold text-gray-800">
                            {{ isVitalPresent(vitals.temperature) ? vitals.temperature : '--' }}
                            <span *ngIf="isVitalPresent(vitals.temperature)" class="text-xs font-normal">{{ vitals.units?.temperature || '°F' }}</span>
                        </div>
                    </div>
                     <div class="p-3 bg-gray-50 rounded border border-gray-100">
                        <div class="text-xs text-gray-500 uppercase font-bold">Weight</div>
                        <div class="text-lg font-mono font-bold text-gray-800">
                            {{ isVitalPresent(vitals.weight) ? vitals.weight : '--' }}
                            <span *ngIf="isVitalPresent(vitals.weight)" class="text-xs font-normal">{{ vitals.units?.weight || 'kg' }}</span>
                        </div>
                    </div>
                </div>
                <ng-template #noVitals>
                    <div class="text-sm text-gray-500 italic text-center py-4">No vitals recorded.</div>
                </ng-template>
            </div>
            <!-- Clinical Safety Summary Card -->
            <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
                <div class="flex items-center justify-between mb-3">
                    <h3 class="font-bold text-gray-800 flex items-center gap-2">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-4 h-4"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75 11.25 15 15 9.75m-3-7.036A11.959 11.959 0 0 1 3.598 6 11.99 11.99 0 0 0 3 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285Z" /></svg> Clinical Safety
                    </h3>
                    <span *ngIf="safetyContext?.has_active_allergies" class="text-xs font-bold px-2 py-0.5 rounded-full bg-red-100 text-red-700">
                        {{ safetyContext.active_allergies.length }} Allergy Alert
                    </span>
                    <span *ngIf="safetyContext && !safetyContext.has_active_allergies" class="text-xs font-semibold px-2 py-0.5 rounded-full bg-green-100 text-green-700 flex items-center gap-1">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor" class="w-3.5 h-3.5"><path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5" /></svg><span>No Known Allergies</span>
                    </span>
                </div>

                <div class="space-y-2 text-xs">
                    <div class="p-2.5 rounded-lg border flex items-center justify-between cursor-pointer hover:bg-gray-50 transition"
                         [ngClass]="safetyContext?.has_active_allergies ? 'bg-red-50/70 border-red-200' : 'bg-gray-50 border-gray-100'"
                         (click)="activeTab = 'summary'">
                        <span class="font-medium text-gray-600">Allergies</span>
                        <span class="font-bold" [ngClass]="safetyContext?.has_active_allergies ? 'text-red-700' : 'text-gray-500'">
                            {{ safetyContext?.active_allergies?.length || 0 }} Active
                        </span>
                    </div>
                    <div class="p-2.5 rounded-lg border bg-gray-50 border-gray-100 flex items-center justify-between cursor-pointer hover:bg-gray-100 transition"
                         (click)="activeTab = 'summary'">
                        <span class="font-medium text-gray-600">Active Problems</span>
                        <span class="font-bold text-gray-700">
                            {{ safetyContext?.active_conditions?.length || 0 }}
                        </span>
                    </div>
                    <div class="p-2.5 rounded-lg border bg-gray-50 border-gray-100 flex items-center justify-between cursor-pointer hover:bg-gray-100 transition"
                         (click)="activeTab = 'summary'">
                        <span class="font-medium text-gray-600">Active Medications</span>
                        <span class="font-bold text-gray-700">
                            {{ safetyContext?.active_medications?.length || 0 }}
                        </span>
                    </div>
                </div>
            </div>
        </div>

        <!-- RIGHT COL: Tabbed Clinical Chart -->
        <div class="col-span-12 md:col-span-8">
<div class="bg-white rounded-lg shadow-sm border border-gray-200 flex flex-col h-[calc(100vh-15rem)] min-h-[360px]">
                <div class="px-6 py-3 border-b flex flex-wrap justify-between items-center bg-gray-50/50 rounded-t-lg gap-2">
                    <!-- Tabs -->
                    <div class="flex items-center gap-2">
                        <button type="button" (click)="activeTab = 'summary'"
                                [class.bg-white]="activeTab === 'summary'"
                                [class.shadow-sm]="activeTab === 'summary'"
                                [class.text-blue-600]="activeTab === 'summary'"
                                [class.font-bold]="activeTab === 'summary'"
                                [class.text-gray-600]="activeTab !== 'summary'"
                                class="px-3 py-1.5 rounded-lg text-sm transition">
                            Summary
                        </button>
                        <button type="button" (click)="activeTab = 'visits'"
                                [class.bg-white]="activeTab === 'visits'"
                                [class.shadow-sm]="activeTab === 'visits'"
                                [class.text-blue-600]="activeTab === 'visits'"
                                [class.font-bold]="activeTab === 'visits'"
                                [class.text-gray-600]="activeTab !== 'visits'"
                                class="px-3 py-1.5 rounded-lg text-sm transition">
                            Visits ({{ visits.length }})
                        </button>
                        <button type="button" (click)="openExternalTab()"
                                [class.bg-white]="activeTab === 'external'"
                                [class.shadow-sm]="activeTab === 'external'"
                                [class.text-blue-600]="activeTab === 'external'"
                                [class.font-bold]="activeTab === 'external'"
                                [class.text-gray-600]="activeTab !== 'external'"
                                class="px-3 py-1.5 rounded-lg text-sm transition flex items-center gap-1.5">
                            <span>External</span>
                            <span *ngIf="externalRecords.length" class="text-[10px] bg-blue-100 text-blue-700 font-bold px-1.5 py-0.5 rounded-full">
                                {{ externalRecords.length }}
                            </span>
                        </button>
                    </div>

                    <!-- Right Actions depending on tab -->
                    <div class="flex items-center gap-2">
                        <button (click)="loadData()" class="text-xs text-blue-600 hover:underline">Refresh</button>
                    </div>
                </div>

                <!-- TAB: VISITS (standard AG Grid) -->
                <div *ngIf="activeTab === 'visits'" class="flex-1 min-h-0 overflow-hidden">
                    <app-shared-table [rowData]="visits" [columnDefs]="visitColumnDefs" [pagination]="true" [pageSize]="10">
                        <div toolbar-left class="flex items-center gap-2">
                            <span class="text-xs text-gray-500">{{ visits.length }} recorded</span>
                        </div>
                    </app-shared-table>
                </div>

                <!-- TAB: SUMMARY -->
                <div *ngIf="activeTab === 'summary'" class="flex-1 min-h-0 overflow-y-auto p-4 md:p-6 space-y-4">
                    <div *ngIf="activeAllergiesList().length > 0" class="rounded-lg border border-red-200 bg-red-50 p-3">
                        <div class="text-xs font-bold uppercase tracking-wider text-red-700 mb-1.5">
                            Active allergies ({{ activeAllergiesList().length }})
                        </div>
                        <div class="flex flex-wrap gap-1.5">
                            <span *ngFor="let a of activeAllergiesList()"
                                  class="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-red-200 bg-white text-xs font-semibold text-red-800">
                                {{ a.substance }}
                                <span *ngIf="a.criticality" class="font-normal text-red-500 uppercase">{{ a.criticality }}</span>
                            </span>
                        </div>
                    </div>
                    <div *ngIf="activeAllergiesList().length === 0" class="text-xs text-gray-500 flex items-center gap-1.5">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor" class="w-3.5 h-3.5 text-green-600"><path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5" /></svg>
                        <span>No known allergies recorded.</span>
                    </div>

                    <section>
                        <div class="flex items-center justify-between mb-2">
                            <h3 class="text-sm font-bold text-gray-800">Active Problems ({{ activeConditionsList().length }})</h3>
                            <button *ngIf="canMutateSafety" (click)="openAddConditionModal()" class="text-xs bg-amber-50 text-amber-800 border border-amber-200 hover:bg-amber-100 font-bold px-2.5 py-1.5 rounded transition">+ Add Problem</button>
                        </div>
                        <div *ngIf="activeConditionsList().length === 0" class="text-xs text-gray-400 italic">No active problems recorded.</div>
                        <div *ngFor="let c of activeConditionsList()" class="flex items-center justify-between gap-2 py-2 border-b border-gray-100 last:border-0">
                            <div class="min-w-0">
                                <div class="text-sm font-semibold text-gray-800 truncate">{{ c.condition_name || c.name }}</div>
                                <div class="text-xs text-gray-500">{{ c.code || c.icd10_code || '' }}{{ (c.code || c.icd10_code) && c.onset_date ? ' • ' : '' }}{{ c.onset_date || '' }}</div>
                            </div>
                            <button *ngIf="canMutateSafety" (click)="removeSafetyRecord('condition', c.id)" class="text-gray-400 hover:text-red-600 text-xs hover:bg-red-50 p-1.5 rounded shrink-0" aria-label="Remove problem">✕</button>
                        </div>
                    </section>

                    <section>
                        <div class="flex items-center justify-between mb-2">
                            <h3 class="text-sm font-bold text-gray-800">Active Medications ({{ activeMedicationsList().length }})</h3>
                            <button *ngIf="canMutateSafety" (click)="openAddMedicationModal()" class="text-xs bg-green-50 text-green-800 border border-green-200 hover:bg-green-100 font-bold px-2.5 py-1.5 rounded transition">+ Add Medication</button>
                        </div>
                        <div *ngIf="activeMedicationsList().length === 0" class="text-xs text-gray-400 italic">No active medications recorded.</div>
                        <div *ngFor="let m of activeMedicationsList()" class="flex items-center justify-between gap-2 py-2 border-b border-gray-100 last:border-0">
                            <div class="min-w-0">
                                <div class="text-sm font-semibold text-gray-800 truncate">{{ m.medicine_name || m.medication_name || m.name }}</div>
                                <div class="text-xs text-gray-500">{{ m.dosage || '' }}{{ m.dosage && m.frequency ? ' • ' : '' }}{{ m.frequency || '' }}</div>
                            </div>
                            <button *ngIf="canMutateSafety" (click)="removeSafetyRecord('medication', m.id)" class="text-gray-400 hover:text-red-600 text-xs hover:bg-red-50 p-1.5 rounded shrink-0" aria-label="Remove medication">✕</button>
                        </div>
                    </section>

                    <section>
                        <div class="flex items-center justify-between mb-2">
                            <h3 class="text-sm font-bold text-gray-800">Recent Visits</h3>
                            <button (click)="activeTab = 'visits'" class="text-xs text-blue-600 hover:underline">View all ({{ visits.length }})</button>
                        </div>
                        <div *ngIf="visits.length === 0" class="text-xs text-gray-400 italic">No visits recorded yet.</div>
                        <div *ngFor="let v of recentVisits()" class="flex items-center justify-between gap-2 py-2 border-b border-gray-100 last:border-0">
                            <div class="min-w-0">
                                <div class="text-sm font-semibold text-gray-800 truncate">{{ v.diagnosis || 'No diagnosis' }}</div>
                                <div class="text-xs text-gray-500">{{ v.date ? (v.date | date:'mediumDate') : '' }}</div>
                            </div>
                            <button (click)="viewVisit(v)" class="text-xs text-blue-600 border border-blue-200 hover:border-blue-400 bg-blue-50 px-3 py-1 rounded shrink-0">View</button>
                        </div>
                    </section>
                </div>

                <!-- TAB: EXTERNAL RECORDS (M3 HIU) -->
                <div *ngIf="activeTab === 'external'" class="flex-1 min-h-0 overflow-y-auto p-4 md:p-6 space-y-4">
                    <div class="flex items-center justify-between gap-2">
                        <span class="text-xs text-gray-500">{{ externalRecords.length }} outside record(s)</span>
                        <div class="flex items-center gap-2">
                            <button *ngIf="canMutateSafety" (click)="showConsentForm = !showConsentForm" class="text-xs bg-blue-50 text-blue-700 border border-blue-200 hover:bg-blue-100 font-bold px-2.5 py-1.5 rounded transition">Request records</button>
                            <button *ngIf="canMutateSafety && externalRecords.length > 0" (click)="clearExternalCache()" class="text-xs text-gray-500 hover:text-red-600 border border-gray-200 hover:border-red-200 px-2.5 py-1.5 rounded transition">Clear cache</button>
                        </div>
                    </div>

                    <div *ngIf="showConsentForm" class="rounded-lg border border-blue-200 bg-blue-50/50 p-4 space-y-3">
                        <label class="block text-xs font-semibold text-gray-700">Health ID address
                            <input [(ngModel)]="consentForm.abhaAddress" placeholder="name@abdm" class="mt-1 w-full border p-2 rounded text-sm outline-none focus:ring-2 focus:ring-blue-500 font-mono">
                        </label>
                        <div>
                            <div class="text-xs font-semibold text-gray-700 mb-1.5">Record types</div>
                            <div class="flex flex-wrap gap-1.5">
                                <button *ngFor="let t of HI_TYPES" type="button" (click)="toggleHiType(t)"
                                        class="px-2.5 py-1 rounded-full border text-xs font-medium transition"
                                        [ngClass]="consentForm.hiTypes.includes(t) ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-600 border-gray-300 hover:border-blue-400'">{{ t }}</button>
                            </div>
                        </div>
                        <div class="grid grid-cols-2 gap-2">
                            <label class="block text-xs font-semibold text-gray-700">From (optional)
                                <input [(ngModel)]="consentForm.dateFrom" type="date" class="mt-1 w-full border p-2 rounded text-sm outline-none">
                            </label>
                            <label class="block text-xs font-semibold text-gray-700">To (optional)
                                <input [(ngModel)]="consentForm.dateTo" type="date" class="mt-1 w-full border p-2 rounded text-sm outline-none">
                            </label>
                        </div>
                        <p *ngIf="consentError" class="text-xs text-red-600">{{ consentError }}</p>
                        <div class="flex justify-end gap-2">
                            <button (click)="showConsentForm = false" class="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded border bg-white transition-colors">Cancel</button>
                            <button (click)="requestExternalConsent()" [disabled]="consentBusy" class="px-4 py-2 text-sm bg-blue-600 text-white font-medium rounded hover:bg-blue-700 disabled:opacity-50 transition-colors">
                                {{ consentBusy ? 'Requesting...' : 'Send request' }}
                            </button>
                        </div>
                        <p class="text-[11px] text-gray-500">The patient approves this in their health app. Records appear here once granted and fetched.</p>
                    </div>

                    <div *ngIf="externalConsents.length > 0" class="space-y-2">
                        <div *ngFor="let c of externalConsents" class="flex items-center justify-between gap-2 rounded-lg border border-gray-200 p-2.5 text-xs">
                            <div class="min-w-0">
                                <div class="font-mono font-semibold text-gray-800 truncate">{{ c.abha_address }}</div>
                                <div class="text-gray-500 truncate">{{ consentTypesText(c) }}{{ c.date_from ? ' • ' + c.date_from + ' → ' + (c.date_to || 'now') : '' }}</div>
                            </div>
                            <div class="flex items-center gap-2 shrink-0">
                                <span class="px-2 py-0.5 rounded uppercase text-[10px] font-bold" [ngClass]="consentChipClass(c.status)">{{ c.status }}</span>
                                <button *ngIf="c.status === 'granted' && canMutateSafety" (click)="fetchExternal(c.id)" class="text-blue-600 border border-blue-200 hover:border-blue-400 bg-blue-50 px-2.5 py-1 rounded font-semibold">Fetch</button>
                            </div>
                        </div>
                    </div>

                    <div *ngIf="!loadingExternal && externalRecords.length === 0 && externalConsents.length === 0" class="text-center text-sm text-gray-500 py-8">
                        No outside records yet. Request them from another facility with patient consent.
                    </div>
                    <div *ngIf="loadingExternal" class="text-center text-sm text-gray-500 py-8">Loading outside records...</div>

                    <div *ngFor="let rec of externalRecords" class="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
                        <div class="flex items-start justify-between gap-2">
                            <div class="font-bold text-gray-800 text-sm">{{ rec.parsed?.title || 'Outside record' }}</div>
                            <div class="text-[11px] text-gray-400 font-mono shrink-0">{{ rec.fetchedAt ? (rec.fetchedAt | date:'shortDate') : '' }}</div>
                        </div>
                        <p *ngIf="rec.error" class="text-xs text-amber-700 mt-1">This record could not be read: {{ rec.error }}</p>
                        <div *ngIf="rec.parsed?.diagnoses?.length" class="mt-2">
                            <div class="text-[11px] font-bold uppercase tracking-wider text-gray-500">Diagnoses</div>
                            <div *ngFor="let d of rec.parsed.diagnoses" class="text-sm text-gray-700">• {{ d.text }}{{ d.code ? ' (' + d.code + ')' : '' }}</div>
                        </div>
                        <div *ngIf="rec.parsed?.medications?.length" class="mt-2">
                            <div class="text-[11px] font-bold uppercase tracking-wider text-gray-500">Medications</div>
                            <div *ngFor="let m of rec.parsed.medications" class="flex items-center justify-between gap-2 py-1 border-b border-gray-50 last:border-0">
                                <div class="text-sm text-gray-700 min-w-0">
                                    <span class="font-semibold">{{ m.name }}</span>
                                    <span class="text-gray-500 text-xs"> {{ m.dosage || '' }}{{ m.dosage && m.frequency ? ' • ' : '' }}{{ m.frequency || '' }}</span>
                                </div>
                                <button *ngIf="canMutateSafety" (click)="importExternalMed(rec.id, m)" class="text-xs text-green-700 border border-green-200 hover:bg-green-50 px-2 py-1 rounded shrink-0">Import</button>
                            </div>
                        </div>
                        <div *ngIf="rec.parsed?.observations?.length" class="mt-2">
                            <div class="text-[11px] font-bold uppercase tracking-wider text-gray-500">Observations</div>
                            <div *ngFor="let o of rec.parsed.observations" class="text-sm text-gray-700">• {{ o.text }}{{ o.value ? ': ' + o.value : '' }}</div>
                        </div>
                        <div *ngIf="rec.parsed?.allergies?.length" class="mt-2">
                            <div class="text-[11px] font-bold uppercase tracking-wider text-gray-500">Allergies noted outside</div>
                            <div *ngFor="let a of rec.parsed.allergies" class="text-sm text-red-700">• {{ a.substance }}</div>
                        </div>
                    </div>
                    <p *ngIf="externalError" class="text-xs text-red-600">{{ externalError }}</p>
                </div>

             </div>
        </div>

      </div>



      <!-- Edit Patient Modal (Synced with Patient List) -->
      <div *ngIf="showEditModal" class="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div class="bg-white rounded-lg w-[800px] max-h-[90vh] shadow-xl flex flex-col overflow-hidden">
            
            <!-- Fixed Header -->
            <div class="px-6 py-4 border-b bg-gray-50 flex justify-between items-center">
                <h2 class="text-xl font-bold text-gray-800">Edit Patient Details</h2>
                <button (click)="showEditModal = false" class="text-gray-500 hover:text-gray-600" aria-label="Close"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="w-4 h-4"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg></button>
            </div>

            <!-- Scrollable Body -->
            <div class="flex-1 overflow-y-auto p-6">
                <form [formGroup]="patientForm" id="patientForm" (ngSubmit)="savePatient()">
                    
                    <!-- 1. Personal Info -->
                    <div class="mb-6">
                        <h3 class="font-bold text-gray-700 border-b pb-1 mb-3">Personal Information</h3>
                        <div class="grid grid-cols-2 gap-4">
                            
                            <!-- Name -->
                            <div class="col-span-1">
                                <label class="block text-sm font-medium text-gray-700">Full Name <span class="text-red-500">*</span></label>
                                <input formControlName="name" placeholder="John Doe" 
                                    class="w-full border p-2 rounded focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none" 
                                    [class.border-red-500]="isFieldInvalid('name')" [class.bg-red-50]="isFieldInvalid('name')">
                                <p *ngIf="isFieldInvalid('name')" class="text-xs text-red-500 mt-1">Name is required (min 3 chars, letters only).</p>
                            </div>

                            <!-- Mobile -->
                            <div class="col-span-1">
                                <label class="block text-sm font-medium text-gray-700">Mobile Number <span class="text-red-500">*</span></label>
                                <input formControlName="mobile" type="tel" inputmode="numeric" maxlength="10" placeholder="9876543210"
                                    class="w-full border p-2 rounded focus:ring-2 focus:ring-blue-500 outline-none"
                                    [class.border-red-500]="isFieldInvalid('mobile')" [class.bg-red-50]="isFieldInvalid('mobile')">
                                <p *ngIf="isFieldInvalid('mobile')" class="text-xs text-red-500 mt-1">Valid 10-digit mobile number required.</p>
                            </div>

                            <!-- DOB & Age Row -->
                            <div class="flex gap-4 col-span-2 items-start">
                                <!-- DOB (First) -->
                                <div class="w-1/3 relative">
                                    <label class="block text-sm font-medium text-gray-700">Date of Birth</label>
                                    <app-date-picker 
                                        formControlName="dob" 
                                        [maxDate]="today"
                                        [minDate]="minDate"
                                        placeholder="Select DOB"
                                        helperText="Auto-calculates Age">
                                    </app-date-picker>
                                </div>

                                <!-- Age -->
                                <div class="w-1/4">
                                    <label class="block text-sm font-medium text-gray-700">Age <span class="text-red-500">*</span></label>
                                    <input type="number" formControlName="age" min="0" max="110" placeholder="30"
                                        class="w-full border p-2 rounded focus:ring-2 focus:ring-blue-500 outline-none bg-gray-50"
                                        [class.border-red-500]="isFieldInvalid('age')">
                                    <p *ngIf="isFieldInvalid('age')" class="text-xs text-red-500 mt-1">Required</p>
                                </div>

                                <!-- Gender -->
                                <div class="w-1/4">
                                    <label class="block text-sm font-medium text-gray-700">Gender <span class="text-red-500">*</span></label>
                                    <select formControlName="gender" class="w-full border p-2 rounded focus:ring-2 focus:ring-blue-500 outline-none"
                                            [class.border-red-500]="isFieldInvalid('gender')">
                                        <option value="" disabled>Select</option>
                                        <option value="Male">Male</option>
                                        <option value="Female">Female</option>
                                        <option value="Other">Other</option>
                                    </select>
                                    <p *ngIf="isFieldInvalid('gender')" class="text-xs text-red-500 mt-1">Required</p>
                                </div>

                                <!-- Blood Group -->
                                <div class="w-1/6">
                                    <label class="block text-sm font-medium text-gray-700">Blood</label>
                                    <select formControlName="blood_group" class="w-full border p-2 rounded">
                                        <option value="">-</option>
                                        <option value="A+">A+</option> <option value="A-">A-</option>
                                        <option value="B+">B+</option> <option value="B-">B-</option>
                                        <option value="O+">O+</option> <option value="O-">O-</option>
                                        <option value="AB+">AB+</option> <option value="AB-">AB-</option>
                                    </select>
                                </div>
                            </div>

                            <div class="col-span-2">
                                <label class="block text-sm font-medium text-gray-700">Email (Optional)</label>
                                <input type="email" formControlName="email" placeholder="patient@example.com" class="w-full border p-2 rounded">
                                <p *ngIf="isFieldInvalid('email')" class="text-xs text-red-500 mt-1">Invalid email format.</p>
                            </div>
                        </div>
                    </div>

                    <!-- 2. Address Info -->
                    <div class="mb-6">
                        <h3 class="font-bold text-gray-700 border-b pb-1 mb-3">Address Details</h3>
                        <div class="grid grid-cols-2 gap-4">
                            <div class="col-span-2">
                                <label class="block text-sm font-medium text-gray-700">Full Address <span class="text-red-500">*</span></label>
                                <textarea formControlName="address" rows="3" placeholder="House No, Street Name, Area"
                                        class="w-full border p-2 rounded focus:ring-2 focus:ring-blue-500 outline-none"
                                        [class.border-red-500]="isFieldInvalid('address')"></textarea>
                                <p *ngIf="isFieldInvalid('address')" class="text-xs text-red-500 mt-1">Address is required.</p>
                            </div>
                            
                            <div>
                                <label class="block text-sm font-medium text-gray-700">City</label>
                                <input formControlName="city" placeholder="City" class="w-full border p-2 rounded">
                            </div>
                            
                            <div class="flex gap-2">
                                <div class="w-1/2">
                                    <label class="block text-sm font-medium text-gray-700">State</label>
                                    <input formControlName="state" class="w-full border p-2 rounded">
                                </div>
                                <div class="w-1/2">
                                    <label class="block text-sm font-medium text-gray-700">Pincode</label>
                                    <input formControlName="zip_code" maxlength="6" inputmode="numeric" placeholder="600000"
                                            class="w-full border p-2 rounded focus:ring-2 focus:ring-blue-500 outline-none"
                                            [class.border-red-500]="isFieldInvalid('zip_code')">
                                    <p *ngIf="isFieldInvalid('zip_code')" class="text-xs text-red-500 mt-1">Invalid Pincode (6 digits)</p>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- 3. Emergency Info -->
                    <div>
                        <h3 class="font-bold text-gray-700 border-b pb-1 mb-3">Emergency Contact</h3>
                        <div class="grid grid-cols-2 gap-4">
                            <div>
                                <label class="block text-sm font-medium text-gray-700">Contact Name</label>
                                <input formControlName="emergency_contact_name" placeholder="Relative Name" class="w-full border p-2 rounded">
                            </div>

                            <div>
                                <label class="block text-sm font-medium text-gray-700">Emergency Mobile</label>
                                <input formControlName="emergency_contact_mobile" type="tel" maxlength="10" placeholder="Mobile Number"
                                    class="w-full border p-2 rounded focus:ring-2 focus:ring-blue-500 outline-none"
                                    [class.border-red-500]="isFieldInvalid('emergency_contact_mobile')">
                                <p *ngIf="isFieldInvalid('emergency_contact_mobile')" class="text-xs text-red-500 mt-1">Invalid Mobile Number</p>
                            </div>
                        </div>
                    </div>
                </form>
            </div>
            
            <!-- Fixed Footer -->
            <div class="px-6 py-4 border-t bg-gray-50 flex justify-between items-center">
                <p class="text-xs text-gray-500"><span class="text-red-500">*</span> Required Fields</p>
                <div class="flex gap-2">
                    <button type="button" (click)="showEditModal = false" class="px-4 py-2 text-gray-600 hover:bg-gray-200 rounded border bg-white transition-colors">
                        Cancel
                    </button>
                    <!-- form attribute links this button to the form above -->
                    <button type="submit" form="patientForm" 
                            [disabled]="patientForm.invalid" 
                            class="px-6 py-2 bg-blue-600 text-white font-medium rounded hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed shadow transition-colors">
                        Update Patient
                    </button>
                </div>
            </div>
          </div>
      </div>

      <!-- Visit Detail Modal (Receipt View) -->
      <div *ngIf="showVisitModal" class="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4 print-scope-receipt" (click)="closeModal()">
        <div class="bg-white rounded-lg shadow-lg w-full max-w-2xl overflow-hidden flex flex-col max-h-[90vh]" (click)="$event.stopPropagation()">
            <!-- Modal Header -->
            <div class="bg-gray-50 border-b px-6 py-4 flex justify-between items-center">
                <div>
                    <h2 class="text-xl font-bold text-gray-800">Medical Record</h2>
                    <p class="text-sm text-gray-500">{{ selectedVisit?.date | date:'mediumDate' }} • {{ selectedVisit?.doctor_name || 'Dr. ' + (currentUser?.name || '') }}</p>
                </div>
                <button (click)="closeModal()" class="text-gray-500 hover:text-gray-600 rounded-full hover:bg-gray-200 w-8 h-8 flex items-center justify-center" aria-label="Close"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="w-4 h-4"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg></button>
            </div>

            <!-- Modal Body (Scrollable) -->
            <div class="p-8 overflow-y-auto space-y-6 flex-1 font-serif">
                <!-- Header Info for Print -->
                <div class="flex justify-between items-start border-b pb-6 mb-6">
                    <div>
                        <h1 class="text-2xl font-bold text-gray-900">{{ patient?.name }}</h1>
                        <p class="text-gray-600">{{ patient?.age }} / {{ patient?.gender }}</p>
                    </div>
                     <div class="text-right text-sm text-gray-500">
                        <p>ID: #{{ patient?.id }}</p>
                        <p>{{ patient?.mobile }}</p>
                    </div>
                </div>

                <!-- Diagnosis -->
                <div class="mb-6">
                    <h4 class="text-xs font-bold text-gray-500 uppercase tracking-widest mb-1 font-sans">Diagnosis</h4>
                    <p class="text-lg font-medium text-gray-800">
                        {{ selectedVisit?.diagnosis || 'N/A' }}
                        <span *ngIf="selectedVisit?.diagnosis_type" class="ml-2 px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 text-xs align-middle font-sans">{{ selectedVisit?.diagnosis_type }}</span>
                    </p>
                </div>

                <!-- Symptoms & Observations -->
                <div class="grid grid-cols-2 gap-8 mb-6">
                    <div>
                        <h4 class="text-xs font-bold text-gray-500 uppercase tracking-widest mb-1 font-sans">Symptoms</h4>
                        <p class="text-gray-700 whitespace-pre-line">{{ selectedVisit?.symptoms || '-' }}</p>
                    </div>
                     <div>
                        <h4 class="text-xs font-bold text-gray-500 uppercase tracking-widest mb-1 font-sans">Observations</h4>
                        <p class="text-gray-700 whitespace-pre-line">{{ selectedVisit?.examination_notes || '-' }}</p>
                    </div>
                </div>

                <!-- Encounter Vitals -->
                <div *ngIf="selectedVisit?.vitals && hasVitalsToDisplay(selectedVisit.vitals)" class="mb-6 p-4 bg-blue-50/60 rounded-lg border border-blue-100">
                    <h4 class="text-xs font-bold text-blue-800 uppercase tracking-widest mb-2 font-sans">Encounter Vitals</h4>
                    <div class="flex flex-wrap gap-4 text-sm text-blue-900 font-sans">
                        <span *ngIf="hasBp(selectedVisit.vitals)">BP: <b>{{ selectedVisit.vitals.systolic_bp }}/{{ selectedVisit.vitals.diastolic_bp }} mmHg</b></span>
                        <span *ngIf="isVitalPresent(selectedVisit.vitals.pulse)">Pulse: <b>{{ selectedVisit.vitals.pulse }} bpm</b></span>
                        <span *ngIf="isVitalPresent(selectedVisit.vitals.temperature)">Temp: <b>{{ selectedVisit.vitals.temperature }} {{ selectedVisit.vitals.units?.temperature || '°F' }}</b></span>
                        <span *ngIf="isVitalPresent(selectedVisit.vitals.spo2)">SpO2: <b>{{ selectedVisit.vitals.spo2 }}%</b></span>
                        <span *ngIf="isVitalPresent(selectedVisit.vitals.weight)">Weight: <b>{{ selectedVisit.vitals.weight }} {{ selectedVisit.vitals.units?.weight || 'kg' }}</b></span>
                    </div>
                </div>

                <!-- Prescription Table -->
                <div *ngIf="selectedVisit?.prescription?.length">
                    <h4 class="text-xs font-bold text-gray-500 uppercase tracking-widest mb-2 font-sans">Prescription</h4>
                    <table class="w-full text-sm border-collapse">
                        <thead class="bg-gray-50 font-sans text-gray-500 font-bold border-b">
                            <tr>
                                <th class="text-left py-2 px-2">Medicine</th>
                                <th class="text-left py-2 px-2">Dosage</th>
                                <th class="text-left py-2 px-2">Duration</th>
                                <th class="text-left py-2 px-2">Instr.</th>
                            </tr>
                        </thead>
                        <tbody class="divide-y">
                            <tr *ngFor="let item of selectedVisit.prescription">
                                <td class="py-2 px-2 font-bold text-gray-800">{{ item.medicine }}</td>
                                <td class="py-2 px-2 text-gray-600">{{ item.frequency }}</td>
                                <td class="py-2 px-2 text-gray-600">{{ item.duration }}</td>
                                <td class="py-2 px-2 text-gray-500 italic">{{ item.instructions }}</td>
                            </tr>
                        </tbody>
                    </table>
                </div>

                <!-- Footer -->
                 <div class="mt-8 pt-8 border-t flex justify-between items-center text-xs text-gray-500 font-sans">
                    <p>Generated via NalamDesk</p>
                    <p>{{ selectedVisit?.date | date:'medium' }}</p>
                 </div>
            </div>

            <!-- Modal Footer (Actions) -->
            <div class="bg-gray-50 border-t px-6 py-4 flex justify-between items-center font-sans">
                <button (click)="closeModal()" class="text-gray-600 hover:text-gray-800 font-medium">Close</button>
                <div class="flex gap-3">
                    <button (click)="exportHealthRecord()" class="px-4 py-2 bg-white border border-gray-300 rounded font-medium hover:bg-gray-100 transition">
                        Export Record
                    </button>
                    <button (click)="transferHealthRecord()" [disabled]="transferBusy" *ngIf="canTransfer" class="px-4 py-2 bg-white border border-blue-300 text-blue-700 rounded font-medium hover:bg-blue-50 transition disabled:opacity-50">
                        {{ transferBusy ? 'Sending...' : 'Secure Share' }}
                    </button>

                    <button (click)="printVisit()" class="px-4 py-2 bg-blue-600 text-white rounded font-bold hover:bg-blue-700 shadow-md transition">
                        Print Record
                    </button>
                </div>
            </div>
        </div>
      </div>

      <!-- Add Allergy Modal -->
      <div *ngIf="showAllergyModal" class="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div class="bg-white rounded-lg w-[500px] max-h-[90vh] shadow-xl flex flex-col overflow-hidden">
              <div class="px-6 py-4 border-b bg-red-50 flex justify-between items-center">
                  <h3 class="font-bold text-red-900">Add Patient Allergy / Intolerance</h3>
                  <button (click)="showAllergyModal = false" class="text-gray-500 hover:text-gray-600" aria-label="Close"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="w-4 h-4"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg></button>
              </div>
              <form [formGroup]="allergyForm" (ngSubmit)="saveAllergy()" class="p-6 space-y-4 overflow-y-auto">
                  <div>
                      <label class="block text-xs font-bold text-gray-700 uppercase mb-1">Substance / Drug <span class="text-red-500">*</span></label>
                      <input formControlName="substance" placeholder="e.g. Penicillin, Peanuts, Aspirin" class="w-full border p-2 rounded text-sm outline-none focus:ring-2 focus:ring-red-500">
                  </div>
                  <div class="grid grid-cols-2 gap-3">
                      <div>
                          <label class="block text-xs font-bold text-gray-700 uppercase mb-1">Criticality</label>
                          <select formControlName="criticality" class="w-full border p-2 rounded text-sm">
                              <option value="low">Low Risk</option>
                              <option value="high">High Risk / Life Threatening</option>
                              <option value="unable-to-assess">Unable to Assess</option>
                          </select>
                      </div>
                      <div>
                          <label class="block text-xs font-bold text-gray-700 uppercase mb-1">Severity</label>
                          <select formControlName="severity" class="w-full border p-2 rounded text-sm">
                              <option value="mild">Mild</option>
                              <option value="moderate">Moderate</option>
                              <option value="severe">Severe</option>
                          </select>
                      </div>
                  </div>
                  <div>
                      <label class="block text-xs font-bold text-gray-700 uppercase mb-1">Reaction Manifestation</label>
                      <input formControlName="reaction" placeholder="e.g. Hives, Anaphylaxis, Rash" class="w-full border p-2 rounded text-sm outline-none focus:ring-2 focus:ring-red-500">
                  </div>
                  <div>
                      <label class="block text-xs font-bold text-gray-700 uppercase mb-1">Clinical Notes</label>
                      <textarea formControlName="notes" rows="2" placeholder="Clinical context, previous episodes..." class="w-full border p-2 rounded text-sm outline-none focus:ring-2 focus:ring-red-500"></textarea>
                  </div>
                  <div class="flex justify-end gap-2 pt-2 border-t">
                      <button type="button" (click)="showAllergyModal = false" class="px-4 py-2 border rounded text-gray-600 hover:bg-gray-100 text-sm">Cancel</button>
                      <button type="submit" [disabled]="allergyForm.invalid" class="px-4 py-2 bg-red-600 text-white font-bold rounded hover:bg-red-700 text-sm disabled:opacity-50">Save Allergy</button>
                  </div>
              </form>
          </div>
      </div>

      <!-- Add Condition / Problem Modal -->
      <div *ngIf="showConditionModal" class="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div class="bg-white rounded-lg w-[500px] max-h-[90vh] shadow-xl flex flex-col overflow-hidden">
              <div class="px-6 py-4 border-b bg-amber-50 flex justify-between items-center">
                  <h3 class="font-bold text-amber-900">Add Problem / Condition</h3>
                  <button (click)="showConditionModal = false" class="text-gray-500 hover:text-gray-600" aria-label="Close"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="w-4 h-4"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg></button>
              </div>
              <form [formGroup]="conditionForm" (ngSubmit)="saveCondition()" class="p-6 space-y-4 overflow-y-auto">
                  <div>
                      <label class="block text-xs font-bold text-gray-700 uppercase mb-1">Problem / Condition Name <span class="text-red-500">*</span></label>
                      <input formControlName="condition_name" placeholder="e.g. Type 2 Diabetes, Essential Hypertension" class="w-full border p-2 rounded text-sm outline-none focus:ring-2 focus:ring-amber-500">
                  </div>
                  <div class="grid grid-cols-2 gap-3">
                      <div>
                          <label class="block text-xs font-bold text-gray-700 uppercase mb-1">ICD-10 Code (Optional)</label>
                          <input formControlName="code" placeholder="e.g. E11.9, I10" class="w-full border p-2 rounded text-sm font-mono uppercase">
                      </div>
                      <div>
                          <label class="block text-xs font-bold text-gray-700 uppercase mb-1">Clinical Status</label>
                          <select formControlName="clinical_status" class="w-full border p-2 rounded text-sm">
                              <option value="active">Active</option>
                              <option value="recurrence">Recurrence</option>
                              <option value="relapse">Relapse</option>
                              <option value="inactive">Inactive</option>
                              <option value="remission">Remission</option>
                              <option value="resolved">Resolved</option>
                          </select>
                      </div>
                  </div>
                  <div>
                      <label class="block text-xs font-bold text-gray-700 uppercase mb-1">Onset Date</label>
                      <input type="date" formControlName="onset_date" class="w-full border p-2 rounded text-sm">
                  </div>
                  <div>
                      <label class="block text-xs font-bold text-gray-700 uppercase mb-1">Clinical Notes</label>
                      <textarea formControlName="notes" rows="2" placeholder="Onset context, severity, notes..." class="w-full border p-2 rounded text-sm outline-none focus:ring-2 focus:ring-amber-500"></textarea>
                  </div>
                  <div class="flex justify-end gap-2 pt-2 border-t">
                      <button type="button" (click)="showConditionModal = false" class="px-4 py-2 border rounded text-gray-600 hover:bg-gray-100 text-sm">Cancel</button>
                      <button type="submit" [disabled]="conditionForm.invalid" class="px-4 py-2 bg-amber-600 text-white font-bold rounded hover:bg-amber-700 text-sm disabled:opacity-50">Save Problem</button>
                  </div>
              </form>
          </div>
      </div>

      <!-- Add Medication Modal -->
      <div *ngIf="showMedicationModal" class="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div class="bg-white rounded-lg w-[500px] max-h-[90vh] shadow-xl flex flex-col overflow-hidden">
              <div class="px-6 py-4 border-b bg-green-50 flex justify-between items-center">
                  <h3 class="font-bold text-green-900">Add Active Medication</h3>
                  <button (click)="showMedicationModal = false" class="text-gray-500 hover:text-gray-600" aria-label="Close"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="w-4 h-4"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg></button>
              </div>
              <form [formGroup]="medicationForm" (ngSubmit)="saveMedication()" class="p-6 space-y-4 overflow-y-auto">
                  <div>
                      <label class="block text-xs font-bold text-gray-700 uppercase mb-1">Medicine Name <span class="text-red-500">*</span></label>
                      <input formControlName="medicine_name" placeholder="e.g. Metformin 500mg, Atorvastatin 20mg" class="w-full border p-2 rounded text-sm outline-none focus:ring-2 focus:ring-green-500">
                  </div>
                  <div class="grid grid-cols-2 gap-3">
                      <div>
                          <label class="block text-xs font-bold text-gray-700 uppercase mb-1">Dosage</label>
                          <input formControlName="dosage" placeholder="e.g. 500mg, 1 tablet" class="w-full border p-2 rounded text-sm">
                      </div>
                      <div>
                          <label class="block text-xs font-bold text-gray-700 uppercase mb-1">Frequency</label>
                          <input formControlName="frequency" placeholder="e.g. 1-0-1 After Food, Daily" class="w-full border p-2 rounded text-sm">
                      </div>
                  </div>
                  <div class="grid grid-cols-2 gap-3">
                      <div>
                          <label class="block text-xs font-bold text-gray-700 uppercase mb-1">Start Date</label>
                          <input type="date" formControlName="start_date" class="w-full border p-2 rounded text-sm">
                      </div>
                      <div>
                          <label class="block text-xs font-bold text-gray-700 uppercase mb-1">Status</label>
                          <select formControlName="status" class="w-full border p-2 rounded text-sm">
                              <option value="active">Active</option>
                              <option value="completed">Completed</option>
                              <option value="stopped">Stopped</option>
                              <option value="on-hold">On Hold</option>
                          </select>
                      </div>
                  </div>
                  <div>
                      <label class="block text-xs font-bold text-gray-700 uppercase mb-1">Clinical Notes</label>
                      <textarea formControlName="notes" rows="2" placeholder="Prescribing indication, compliance..." class="w-full border p-2 rounded text-sm outline-none focus:ring-2 focus:ring-green-500"></textarea>
                  </div>
                  <div class="flex justify-end gap-2 pt-2 border-t">
                      <button type="button" (click)="showMedicationModal = false" class="px-4 py-2 border rounded text-gray-600 hover:bg-gray-100 text-sm">Cancel</button>
                      <button type="submit" [disabled]="medicationForm.invalid" class="px-4 py-2 bg-green-600 text-white font-bold rounded hover:bg-green-700 text-sm disabled:opacity-50">Save Medication</button>
                  </div>
              </form>
          </div>
      </div>

      <!-- Health ID (ABHA) modal: strictly voluntary, opened only from the profile card -->
      <app-abha-modal *ngIf="showAbhaModal"
          [patientId]="patientId" [patientName]="patient?.name"
          (close)="showAbhaModal = false"
          (linked)="onAbhaLinked($event)">
      </app-abha-modal>
    </div>
  `
})
export class PatientDetailsComponent implements OnInit {
    patientId!: number;
    patient: any;
    visits: any[] = [];
    vitals: any;
    currentUser: any;

    // Clinical Safety & Longitudinal Records
    activeTab: 'summary' | 'visits' | 'external' = 'summary';
    safetyContext: any = null;
    allergies: any[] = [];
    conditions: any[] = [];
    medications: any[] = [];

    // M3 HIU External Records
    readonly HI_TYPES = ['Prescription', 'DiagnosticReport', 'DischargeSummary', 'OPConsultation', 'ImmunizationRecord', 'WellnessRecord'];
    externalRecords: any[] = [];
    externalConsents: any[] = [];
    loadingExternal = false;
    externalError = '';
    showConsentForm = false;
    consentBusy = false;
    consentError = '';
    consentForm = { abhaAddress: '', hiTypes: ['Prescription', 'DiagnosticReport'] as string[], dateFrom: '', dateTo: '' };

    /** Summary helpers: the chart leads with active records, not raw tables. */
    activeAllergiesList(): any[] {
        return (this.allergies || []).filter((a: any) => a?.status === 'active');
    }

    activeConditionsList(): any[] {
        return (this.conditions || []).filter((c: any) => {
            const status = c?.clinical_status || c?.status;
            return status === 'active';
        });
    }

    activeMedicationsList(): any[] {
        return (this.medications || []).filter((m: any) => m?.status === 'active');
    }

    recentVisits(): any[] {
        return (this.visits || []).slice(0, 3);
    }

    removeSafetyRecord(kind: 'allergy' | 'condition' | 'medication', id: number): void {
        if (this.denySafetyMutation()) return;
        if (kind === 'allergy') void this.deleteAllergy(id);
        else if (kind === 'condition') void this.deleteCondition(id);
        else void this.deleteMedication(id);
    }

    consentChipClass(status: unknown): string {
        switch (String(status || '').toLowerCase()) {
            case 'granted': return 'bg-green-100 text-green-700';
            case 'denied': return 'bg-red-100 text-red-700';
            case 'expired': return 'bg-gray-100 text-gray-500';
            default: return 'bg-amber-100 text-amber-800';
        }
    }

    consentTypesText(consent: any): string {
        try {
            const types = typeof consent?.hi_types === 'string' ? JSON.parse(consent.hi_types) : consent?.hi_types;
            return Array.isArray(types) ? types.join(', ') : '';
        } catch {
            return '';
        }
    }

    async openExternalTab(): Promise<void> {
        this.activeTab = 'external';
        await this.loadExternal();
    }

    async loadExternal(): Promise<void> {
        if (!this.patientId) return;
        this.loadingExternal = true;
        this.externalError = '';
        try {
            const [consents, records] = await Promise.all([
                this.dataService.invoke<any[]>('abdmHiuGetConsents', { patientId: this.patientId }).catch(() => []),
                this.dataService.invoke<any[]>('abdmHiuGetExternalRecords', { patientId: this.patientId }).catch(() => [])
            ]);
            this.ngZone.run(() => {
                this.externalConsents = consents || [];
                this.externalRecords = records || [];
                this.loadingExternal = false;
            });
        } catch (e) {
            this.ngZone.run(() => {
                this.loadingExternal = false;
                this.externalError = e instanceof Error ? e.message : 'Could not load outside records.';
            });
        }
    }

    toggleHiType(type: string): void {
        const selected = this.consentForm.hiTypes;
        this.consentForm.hiTypes = selected.includes(type)
            ? selected.filter((t) => t !== type)
            : [...selected, type];
    }

    async requestExternalConsent(): Promise<void> {
        this.consentError = '';
        const address = this.consentForm.abhaAddress.trim() || this.patient?.abha_address || '';
        if (!address) {
            this.consentError = 'A health ID address is required.';
            return;
        }
        if (this.consentForm.hiTypes.length === 0) {
            this.consentError = 'Select at least one record type.';
            return;
        }
        this.consentBusy = true;
        try {
            await this.dataService.invoke('abdmHiuRequestConsent', {
                patientId: this.patientId,
                abhaAddress: address,
                hiTypes: this.consentForm.hiTypes,
                dateFrom: this.consentForm.dateFrom || null,
                dateTo: this.consentForm.dateTo || null
            });
            this.ngZone.run(() => {
                this.showConsentForm = false;
                this.consentForm = { abhaAddress: '', hiTypes: ['Prescription', 'DiagnosticReport'], dateFrom: '', dateTo: '' };
                this.consentBusy = false;
            });
            await this.loadExternal();
        } catch (e) {
            this.ngZone.run(() => {
                this.consentBusy = false;
                this.consentError = e instanceof Error ? e.message : 'Could not send the request.';
            });
        }
    }

    async fetchExternal(consentId: number): Promise<void> {
        this.externalError = '';
        try {
            await this.dataService.invoke('abdmHiuFetchRecords', { consentId });
            await this.loadExternal();
        } catch (e) {
            this.externalError = e instanceof Error ? e.message : 'Could not fetch records.';
        }
    }

    async clearExternalCache(): Promise<void> {
        const confirmed = await this.dialogService.open({
            title: 'Clear outside records?',
            message: 'Cached records from other facilities will be permanently removed from this device.',
            type: 'confirm',
            confirmText: 'Clear',
            cancelText: 'Keep'
        });
        if (!confirmed) return;
        try {
            await this.dataService.invoke('abdmHiuClearExternalRecords', { patientId: this.patientId });
            await this.loadExternal();
        } catch (e) {
            await this.dialogService.open({
                title: 'Clear failed',
                message: e instanceof Error ? e.message : 'Could not clear the cache.',
                type: 'error'
            });
        }
    }

    /**
     * Imports one outside medication into the active list through the same
     * allergy-conflict gate as prescribing: a conflict needs an explicit
     * override, recorded in the audit trail.
     */
    async importExternalMed(recordId: number, med: any): Promise<void> {
        const name = String(med?.name || '').trim();
        if (!name) return;
        const attempt = async (overrideReason?: string) => this.dataService.invoke('abdmHiuImportMedication', {
            patientId: this.patientId,
            medicine_name: name,
            dosage: med?.dosage || '',
            frequency: med?.frequency || '',
            source: `Outside record #${recordId}`,
            ...(overrideReason ? { overrideReason } : {})
        });
        try {
            await attempt();
            await this.loadData();
        } catch (e) {
            const message = e instanceof Error ? e.message : 'Could not import the medication.';
            if (!message.includes('conflicting')) {
                await this.dialogService.open({ title: 'Import failed', message, type: 'error' });
                return;
            }
            const confirmed = await this.dialogService.open({
                title: 'Allergy conflict',
                message: `${message} Import anyway? The override will be recorded.`,
                type: 'confirm',
                confirmText: 'Import with override',
                cancelText: 'Cancel'
            });
            if (!confirmed) return;
            try {
                await attempt(`Clinician override on import despite known allergy`);
                await this.loadData();
            } catch (retryError) {
                await this.dialogService.open({
                    title: 'Import failed',
                    message: retryError instanceof Error ? retryError.message : 'Could not import.',
                    type: 'error'
                });
            }
        }
    }

    // Modal State
    showVisitModal = false;
    selectedVisit: any = null;
    showAbhaModal = false;

    onAbhaLinked(link: { abhaAddress: string; abhaName: string }): void {
        if (this.patient) {
            this.patient = { ...this.patient, abha_address: link.abhaAddress, abha_name: link.abhaName };
        }
    }

    // Edit Patient Modal
    showEditModal = false;
    patientForm!: FormGroup;

    // Clinical Modals
    showAllergyModal = false;
    allergyForm!: FormGroup;

    showConditionModal = false;
    conditionForm!: FormGroup;

    showMedicationModal = false;
    medicationForm!: FormGroup;

    // Standard AG Grid tables (shared-table, cf. Settings Users/Audit tabs)
    // Safety-record mutation (allergies, problems, medications, visit history)
    // is a doctor/admin action; other roles get read-only grids.
    get canMutateSafety(): boolean {
        return this.currentUser?.role === 'doctor' || this.currentUser?.role === 'admin';
    }

    private denySafetyMutation(): boolean {
        if (this.canMutateSafety) return false;
        void this.dialogService.open({
            title: 'Not permitted',
            message: 'Only doctors and admins can modify clinical safety records.',
            type: 'warning'
        });
        return true;
    }
    private fmtDate(value: any): string {
        return value ? new DatePipe('en-US').transform(value, 'mediumDate') || '-' : '-';
    }

    private escHtml(value: unknown): string {
        const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
        return String(value ?? '').replace(/[&<>"']/g, (c) => map[c]);
    }

    private statusChip(text: string, active: boolean, activeClasses: string): string {
        const label = this.escHtml(text || 'active').toUpperCase();
        const classes = active ? activeClasses : 'bg-gray-100 text-gray-600';
        return `<span class="px-2 py-0.5 rounded uppercase text-[10px] font-bold ${classes}">${label}</span>`;
    }

    private deleteActionHtml(): string {
        return `<button data-action="delete" title="Delete" class="text-gray-500 hover:text-red-600 text-xs hover:bg-red-50 p-1.5 rounded"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-4 h-4"><path stroke-linecap="round" stroke-linejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" /></svg></button>`;
    }

    visitColumnDefs: ColDef[] = [
        {
            headerName: 'Date', field: 'date', flex: 1, minWidth: 130,
            valueFormatter: (params: any) => this.fmtDate(params.value)
        },
        {
            headerName: 'Diagnosis', field: 'diagnosis', flex: 2, minWidth: 220,
            cellRenderer: (params: any) => {
                const v = params.data;
                if (!v) return '';
                const type = v.diagnosis_type
                    ? `<span class="ml-2 px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 border border-gray-200 text-[10px]">${this.escHtml(v.diagnosis_type)}</span>`
                    : '';
                return `<span class="font-bold text-gray-800">${this.escHtml(v.diagnosis || 'No Diagnosis')}</span>${type}`;
            }
        },
        {
            headerName: 'Rx Items', flex: 1, minWidth: 100,
            valueGetter: (params: any) => params.data?.prescription?.length || 0,
            cellRenderer: (params: any) => `<span class="text-gray-600">${params.value} items</span>`
        },
        {
            headerName: 'Actions', flex: 1, minWidth: 170, sortable: false, filter: false,
            cellClass: 'flex items-center justify-end',
            cellRenderer: () => `<button data-action="view" class="text-blue-600 hover:text-blue-800 font-medium text-xs border border-blue-200 hover:border-blue-400 bg-blue-50 px-3 py-1 rounded mr-2">View</button>${this.deleteActionHtml()}`,
            onCellClicked: (params: any) => {
                const action = (params.event?.target as HTMLElement)?.closest?.('[data-action]')?.getAttribute('data-action');
                if (action === 'view') this.viewVisit(params.data);
                else if (action === 'delete' && !this.denySafetyMutation()) this.deleteVisit(params.data.id);
            }
        }
    ];


    constructor(
        private route: ActivatedRoute,
        private router: Router,
        private ngZone: NgZone,
        private fb: FormBuilder,
        private dataService: DataService,
        private authService: AuthService,
        private dialogService: DialogService
    ) {
        this.initForm();
        this.initClinicalForms();
    }

    get today(): string {
        return new Date().toISOString().split('T')[0];
    }

    get minDate(): string {
        const d = new Date();
        d.setFullYear(d.getFullYear() - 110);
        return d.toISOString().split('T')[0];
    }

    isFieldInvalid(field: string): boolean {
        const control = this.patientForm.get(field);
        return !!(control && control.invalid && (control.dirty || control.touched));
    }

    initForm() {
        this.patientForm = this.fb.group({
            id: [null],
            uuid: [null],
            name: ['', [Validators.required, Validators.minLength(3)]],
            mobile: ['', [Validators.required, Validators.pattern(/^[0-9]{10}$/)]],
            age: [null, [Validators.required, Validators.min(0), Validators.max(110)]],
            gender: ['', Validators.required],
            address: ['', [Validators.required]],
            // Extended fields
            dob: [null],
            blood_group: [''],
            email: ['', Validators.email],
            emergency_contact_name: [''],
            emergency_contact_mobile: ['', Validators.pattern(/^[0-9]{10}$/)],
            street: [''],
            city: [''],
            state: [''],
            zip_code: ['', [Validators.pattern(/^[0-9]{6}$/)]],
            insurance_provider: [''],
            policy_number: ['']
        });

        // Auto-calculate DOB from Age
        this.patientForm.get('age')?.valueChanges.subscribe(age => {
            if (age && !this.patientForm.get('dob')?.dirty) {
                const date = new Date();
                date.setFullYear(date.getFullYear() - age);
                this.patientForm.patchValue({ dob: date.toISOString().split('T')[0] }, { emitEvent: false });
            }
        });

        // Auto-calculate Age from DOB
        this.patientForm.get('dob')?.valueChanges.subscribe(dob => {
            if (dob) {
                const birthDate = new Date(dob);
                const today = new Date();
                let age = today.getFullYear() - birthDate.getFullYear();
                const m = today.getMonth() - birthDate.getMonth();
                if (m < 0 || (m === 0 && today.getDate() < birthDate.getDate())) {
                    age--;
                }
                this.patientForm.patchValue({ age: age }, { emitEvent: false });
            }
        });
    }

    initClinicalForms() {
        this.allergyForm = this.fb.group({
            id: [null],
            patient_id: [null],
            substance: ['', [Validators.required, Validators.minLength(2)]],
            reaction: [''],
            severity: ['moderate'],
            criticality: ['low'],
            verification_status: ['confirmed'],
            status: ['active'],
            notes: ['']
        });

        this.conditionForm = this.fb.group({
            id: [null],
            patient_id: [null],
            condition_name: ['', [Validators.required, Validators.minLength(2)]],
            code: [''],
            category: ['problem-list-item'],
            clinical_status: ['active'],
            onset_date: [''],
            notes: ['']
        });

        this.medicationForm = this.fb.group({
            id: [null],
            patient_id: [null],
            medicine_name: ['', [Validators.required, Validators.minLength(2)]],
            dosage: [''],
            frequency: [''],
            status: ['active'],
            start_date: [''],
            end_date: [''],
            notes: ['']
        });
    }

    ngOnInit() {
        this.currentUser = this.authService.getUser();
        this.route.params.subscribe(params => {
            this.patientId = +params['id'];
            this.loadData();
        });
    }

    async loadData() {
        try {
            const [patient, visits, vitals, safetyContext] = await Promise.all([
                this.dataService.invoke<any>('getPatientById', this.patientId),
                this.dataService.invoke<any[]>('getVisits', this.patientId),
                this.dataService.invoke<any>('getVitals', this.patientId),
                this.dataService.invoke<any>('getPatientSafetyContext', this.patientId).catch(() => null)
            ]);

            this.ngZone.run(() => {
                this.patient = patient;
                this.visits = visits || [];
                this.vitals = vitals;
                this.safetyContext = safetyContext;
                this.allergies = safetyContext?.allergies || [];
                this.conditions = safetyContext?.conditions || [];
                this.medications = safetyContext?.medications || [];
            });
        } catch (e) {
            console.error('Failed to load patient details', e);
        }
    }

    startingConsult = false;

    async startConsult() {
        if (this.startingConsult) return;
        this.startingConsult = true;
        try {
            let doctorId: number | undefined;
            if (this.currentUser?.role === 'admin') {
                const doctors = await this.dataService.invoke<any[]>('getDoctors').catch(() => []);
                if (doctors && doctors.length > 0) {
                    doctorId = doctors[0].id;
                }
            }

            let queue = await this.dataService.invoke<any[]>('getQueue');
            let queueEntry = queue.find(item => item.patient_id === this.patientId);
            if (!queueEntry) {
                await this.dataService.invoke('addToQueue', { patientId: this.patientId, priority: 1 });
                queue = await this.dataService.invoke<any[]>('getQueue');
                queueEntry = queue.find(item => item.patient_id === this.patientId);
            }
            if (!queueEntry) throw new Error('Queue entry was not created');

            const encounter = queueEntry.active_encounter_id
                ? await this.dataService.invoke<any>('resumeConsultation', { encounterId: queueEntry.active_encounter_id })
                : await this.dataService.invoke<any>('beginConsultation', {
                    patientId: this.patientId,
                    queueEntryId: queueEntry.id,
                    startRequestId: newRequestId(),
                    ...(doctorId ? { doctorId } : {})
                });
            this.router.navigate(['/visit', this.patientId], {
                state: { isConsulting: true, encounterId: encounter.id }
            });
        } catch (e) {
            console.error('Failed to start consultation', e);
            await this.dialogService.open({
                title: 'Error',
                message: e instanceof Error && e.message
                    ? `Failed to start consultation: ${e.message}`
                    : 'Failed to start consultation',
                type: 'error'
            });
        } finally {
            this.startingConsult = false;
        }
    }

    viewVisit(visit: any) {
        this.selectedVisit = visit;
        this.showVisitModal = true;
    }

    closeModal() {
        this.showVisitModal = false;
        this.selectedVisit = null;
    }

    editVisitFromModal() {
        if (this.selectedVisit) {
            this.router.navigate(['/visit', this.selectedVisit.id]);
        }
    }

    printVisit() {
        // Placeholder for printing logic
        window.print();
    }

    // The visit's license snapshot is the durable authorship record: it holds
    // the practitioner's identity exactly as it was when the encounter was
    // signed, even if their account details changed afterwards.
    private practitionerForExport(visit: any, user: any, hprId?: string): { id: any; name: string; licenseNumber?: string; specialty?: string; registryId?: string } {
        const attachRegistry = (entry: { id: any; name: string; licenseNumber?: string; specialty?: string }) =>
            hprId ? { ...entry, registryId: hprId } : entry;
        try {
            const snapshot = visit.doctor_license_snapshot ? JSON.parse(visit.doctor_license_snapshot) : null;
            if (snapshot?.name) {
                return attachRegistry({
                    id: visit.doctor_id || user.id, name: snapshot.name,
                    licenseNumber: snapshot.license_number, specialty: snapshot.specialty
                });
            }
        } catch { /* fall through to the live record below */ }
        const sameAuthor = !user.id || !visit.doctor_id || Number(user.id) === Number(visit.doctor_id);
        if (sameAuthor) {
            return attachRegistry({
                id: visit.doctor_id || user.id, name: visit.doctor_name || user.name || 'Doctor',
                licenseNumber: user.license_number, specialty: user.specialty
            });
        }
        return attachRegistry({ id: visit.doctor_id, name: visit.doctor_name || 'Doctor' });
    }

    // Resolves the registry ID that belongs to the visit's own doctor: the
    // doctor's own record first; the deployment default only when the single
    // doctor on file IS the visit's author (verified by id match, so a
    // deactivated author's record can never inherit another doctor's ID);
    // otherwise omitted rather than misattributed.
    private resolveVisitHprId(visit: any, doctors: any[], deploymentHprId?: string): string | undefined {
        const match = (doctors || []).find((d: any) => Number(d?.id) === Number(visit?.doctor_id));
        if (match?.abdm_hpr_id) return String(match.abdm_hpr_id);
        const activeDoctors = (doctors || []).filter((d: any) => d && Number(d.id) > 0);
        if (deploymentHprId && activeDoctors.length === 1
            && Number(activeDoctors[0].id) === Number(visit?.doctor_id)) {
            return deploymentHprId;
        }
        return undefined;
    }

    buildHealthRecordJson(clinicName = 'NalamDesk Clinic', registry?: { hfrId?: string; hprId?: string }) {
        const visit: any = this.selectedVisit || {};
        const patient: any = this.patient || {};
        // Historical authorship comes from the visit's own license snapshot,
        // frozen at signing time — never from whoever is exporting today.
        // The registry HPR ID identifies the same practitioner in the
        // national registry; it is deployment-level, not encounter-level.
        const practitioner = this.practitionerForExport(visit, this.currentUser || {}, registry?.hprId);
        const units = visit.vitals?.units || {};
        const { bundle, warnings } = buildOpConsultRecord({
            patient: {
                id: patient.id, name: patient.name, mobile: patient.mobile,
                age: patient.age, gender: patient.gender, dob: patient.dob,
                address: patient.address, abhaAddress: patient.abha_address
            },
            practitioner,
            clinic: { name: clinicName, registryId: registry?.hfrId || undefined },
            encounter: {
                id: visit.id, date: visit.date, diagnosis: visit.diagnosis,
                diagnosisType: visit.diagnosis_type, symptoms: visit.symptoms,
                examinationNotes: visit.examination_notes,
                careContextRef: visit.care_context_ref || null
            },
            prescriptions: (visit.prescription || []).map((item: any) => ({
                medicine: item.medicine, dosage: item.dosage, route: item.route,
                frequency: item.frequency, duration: item.duration,
                instruction: item.instruction || item.instructions
            })),
            allergies: (this.allergies || []).map((a: any) => ({
                substance: a.substance, criticality: a.criticality,
                severity: a.severity, reaction: a.reaction, status: a.status
            })),
            conditions: (this.conditions || []).map((c: any) => ({
                name: c.condition_name, code: c.code,
                status: c.clinical_status, onsetDate: c.onset_date
            })),
            vitals: visit.vitals ? {
                systolic_bp: visit.vitals.systolic_bp, diastolic_bp: visit.vitals.diastolic_bp,
                pulse: visit.vitals.pulse, temperature: visit.vitals.temperature,
                temperatureUnits: units.temperature, spo2: visit.vitals.spo2,
                weight: visit.vitals.weight, weightUnits: units.weight,
                height: visit.vitals.height
            } : null
        });
        return { json: JSON.stringify(bundle, null, 2), warnings };
    }

    async exportHealthRecord() {
        if (!this.selectedVisit) return;
        const settings = await this.dataService.invoke<any>('getPublicSettings').catch(() => null);
        const clinicName = settings?.clinic_name || 'NalamDesk Clinic';
        const abdm = await this.dataService.invoke<any>('abdmGetConfig').catch(() => null);
        const doctors = await this.dataService.invoke<any[]>('getDoctors').catch(() => []);
        const { json, warnings } = this.buildHealthRecordJson(clinicName, {
            hfrId: abdm?.hfr_id || undefined,
            hprId: this.resolveVisitHprId(this.selectedVisit, doctors || [], abdm?.hpr_id || undefined)
        });
        if (warnings.length > 0) {
            await this.dialogService.open({
                title: 'Exported with notes',
                message: warnings.join('\n'),
                type: 'info'
            });
        }
        if (typeof URL.createObjectURL === 'function') {
            const blob = new Blob([json], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = `health-record-${this.selectedVisit.id || 'visit'}.json`;
            anchor.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        }
    }

    transferBusy = false;

    // Mirrors the doctor/admin gate on the transfer handler: roles that
    // would only ever see Forbidden never see the button.
    get canTransfer(): boolean {
        return this.currentUser?.role === 'doctor' || this.currentUser?.role === 'admin';
    }

    // Encrypts the current receipt bundle for the configured recipient and
    // pushes it. Without a live endpoint the transfer loopbacks on-device
    // and the dialog says so — nothing silently pretends to leave.
    async transferHealthRecord() {
        if (!this.selectedVisit || this.transferBusy) return;
        this.transferBusy = true;
        try {
            const settings = await this.dataService.invoke<any>('getPublicSettings').catch(() => null);
            const clinicName = settings?.clinic_name || 'NalamDesk Clinic';
            const abdm = await this.dataService.invoke<any>('abdmGetConfig').catch(() => null);
            if (!abdm?.has_recipient_key) {
                await this.dialogService.open({
                    title: 'No recipient key',
                    message: 'Add a recipient public key under Settings → ABDM → Secure Transfer first.',
                    type: 'warning'
                });
                return;
            }
            const { json, warnings } = this.buildHealthRecordJson(clinicName, {
                hfrId: abdm?.hfr_id || undefined,
                hprId: this.resolveVisitHprId(
                    this.selectedVisit,
                    await this.dataService.invoke<any[]>('getDoctors').catch(() => []) || [],
                    abdm?.hpr_id || undefined)
            });
            if (warnings.length > 0) {
                await this.dialogService.open({
                    title: 'Exported with notes',
                    message: warnings.join('\n'),
                    type: 'info'
                });
            }
            const receipt: any = await this.dataService.invoke('abdmTransferBundle', {
                bundle: JSON.parse(json)
            });
            await this.dialogService.open({
                title: receipt?.status === 'delivered' ? 'Record sent' : 'Test transfer complete',
                message: receipt?.status === 'delivered'
                    ? `Encrypted record delivered (${receipt.bytes} bytes).`
                    : 'No live endpoint is configured, so the encrypted record looped back on this device for testing.',
                type: 'success'
            });
        } catch (e) {
            await this.dialogService.open({
                title: 'Transfer failed',
                message: e instanceof Error ? e.message : 'Could not send the record.',
                type: 'error'
            });
        } finally {
            this.transferBusy = false;
        }
    }

    async deleteVisit(visitId: number) {
        const confirmed = await this.dialogService.open({
            title: 'Delete Visit?',
            message: 'Permanently delete this visit record? This processing cannot be undone.',
            type: 'confirm',
            confirmText: 'Delete Forever',
            cancelText: 'Cancel'
        });

        if (confirmed) {
            try {
                await this.dataService.invoke('deleteVisit', visitId);
                await this.loadData();
            } catch (e) {
                console.error(e);
                this.dialogService.open({
                    title: 'Error',
                    message: 'Failed to delete visit.',
                    type: 'error'
                });
            }
        }
    }

    async deletePatient() {
        const confirmed = await this.dialogService.open({
            title: 'Delete Patient?',
            message: 'Are you sure you want to delete this patient? All their visits, vitals, and history will be permanently deleted.',
            type: 'confirm',
            confirmText: 'Delete Patient',
            cancelText: 'Cancel'
        });

        if (confirmed) {
            try {
                await this.dataService.invoke('deletePatient', this.patientId);
                this.router.navigate(['/patients']);
            } catch (e) {
                console.error(e);
                this.dialogService.open({
                    title: 'Error',
                    message: 'Failed to delete patient.',
                    type: 'error'
                });
            }
        }
    }

    goBack() {
        this.router.navigate(['/patients']);
    }

    openEditModal() {
        if (this.patient) {
            this.patientForm.patchValue(this.patient);
            this.showEditModal = true;
        }
    }

    async savePatient() {
        if (this.patientForm.invalid) {
            this.patientForm.markAllAsTouched();
            return;
        }
        try {
            await this.dataService.invoke('savePatient', this.patientForm.value);
            this.showEditModal = false;
            this.loadData();
            this.dialogService.open({
                title: 'Success',
                message: 'Patient updated successfully.',
                type: 'success'
            });
        } catch (e) {
            console.error(e);
            this.dialogService.open({
                title: 'Error',
                message: 'Failed to update patient.',
                type: 'error'
            });
        }
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

    openAddAllergyModal() {
        this.allergyForm.reset({
            patient_id: this.patientId,
            substance: '',
            reaction: '',
            severity: 'moderate',
            criticality: 'low',
            verification_status: 'confirmed',
            status: 'active',
            notes: ''
        });
        this.showAllergyModal = true;
    }

    async saveAllergy() {
        if (this.allergyForm.invalid) {
            this.allergyForm.markAllAsTouched();
            return;
        }
        try {
            await this.dataService.invoke('saveAllergy', {
                ...this.allergyForm.value,
                patient_id: this.patientId
            });
            this.showAllergyModal = false;
            await this.loadData();
        } catch (e) {
            console.error('Failed to save allergy', e);
            this.dialogService.open({
                title: 'Error',
                message: 'Failed to save allergy record.',
                type: 'error'
            });
        }
    }

    async deleteAllergy(id: number) {
        const confirmed = await this.dialogService.open({
            title: 'Delete Allergy?',
            message: 'Are you sure you want to remove this allergy record?',
            type: 'confirm',
            confirmText: 'Delete',
            cancelText: 'Cancel'
        });
        if (confirmed) {
            try {
                await this.dataService.invoke('deleteAllergy', id);
                await this.loadData();
            } catch (e) {
                console.error('Failed to delete allergy', e);
            }
        }
    }

    openAddConditionModal() {
        this.conditionForm.reset({
            patient_id: this.patientId,
            condition_name: '',
            code: '',
            category: 'problem-list-item',
            clinical_status: 'active',
            onset_date: '',
            notes: ''
        });
        this.showConditionModal = true;
    }

    async saveCondition() {
        if (this.conditionForm.invalid) {
            this.conditionForm.markAllAsTouched();
            return;
        }
        try {
            await this.dataService.invoke('saveCondition', {
                ...this.conditionForm.value,
                patient_id: this.patientId
            });
            this.showConditionModal = false;
            await this.loadData();
        } catch (e) {
            console.error('Failed to save condition', e);
            this.dialogService.open({
                title: 'Error',
                message: 'Failed to save condition record.',
                type: 'error'
            });
        }
    }

    async deleteCondition(id: number) {
        const confirmed = await this.dialogService.open({
            title: 'Delete Condition?',
            message: 'Are you sure you want to remove this problem from the active list?',
            type: 'confirm',
            confirmText: 'Delete',
            cancelText: 'Cancel'
        });
        if (confirmed) {
            try {
                await this.dataService.invoke('deleteCondition', id);
                await this.loadData();
            } catch (e) {
                console.error('Failed to delete condition', e);
            }
        }
    }

    openAddMedicationModal() {
        this.medicationForm.reset({
            patient_id: this.patientId,
            medicine_name: '',
            dosage: '',
            frequency: '',
            status: 'active',
            start_date: '',
            end_date: '',
            notes: ''
        });
        this.showMedicationModal = true;
    }

    async saveMedication() {
        if (this.medicationForm.invalid) {
            this.medicationForm.markAllAsTouched();
            return;
        }
        try {
            await this.dataService.invoke('saveMedication', {
                ...this.medicationForm.value,
                patient_id: this.patientId
            });
            this.showMedicationModal = false;
            await this.loadData();
        } catch (e) {
            console.error('Failed to save medication', e);
            this.dialogService.open({
                title: 'Error',
                message: 'Failed to save medication record.',
                type: 'error'
            });
        }
    }

    async deleteMedication(id: number) {
        const confirmed = await this.dialogService.open({
            title: 'Delete Medication?',
            message: 'Are you sure you want to remove this medication from the active list?',
            type: 'confirm',
            confirmText: 'Delete',
            cancelText: 'Cancel'
        });
        if (confirmed) {
            try {
                await this.dataService.invoke('deleteMedication', id);
                await this.loadData();
            } catch (e) {
                console.error('Failed to delete medication', e);
            }
        }
    }
}
