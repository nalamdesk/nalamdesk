// Request context for the audit trail (#193): the API server runs each call
// inside this context so audit rows name the computer as well as the user,
// without threading a device id through every DatabaseService method.

import { AsyncLocalStorage } from 'node:async_hooks';

export interface AuditContext {
    deviceId: string | null;
}

export const auditContext = new AsyncLocalStorage<AuditContext>();

export function currentAuditDeviceId(): string | null {
    return auditContext.getStore()?.deviceId ?? null;
}
