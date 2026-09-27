import { describe, it, expect } from 'vitest';
import { AccessPolicy } from './AccessPolicy';

function sourceWith(overrides: Array<{ user_id: number; action: string; effect: string }> = []) {
    return {
        getRoles: () => [
            { name: 'nurse', permissions: ['getQueue', 'saveVitals'] },
            { name: 'receptionist', permissions: ['getQueue', 'addToQueue'] },
            { name: 'doctor', permissions: ['getQueue', 'deleteAllergy'] },
            { name: 'admin', permissions: [] }
        ],
        getAllOverrides: () => overrides
    };
}

describe('AccessPolicy (role baseline + user deltas)', () => {
    it('denies by default and permits role grants', () => {
        const policy = new AccessPolicy(sourceWith());
        expect(policy.isAuthorized({
            user: { id: 5, role: 'nurse' }, action: 'updateQueueStatus'
        }).allow).toBe(false);
        const allowed = policy.isAuthorized({
            user: { id: 5, role: 'nurse' }, action: 'saveVitals'
        });
        expect(allowed.allow).toBe(true);
        expect(allowed.reasons.length).toBeGreaterThan(0);
    });

    it('grants one nurse queue management by override without touching the role', () => {
        const policy = new AccessPolicy(sourceWith([
            { user_id: 5, action: 'updateQueueStatus', effect: 'allow' }
        ]));
        expect(policy.isAuthorized({
            user: { id: 5, role: 'nurse' }, action: 'updateQueueStatus'
        }).allow).toBe(true);
        // Another nurse with the same role stays denied.
        expect(policy.isAuthorized({
            user: { id: 6, role: 'nurse' }, action: 'updateQueueStatus'
        }).allow).toBe(false);
    });

    it('lets forbid strip a single grant from a role holder', () => {
        const policy = new AccessPolicy(sourceWith([
            { user_id: 3, action: 'deleteAllergy', effect: 'forbid' }
        ]));
        expect(policy.isAuthorized({
            user: { id: 3, role: 'doctor' }, action: 'deleteAllergy'
        }).allow).toBe(false);
        expect(policy.isAuthorized({
            user: { id: 4, role: 'doctor' }, action: 'deleteAllergy'
        }).allow).toBe(true);
    });

    it('fails closed when the policy source is broken', () => {
        const policy = new AccessPolicy({
            getRoles: () => { throw new Error('db locked'); },
            getAllOverrides: () => []
        });
        expect(policy.isAuthorized({
            user: { id: 1, role: 'admin' }, action: 'getQueue'
        })).toEqual({ allow: false, reasons: ['policy-unavailable'] });
    });

    it('rebuilds after override mutations', () => {
        const overrides: Array<{ user_id: number; action: string; effect: string }> = [];
        const policy = new AccessPolicy(sourceWith(overrides));
        const req = { user: { id: 5, role: 'nurse' }, action: 'updateQueueStatus' };
        expect(policy.isAuthorized(req).allow).toBe(false);
        overrides.push({ user_id: 5, action: 'updateQueueStatus', effect: 'allow' });
        policy.rebuild();
        expect(policy.isAuthorized(req).allow).toBe(true);
    });
});
