/**
 * @vitest-environment jsdom
 */
import '@angular/compiler';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AbhaModalComponent } from './abha-modal.component';

describe('AbhaModalComponent', () => {
    let component: AbhaModalComponent;
    let mockDataService: any;

    beforeEach(() => {
        mockDataService = { invoke: vi.fn() };
        component = new AbhaModalComponent(mockDataService);
        component.patientId = 7;
        component.patientName = 'Asha';
    });

    it('verifies an address and links it on confirmation', async () => {
        mockDataService.invoke.mockImplementation((method: string) => {
            if (method === 'abdmAbhaLookup') return Promise.resolve({ exists: true, name: 'Asha Worker', mock: true });
            if (method === 'abdmLinkAbha') return Promise.resolve({ id: 7 });
            return Promise.resolve(null);
        });
        const linked: any[] = [];
        const closed: any[] = [];
        component.linked.subscribe((v) => linked.push(v));
        component.close.subscribe(() => closed.push(true));

        component.address = 'asha.worker@sbx';
        await component.lookup();
        expect(component.foundName).toBe('Asha Worker');
        expect(component.mockHint).toContain('Mock');

        await component.link('Asha Worker');
        expect(mockDataService.invoke).toHaveBeenCalledWith('abdmLinkAbha', {
            patientId: 7,
            abhaAddress: 'asha.worker@sbx',
            abhaName: 'Asha Worker'
        });
        expect(linked).toEqual([{ abhaAddress: 'asha.worker@sbx', abhaName: 'Asha Worker' }]);
        expect(closed).toHaveLength(1);
    });

    it('reports a miss without blocking and offers enrollment', async () => {
        mockDataService.invoke.mockResolvedValue({ exists: false, mock: true });
        component.address = 'nobody@sbx';
        await component.lookup();
        expect(component.lookupMiss).toBe(true);
        expect(component.foundName).toBe('');
    });

    it('verifies a returning patient through the login code flow', async () => {
        mockDataService.invoke.mockImplementation((method: string) => {
            if (method === 'abdmAbhaLookup') return Promise.resolve({ exists: true, name: 'Asha Worker', mock: true });
            if (method === 'abdmAbhaRequestLoginOtp') return Promise.resolve({ txnId: 'mock-login-1', mock: true });
            if (method === 'abdmAbhaConfirmLoginOtp') return Promise.resolve({ abhaAddress: 'asha.worker@sbx', name: 'Asha Worker', mock: true });
            if (method === 'abdmAbhaCard') return Promise.resolve({ name: 'Asha Worker', mock: true });
            return Promise.resolve(null);
        });
        component.address = 'asha.worker@sbx';
        await component.lookup();
        expect(component.verifiedAddress).toBe('asha.worker@sbx');

        await component.requestLoginOtp();
        expect(mockDataService.invoke).toHaveBeenCalledWith('abdmAbhaRequestLoginOtp', { abhaAddress: 'asha.worker@sbx' });
        expect(component.step).toBe('otp');
        expect(component.otpMode).toBe('login');

        component.otp = '482916';
        await component.confirmOtp();
        expect(mockDataService.invoke).toHaveBeenCalledWith('abdmAbhaConfirmLoginOtp', { txnId: 'mock-login-1', otp: '482916' });
        expect(component.step).toBe('card');
        expect(component.card?.abhaAddress).toBe('asha.worker@sbx');
    });

    it('runs the enrollment code flow through to the printable card', async () => {
        mockDataService.invoke.mockImplementation((method: string) => {
            if (method === 'abdmAbhaRequestOtp') return Promise.resolve({ txnId: 'mock-txn-1', mock: true, hint: 'Mock hint' });
            if (method === 'abdmAbhaConfirmOtp') return Promise.resolve({ abhaAddress: 'new.id@sbx', name: 'Asha', mock: true });
            if (method === 'abdmAbhaCard') return Promise.resolve({ name: 'Asha', gender: 'Female', mock: true });
            return Promise.resolve(null);
        });
        component.step = 'enroll';
        component.via = 'mobile';
        component.identifier = '9876543210';
        await component.requestOtp();
        expect(component.step).toBe('otp');
        expect(component.txnId).toBe('mock-txn-1');

        component.otp = '482916';
        await component.confirmOtp();
        expect(component.step).toBe('card');
        expect(component.card).toMatchObject({ abhaAddress: 'new.id@sbx', name: 'Asha' });
    });

    it('links the generated ID from the card step', async () => {
        mockDataService.invoke.mockImplementation((method: string) => {
            if (method === 'abdmLinkAbha') return Promise.resolve({ id: 7 });
            return Promise.resolve(null);
        });
        const linked: any[] = [];
        component.linked.subscribe((v) => linked.push(v));
        component.step = 'card';
        component.card = { abhaAddress: 'new.id@sbx', name: 'Asha' };

        await component.link('Asha');

        expect(mockDataService.invoke).toHaveBeenCalledWith('abdmLinkAbha', {
            patientId: 7,
            abhaAddress: 'new.id@sbx',
            abhaName: 'Asha'
        });
        expect(linked).toEqual([{ abhaAddress: 'new.id@sbx', abhaName: 'Asha' }]);
        expect(component.linkedDone).toBe(true);
    });

    it('refuses to link an address edited after verification', async () => {
        mockDataService.invoke.mockImplementation((method: string) => {
            if (method === 'abdmAbhaLookup') return Promise.resolve({ exists: true, name: 'Asha', mock: true });
            return Promise.resolve(null);
        });
        const linked: any[] = [];
        component.linked.subscribe((v) => linked.push(v));

        component.onAddressInput('asha@sbx');
        await component.lookup();
        expect(component.foundName).toBe('Asha');

        component.onAddressInput('someone.else@sbx');
        expect(component.foundName).toBe('');
        await component.link('Someone Else');
        expect(linked).toHaveLength(0);
        expect(mockDataService.invoke).not.toHaveBeenCalledWith('abdmLinkAbha', expect.anything());
    });

    it('closes untouched without any backend calls', async () => {
        const closed: any[] = [];
        component.close.subscribe(() => closed.push(true));
        component.close.emit();
        expect(closed).toHaveLength(1);
        expect(mockDataService.invoke).not.toHaveBeenCalled();
    });
});
