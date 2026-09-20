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
                         (click)="activeTab = 'allergies'">
                        <span class="font-medium text-gray-600">Allergies</span>
                        <span class="font-bold" [ngClass]="safetyContext?.has_active_allergies ? 'text-red-700' : 'text-gray-500'">
                            {{ safetyContext?.active_allergies?.length || 0 }} Active
                        </span>
                    </div>
                    <div class="p-2.5 rounded-lg border bg-gray-50 border-gray-100 flex items-center justify-between cursor-pointer hover:bg-gray-100 transition"
                         (click)="activeTab = 'conditions'">
                        <span class="font-medium text-gray-600">Active Problems</span>
                        <span class="font-bold text-gray-700">
                            {{ safetyContext?.active_conditions?.length || 0 }}
                        </span>
                    </div>
                    <div class="p-2.5 rounded-lg border bg-gray-50 border-gray-100 flex items-center justify-between cursor-pointer hover:bg-gray-100 transition"
                         (click)="activeTab = 'medications'">
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
                        <button type="button" (click)="activeTab = 'visits'"
                                [class.bg-white]="activeTab === 'visits'"
                                [class.shadow-sm]="activeTab === 'visits'"
                                [class.text-blue-600]="activeTab === 'visits'"
                                [class.font-bold]="activeTab === 'visits'"
                                [class.text-gray-600]="activeTab !== 'visits'"
                                class="px-3 py-1.5 rounded-lg text-sm transition">
                            Visits ({{ visits.length }})
                        </button>
                        <button type="button" (click)="activeTab = 'allergies'"
                                [class.bg-white]="activeTab === 'allergies'"
                                [class.shadow-sm]="activeTab === 'allergies'"
                                [class.text-red-600]="activeTab === 'allergies'"
                                [class.font-bold]="activeTab === 'allergies'"
                                [class.text-gray-600]="activeTab !== 'allergies'"
                                class="px-3 py-1.5 rounded-lg text-sm transition flex items-center gap-1.5">
                            <span>Allergies</span>
                            <span *ngIf="safetyContext?.active_allergies?.length" class="text-[10px] bg-red-100 text-red-700 font-bold px-1.5 py-0.5 rounded-full">
                                {{ safetyContext.active_allergies.length }}
                            </span>
                            <span *ngIf="!safetyContext?.active_allergies?.length" class="text-[10px] text-gray-500">
                                ({{ allergies.length }})
                            </span>
                        </button>
                        <button type="button" (click)="activeTab = 'conditions'"
                                [class.bg-white]="activeTab === 'conditions'"
                                [class.shadow-sm]="activeTab === 'conditions'"
                                [class.text-amber-600]="activeTab === 'conditions'"
                                [class.font-bold]="activeTab === 'conditions'"
                                [class.text-gray-600]="activeTab !== 'conditions'"
                                class="px-3 py-1.5 rounded-lg text-sm transition">
                            Problems ({{ conditions.length }})
                        </button>
                        <button type="button" (click)="activeTab = 'medications'"
                                [class.bg-white]="activeTab === 'medications'"
                                [class.shadow-sm]="activeTab === 'medications'"
                                [class.text-green-600]="activeTab === 'medications'"
                                [class.font-bold]="activeTab === 'medications'"
                                [class.text-gray-600]="activeTab !== 'medications'"
                                class="px-3 py-1.5 rounded-lg text-sm transition">
                            Medications ({{ medications.length }})
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

                <!-- TAB: ALLERGIES (standard AG Grid) -->
                <div *ngIf="activeTab === 'allergies'" class="flex-1 min-h-0 overflow-hidden">
                    <app-shared-table [rowData]="allergies" [columnDefs]="allergyColumnDefs" [pagination]="true" [pageSize]="10">
                        <div toolbar-left class="flex items-center gap-2">
                            <span class="text-xs text-gray-500">{{ allergies.length }} recorded</span>
                            <button *ngIf="canMutateSafety" (click)="openAddAllergyModal()" class="text-xs bg-red-50 text-red-700 border border-red-200 hover:bg-red-100 font-bold px-2.5 py-1.5 rounded flex items-center gap-1 transition">
                                <span>+</span> Add Allergy
                            </button>
                        </div>
                    </app-shared-table>
                </div>

                <!-- TAB: CONDITIONS / PROBLEMS (standard AG Grid) -->
                <div *ngIf="activeTab === 'conditions'" class="flex-1 min-h-0 overflow-hidden">
                    <app-shared-table [rowData]="conditions" [columnDefs]="conditionColumnDefs" [pagination]="true" [pageSize]="10">
                        <div toolbar-left class="flex items-center gap-2">
                            <span class="text-xs text-gray-500">{{ conditions.length }} recorded</span>
                            <button *ngIf="canMutateSafety" (click)="openAddConditionModal()" class="text-xs bg-amber-50 text-amber-800 border border-amber-200 hover:bg-amber-100 font-bold px-2.5 py-1.5 rounded flex items-center gap-1 transition">
                                <span>+</span> Add Problem
                            </button>
                        </div>
                    </app-shared-table>
                </div>

                <!-- TAB: MEDICATIONS (standard AG Grid) -->
                <div *ngIf="activeTab === 'medications'" class="flex-1 min-h-0 overflow-hidden">
                    <app-shared-table [rowData]="medications" [columnDefs]="medicationColumnDefs" [pagination]="true" [pageSize]="10">
                        <div toolbar-left class="flex items-center gap-2">
                            <span class="text-xs text-gray-500">{{ medications.length }} recorded</span>
                            <button *ngIf="canMutateSafety" (click)="openAddMedicationModal()" class="text-xs bg-green-50 text-green-800 border border-green-200 hover:bg-green-100 font-bold px-2.5 py-1.5 rounded flex items-center gap-1 transition">
                                <span>+</span> Add Medication
                            </button>
                        </div>
                    </app-shared-table>
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
    activeTab: 'visits' | 'allergies' | 'conditions' | 'medications' = 'visits';
    safetyContext: any = null;
    allergies: any[] = [];
    conditions: any[] = [];
    medications: any[] = [];

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

    allergyColumnDefs: ColDef[] = [
        {
            headerName: 'Substance', field: 'substance', flex: 1.5, minWidth: 180,
            cellRenderer: (params: any) => {
                const a = params.data;
                if (!a) return '';
                const notes = a.notes ? `<span class="block text-xs font-normal text-gray-500">${this.escHtml(a.notes)}</span>` : '';
                return `<span class="font-bold text-gray-800">${this.escHtml(a.substance)}</span>${notes}`;
            }
        },
        {
            headerName: 'Criticality', field: 'criticality', flex: 1, minWidth: 130,
            cellRenderer: (params: any) => {
                const c = params.value || 'low';
                const classes = c === 'high'
                    ? 'bg-red-100 text-red-800 border-red-200'
                    : c === 'low'
                        ? 'bg-amber-100 text-amber-800 border-amber-200'
                        : 'bg-gray-100 text-gray-700 border-gray-200';
                return `<span class="px-2 py-0.5 rounded border uppercase text-[10px] font-semibold ${classes}">${this.escHtml(c)}</span>`;
            }
        },
        {
            headerName: 'Severity & Reaction', flex: 1.5, minWidth: 180,
            valueGetter: (params: any) => `${params.data?.severity || '-'}${params.data?.reaction ? ' ' + params.data.reaction : ''}`,
            cellRenderer: (params: any) => {
                const a = params.data;
                if (!a) return '';
                const reaction = a.reaction ? `<span class="text-xs text-gray-500 block">${this.escHtml(a.reaction)}</span>` : '';
                return `<span class="capitalize font-medium text-gray-600">${this.escHtml(a.severity || '-')}</span>${reaction}`;
            }
        },
        {
            headerName: 'Status', field: 'status', flex: 1, minWidth: 120,
            cellRenderer: (params: any) => this.statusChip(params.value, params.value === 'active', 'bg-red-100 text-red-800')
        },
        {
            headerName: 'Actions', flex: 0.6, minWidth: 100, sortable: false, filter: false,
            cellClass: 'flex items-center justify-end',
            cellRenderer: () => this.deleteActionHtml(),
            onCellClicked: (params: any) => { if (!this.denySafetyMutation()) this.deleteAllergy(params.data.id); }
        }
    ];

    conditionColumnDefs: ColDef[] = [
        {
            headerName: 'Problem / Condition', field: 'condition_name', flex: 1.5, minWidth: 200,
            cellRenderer: (params: any) => {
                const c = params.data;
                if (!c) return '';
                const notes = c.notes ? `<span class="block text-xs font-normal text-gray-500">${this.escHtml(c.notes)}</span>` : '';
                return `<span class="font-bold text-gray-800">${this.escHtml(c.condition_name)}</span>${notes}`;
            }
        },
        {
            headerName: 'ICD-10 Code', field: 'code', flex: 1, minWidth: 130,
            cellRenderer: (params: any) => `<span class="font-mono text-xs text-gray-600">${this.escHtml(params.value || '-')}</span>`
        },
        {
            headerName: 'Status', field: 'clinical_status', flex: 1, minWidth: 130,
            cellRenderer: (params: any) => this.statusChip(params.value, params.value === 'active', 'bg-amber-100 text-amber-800')
        },
        {
            headerName: 'Onset Date', field: 'onset_date', flex: 1, minWidth: 130,
            valueFormatter: (params: any) => params.value ? this.fmtDate(params.value) : '-',
            cellRenderer: (params: any) => `<span class="text-xs text-gray-600">${this.escHtml(params.value ? this.fmtDate(params.value) : '-')}</span>`
        },
        {
            headerName: 'Actions', flex: 0.6, minWidth: 100, sortable: false, filter: false,
            cellClass: 'flex items-center justify-end',
            cellRenderer: () => this.deleteActionHtml(),
            onCellClicked: (params: any) => { if (!this.denySafetyMutation()) this.deleteCondition(params.data.id); }
        }
    ];

    medicationColumnDefs: ColDef[] = [
        {
            headerName: 'Medication', field: 'medicine_name', flex: 1.5, minWidth: 200,
            cellRenderer: (params: any) => {
                const m = params.data;
                if (!m) return '';
                const notes = m.notes ? `<span class="block text-xs font-normal text-gray-500">${this.escHtml(m.notes)}</span>` : '';
                return `<span class="font-bold text-gray-800">${this.escHtml(m.medicine_name)}</span>${notes}`;
            }
        },
        {
            headerName: 'Dosage & Frequency', flex: 1.5, minWidth: 180,
            valueGetter: (params: any) => `${params.data?.dosage || '-'} ${params.data?.frequency ? '(' + params.data.frequency + ')' : ''}`,
            cellRenderer: (params: any) => {
                const m = params.data;
                if (!m) return '';
                const freq = m.frequency ? `<span class="text-gray-500 ml-1">(${this.escHtml(m.frequency)})</span>` : '';
                return `<span class="text-xs text-gray-700 font-medium">${this.escHtml(m.dosage || '-')}</span>${freq}`;
            }
        },
        {
            headerName: 'Status', field: 'status', flex: 1, minWidth: 120,
            cellRenderer: (params: any) => this.statusChip(params.value, params.value === 'active', 'bg-green-100 text-green-800')
        },
        {
            headerName: 'Duration', flex: 1, minWidth: 150,
            valueGetter: (params: any) => `${params.data?.start_date || '-'}${params.data?.end_date ? ' to ' + params.data.end_date : ''}`,
            cellRenderer: (params: any) => `<span class="text-xs text-gray-600">${this.escHtml(params.value)}</span>`
        },
        {
            headerName: 'Actions', flex: 0.6, minWidth: 100, sortable: false, filter: false,
            cellClass: 'flex items-center justify-end',
            cellRenderer: () => this.deleteActionHtml(),
            onCellClicked: (params: any) => { if (!this.denySafetyMutation()) this.deleteMedication(params.data.id); }
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
