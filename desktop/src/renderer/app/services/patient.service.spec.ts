/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { PatientService, Patient } from './patient.service';

describe('PatientService', () => {
    let service: PatientService;
    let mockDataService: any;

    beforeEach(() => {
        mockDataService = {
            invoke: vi.fn()
        };
        service = new PatientService(mockDataService);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('getPatients', () => {
        it('should call DataService.invoke with getPatients', async () => {
            const mockPatients = [{ id: 1, name: 'John', mobile: '1234567890', age: 30, gender: 'Male', address: '123 St' }];
            mockDataService.invoke.mockResolvedValue(mockPatients);

            const result = await service.getPatients('John');
            expect(mockDataService.invoke).toHaveBeenCalledWith('getPatients', 'John', false);
            expect(result).toEqual(mockPatients);
        });

        it('should default query to empty string', async () => {
            mockDataService.invoke.mockResolvedValue([]);
            await service.getPatients();
            expect(mockDataService.invoke).toHaveBeenCalledWith('getPatients', '', false);
        });
    });

    describe('savePatient', () => {
        it('should call DataService.invoke with savePatient', async () => {
            const patient: Patient = { name: 'Jane', mobile: '9876543210', age: 25, gender: 'Female', address: '456 Ave' };
            mockDataService.invoke.mockResolvedValue({ lastInsertRowid: 1 });

            const result = await service.savePatient(patient);
            expect(mockDataService.invoke).toHaveBeenCalledWith('savePatient', patient);
            expect(result).toEqual({ lastInsertRowid: 1 });
        });
    });

    describe('isPatientComplete', () => {
        const validPatient: Patient = {
            name: 'Test Patient',
            mobile: '1234567890',
            age: 30,
            gender: 'Male',
            address: '123 Street'
        };

        it('should return true for a complete patient', () => {
            expect(service.isPatientComplete(validPatient)).toBe(true);
        });

        it('should return true for patient with DOB instead of age', () => {
            const patient = { ...validPatient, age: 0, dob: '1990-01-01' };
            expect(service.isPatientComplete(patient)).toBe(true);
        });

        it('should return false for null patient', () => {
            expect(service.isPatientComplete(null as any)).toBe(false);
        });

        it('should return false when name is missing', () => {
            expect(service.isPatientComplete({ ...validPatient, name: '' })).toBe(false);
        });

        it('should return false when name is whitespace only', () => {
            expect(service.isPatientComplete({ ...validPatient, name: '   ' })).toBe(false);
        });

        it('should return false when mobile is missing', () => {
            expect(service.isPatientComplete({ ...validPatient, mobile: '' })).toBe(false);
        });

        it('should return false when gender is Unknown', () => {
            expect(service.isPatientComplete({ ...validPatient, gender: 'Unknown' })).toBe(false);
        });

        it('should return false when gender is empty', () => {
            expect(service.isPatientComplete({ ...validPatient, gender: '' })).toBe(false);
        });

        it('should return false when age is 0 and no DOB', () => {
            expect(service.isPatientComplete({ ...validPatient, age: 0 })).toBe(false);
        });

        it('should return false when age is null and no DOB', () => {
            expect(service.isPatientComplete({ ...validPatient, age: null as any })).toBe(false);
        });

        it('should return false when age is undefined and no DOB', () => {
            const patient = { ...validPatient };
            delete (patient as any).age;
            expect(service.isPatientComplete(patient)).toBe(false);
        });
    });
});
