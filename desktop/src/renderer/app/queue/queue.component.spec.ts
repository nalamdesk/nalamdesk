/**
 * @vitest-environment jsdom
 */
import '@angular/compiler';
import { describe, xdescribe, it, expect, vi, beforeEach } from 'vitest';
import { QueueComponent } from './queue.component';

// Mock inject/core to prevent Zone issues
vi.mock('@angular/core', async () => {
    const actual = await vi.importActual('@angular/core');
    return {
        ...actual as any,
        inject: vi.fn(),
    };
});
import { inject } from '@angular/core';

// Mock Services
// vi.mock('../services/api.service'); // Removed, using manual mock object

describe('QueueComponent', () => {
    let component: QueueComponent;
    let mockDataService: any;
    let mockRouter: any;
    let mockDialogService: any;
    let mockAuthService: any;

    beforeEach(() => {
        mockAuthService = {
            getUser: vi.fn().mockReturnValue({ role: 'doctor', id: 10 })
        };

        mockDataService = {
            invoke: vi.fn().mockImplementation((endpoint: string) => {
                if (endpoint === 'getQueue') {
                    return Promise.resolve([
                        { id: 1, patient_id: 11, patient_name: 'P1', priority: 1, status: 'waiting', check_in_time: new Date().toISOString() },
                        { id: 2, patient_id: 22, patient_name: 'P2', priority: 2, status: 'waiting', check_in_time: new Date().toISOString() }
                    ]);
                }
                if (endpoint === 'beginConsultation') return Promise.resolve({ id: 101, patient_id: 11 });
                if (endpoint === 'resumeConsultation') return Promise.resolve({ id: 102, patient_id: 11 });
                if (endpoint === 'getDoctors') return Promise.resolve([{ id: 10, name: 'Dr. Smith' }]);
                if (endpoint === 'getQueueTriageHistory') return Promise.resolve([{ id: 1, new_urgency: 'urgent', reason: 'Fever' }]);
                if (endpoint === 'reassessQueueTriage') return Promise.resolve({ id: 1, urgency: 'urgent' });
                return Promise.resolve(null);
            })
        };

        mockRouter = {
            navigate: vi.fn()
        };

        mockDialogService = {
            open: vi.fn().mockResolvedValue(true)
        };

        component = new QueueComponent(mockRouter, mockDataService, mockDialogService, mockAuthService);
    });

    it('should resume the exact linked encounter for a postponed queue item', async () => {
        const item = { id: 1, patient_id: 11, patient_name: 'P1', status: 'waiting', active_encounter_id: 102 };

        await component.startConsult(item);

        expect(mockDataService.invoke).toHaveBeenCalledWith('resumeConsultation', { encounterId: 102 });
        expect(mockDataService.invoke.mock.calls.some((call: any[]) => call[0] === 'beginConsultation')).toBe(false);
        expect(mockRouter.navigate).toHaveBeenCalledWith(['/visit', 11], {
            state: { isConsulting: true, encounterId: 102, patientName: 'P1' }
        });
    });

    it('should create and load queue', async () => {
        component.ngOnInit();
        // Wait for async refreshQueue
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(component).toBeTruthy();
        expect(mockDataService.invoke).toHaveBeenCalledWith('getQueue');
        const queue = component.queue();
        expect(queue.length).toBe(2);
        expect(queue.find((q: any) => q.priority === 2)?.patient_name).toBe('P2');
    });

    it('should atomically start an encounter before navigating', async () => {
        const item = { id: 1, patient_id: 11, patient_name: 'P1' };

        await component.startConsult(item);
        expect(mockDataService.invoke).toHaveBeenCalledWith('beginConsultation', expect.objectContaining({
            patientId: 11,
            queueEntryId: 1,
            startRequestId: expect.any(String)
        }));
        expect(mockDataService.invoke).toHaveBeenCalledWith('getQueue'); // Should reload
        expect(mockRouter.navigate).toHaveBeenCalledWith(['/visit', 11], {
            state: { isConsulting: true, encounterId: 101, patientName: 'P1' }
        });
    });

    it('should reuse the start request id after a lost response', async () => {
        const item = { id: 1, patient_id: 11, patient_name: 'P1' };
        const requestIds: string[] = [];
        let attempts = 0;
        mockDataService.invoke.mockImplementation((method: string, input: any) => {
            if (method === 'beginConsultation') {
                requestIds.push(input.startRequestId);
                attempts += 1;
                return attempts === 1 ? Promise.reject(new Error('response lost')) : Promise.resolve({ id: 101 });
            }
            if (method === 'getQueue') return Promise.resolve([]);
            return Promise.resolve(null);
        });
        vi.spyOn(console, 'error').mockImplementation(() => undefined);

        await component.startConsult(item);
        await component.startConsult(item);

        expect(requestIds).toHaveLength(2);
        expect(requestIds[1]).toBe(requestIds[0]);
        expect(mockRouter.navigate).toHaveBeenCalledWith(['/visit', 11], expect.objectContaining({ state: expect.objectContaining({ encounterId: 101 }) }));
    });

    it('surfaces start-consultation failures in the in-app dialog instead of alert', async () => {
        mockDataService.invoke.mockRejectedValue(new Error('Queue entry was not created'));
        const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
        vi.spyOn(console, 'error').mockImplementation(() => undefined);

        await component.startConsult({ id: 1, patient_id: 11 });

        expect(alertSpy).not.toHaveBeenCalled();
        expect(mockDialogService.open).toHaveBeenCalledWith(expect.objectContaining({
            type: 'error',
            title: 'Error'
        }));
        expect(mockRouter.navigate).not.toHaveBeenCalled();
    });

    it('explains resume denial without IPC framing when another practitioner owns the encounter', async () => {
        mockDataService.invoke.mockRejectedValue(new Error("Error invoking remote method 'db:resumeConsultation': Error: Only the responsible practitioner can access this encounter"));
        vi.spyOn(console, 'error').mockImplementation(() => undefined);

        await component.startConsult({ id: 1, patient_id: 11, active_encounter_id: 77 });

        expect(mockDialogService.open).toHaveBeenCalledWith(expect.objectContaining({
            type: 'warning',
            title: 'Consultation in progress',
            message: expect.not.stringContaining('db:resumeConsultation')
        }));
        expect(mockRouter.navigate).not.toHaveBeenCalled();
    });

    it('loads pending scan tokens for the dock', async () => {
        mockDataService.invoke.mockImplementation((endpoint: string) => {
            if (endpoint === 'abdmGetShareTokens') {
                return Promise.resolve([{ id: 1, token_no: 14, patient_name: 'Ramesh', abha_address: 'ramesh@sbx' }]);
            }
            return Promise.resolve([]);
        });

        await component.refreshShareTokens();

        expect(component.shareTokens).toHaveLength(1);
        expect(component.shareTokens[0].token_no).toBe(14);
    });

    it('checks in a scan through one atomic call', async () => {
        const token = { id: 3, token_no: 15, patient_name: 'Ramesh', abha_address: 'ramesh@sbx' };
        mockDataService.invoke.mockImplementation((endpoint: string) => {
            if (endpoint === 'abdmAcceptShareTokenAndCheckIn') {
                return Promise.resolve({ outcome: 'checked-in', patientId: 9, queueEntryId: 11, tokenId: 3 });
            }
            if (endpoint === 'abdmGetShareTokens') return Promise.resolve([]);
            if (endpoint === 'getQueue') return Promise.resolve([]);
            return Promise.resolve(null);
        });

        await component.acceptShareToken(token);

        expect(mockDataService.invoke).toHaveBeenCalledWith('abdmAcceptShareTokenAndCheckIn', { tokenId: 3 });
        expect(mockDialogService.open).not.toHaveBeenCalled();
        expect(component.acceptingTokenId).toBeNull();
    });

    it('opens the chart when the atomic check-in reports incomplete demographics', async () => {
        const token = { id: 5, token_no: 17, patient_name: 'NoMobile' };
        mockDataService.invoke.mockImplementation((endpoint: string) => {
            if (endpoint === 'abdmAcceptShareTokenAndCheckIn') {
                return Promise.resolve({ outcome: 'incomplete', patientId: 22, tokenId: 5 });
            }
            return Promise.resolve(null);
        });

        await component.acceptShareToken(token);

        expect(mockRouter.navigate).toHaveBeenCalledWith(['/patients', 22]);
        expect(component.acceptingTokenId).toBeNull();
    });

    it('reports atomic check-in failures without partial states', async () => {
        const token = { id: 6, token_no: 18, patient_name: 'Ramesh' };
        mockDataService.invoke.mockImplementation((endpoint: string) => {
            if (endpoint === 'abdmAcceptShareTokenAndCheckIn') {
                return Promise.reject(new Error('Token has expired. Ask the patient to scan again.'));
            }
            return Promise.resolve(null);
        });

        await component.acceptShareToken(token);

        expect(mockDialogService.open).toHaveBeenCalledWith(expect.objectContaining({
            title: 'Could not check in',
            type: 'error'
        }));
        expect(mockRouter.navigate).not.toHaveBeenCalled();
    });

    it('ignores Space while typing but accepts the oldest token when idle', async () => {
        component.shareTokens = [{ id: 6, token_no: 18, patient_name: 'Ramesh' }];
        const acceptSpy = vi.spyOn(component, 'acceptShareToken').mockResolvedValue(undefined);
        const inInput = { key: ' ', target: { tagName: 'INPUT' }, preventDefault: vi.fn() } as any;
        expect(component.acceptFirstTokenIfIdle(inInput)).toBe(false);
        expect(acceptSpy).not.toHaveBeenCalled();

        const idle = { key: ' ', target: { tagName: 'DIV' }, preventDefault: vi.fn() } as any;
        expect(component.acceptFirstTokenIfIdle(idle)).toBe(true);
        expect(idle.preventDefault).toHaveBeenCalled();
        expect(acceptSpy).toHaveBeenCalledWith(component.shareTokens[0]);
    });

    it('surfaces remove-from-queue failures in the in-app dialog instead of alert', async () => {
        mockDataService.invoke.mockRejectedValue(new Error('Cannot remove a queue entry with an active encounter'));
        const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
        vi.spyOn(console, 'error').mockImplementation(() => undefined);

        await component.remove(1);
        expect(component.showRemoveDialog).toBe(true);
        await component.onRemoveDecided('no-show');

        expect(alertSpy).not.toHaveBeenCalled();
        expect(mockDataService.invoke).toHaveBeenCalledWith('removeFromQueue', { id: 1, reason: 'no-show' });
        expect(mockDialogService.open).toHaveBeenCalledWith(expect.objectContaining({
            type: 'error',
            title: 'Error',
            message: expect.stringContaining('Failed to remove from queue')
        }));
    });

    it('keeps the patient when removal is cancelled', async () => {
        await component.remove(1);
        expect(component.showRemoveDialog).toBe(true);
        await component.onRemoveDecided(null);

        expect(mockDataService.invoke).not.toHaveBeenCalledWith('removeFromQueue', expect.anything());
    });

    it('opens vitals modal with queue entry id and patient id', () => {
        const item = { id: 42, patient_id: 11, status: 'waiting', active_encounter_id: 105 };
        component.openVitals(item);

        expect(component.showVitalsModal).toBe(true);
        expect(component.selectedPatientIdForVitals).toBe(11);
        expect(component.selectedQueueEntryIdForVitals).toBe(42);
        expect(component.selectedVisitIdForVitals).toBe(105);

        component.closeVitalsModal();
        expect(component.showVitalsModal).toBe(false);
        expect(component.selectedPatientIdForVitals).toBeNull();
        expect(component.selectedQueueEntryIdForVitals).toBeNull();
        expect(component.selectedVisitIdForVitals).toBeNull();
    });

    it('opens vitals modal with numeric patient id', () => {
        component.openVitals(99);
        expect(component.showVitalsModal).toBe(true);
        expect(component.selectedPatientIdForVitals).toBe(99);
        expect(component.selectedQueueEntryIdForVitals).toBeNull();
        expect(component.selectedVisitIdForVitals).toBeNull();

        component.onVitalsSaved({});
        expect(component.showVitalsModal).toBe(false);
    });

    it('opens and loads triage history modal', async () => {
        const item = { id: 1, patient_name: 'Alice', urgency: 'priority' };
        await component.openTriageModal(item);

        expect(component.showTriageModal).toBe(true);
        expect(component.selectedQueueItem).toBe(item);
        expect(component.selectedUrgency).toBe('priority');
        expect(component.triageHistory).toHaveLength(1);
        expect(component.triageHistory[0].new_urgency).toBe('urgent');

        component.closeTriageModal();
        expect(component.showTriageModal).toBe(false);
        expect(component.selectedQueueItem).toBeNull();
        expect(component.triageHistory).toHaveLength(0);
    });

    it('handles triage history loading failure gracefully', async () => {
        mockDataService.invoke.mockImplementation((endpoint: string) => {
            if (endpoint === 'getQueueTriageHistory') return Promise.reject(new Error('DB error'));
            return Promise.resolve(null);
        });

        const item = { id: 2, patient_name: 'Bob' };
        await component.openTriageModal(item);

        expect(component.showTriageModal).toBe(true);
        expect(component.triageHistory).toEqual([]);
    });

    it('submits triage reassessment and refreshes queue', async () => {
        const item = { id: 1, patient_name: 'Alice', urgency: 'routine' };
        await component.openTriageModal(item);

        // Does nothing if reason is empty
        component.triageReason = '   ';
        await component.submitTriageReassessment();
        expect(mockDataService.invoke).not.toHaveBeenCalledWith('reassessQueueTriage', expect.anything());

        // Submits with clinical reason
        component.selectedUrgency = 'immediate';
        component.triageReason = 'Patient has acute respiratory distress';
        await component.submitTriageReassessment();

        expect(mockDataService.invoke).toHaveBeenCalledWith('reassessQueueTriage', {
            queueId: 1,
            urgency: 'immediate',
            reason: 'Patient has acute respiratory distress'
        });
        expect(component.showTriageModal).toBe(false);
        expect(mockDataService.invoke).toHaveBeenCalledWith('getQueue');
    });

    it('surfaces triage update failure via dialog', async () => {
        const item = { id: 1, patient_name: 'Alice', urgency: 'routine' };
        await component.openTriageModal(item);

        mockDataService.invoke.mockImplementation((endpoint: string) => {
            if (endpoint === 'reassessQueueTriage') return Promise.reject(new Error('Cannot update completed'));
            return Promise.resolve(null);
        });

        component.triageReason = 'Condition worsened';
        await component.submitTriageReassessment();

        expect(mockDialogService.open).toHaveBeenCalledWith(expect.objectContaining({
            title: 'Triage Update Failed',
            type: 'error',
            message: 'Cannot update completed'
        }));
        expect(component.savingTriage).toBe(false);
    });

    it('associates active doctor when admin starts consultation', async () => {
        mockAuthService.getUser.mockReturnValue({ role: 'admin', id: 99 });
        const item = { id: 1, patient_id: 11, patient_name: 'P1' };

        await component.startConsult(item);

        expect(mockDataService.invoke).toHaveBeenCalledWith('getDoctors');
        expect(mockDataService.invoke).toHaveBeenCalledWith('beginConsultation', expect.objectContaining({
            patientId: 11,
            queueEntryId: 1,
            doctorId: 10
        }));
    });

    it('lets admin pick the attending doctor when several are active', async () => {
        mockAuthService.getUser.mockReturnValue({ role: 'admin', id: 99 });
        mockDataService.invoke.mockImplementation((endpoint: string) => {
            if (endpoint === 'getDoctors') return Promise.resolve([{ id: 10, name: 'Dr. A' }, { id: 11, name: 'Dr. B' }]);
            if (endpoint === 'beginConsultation') return Promise.resolve({ id: 101, patient_id: 11 });
            return Promise.resolve(null);
        });
        const mockPick = { request: vi.fn().mockResolvedValue(11) };
        const picked = new QueueComponent(mockRouter, mockDataService, mockDialogService, mockAuthService, mockPick as any);

        await picked.startConsult({ id: 1, patient_id: 11, patient_name: 'P1' });

        expect(mockPick.request).toHaveBeenCalledWith(expect.arrayContaining([
            expect.objectContaining({ id: 10 }), expect.objectContaining({ id: 11 })
        ]));
        expect(mockDataService.invoke).toHaveBeenCalledWith('beginConsultation', expect.objectContaining({ doctorId: 11 }));
    });

    it('aborts silently when admin cancels the attending picker', async () => {
        mockAuthService.getUser.mockReturnValue({ role: 'admin', id: 99 });
        mockDataService.invoke.mockImplementation((endpoint: string) => {
            if (endpoint === 'getDoctors') return Promise.resolve([{ id: 10, name: 'Dr. A' }, { id: 11, name: 'Dr. B' }]);
            return Promise.resolve(null);
        });
        const mockPick = { request: vi.fn().mockResolvedValue(null) };
        const picked = new QueueComponent(mockRouter, mockDataService, mockDialogService, mockAuthService, mockPick as any);

        await picked.startConsult({ id: 1, patient_id: 11, patient_name: 'P1' });

        expect(mockDataService.invoke).not.toHaveBeenCalledWith('beginConsultation', expect.anything());
        expect(mockRouter.navigate).not.toHaveBeenCalled();
    });

    it('warns when admin starts a consultation with no active doctor on file', async () => {
        mockAuthService.getUser.mockReturnValue({ role: 'admin', id: 99 });
        mockDataService.invoke.mockImplementation((endpoint: string) => {
            if (endpoint === 'getDoctors') return Promise.resolve([]);
            return Promise.resolve(null);
        });

        await component.startConsult({ id: 1, patient_id: 11, patient_name: 'P1' });

        expect(mockDialogService.open).toHaveBeenCalledWith(expect.objectContaining({
            title: 'No responsible doctor',
            type: 'warning'
        }));
        expect(mockDataService.invoke).not.toHaveBeenCalledWith('beginConsultation', expect.anything());
    });

    it('computes wait time string accurately', () => {
        expect(component.getWaitTime('')).toBe('');
        expect(component.getWaitTime('invalid-date')).toBe('');

        // Future date (clock skew) returns 0m
        const future = new Date(Date.now() + 60000).toISOString();
        expect(component.getWaitTime(future)).toBe('0m');

        // 15 minutes ago
        const past15m = new Date(Date.now() - 15 * 60000).toISOString();
        expect(component.getWaitTime(past15m)).toBe('15m');

        // 2 hours 10 minutes ago
        const past2h = new Date(Date.now() - (130 * 60000)).toISOString();
        expect(component.getWaitTime(past2h)).toBe('2h 10m');
    });

    it('cleans up timers on destroy', () => {
        component.refreshIntervalId = 12345;
        const clearSpy = vi.spyOn(globalThis, 'clearInterval');
        component.ngOnDestroy();
        expect(clearSpy).toHaveBeenCalledWith(12345);
    });

    it('defines the standard grid columns', () => {
        const headers = component.queueColumnDefs.map((c: any) => c.headerName);
        expect(headers).toEqual(['Urgency / Triage', 'Patient Details', 'Check-in Time', 'Status', 'Actions']);
    });

    it('renders urgency badges from the same triage levels', () => {
        const urgencyCol: any = component.queueColumnDefs[0];
        const immediate = urgencyCol.cellRenderer({ data: { urgency: 'immediate' }, value: 'immediate' });
        expect(immediate).toContain('badge-error');
        const routine = urgencyCol.cellRenderer({ data: { urgency: 'routine' }, value: 'routine' });
        expect(routine).toContain('badge-ghost');
    });

    it('dispatches the primary consult action and opens the overflow menu', async () => {
        const actionsCol: any = component.queueColumnDefs[4];
        const item = { id: 1, patient_id: 11, status: 'waiting' };
        const consultSpy = vi.spyOn(component, 'startConsult').mockResolvedValue(undefined);
        const menuSpy = vi.spyOn(component, 'openRowMenu').mockImplementation(() => undefined);
        const click = (action: string) => actionsCol.onCellClicked({
            data: item,
            event: { target: { closest: () => ({ getAttribute: () => action }) } }
        });

        click('consult');
        expect(consultSpy).toHaveBeenCalledWith(item);
        click('menu');
        expect(menuSpy).toHaveBeenCalledWith(item, expect.anything());
    });

    it('routes overflow menu choices to the queue workflows', async () => {
        const item = { id: 1, patient_id: 11, status: 'waiting' };
        const triageSpy = vi.spyOn(component, 'openTriageModal').mockImplementation(() => Promise.resolve() as any);
        const vitalsSpy = vi.spyOn(component, 'openVitals').mockImplementation(() => undefined);
        const removeSpy = vi.spyOn(component, 'remove').mockResolvedValue(undefined);

        component.rowMenu = { item, x: 0, y: 0 };
        component.menuAction('triage');
        expect(triageSpy).toHaveBeenCalledWith(item);
        expect(component.rowMenu).toBeNull();

        component.rowMenu = { item, x: 0, y: 0 };
        component.menuAction('vitals');
        expect(vitalsSpy).toHaveBeenCalledWith(item);

        component.rowMenu = { item, x: 0, y: 0 };
        await component.menuAction('remove');
        expect(removeSpy).toHaveBeenCalledWith(1);
    });

    it('closes the overflow menu on Escape', () => {
        component.rowMenu = { item: { id: 1 }, x: 0, y: 0 };
        component.onDocumentKeydown({ key: 'Escape' } as any);
        expect(component.rowMenu).toBeNull();
    });

    it('hides queue removal from nurses without the grant', () => {
        const nurse = new QueueComponent(mockRouter, mockDataService, mockDialogService,
            { getUser: () => ({ role: 'nurse' }) } as any);
        expect(nurse.canRemoveFromQueue()).toBe(false);
        const receptionist = new QueueComponent(mockRouter, mockDataService, mockDialogService,
            { getUser: () => ({ role: 'receptionist' }) } as any);
        expect(receptionist.canRemoveFromQueue()).toBe(true);
        expect(component.canRemoveFromQueue()).toBe(true);
    });

    it('summarises waiting and in-consult counts for the header', () => {
        component.queue.set([
            { status: 'waiting' }, { status: 'waiting' }, { status: 'in-consult' }, { status: 'completed' }
        ] as any);
        expect(component.waitingCount()).toBe(2);
        expect(component.inConsultCount()).toBe(1);
    });

    it('filters the queue client-side across identity and triage fields', () => {
        component.queue.set([
            { patient_name: 'Ramesh Gupta', mobile: '9810012345', urgency: 'urgent', status: 'waiting', triage_notes: 'BP review' },
            { patient_name: 'Arjun Karthik', mobile: '9655011122', urgency: 'immediate', status: 'waiting', triage_notes: 'Fever' }
        ] as any);
        expect(component.visibleQueue()).toHaveLength(2);
        component.searchTerm = 'ramesh';
        expect(component.visibleQueue()).toHaveLength(1);
        component.searchTerm = '9655';
        expect(component.visibleQueue()).toHaveLength(1);
        component.searchTerm = 'fever';
        expect(component.visibleQueue()).toHaveLength(1);
        component.searchTerm = 'no-match-xyz';
        expect(component.visibleQueue()).toHaveLength(0);
    });

    it('persists the narrow-viewport view override', () => {
        component.setMobileView('grid');
        expect(component.mobileView).toBe('grid');
        const fresh = new QueueComponent(mockRouter, mockDataService, mockDialogService, mockAuthService);
        fresh.ngOnInit();
        expect(fresh.mobileView).toBe('grid');
        fresh.setMobileView('cards');
        expect(fresh.mobileView).toBe('cards');
    });

    it('shows resume wording plus overflow for live consultations in the actions cell', () => {
        const actionsCol: any = component.queueColumnDefs[4];
        const html = actionsCol.cellRenderer({ data: { id: 2, status: 'in-consult', active_encounter_id: 9 } });
        expect(html).toContain('Resume Consult');
        expect(html).toContain('data-action="menu"');
        expect(html).not.toContain('data-action="triage"');
        expect(html).not.toContain('data-action="vitals"');
        expect(html).not.toContain('data-action="remove"');
    });

    it('ranks urgency clinically rather than lexically', () => {
        const urgencyCol: any = component.queueColumnDefs[0];
        const levels = ['routine', 'urgent', 'immediate', 'priority'];
        expect([...levels].sort((a, b) => urgencyCol.comparator(a, b)))
            .toEqual(['routine', 'priority', 'urgent', 'immediate']);
    });

    it('exposes patient names for grid sort and filter', () => {
        const patientCol: any = component.queueColumnDefs[1];
        expect(patientCol.field).toBe('patient_name');
    });
});
