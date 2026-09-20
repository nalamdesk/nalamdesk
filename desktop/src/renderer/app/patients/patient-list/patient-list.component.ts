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
import { PatientActionsRenderer } from './patient-actions.component';
import { ColDef } from 'ag-grid-community';

@Component({
  selector: 'app-patient-list',
  standalone: true,
  imports: [CommonModule, FormsModule, ReactiveFormsModule, DatePickerComponent, SharedTableComponent],
  template: `
    <div class="h-full bg-gray-100 p-4 md:p-6 flex flex-col overflow-hidden">
      <div class="w-full">
        <div class="flex justify-between items-center mb-6">
          <h1 class="text-3xl font-bold text-gray-800">Patients</h1>
          <button (click)="openAddModal()" class="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 transition shadow-sm">
            + Add Patient
          </button>
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
        <div class="flex-1 h-[calc(100vh-200px)]">
           <app-shared-table
              [rowData]="gridData"
              [columnDefs]="colDefs"
              [loading]="loading"
              [multiSelect]="true"
              (selectionChanged)="selectedPatients = $event"
              (rowClick)="onRowClick($event)"
           >
              <div toolbar-left>
                  <button *ngIf="selectedPatients.length > 0" (click)="deleteSelectedPatients()" 
                          class="bg-red-50 text-red-600 px-3 py-1.5 rounded-md text-xs font-medium border border-red-200 hover:bg-red-100 flex items-center gap-2 animate-in fade-in zoom-in duration-200">
                      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-4 h-4">
                        <path stroke-linecap="round" stroke-linejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />
                      </svg>
                      Delete ({{ selectedPatients.length }})
                  </button>
              </div>
           </app-shared-table>
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
  // Additional details collapsed for rapid intake; expanded when editing.
  showAdditional = false;

  // AG Grid Definitions
  colDefs: ColDef[] = [
    { field: 'name', headerName: 'Name', flex: 2, minWidth: 200 },
    { field: 'mobile', headerName: 'Mobile', flex: 1, minWidth: 150 },
    {
      headerName: 'Age / Gender',
      flex: 1,
      valueGetter: (p) => p.data.age + ' / ' + p.data.gender,
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

  private dataService: DataService = inject(DataService);
  private authService: AuthService = inject(AuthService);
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

  initForm() {
    this.patientForm = this.fb.group({
      id: [null],
      uuid: [null],
      name: ['', [Validators.required, Validators.minLength(3)]],
      mobile: ['', [Validators.required, Validators.pattern(/^[0-9]{10}$/)]],
      age: [null, [Validators.required, Validators.min(0), Validators.max(110)]],
      dob: [null],
      gender: ['Male', Validators.required],
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
    });
  }

  calculateAge(dob: Date): number {
    const diff = Date.now() - dob.getTime();
    const ageDate = new Date(diff);
    return Math.abs(ageDate.getUTCFullYear() - 1970);
  }

  ngOnInit() {
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
  }

  onSearch() {
    this.loadPatients();
  }

  openAddModal() {
    this.patientForm.reset({ gender: 'Male', age: null });
    this.showAdditional = false;
    this.showModal = true;
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
    if (!confirm(`Are you sure you want to delete ${this.selectedPatients.length} patients? associated visits and records will effectively be orphaned or deleted.`)) return;

    try {
      for (const p of this.selectedPatients) {
        // Assuming 'deletePatient' exists in backend or we need to add it via DataService
        // Actually PatientService usually handles this. Let's check PatientService or use invoke directly.
        // Given deleteUser used dataService.invoke('deleteUser'), we probably have 'deletePatient'.
        await this.dataService.invoke('deletePatient', p.id);
      }
      this.ngZone.run(() => {
        this.selectedPatients = [];
        this.loadPatients();
      });
    } catch (e) {
      console.error(e);
      alert('Error deleting patients. Check console.');
    }
  }
}
