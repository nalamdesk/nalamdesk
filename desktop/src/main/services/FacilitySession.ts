import { DEFAULT_FACILITY_ID } from '../../shared/request-context';

/** A facility a user can work in, with their role there (#195). */
export interface FacilityGrant {
    id: number;
    code: string;
    name: string;
    kind: string;
    role: string;
}

/**
 * Picks the facility a sign-in starts in: the one asked for when the user
 * holds a role there, otherwise facility 1 when granted, otherwise their
 * first facility. Null when the user has no facility, or asked for one they
 * cannot use.
 */
export function chooseFacility(grants: FacilityGrant[], requested?: unknown): FacilityGrant | null {
    if (grants.length === 0) return null;
    if (requested !== undefined && requested !== null && requested !== '') {
        return grants.find(grant => grant.id === Number(requested)) ?? null;
    }
    return grants.find(grant => grant.id === DEFAULT_FACILITY_ID) ?? grants[0];
}
