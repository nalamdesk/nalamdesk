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
});
