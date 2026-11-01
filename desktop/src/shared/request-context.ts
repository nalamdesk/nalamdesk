import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Who is acting and in which facility (#195). Every data call runs inside
 * one, so facility-scoped reads and writes never take a facility from
 * method arguments. Node-only: main process and server.
 */
export interface RequestContext {
    userId: number;
    facilityId: number;
}

export const DEFAULT_FACILITY_ID = 1;

const storage = new AsyncLocalStorage<RequestContext>();
let fallbackFacility: () => number | null | undefined = () => DEFAULT_FACILITY_ID;

function validFacility(value: unknown): number | null {
    const id = Number(value);
    return Number.isInteger(id) && id > 0 ? id : null;
}

/** Runs `operation` with `context` as the active request context. */
export function runWithContext<T>(context: RequestContext, operation: () => T): T {
    const facilityId = validFacility(context.facilityId) ?? DEFAULT_FACILITY_ID;
    return storage.run({ userId: Number(context.userId), facilityId }, operation);
}

/**
 * Where calls outside any request run: the desktop session's facility in
 * single-PC mode, facility 1 otherwise.
 */
export function setFallbackFacility(resolver: () => number | null | undefined): void {
    fallbackFacility = resolver;
}

export function currentContext(): RequestContext | undefined {
    return storage.getStore();
}

export function currentFacilityId(): number {
    return validFacility(storage.getStore()?.facilityId)
        ?? validFacility(fallbackFacility())
        ?? DEFAULT_FACILITY_ID;
}
