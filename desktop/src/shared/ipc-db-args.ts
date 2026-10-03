/**
 * Maps renderer IPC payloads onto DatabaseService arguments.
 * Electron handlers (`main.ts`) and the HTTP `/api/ipc` wrapper must stay in lockstep.
 *
 * Renderer `DataService.invoke(method, ...args)` sends `args` as an array. Queue
 * commands pass a single object (or an id); DatabaseService expects unpacked
 * scalars plus the authenticated user id.
 */

function payloadObject(value: unknown): Record<string, unknown> {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        return value as Record<string, unknown>;
    }
    return {};
}

const ENCOUNTER_METHODS = new Set([
    'beginConsultation',
    'getActiveConsultation',
    'saveConsultationProgress',
    'completeConsultation',
    'postponeConsultation',
    'resumeConsultation',
    'beginNextConsultation'
]);

export function resolveDbMethodArgs(method: string, args: unknown[], actingUserId: number): unknown[] {
    switch (method) {
        case 'addToQueue': {
            const payload = payloadObject(args[0]);
            if (payload['urgency'] != null || payload['triage_notes'] != null || payload['notes'] != null) {
                // Pass the object through so addToQueue derives a matching
                // numeric priority from an urgency-only request.
                return [payload['patientId'], { priority: payload['priority'], urgency: payload['urgency'], triage_notes: payload['triage_notes'] ?? payload['notes'] }, actingUserId];
            }
            return [payload['patientId'], payload['priority'], actingUserId];
        }
        case 'reassessQueueTriage': {
            const payload = payloadObject(args[0]);
            return [payload['queueId'] ?? args[0], payload['urgency'] ?? args[1], payload['reason'] ?? args[2], actingUserId];
        }
        case 'saveAllergy':
        case 'saveCondition':
        case 'saveMedication':
            return [args[0], actingUserId];
        case 'deleteAllergy':
        case 'deleteCondition':
        case 'deleteMedication': {
            // Scalar id (legacy callers) or { id, reason } (reason dialogs).
            const payload = payloadObject(args[0]);
            const hasShape = payload['id'] != null || payload['reason'] != null;
            return hasShape
                ? [payload['id'] ?? args[0], actingUserId, String(payload['reason'] || '')]
                : [args[0], actingUserId, ''];
        }
        case 'updateQueueStatus': {
            const payload = payloadObject(args[0]);
            return [payload['id'], payload['status'], actingUserId];
        }
        case 'updateQueueStatusByPatientId': {
            const payload = payloadObject(args[0]);
            return [payload['patientId'], payload['status'], actingUserId];
        }
        case 'removeFromQueue': {
            const payload = payloadObject(args[0]);
            const hasShape = payload['id'] != null || payload['reason'] != null;
            return hasShape
                ? [payload['id'] ?? args[0], actingUserId, String(payload['reason'] || '')]
                : [args[0], actingUserId, ''];
        }
        case 'abdmAcceptShareToken': {
            const payload = payloadObject(args[0]);
            return [payload, actingUserId];
        }
        case 'abdmAcceptShareTokenAndCheckIn': {
            const payload = payloadObject(args[0]);
            return [payload['tokenId'] ?? payload['id'], actingUserId];
        }
        case 'abdmAckInbox': {
            const payload = payloadObject(args[0]);
            return [payload['id'], actingUserId];
        }
        case 'saveVitals':
            return [args[0], actingUserId];
        case 'saveRole': {
            const payload = payloadObject(args[0]);
            return [payload['name'], payload['permissions'], actingUserId];
        }
        case 'deleteRole': {
            const payload = payloadObject(args[0]);
            return [payload['name'] ?? args[0], actingUserId];
        }
        case 'saveUserOverride': {
            return [payloadObject(args[0]), actingUserId];
        }
        case 'deleteUserOverride': {
            const payload = payloadObject(args[0]);
            return [Number(payload['userId'] ?? args[0]), String(payload['action'] ?? args[1] ?? ''), actingUserId];
        }
        case 'getUserOverrides': {
            const payload = payloadObject(args[0]);
            return [Number(payload['userId'] ?? args[0])];
        }
        case 'seedDemoData':
        case 'clearDemoData':
            return [actingUserId];
        case 'previewPatientMerge': {
            return [payloadObject(args[0])];
        }
        case 'mergePatients': {
            return [payloadObject(args[0]), actingUserId];
        }
        case 'unmergePatients': {
            const payload = payloadObject(args[0]);
            return [Number(payload['duplicateId'] ?? args[0]), actingUserId];
        }
        case 'getInvoice': {
            return [Number(payloadObject(args[0])['invoiceId'] ?? args[0])];
        }
        case 'getVisitInvoices': {
            return [Number(payloadObject(args[0])['visitId'] ?? args[0])];
        }
        case 'createInvoice':
        case 'recordPayment':
        case 'refundPayment': {
            return [payloadObject(args[0]), actingUserId];
        }
        case 'voidInvoice': {
            const payload = payloadObject(args[0]);
            return [Number(payload['invoiceId'] ?? payload['id'] ?? args[0]), String(payload['reason'] ?? args[1] ?? ''), actingUserId];
        }
        case 'getDailyClose': {
            const payload = payloadObject(args[0]);
            return [String(payload['date'] ?? args[0] ?? '')];
        }
        case 'archivePatient': {
            const payload = payloadObject(args[0]);
            return [payload['id'] ?? args[0], String(payload['reason'] || ''), actingUserId];
        }
        case 'unarchivePatient':
        case 'purgeUser': {
            return [Number(payloadObject(args[0])['id'] ?? args[0]), actingUserId];
        }
        case 'markVisitEnteredInError': {
            const payload = payloadObject(args[0]);
            return [Number(payload['id'] ?? payload['visitId'] ?? args[0]), String(payload['reason'] || ''), actingUserId];
        }
        default:
            if (ENCOUNTER_METHODS.has(method)) {
                return [...args, actingUserId];
            }
            return args;
    }
}

export function invokeDbMethod(
    db: object,
    method: string,
    args: unknown[],
    actingUserId: number
): unknown {
    const fn = (db as Record<string, unknown>)[method];
    if (typeof fn !== 'function') {
        throw new Error(`Method not implemented: ${method}`);
    }
    return (fn as (...fnArgs: unknown[]) => unknown).apply(db, resolveDbMethodArgs(method, args, actingUserId));
}
