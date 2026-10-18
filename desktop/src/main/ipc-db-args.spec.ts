import { describe, expect, it, vi } from 'vitest';
import { invokeDbMethod, resolveDbMethodArgs } from '../shared/ipc-db-args';

/**
 * Renderer DataService.invoke() always POSTs/IPC-invokes an args array.
 * Queue writes send a single object (or a bare id) — the same shape on
 * Electron IPC and HTTP /api/ipc.
 */
const rendererQueuePayloads = {
    addToQueue: [{ patientId: 42, priority: 2 }],
    updateQueueStatus: [{ id: 9, status: 'waiting' }],
    updateQueueStatusByPatientId: [{ patientId: 42, status: 'waiting' }],
    removeFromQueue: [9]
} as const;

describe('IPC DatabaseService argument unpacking', () => {
    it('unpacks addToQueue object args and appends the authenticated user id', () => {
        expect(resolveDbMethodArgs('addToQueue', rendererQueuePayloads.addToQueue, 7))
            .toEqual([42, 2, 7]);
    });

    it('unpacks updateQueueStatus object args and appends the authenticated user id', () => {
        expect(resolveDbMethodArgs('updateQueueStatus', rendererQueuePayloads.updateQueueStatus, 7))
            .toEqual([9, 'waiting', 7]);
    });

    it('unpacks updateQueueStatusByPatientId object args and appends the authenticated user id', () => {
        expect(resolveDbMethodArgs('updateQueueStatusByPatientId', rendererQueuePayloads.updateQueueStatusByPatientId, 7))
            .toEqual([42, 'waiting', 7]);
    });

    it('appends the authenticated user id to removeFromQueue', () => {
        expect(resolveDbMethodArgs('removeFromQueue', rendererQueuePayloads.removeFromQueue, 7))
            .toEqual([9, 7, '']);
    });

    it('forwards removeFromQueue reasons when supplied', () => {
        expect(resolveDbMethodArgs('removeFromQueue', [{ id: 9, reason: 'No-show' }], 7))
            .toEqual([9, 7, 'No-show']);
    });

    it('does not bind the renderer object as patient_id / actingUserId', () => {
        const args = resolveDbMethodArgs('addToQueue', rendererQueuePayloads.addToQueue, 7);
        expect(args[0]).toBe(42);
        expect(args[0]).not.toEqual({ patientId: 42, priority: 2 });
        expect(args[2]).toBe(7);
    });

    it('appends user id for encounter commands without unpacking the payload object', () => {
        const input = { patientId: 42, queueEntryId: 9, startRequestId: 'req-1' };
        expect(resolveDbMethodArgs('beginConsultation', [input], 7)).toEqual([input, 7]);
        expect(resolveDbMethodArgs('getActiveConsultation', [42], 7)).toEqual([42, 7]);
        expect(resolveDbMethodArgs('getAppointmentsByPatient', [{ patientId: 42 }], 7)).toEqual([42, 7]);
        expect(resolveDbMethodArgs('getAppointmentsByPatient', [42], 7)).toEqual([42, 7]);
    });

    it('leaves read methods unchanged', () => {
        expect(resolveDbMethodArgs('getQueue', [], 7)).toEqual([]);
        expect(resolveDbMethodArgs('getPatients', [''], 7)).toEqual(['']);
        expect(resolveDbMethodArgs('searchConditions', ['flu'], 7)).toEqual(['flu']);
        expect(resolveDbMethodArgs('createCondition', [{ name: 'URI' }], 7)).toEqual([{ name: 'URI' }]);
        expect(resolveDbMethodArgs('replaceConditionMedPresets', [{ conditionId: 1, lines: [] }], 7))
            .toEqual([{ conditionId: 1, lines: [] }]);
    });

    it('does not bind a non-object payload as patient_id', () => {
        expect(resolveDbMethodArgs('addToQueue', [null], 7)).toEqual([undefined, undefined, 7]);
        expect(resolveDbMethodArgs('addToQueue', ['1'], 7)).toEqual([undefined, undefined, 7]);
    });

    it('throws when the database method is missing', () => {
        expect(() => invokeDbMethod({}, 'addToQueue', [{ patientId: 1, priority: 1 }], 7))
            .toThrow('Method not implemented: addToQueue');
    });

    it('invokes DatabaseService with Electron/HTTP-identical unpacked args', () => {
        const db = {
            addToQueue: vi.fn(),
            updateQueueStatus: vi.fn(),
            updateQueueStatusByPatientId: vi.fn(),
            removeFromQueue: vi.fn()
        };

        invokeDbMethod(db, 'addToQueue', rendererQueuePayloads.addToQueue, 7);
        invokeDbMethod(db, 'updateQueueStatus', rendererQueuePayloads.updateQueueStatus, 7);
        invokeDbMethod(db, 'updateQueueStatusByPatientId', rendererQueuePayloads.updateQueueStatusByPatientId, 7);
        invokeDbMethod(db, 'removeFromQueue', rendererQueuePayloads.removeFromQueue, 7);

        expect(db.addToQueue).toHaveBeenCalledWith(42, 2, 7);
        expect(db.updateQueueStatus).toHaveBeenCalledWith(9, 'waiting', 7);
        expect(db.updateQueueStatusByPatientId).toHaveBeenCalledWith(42, 'waiting', 7);
        expect(db.removeFromQueue).toHaveBeenCalledWith(9, 7, '');
    });
});
