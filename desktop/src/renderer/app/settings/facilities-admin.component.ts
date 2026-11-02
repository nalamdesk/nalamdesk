import { Component, NgZone, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DataService } from '../services/api.service';
import { DialogService } from '../shared/services/dialog.service';
import { roleLabel } from '../services/facility.service';

export interface AdminFacility {
  id: number;
  code: string;
  name: string;
  kind: string;
  active: number;
  doctor_name: string | null;
  address: string | null;
  phone: string | null;
  abdm_hfr_id: string | null;
  abdm_hip_id: string | null;
}

export interface AdminDepartment {
  id: number;
  facility_id: number;
  code: string;
  name: string;
  kind: string;
  active: number;
}

export interface AdminUser {
  id: number;
  username: string;
  name: string;
  role: string;
  active: number;
  org_admin: number;
}

export interface FacilityAdminData {
  facilities: AdminFacility[];
  departments: AdminDepartment[];
  users: AdminUser[];
  grants: Array<{ user_id: number; facility_id: number; role: string }>;
  roles: string[];
}

type FacilityForm = Partial<AdminFacility>;
type DepartmentForm = Partial<AdminDepartment>;

export const DEPARTMENT_KIND_LABELS: Record<string, string> = {
  opd: 'Outpatient',
  ipd: 'Inpatient',
  emergency: 'Emergency',
  diagnostics: 'Diagnostics',
  pharmacy: 'Pharmacy',
  other: 'Other'
};

/** "Error invoking remote method 'db:x': FacilityAdminError: msg" → "msg". */
export function adminErrorMessage(error: unknown): string {
  const raw = String((error as Error)?.message ?? error ?? '');
  const message = raw.replace(/^Error invoking remote method '[^']*': /, '').replace(/^(\w*Error): /, '');
  if (!message || message === 'Forbidden') return 'Only organisation admins can change facilities and access.';
  if (message === 'Internal server error' || message === 'Server Error') return 'Could not save. Try again.';
  return message;
}

/**
 * Organisation admin (#214): facilities, their departments (hospital mode),
 * and which role each staff member holds at each facility.
 */
@Component({
  selector: 'app-facilities-admin',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="max-w-5xl space-y-8" data-testid="facilities-admin">
      <div>
        <h2 class="text-2xl font-bold text-gray-800">Facilities</h2>
        <p class="text-sm text-gray-500 mt-1">
          Clinics and hospitals in this organisation. Staff sign in to one facility at a time and switch from the top bar.
        </p>
      </div>

      <div *ngIf="error" class="alert alert-error text-sm" role="alert">{{ error }}</div>
      <div *ngIf="forbidden" class="alert alert-info text-sm">Only organisation admins can manage facilities.</div>

      <ng-container *ngIf="data && !forbidden">
        <!-- Facilities -->
        <section class="bg-white border border-gray-200 rounded-lg">
          <div class="flex items-center justify-between px-4 py-3 border-b">
            <h3 class="font-semibold text-gray-800">Facilities</h3>
            <button type="button" class="btn btn-primary btn-sm" (click)="newFacility()" [disabled]="busy" data-testid="add-facility">Add facility</button>
          </div>
          <div class="overflow-x-auto">
            <table class="table table-sm">
              <thead><tr><th>Code</th><th>Name</th><th>Type</th><th>Status</th><th class="text-right">Actions</th></tr></thead>
              <tbody>
                <tr *ngFor="let f of data.facilities" [class.opacity-60]="!f.active" [class.bg-blue-50]="selectedFacilityId === f.id">
                  <td class="font-mono">{{ f.code }}</td>
                  <td>
                    <button type="button" class="link link-hover font-medium text-left" (click)="selectFacility(f.id)">{{ f.name || f.code }}</button>
                  </td>
                  <td>{{ f.kind === 'hospital' ? 'Hospital' : 'Clinic' }}</td>
                  <td>
                    <span class="badge badge-sm" [ngClass]="f.active ? 'badge-success badge-outline' : 'badge-ghost'">{{ f.active ? 'Open' : 'Closed' }}</span>
                  </td>
                  <td class="text-right whitespace-nowrap">
                    <button type="button" class="btn btn-ghost btn-xs" (click)="editFacility(f)" [disabled]="busy">Edit</button>
                    <button type="button" class="btn btn-ghost btn-xs" (click)="toggleFacility(f)" [disabled]="busy"
                            [attr.data-testid]="'toggle-facility-' + f.id">{{ f.active ? 'Close' : 'Reopen' }}</button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <form *ngIf="facilityForm" (ngSubmit)="saveFacility()" class="bg-white border border-gray-200 rounded-lg p-4 space-y-4" data-testid="facility-form">
          <h3 class="font-semibold text-gray-800">{{ facilityForm.id ? 'Edit facility' : 'New facility' }}</h3>
          <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label for="facility-code" class="block text-xs font-semibold text-gray-600 mb-1">Code</label>
              <input id="facility-code" name="code" [(ngModel)]="facilityForm.code" maxlength="16" required
                     class="input input-bordered input-sm w-full font-mono uppercase" placeholder="ANN">
            </div>
            <div class="md:col-span-2">
              <label for="facility-name" class="block text-xs font-semibold text-gray-600 mb-1">Name</label>
              <input id="facility-name" name="name" [(ngModel)]="facilityForm.name" maxlength="200" required
                     class="input input-bordered input-sm w-full" placeholder="Anna Nagar Clinic">
            </div>
            <div>
              <label for="facility-kind" class="block text-xs font-semibold text-gray-600 mb-1">Type</label>
              <select id="facility-kind" name="kind" [(ngModel)]="facilityForm.kind" class="select select-bordered select-sm w-full">
                <option value="clinic">Clinic</option>
                <option value="hospital">Hospital (departments)</option>
              </select>
            </div>
            <div class="md:col-span-2">
              <label for="facility-doctor" class="block text-xs font-semibold text-gray-600 mb-1">Letterhead doctor name</label>
              <input id="facility-doctor" name="doctor_name" [(ngModel)]="facilityForm.doctor_name" maxlength="200"
                     class="input input-bordered input-sm w-full">
            </div>
            <div class="md:col-span-2">
              <label for="facility-address" class="block text-xs font-semibold text-gray-600 mb-1">Letterhead address</label>
              <input id="facility-address" name="address" [(ngModel)]="facilityForm.address" maxlength="200"
                     class="input input-bordered input-sm w-full">
            </div>
            <div>
              <label for="facility-phone" class="block text-xs font-semibold text-gray-600 mb-1">Phone</label>
              <input id="facility-phone" name="phone" [(ngModel)]="facilityForm.phone" maxlength="200"
                     class="input input-bordered input-sm w-full">
            </div>
            <div>
              <label for="facility-hfr" class="block text-xs font-semibold text-gray-600 mb-1">ABDM HFR ID</label>
              <input id="facility-hfr" name="abdm_hfr_id" [(ngModel)]="facilityForm.abdm_hfr_id" maxlength="200"
                     class="input input-bordered input-sm w-full font-mono">
            </div>
            <div>
              <label for="facility-hip" class="block text-xs font-semibold text-gray-600 mb-1">ABDM HIP ID</label>
              <input id="facility-hip" name="abdm_hip_id" [(ngModel)]="facilityForm.abdm_hip_id" maxlength="200"
                     class="input input-bordered input-sm w-full font-mono">
            </div>
          </div>
          <div class="flex justify-end gap-2">
            <button type="button" class="btn btn-ghost btn-sm" (click)="facilityForm = null" [disabled]="busy">Cancel</button>
            <button type="submit" class="btn btn-primary btn-sm" [disabled]="busy || !facilityForm.code || !facilityForm.name">Save facility</button>
          </div>
        </form>

        <!-- Departments of the selected facility -->
        <section *ngIf="selectedFacility as f" class="bg-white border border-gray-200 rounded-lg" data-testid="departments">
          <div class="flex items-center justify-between px-4 py-3 border-b">
            <h3 class="font-semibold text-gray-800">Departments at {{ f.name || f.code }}</h3>
            <button *ngIf="f.kind === 'hospital'" type="button" class="btn btn-outline btn-sm" (click)="newDepartment(f.id)" [disabled]="busy">Add department</button>
          </div>
          <p *ngIf="f.kind !== 'hospital'" class="px-4 py-3 text-sm text-gray-500">
            Clinics work as one General OPD. Change the type to Hospital to add departments.
          </p>
          <div *ngIf="f.kind === 'hospital'" class="overflow-x-auto">
            <table class="table table-sm">
              <thead><tr><th>Code</th><th>Name</th><th>Type</th><th>Status</th><th class="text-right">Actions</th></tr></thead>
              <tbody>
                <tr *ngFor="let d of departmentsOf(f.id)" [class.opacity-60]="!d.active">
                  <td class="font-mono">{{ d.code }}</td>
                  <td>{{ d.name }}</td>
                  <td>{{ departmentKind(d.kind) }}</td>
                  <td><span class="badge badge-sm" [ngClass]="d.active ? 'badge-success badge-outline' : 'badge-ghost'">{{ d.active ? 'Open' : 'Closed' }}</span></td>
                  <td class="text-right whitespace-nowrap">
                    <button type="button" class="btn btn-ghost btn-xs" (click)="editDepartment(d)" [disabled]="busy">Edit</button>
                    <button type="button" class="btn btn-ghost btn-xs" (click)="toggleDepartment(d)" [disabled]="busy">{{ d.active ? 'Close' : 'Reopen' }}</button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <form *ngIf="departmentForm" (ngSubmit)="saveDepartment()" class="p-4 border-t grid grid-cols-1 md:grid-cols-4 gap-3 items-end" data-testid="department-form">
            <div>
              <label for="department-code" class="block text-xs font-semibold text-gray-600 mb-1">Code</label>
              <input id="department-code" name="code" [(ngModel)]="departmentForm.code" maxlength="16" required class="input input-bordered input-sm w-full font-mono uppercase" placeholder="ORTHO">
            </div>
            <div>
              <label for="department-name" class="block text-xs font-semibold text-gray-600 mb-1">Name</label>
              <input id="department-name" name="name" [(ngModel)]="departmentForm.name" maxlength="200" required class="input input-bordered input-sm w-full" placeholder="Orthopaedics">
            </div>
            <div>
              <label for="department-kind" class="block text-xs font-semibold text-gray-600 mb-1">Type</label>
              <select id="department-kind" name="kind" [(ngModel)]="departmentForm.kind" class="select select-bordered select-sm w-full">
                <option *ngFor="let k of departmentKinds" [value]="k">{{ departmentKind(k) }}</option>
              </select>
            </div>
            <div class="flex gap-2 justify-end">
              <button type="button" class="btn btn-ghost btn-sm" (click)="departmentForm = null" [disabled]="busy">Cancel</button>
              <button type="submit" class="btn btn-primary btn-sm" [disabled]="busy || !departmentForm.code || !departmentForm.name">Save</button>
            </div>
          </form>
        </section>

        <!-- Staff access -->
        <section class="bg-white border border-gray-200 rounded-lg" data-testid="staff-access">
          <div class="px-4 py-3 border-b">
            <h3 class="font-semibold text-gray-800">Staff access</h3>
            <p class="text-xs text-gray-500 mt-1">
              A staff member signs in only to facilities where they hold a role. Organisation admins are admins at every facility.
            </p>
          </div>
          <div class="overflow-x-auto">
            <table class="table table-sm">
              <thead>
                <tr>
                  <th>Staff member</th>
                  <th>Organisation admin</th>
                  <th *ngFor="let f of openFacilities">{{ f.code }}</th>
                </tr>
              </thead>
              <tbody>
                <tr *ngFor="let u of activeUsers">
                  <td>
                    <div class="font-medium">{{ u.name || u.username }}</div>
                    <div class="text-xs text-gray-500">{{ u.username }}</div>
                  </td>
                  <td>
                    <input type="checkbox" class="toggle toggle-sm toggle-primary" [checked]="!!u.org_admin" [disabled]="busy"
                           [attr.aria-label]="'Organisation admin: ' + (u.name || u.username)"
                           (change)="setOrgAdmin(u, $event)">
                  </td>
                  <td *ngFor="let f of openFacilities">
                    <span *ngIf="u.org_admin" class="text-xs text-gray-500">Admin</span>
                    <select *ngIf="!u.org_admin" class="select select-bordered select-xs"
                            [attr.aria-label]="'Role at ' + f.code + ': ' + (u.name || u.username)"
                            [disabled]="busy" (change)="setRole(u, f, $event)">
                      <option value="" [selected]="!roleAt(u.id, f.id)">No access</option>
                      <option *ngFor="let r of data.roles" [value]="r" [selected]="roleAt(u.id, f.id) === r">{{ label(r) }}</option>
                    </select>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      </ng-container>
    </div>
  `
})
export class FacilitiesAdminComponent implements OnInit {
  data: FacilityAdminData | null = null;
  error = '';
  forbidden = false;
  busy = false;
  facilityForm: FacilityForm | null = null;
  departmentForm: DepartmentForm | null = null;
  selectedFacilityId: number | null = null;
  readonly departmentKinds = Object.keys(DEPARTMENT_KIND_LABELS);

  constructor(private dataService: DataService, private dialog: DialogService, private zone: NgZone) { }

  ngOnInit(): void {
    void this.load();
  }

  get selectedFacility(): AdminFacility | null {
    return this.data?.facilities.find(f => f.id === this.selectedFacilityId) ?? null;
  }

  get openFacilities(): AdminFacility[] {
    return this.data?.facilities.filter(f => f.active) ?? [];
  }

  get activeUsers(): AdminUser[] {
    return this.data?.users.filter(u => u.active) ?? [];
  }

  departmentsOf(facilityId: number): AdminDepartment[] {
    return this.data?.departments.filter(d => d.facility_id === facilityId) ?? [];
  }

  roleAt(userId: number, facilityId: number): string {
    return this.data?.grants.find(g => g.user_id === userId && g.facility_id === facilityId)?.role ?? '';
  }

  label(role: string): string {
    return roleLabel(role);
  }

  departmentKind(kind: string): string {
    return DEPARTMENT_KIND_LABELS[kind] ?? kind;
  }

  async load(): Promise<void> {
    try {
      const data = await this.dataService.invoke<FacilityAdminData>('getFacilityAdmin');
      this.zone.run(() => {
        this.data = data;
        this.forbidden = false;
        this.selectedFacilityId ??= data.facilities[0]?.id ?? null;
      });
    } catch (e) {
      this.zone.run(() => {
        const message = adminErrorMessage(e);
        this.forbidden = message.startsWith('Only organisation admins');
        this.error = this.forbidden ? '' : message;
      });
    }
  }

  /** Runs one change, then reloads; a refusal shows its reason. */
  private async run(method: string, input: unknown): Promise<boolean> {
    this.busy = true;
    this.error = '';
    try {
      await this.dataService.invoke(method, input);
      await this.load();
      return true;
    } catch (e) {
      this.zone.run(() => { this.error = adminErrorMessage(e); });
      await this.load();
      return false;
    } finally {
      this.zone.run(() => { this.busy = false; });
    }
  }

  selectFacility(id: number): void {
    this.selectedFacilityId = id;
    this.departmentForm = null;
  }

  newFacility(): void {
    this.facilityForm = { kind: 'clinic', code: '', name: '' };
  }

  editFacility(facility: AdminFacility): void {
    this.facilityForm = { ...facility };
    this.selectFacility(facility.id);
  }

  async saveFacility(): Promise<void> {
    if (!this.facilityForm) return;
    if (await this.run('saveFacility', this.facilityForm)) this.facilityForm = null;
  }

  async toggleFacility(facility: AdminFacility): Promise<void> {
    if (facility.active) {
      const confirmed = await this.dialog.open({
        title: `Close ${facility.name || facility.code}?`,
        message: 'Staff can no longer sign in to this facility or work in it. Its records are kept, and you can reopen it later.',
        type: 'confirm',
        confirmText: 'Close facility',
        cancelText: 'Cancel'
      });
      if (!confirmed) return;
    }
    await this.run('setFacilityActive', { id: facility.id, active: !facility.active });
  }

  newDepartment(facilityId: number): void {
    this.departmentForm = { facility_id: facilityId, kind: 'opd', code: '', name: '' };
  }

  editDepartment(department: AdminDepartment): void {
    this.departmentForm = { ...department };
  }

  async saveDepartment(): Promise<void> {
    const form = this.departmentForm;
    if (!form) return;
    const input = { id: form.id, facilityId: form.facility_id, code: form.code, name: form.name, kind: form.kind };
    if (await this.run('saveDepartment', input)) this.departmentForm = null;
  }

  async toggleDepartment(department: AdminDepartment): Promise<void> {
    await this.run('setDepartmentActive', { id: department.id, active: !department.active });
  }

  async setRole(user: AdminUser, facility: AdminFacility, event: Event): Promise<void> {
    const role = (event.target as HTMLSelectElement).value;
    if (role) {
      await this.run('grantFacilityRole', { userId: user.id, facilityId: facility.id, role });
    } else {
      await this.run('revokeFacilityRole', { userId: user.id, facilityId: facility.id });
    }
  }

  async setOrgAdmin(user: AdminUser, event: Event): Promise<void> {
    const orgAdmin = (event.target as HTMLInputElement).checked;
    await this.run('setOrgAdmin', { userId: user.id, orgAdmin });
  }
}
