import { Injectable, NgZone } from '@angular/core';
import { DataService } from './api.service';

export interface Patient {
  id?: number;
  uuid?: string;
  name: string;
  mobile: string;
  age: number;
  gender: string;
  address: string;
  created_at?: string;

  // Demographics
  dob?: string;
  dob_estimated?: boolean | number;
  mrn?: string;
  merged_into?: number | null;
  blood_group?: string;
  email?: string;

  // Emergency Contact
  emergency_contact_name?: string;
  emergency_contact_mobile?: string;

  // Detailed Address
  street?: string;
  city?: string;
  state?: string;
  zip_code?: string;

  // Insurance
  insurance_provider?: string;
  policy_number?: string;
}

@Injectable({
  providedIn: 'root'
})

// ... interface ...

@Injectable({
  providedIn: 'root'
})
export class PatientService {

  constructor(private dataService: DataService) { }

  async getPatients(query: string = ''): Promise<Patient[]> {
    return await this.dataService.invoke<any>('getPatients', query);
  }

  async savePatient(patient: Patient): Promise<any> {
    return await this.dataService.invoke<any>('savePatient', patient);
  }

  isPatientComplete(patient: Patient): boolean {
    if (!patient) return false;
    // Required: Name, Mobile, Age, Gender
    if (!patient.name || !patient.name.trim()) return false;
    if (!patient.mobile || !patient.mobile.trim()) return false;
    if (!patient.gender || !patient.gender.trim() || patient.gender === 'Unknown') return false;
    // Age or DOB
    if ((patient.age === null || patient.age === undefined || patient.age === 0) && !patient.dob) return false;

    return true;
  }
}
