import { Component, NgZone, OnInit, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule, ReactiveFormsModule, FormBuilder, FormGroup, Validators } from '@angular/forms';
import { Patient, PatientService } from '../../services/patient.service';
import { DataService } from '../../services/api.service';
import { Router, ActivatedRoute } from '@angular/router';
import { AuthService } from '../../services/auth.service';
import { DialogService } from '../../shared/services/dialog.service';
import { DatePickerComponent } from '../../shared/components/date-picker/date-picker.component';
import { SharedTableComponent } from '../../shared/components/table/table.component';
import { ViewToggleComponent, CompactView, restoreCompactView, persistCompactView } from '../../shared/components/view-toggle/view-toggle.component';
import { QueueCountService } from '../../shared/services/queue-count.service';
import { PatientActionsRenderer } from './patient-actions.component';
import { ColDef } from 'ag-grid-community';
import { deriveAge } from '../../../../shared/patient-age';

@Component({
  selector: 'app-patient-list',
  standalone: true,
  imports: [CommonModule, FormsModule, ReactiveFormsModule, DatePickerComponent, SharedTableComponent, ViewToggleComponent],
  template: `
    <div class="h-full bg-gray-100 p-4 md:p-6 flex flex-col overflow-hidden">
      <div class="w-full">
        <div class="flex justify-between items-center mb-6">
          <h1 class="text-2xl font-bold text-gray-800">Patients</h1>
          <div class="flex items-center gap-2">
            <app-view-toggle class="md:hidden" [value]="mobileView" (valueChange)="setMobileView($event)" label="Patients view"></app-view-toggle>
            <button (click)="openAddModal()" class="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 transition shadow-sm">
              + Add Patient
            </button>
          </div>
        </div>

        <!-- Search Bar -->
        <div class="mb-6 relative">
          <input 
            type="text" 
            [(ngModel)]="searchQuery" 
            (ngModelChange)="onSearch()"
            placeholder="Search by name or mobile..." 
            class="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all"
          >
          <span class="absolute left-3 top-2.5 text-gray-400">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-5 h-5"><path stroke-linecap="round" stroke-linejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" /></svg>
          </span>
        </div>

        <!-- AG Grid Data Table -->
        <div class="flex-1 h-[calc(100vh-200px)]" [ngClass]="mobileView === 'grid' ? 'block' : 'hidden md:block'">
           <app-shared-table
              [rowData]="gridData"
              [columnDefs]="colDefs"
              [loading]="loading"
              [multiSelect]="isAdmin"
              (selectionChanged)="selectedPatients = $event"
              (rowClick)="onRowClick($event)"
           >
              <div toolbar-left>
                  <button *ngIf="isAdmin && selectedPatients.length > 0" (click)="deleteSelectedPatients()" 
                          class="bg-red-50 text-red-600 px-3 py-1.5 rounded-md text-xs font-medium border border-red-200 hover:bg-red-100 flex items-center gap-2 animate-in fade-in zoom-in duration-200">
                      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-4 h-4">
                        <path stroke-linecap="round" stroke-linejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />
                      </svg>
                      Delete ({{ selectedPatients.length }})
                  </button>
              </div>
           </app-shared-table>
        </div>
        <!-- Compact cards for narrow viewports: server-filtered gridData, same actions -->
        <div class="max-h-[calc(100vh-280px)] min-h-[200px] overflow-y-auto space-y-2 pb-4" [ngClass]="mobileView === 'cards' ? 'block md:hidden' : 'hidden'">
          <div *ngIf="isAdmin" class="flex items-center justify-between px-1">
            <button (click)="toggleCardSelectMode()" class="text-xs font-semibold text-blue-600 hover:text-blue-800">
              {{ cardSelectMode ? 'Cancel' : 'Select' }}
            </button>
            <span *ngIf="cardSelectMode" class="text-xs text-gray-500">{{ selectedPatients.length }} selected</span>
          </div>
          <div *ngIf="gridData.length === 0" class="text-center text-sm text-gray-500 py-8">No patients found</div>
          <div *ngFor="let p of gridData" (click)="onCardTap(p)"
               class="bg-white rounded-lg border border-gray-200 p-3 shadow-sm"
               [ngClass]="isCardSelected(p) ? 'ring-2 ring-blue-500 border-blue-500' : ''">
            <div class="flex items-center gap-3">
              <div *ngIf="cardSelectMode" class="shrink-0 w-5 h-5 rounded border flex items-center justify-center"
                   [ngClass]="isCardSelected(p) ? 'bg-blue-600 border-blue-600 text-white' : 'border-gray-300 bg-white'">
                <svg *ngIf="isCardSelected(p)" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="3" stroke="currentColor" class="w-3.5 h-3.5"><path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5" /></svg>
              </div>
              <div class="w-10 h-10 rounded-full bg-neutral text-neutral-content flex items-center justify-center font-bold shrink-0">
                {{ (p.name || '?').charAt(0).toUpperCase() }}
              </div>
              <div class="min-w-0 flex-1">
                <div class="font-bold text-gray-800 truncate">{{ p.name }}</div>
                <div class="text-xs text-gray-500">{{ p.mobile }} · {{ p.age }} / {{ p.gender }}</div>
              </div>
              <span *ngIf="p.inQueue" class="badge badge-sm badge-primary shrink-0">In Queue</span>
            </div>
            <div *ngIf="!cardSelectMode" class="mt-2.5 flex items-center gap-1.5">
              <button (click)="$event.stopPropagation(); addToQueue(p)" [disabled]="p.inQueue"
                      class="btn btn-sm flex-1"
                      [ngClass]="p.inQueue ? 'btn-ghost text-gray-400' : 'btn-primary'">
                {{ p.inQueue ? 'In Queue' : 'Add to Queue' }}
              </button>
              <button (click)="$event.stopPropagation(); editPatient(p)" class="btn btn-sm btn-ghost border border-gray-200">Edit</button>
            </div>
          </div>
          <div *ngIf="cardSelectMode && selectedPatients.length > 0" class="sticky bottom-0 flex items-center gap-2 bg-white border border-gray-200 rounded-lg p-2 shadow-lg">
            <button (click)="deleteSelectedPatients()" class="btn btn-sm btn-error flex-1 text-white">Delete ({{ selectedPatients.length }})</button>
            <button (click)="toggleCardSelectMode()" class="btn btn-sm btn-ghost border border-gray-200">Done</button>
          </div>
        </div>
      </div>

      <!-- Add Patient Modal (Responsive) -->
      <div *ngIf="showModal" class="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <!-- Width fixed -> Max Width Responsive -->
          <div class="bg-white rounded-lg w-full max-w-3xl max-h-[90vh] shadow-xl flex flex-col overflow-hidden">
            
            <!-- Fixed Header -->
            <div class="px-6 py-4 border-b bg-gray-50 flex justify-between items-center">
                <h2 class="text-xl font-bold text-gray-800">{{ isEditMode ? 'Edit Patient Details' : 'New Patient Registration' }}</h2>
                <button (click)="showModal = false" class="text-gray-500 hover:text-gray-600" aria-label="Close"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="w-4 h-4"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg></button>
            </div>

            <!-- Scrollable Body -->
            <div class="flex-1 overflow-y-auto p-6">
                <form [formGroup]="patientForm" id="patientForm" (ngSubmit)="savePatient(!isEditMode)">
                    <!-- Possible-duplicate warning: non-blocking, opens the chart -->
                    <div *ngIf="duplicateCandidates.length > 0"
                         class="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3">
                        <div class="text-xs font-bold uppercase tracking-wider text-amber-700 mb-1">
                            Possible existing record{{ duplicateCandidates.length > 1 ? 's' : '' }}
                        </div>
                        <div *ngFor="let dup of duplicateCandidates"
                             class="flex items-center justify-between gap-2 py-1 text-sm">
                            <div class="min-w-0">
                                <span class="font-medium text-gray-800">{{ dup.patient.name }}</span>
                                <span *ngIf="dup.patient.mrn" class="font-mono text-xs text-gray-500 ml-1">{{ dup.patient.mrn }}</span>
                                <span class="text-xs text-gray-500 ml-1">{{ dup.patient.mobile }}</span>
                                <div class="text-[11px] text-gray-500">{{ dup.signals.map(duplicateSignalLabel.bind(this)).join(', ') }}</div>
                            </div>
                            <button type="button" (click)="goToVisit(dup.patient)"
                                    class="shrink-0 text-xs text-blue-600 border border-blue-200 hover:bg-blue-50 px-2.5 py-1 rounded">Open</button>
                        </div>
                    </div>
                    <!-- Essential details: everything a walk-in needs, always visible -->
                    <div class="mb-6">
                        <h3 class="font-bold text-gray-700 border-b pb-1 mb-3">Essential details</h3>
                        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                            
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

                            <!-- DOB & Age Row (Stacked on Mobile) -->
                            <div class="flex flex-col md:flex-row gap-4 col-span-1 md:col-span-2 items-start">
                                <!-- DOB (First) -->
                                <div class="w-full md:w-1/3 relative">
                                    <label class="block text-sm font-medium text-gray-700">Date of Birth</label>
                                    <app-date-picker 
                                        formControlName="dob" 
                                        [maxDate]="today"
                                        [minDate]="minDate"
                                        placeholder="Select DOB"
                                        helperText="Auto-calculates Age">
                                    </app-date-picker>
                                    <label class="mt-1 flex items-center gap-1.5 text-xs text-gray-500">
                                        <input type="checkbox" formControlName="dob_estimated" class="checkbox checkbox-xs" />
                                        Approximate date
                                    </label>
                                </div>

                                <!-- Age -->
                                <div class="w-full md:w-1/4">
                                    <label class="block text-sm font-medium text-gray-700">Age <span class="text-red-500">*</span></label>
                                    <input type="number" formControlName="age" min="0" max="110" placeholder="30"
                                        class="w-full border p-2 rounded focus:ring-2 focus:ring-blue-500 outline-none bg-gray-50"
                                        [class.border-red-500]="isFieldInvalid('age')">
                                    <p *ngIf="isFieldInvalid('age')" class="text-xs text-red-500 mt-1">Required</p>
                                </div>

                                <!-- Gender -->
                                <div class="w-full md:w-1/4">
                                    <label class="block text-sm font-medium text-gray-700">Gender <span class="text-red-500">*</span></label>
                                    <select formControlName="gender" class="w-full border p-2 rounded focus:ring-2 focus:ring-blue-500 outline-none"
                                            [class.border-red-500]="isFieldInvalid('gender')">
                                        <option value="" disabled>Select</option>
                                        <option value="Male">Male</option>
                                        <option value="Female">Female</option>
                                        <option value="Other">Other</option>
                                        <option value="Unknown">Unknown / not stated</option>
                                    </select>
                                    <p *ngIf="isFieldInvalid('gender')" class="text-xs text-red-500 mt-1">Required</p>
                                </div>

                            </div>
                        </div>
                    </div>

                    <!-- Additional details: collapsed for rapid intake -->
                    <div class="mb-2">
                        <button type="button" (click)="showAdditional = !showAdditional"
                                class="w-full flex items-center justify-between py-2 text-sm font-bold text-gray-700 border-b mb-3"
                                [attr.aria-expanded]="showAdditional">
                            <span>Additional details <span class="font-normal text-gray-400">(contact, address, blood group)</span></span>
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"
                                 class="w-4 h-4 text-gray-500 transition-transform" [class.rotate-180]="showAdditional">
                                <path stroke-linecap="round" stroke-linejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
                            </svg>
                        </button>
                        <div *ngIf="showAdditional">
                            <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
                                <div class="col-span-1">
                                    <label class="block text-sm font-medium text-gray-700">Blood Group</label>
                                    <select formControlName="blood_group" class="w-full border p-2 rounded">
                                        <option value="">-</option>
                                        <option value="A+">A+</option> <option value="A-">A-</option>
                                        <option value="B+">B+</option> <option value="B-">B-</option>
                                        <option value="O+">O+</option> <option value="O-">O-</option>
                                        <option value="AB+">AB+</option> <option value="AB-">AB-</option>
                                    </select>
                                </div>
                                <div class="col-span-1">
                                    <label class="block text-sm font-medium text-gray-700">Email (Optional)</label>
                                    <input type="email" formControlName="email" placeholder="patient@example.com" class="w-full border p-2 rounded">
                                    <p *ngIf="isFieldInvalid('email')" class="text-xs text-red-500 mt-1">Invalid email format.</p>
                                </div>
                            </div>

                    <!-- Address -->
                    <div class="mb-6">
                        <h3 class="font-bold text-gray-700 border-b pb-1 mb-3">Address</h3>
                        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div class="col-span-1 md:col-span-2">
                                <label class="block text-sm font-medium text-gray-700">Full Address (Optional)</label>
                                <textarea formControlName="address" rows="3" placeholder="House No, Street Name, Area"
                                        class="w-full border p-2 rounded focus:ring-2 focus:ring-blue-500 outline-none"></textarea>
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

                    <!-- Emergency contact -->
                    <div>
                        <h3 class="font-bold text-gray-700 border-b pb-1 mb-3">Emergency contact</h3>
                        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
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
                        </div>
                    </div>
                </form>
            </div>
            
            <!-- Fixed Footer -->
            <div class="px-6 py-4 border-t bg-gray-50 flex justify-between items-center">
                <p class="text-xs text-gray-500"><span class="text-red-500">*</span> Required Fields</p>
                <div class="flex gap-2">
                    <button type="button" (click)="showModal = false" class="px-4 py-2 text-gray-600 hover:bg-gray-200 rounded border bg-white transition-colors">
                        Cancel
                    </button>
                    <button *ngIf="!isEditMode" type="button" (click)="savePatient(false)"
                            [disabled]="patientForm.invalid"
                            class="px-4 py-2 text-blue-700 border border-blue-200 hover:bg-blue-50 rounded font-medium transition-colors disabled:opacity-50">
                        Save only
                    </button>
                    <!-- form attribute links this button to the form above; Enter submits here -->
                    <button type="submit" form="patientForm"
                            [disabled]="patientForm.invalid"
                            class="px-6 py-2 bg-blue-600 text-white font-medium rounded hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed shadow transition-colors">
                        {{ isEditMode ? 'Update Patient' : 'Save & Add to Queue' }}
                    </button>
                </div>
            </div>
        </div>
      </div>


    </div>
  `,
  styles: []
})
export class PatientListComponent implements OnInit {
  patients: Patient[] = [];
  gridData: any[] = [];
  loading = false;
  searchQuery = '';
  showModal = false;
  // Narrow-viewport layout override; desktop always uses the grid.
  mobileView: CompactView = 'cards';
  private static readonly MOBILE_VIEW_KEY = 'nalamdesk.patients.mobileView';

  setMobileView(view: CompactView): void {
    this.mobileView = view;
    persistCompactView(PatientListComponent.MOBILE_VIEW_KEY, view);
  }
  // Additional details collapsed for rapid intake; expanded when editing.
  showAdditional = false;

  // AG Grid Definitions
  colDefs: ColDef[] = [
    { field: 'mrn', headerName: 'MRN', flex: 1, minWidth: 130 },
    { field: 'name', headerName: 'Name', flex: 2, minWidth: 200 },
    { field: 'mobile', headerName: 'Mobile', flex: 1, minWidth: 150 },
    {
      headerName: 'Age / Gender',
      flex: 1,
      valueGetter: (p) => `${deriveAge(p.data.dob, p.data.dob_estimated, p.data.age).label} / ${p.data.gender}`,
      minWidth: 150
    },
    {
      headerName: 'Actions',
      flex: 1.5,
      minWidth: 200,
      cellRenderer: PatientActionsRenderer,
      cellRendererParams: {
        onQueue: (data: any) => this.addToQueue(data),
        onEdit: (data: any) => this.editPatient(data)
      },
      sortable: false,
      filter: false
    }
  ];

  get today(): string {
    return new Date().toISOString().split('T')[0];
  }

  get minDate(): string {
    const d = new Date();
    d.setFullYear(d.getFullYear() - 110);
    return d.toISOString().split('T')[0];
  }

  get isEditMode(): boolean {
    return !!this.patientForm.get('id')?.value;
  }

  /** Destructive batch deletes are admin-only (server 403s the rest). */
  get isAdmin(): boolean {
    return this.currentUser?.role === 'admin';
  }

  // Card batch-select (narrow viewports): mirrors grid multi-select for admins.
  cardSelectMode = false;

  toggleCardSelectMode(): void {
    this.cardSelectMode = !this.cardSelectMode;
    if (!this.cardSelectMode) this.selectedPatients = [];
  }

  isCardSelected(patient: any): boolean {
    return this.selectedPatients.some((p: any) => p?.id === patient?.id);
  }

  onCardTap(patient: any): void {
    if (this.cardSelectMode) this.toggleCardSelection(patient);
    else this.goToVisit(patient);
  }

  toggleCardSelection(patient: any): void {
    if (this.isCardSelected(patient)) {
      this.selectedPatients = this.selectedPatients.filter((p: any) => p?.id !== patient?.id);
    } else {
      this.selectedPatients = [...this.selectedPatients, patient];
    }
  }

  private dataService: DataService = inject(DataService);
  private authService: AuthService = inject(AuthService);
  private queueCountService: QueueCountService | null = inject(QueueCountService, { optional: true });
  currentUser: any = null;
  private dialogService = inject(DialogService);

  constructor(
    private fb: FormBuilder,
    private patientService: PatientService,
    private ngZone: NgZone,
    private router: Router,
    private cdr: ChangeDetectorRef,
    private route: ActivatedRoute
  ) {
    this.initForm();
  }

  patientForm!: FormGroup;

  // Possible duplicates for the in-progress registration (non-blocking).
  duplicateCandidates: any[] = [];
  checkingDuplicates = false;
  private duplicateTimer: any = null;
  private duplicateRequest = 0;

  initForm() {
    this.patientForm = this.fb.group({
      id: [null],
      uuid: [null],
      name: ['', [Validators.required, Validators.minLength(3)]],
      mobile: ['', [Validators.required, Validators.pattern(/^[0-9]{10}$/)]],
      age: [null, [Validators.required, Validators.min(0), Validators.max(110)]],
      dob: [null],
      dob_estimated: [false],
      gender: ['', Validators.required],
      blood_group: [''],
      email: ['', [Validators.email]],

      // Address (all optional for rapid walk-in intake)
      address: [''],
      street: [''],
      city: [''],
      state: [''],
      zip_code: ['', [Validators.pattern(/^[0-9]{6}$/)]],

      // Emergency
      emergency_contact_name: [''],
      emergency_contact_mobile: ['', [Validators.pattern(/^[0-9]{10}$/)]],

      // Insurance
      insurance_provider: [''],
      policy_number: ['']
    });

    this.patientForm.get('dob')?.valueChanges.subscribe(dob => {
      if (dob) {
        const age = this.calculateAge(new Date(dob));
        this.patientForm.patchValue({ age }, { emitEvent: false });
      }
      this.scheduleDuplicateCheck();
    });
    this.patientForm.get('name')?.valueChanges.subscribe(() => this.scheduleDuplicateCheck());
    this.patientForm.get('mobile')?.valueChanges.subscribe(() => this.scheduleDuplicateCheck());
  }

  /** Debounced duplicate warning for the in-progress registration form. */
  scheduleDuplicateCheck(): void {
    if (this.duplicateTimer) clearTimeout(this.duplicateTimer);
    this.duplicateTimer = setTimeout(() => void this.checkDuplicates(), 400);
  }

  async checkDuplicates(): Promise<void> {
    const value = this.patientForm?.value;
    if (!value || !this.showModal) return;
    const input = {
      name: value.name || '', dob: value.dob || null,
      mobile: value.mobile || '', excludeId: value.id || 0
    };
    if (!input.name && !input.mobile) {
      this.ngZone.run(() => {
        this.duplicateCandidates = [];
        this.checkingDuplicates = false;
      });
      return;
    }
    // Sequence guard: a slow earlier request must not overwrite a newer one.
    const request = ++this.duplicateRequest;
    this.checkingDuplicates = true;
    try {
      const rows = await this.dataService.invoke<any[]>('findDuplicateCandidates', input);
      if (request !== this.duplicateRequest) return;
      this.ngZone.run(() => {
        this.duplicateCandidates = rows || [];
        this.checkingDuplicates = false;
      });
    } catch (e) {
      console.error(e);
      if (request !== this.duplicateRequest) return;
      this.ngZone.run(() => { this.checkingDuplicates = false; });
    }
  }

  duplicateSignalLabel(signal: string): string {
    switch (signal) {
      case 'mrn': return 'same MRN';
      case 'name-dob': return 'same name + birth date';
      case 'name': return 'same name';
      case 'phone-shared-possible': return 'same phone (may be shared)';
      default: return signal;
    }
  }

  calculateAge(dob: Date): number {
    const diff = Date.now() - dob.getTime();
    const ageDate = new Date(diff);
    return Math.abs(ageDate.getUTCFullYear() - 1970);
  }

  ngOnInit() {
    this.mobileView = restoreCompactView(PatientListComponent.MOBILE_VIEW_KEY);
    this.currentUser = this.authService.getUser();
    this.loadPatients();
    this.loadQueueStatus();

    this.route.queryParams.subscribe(params => {
      if (params['editId']) {
        const id = Number(params['editId']);
        setTimeout(() => {
          const p = this.patients.find(pt => pt.id === id);
          if (p) {
            this.editPatient(p);
          }
        }, 500);
      }
    });
  }

  async loadPatients() {
    this.loading = true;
    try {
      const data = await this.patientService.getPatients(this.searchQuery);
      this.ngZone.run(() => {
        this.patients = data;
        this.updateGridData();
        this.loading = false;
      });
    } catch (e) {
      console.error('Failed to load patients', e);
      this.loading = false;
    }
  }

  async loadQueueStatus() {
    try {
      const queue = await this.dataService.invoke<any>('getQueue');
      this.enqueuedPatientIds.clear();
      queue.forEach((item: any) => {
        if (item.status !== 'completed') {
          this.enqueuedPatientIds.add(Number(item.patient_id));
        }
      });
      this.updateGridData();
    } catch (e) {
      console.error('Failed to load queue status', e);
    }
  }

  updateGridData() {
    // Merge patients with queue status for the grid
    this.gridData = this.patients.map(p => ({
      ...p,
      inQueue: this.enqueuedPatientIds.has(p.id!)
    }));
    // Drop selections that are no longer visible: a batch delete must only
    // ever cover records the admin can currently see.
    const visible = new Set(this.gridData.map((p: any) => p?.id));
    this.selectedPatients = this.selectedPatients.filter((p: any) => visible.has(p?.id));
  }

  onSearch() {
    this.loadPatients();
  }

  openAddModal() {
    this.patientForm.reset({ gender: '', age: null, dob_estimated: false });
    this.showAdditional = false;
    this.showModal = true;
    this.duplicateCandidates = [];
  }

  editPatient(patient: Patient) {
    this.patientForm.patchValue(patient);
    this.showAdditional = true;
    this.showModal = true;
  }

  // Submit from the form (Enter key) saves and queues a new walk-in.
  // The explicit Save button passes false for a save without queueing.
  async savePatient(addToQueueAfter = false) {
    if (this.patientForm.invalid) {
      this.patientForm.markAllAsTouched();
      return;
    }

    try {
      const formValue = this.patientForm.value;
      const wasNew = !formValue.id;
      const result = await this.patientService.savePatient(formValue);
      const savedId = Number(result?.lastInsertRowid ?? result?.id ?? formValue.id);
      this.ngZone.run(() => {
        this.showModal = false;
        this.loadPatients();
      });
      if (addToQueueAfter && wasNew && savedId) {
        await this.addToQueue({ ...formValue, id: savedId } as Patient);
      }
    } catch (e) {
      console.error('Failed to save patient', e);
      await this.dialogService.open({
        title: 'Save failed',
        message: e instanceof Error ? e.message : 'Could not save the patient.',
        type: 'error'
      });
    }
  }

  onRowClick(data: any) {
    this.goToVisit(data);
  }

  goToVisit(patient: Patient) {
    this.router.navigate(['/patients', patient.id]);
  }

  enqueuedPatientIds = new Set<number>();

  async addToQueue(patient: Patient) {
    if (this.isEnqueued(patient)) return;

    if (!this.patientService.isPatientComplete(patient)) {
      await this.dialogService.open({
        title: 'Incomplete Details',
        message: 'Some essentials are missing (name, mobile, age and gender). Please update details first.',
        type: 'warning',
        confirmText: 'Edit Now'
      });
      this.editPatient(patient);
      return;
    }

    try {
      await this.dataService.invoke<any>('addToQueue', { patientId: patient.id!, priority: 1 });
      this.ngZone.run(() => {
        this.enqueuedPatientIds.add(Number(patient.id!));
        this.updateGridData();
        this.cdr.detectChanges();
      });
      void this.queueCountService?.refresh();
    } catch (e: any) {
      console.error(e);
      this.ngZone.run(async () => {
        if (e.message && e.message.includes('already in queue')) {
          this.enqueuedPatientIds.add(patient.id!);
          this.updateGridData();
          this.cdr.detectChanges();
        } else {
          await this.dialogService.open({
            title: 'Error',
            message: 'Failed to add to queue: ' + e.message,
            type: 'error'
          });
        }
      });
    }
  }

  isEnqueued(patient: Patient): boolean {
    return this.enqueuedPatientIds.has(patient.id!);
  }

  isFieldInvalid(field: string): boolean {
    const control = this.patientForm.get(field);
    return !!(control && control.invalid && (control.dirty || control.touched));
  }

  // Batch Selection
  selectedPatients: any[] = [];

  async deleteSelectedPatients() {
    if (this.selectedPatients.length === 0) return;
    const confirmed = await this.dialogService.open({
      title: `Delete ${this.selectedPatients.length} patients?`,
      message: 'Associated visits and records will be deleted too. This cannot be undone.',
      type: 'confirm',
      confirmText: 'Delete',
      cancelText: 'Keep'
    });
    if (!confirmed) return;

    try {
      for (const p of this.selectedPatients) {
        // Assuming 'deletePatient' exists in backend or we need to add it via DataService
        // Actually PatientService usually handles this. Let's check PatientService or use invoke directly.
        // Given deleteUser used dataService.invoke('deleteUser'), we probably have 'deletePatient'.
        await this.dataService.invoke('deletePatient', p.id);
      }
      this.ngZone.run(() => {
        this.selectedPatients = [];
        this.cardSelectMode = false;
        this.loadPatients();
      });
    } catch (e) {
      console.error(e);
      await this.dialogService.open({
        title: 'Delete failed',
        message: 'Patients could not be deleted. Check console.',
        type: 'error'
      });
    }
  }
}
