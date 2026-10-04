import { describe, it, expect } from 'vitest';
import { resolveDbMethodArgs } from './ipc-db-args';

describe('resolveDbMethodArgs addToQueue', () => {
    it('passes urgency-only requests through so priority derives from urgency', () => {
        const args = resolveDbMethodArgs('addToQueue', [{ patientId: 5, urgency: 'immediate' }], 99);
        expect(args[0]).toBe(5);
        expect(args[1]).toEqual(expect.objectContaining({ urgency: 'immediate' }));
        expect(args[2]).toBe(99);
    });

    it('preserves explicit numeric priority alongside urgency', () => {
        const args = resolveDbMethodArgs(
            'addToQueue',
            [{ patientId: 5, priority: 2, urgency: 'priority', triage_notes: 'Chest pain' }],
            99
        );
        expect(args[1]).toEqual(expect.objectContaining({
            priority: 2,
            urgency: 'priority',
            triage_notes: 'Chest pain'
        }));
    });

    it('keeps the scalar fast path for plain check-ins', () => {
        expect(resolveDbMethodArgs('addToQueue', [{ patientId: 5, priority: 1 }], 99))
            .toEqual([5, 1, 99]);
    });

    it('unpacks share-token acknowledgement with the acting user', () => {
        expect(resolveDbMethodArgs('abdmAcceptShareToken', [{ tokenId: 7 }], 99))
            .toEqual([{ tokenId: 7 }, 99]);
    });

    it('unpacks role mutations for both transports', () => {
        expect(resolveDbMethodArgs('saveRole', [{ name: 'Billing-Clerk', permissions: ['getQueue'] }], 99))
            .toEqual(['Billing-Clerk', ['getQueue'], 99]);
        expect(resolveDbMethodArgs('deleteRole', ['billing-clerk'], 99))
            .toEqual(['billing-clerk', 99]);
        expect(resolveDbMethodArgs('deleteRole', [{ name: 'billing-clerk' }], 99))
            .toEqual(['billing-clerk', 99]);
    });

    it('unpacks override mutations for both transports', () => {
        const input = { userId: 20, action: 'updateQueueStatus', effect: 'allow', reason: 'Covers Tuesdays' };
        expect(resolveDbMethodArgs('saveUserOverride', [input], 99))
            .toEqual([input, 99]);
        expect(resolveDbMethodArgs('deleteUserOverride', [{ userId: 20, action: 'updateQueueStatus' }], 99))
            .toEqual([20, 'updateQueueStatus', 99]);
        expect(resolveDbMethodArgs('getUserOverrides', [20], 99))
            .toEqual([20]);
    });

    it('unpacks demo seed mutations for both transports', () => {
        expect(resolveDbMethodArgs('seedDemoData', [], 99)).toEqual([99]);
        expect(resolveDbMethodArgs('clearDemoData', [], 99)).toEqual([99]);
        expect(resolveDbMethodArgs('getDemoSeedState', [], 99)).toEqual([]);
    });

    it('passes duplicate search input through untouched', () => {
        const input = { name: 'Ravi', mobile: '9888877771' };
        expect(resolveDbMethodArgs('findDuplicateCandidates', [input], 99)).toEqual([input]);
    });

    it('unpacks merge workflow calls for both transports', () => {
        const preview = { survivorId: 1, duplicateId: 2 };
        expect(resolveDbMethodArgs('previewPatientMerge', [preview], 99)).toEqual([preview]);
        const merge = { survivorId: 1, duplicateId: 2, reason: 'Dup' };
        expect(resolveDbMethodArgs('mergePatients', [merge], 99)).toEqual([merge, 99]);
        expect(resolveDbMethodArgs('unmergePatients', [{ duplicateId: 2 }], 99)).toEqual([2, 99]);
        expect(resolveDbMethodArgs('unmergePatients', [2], 99)).toEqual([2, 99]);
    });

    it('unpacks billing ledger calls for both transports', () => {
        expect(resolveDbMethodArgs('getInvoice', [7], 99)).toEqual([7]);
        expect(resolveDbMethodArgs('getVisitInvoices', [3], 99)).toEqual([3]);
        const create = { visitId: 3, items: [{ description: 'X-ray', rate: 350 }] };
        expect(resolveDbMethodArgs('createInvoice', [create], 99)).toEqual([create, 99]);
        const pay = { invoiceId: 9, amount: 200, method: 'upi' };
        expect(resolveDbMethodArgs('recordPayment', [pay], 99)).toEqual([pay, 99]);
        const refund = { paymentId: 4, reason: 'Dup' };
        expect(resolveDbMethodArgs('refundPayment', [refund], 99)).toEqual([refund, 99]);
        expect(resolveDbMethodArgs('voidInvoice', [{ invoiceId: 9, reason: 'Cancelled' }], 99))
            .toEqual([9, 'Cancelled', 99]);
    });

    it('unpacks appointment lifecycle calls with the authenticated actor', () => {
        // actorId always comes from the session, never the renderer payload:
        // a forged actorId in input is overwritten, not honored.
        expect(resolveDbMethodArgs('transitionAppointment',
            [{ id: 3, to: 'confirmed', reason: 'called', actorId: 666 }], 99))
            .toEqual([3, 'confirmed', { reason: 'called', actorId: 99, date: undefined, time: undefined }]);
        expect(resolveDbMethodArgs('getAppointmentHistory', [3], 99)).toEqual([3, 99]);
        expect(resolveDbMethodArgs('getAppointmentHistory', [{ id: 3 }], 99)).toEqual([3, 99]);
        expect(resolveDbMethodArgs('detectConflicts', [{ doctorId: 5, date: '2026-10-05', time: '10:00' }], 99))
            .toEqual([{ doctorId: 5, date: '2026-10-05', time: '10:00' }]);
        expect(resolveDbMethodArgs('checkInAppointment', [3], 99)).toEqual([3, 99]);
        expect(resolveDbMethodArgs('fulfillAppointment', [{ id: 3, visitId: 50 }], 99))
            .toEqual([3, 50, 99]);
    });
});
