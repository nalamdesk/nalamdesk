import { describe, it, expect } from 'vitest';
import { AccessPolicy } from './AccessPolicy';
import { DatabaseService } from './DatabaseService';

const { DatabaseSync } = require('node:sqlite');

class MatrixDatabase {
    private readonly sqlite = new DatabaseSync(':memory:');
    readonly name = ':memory:';
    exec(sql: string) { return this.sqlite.exec(sql); }
    prepare(sql: string) { return this.sqlite.prepare(sql); }
    close() { return this.sqlite.close(); }
    pragma(sql: string, options?: { simple?: boolean }) {
        const assignment = sql.match(/^user_version\s*=\s*(\d+)$/);
        if (assignment) {
            this.sqlite.exec(`PRAGMA user_version = ${assignment[1]}`);
            return;
        }
        const row = this.sqlite.prepare(`PRAGMA ${sql}`).get() as any;
        return options?.simple ? row?.user_version : row;
    }
    transaction<T extends (...args: any[]) => any>(operation: T): T & { immediate: T } {
        const run = ((...args: any[]) => {
            this.sqlite.exec('BEGIN IMMEDIATE');
            try {
                const value = operation(...args);
                this.sqlite.exec('COMMIT');
                return value;
            } catch (error) {
                this.sqlite.exec('ROLLBACK');
                throw error;
            }
        }) as T & { immediate: T };
        run.immediate = run;
        return run;
    }
}

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

    it('matches the migrated roles table on representative desk flows', async () => {
        const db: any = new MatrixDatabase();
        const service = new DatabaseService();
        service.setDb(db);
        await service.migrate();
        const policy = new AccessPolicy({
            getRoles: () => service.getAllRoles(),
            getAllOverrides: () => service.getAllOverrides()
        });
        const check = (role: string, action: string) =>
            policy.isAuthorized({ user: { id: 7, role }, action }).allow;
        // Desk flows that must keep working.
        expect(check('receptionist', 'addToQueue')).toBe(true);
        expect(check('receptionist', 'saveVitals')).toBe(true);
        expect(check('receptionist', 'getDashboardStats')).toBe(true);
        expect(check('receptionist', 'saveAppointment')).toBe(true);
        expect(check('nurse', 'saveVitals')).toBe(true);
        expect(check('nurse', 'getVisits')).toBe(true);
        expect(check('doctor', 'saveAllergy')).toBe(true);
        expect(check('doctor', 'beginConsultation')).toBe(true);
        // Destructive and secret methods stay denied off-admin.
        expect(check('receptionist', 'deletePatient')).toBe(false);
        expect(check('nurse', 'removeFromQueue')).toBe(false);
        expect(check('doctor', 'deleteVisit')).toBe(false);
        expect(check('doctor', 'getSettings')).toBe(false);
        expect(check('receptionist', 'getAuditLogs')).toBe(false);
        expect(check('doctor', 'noSuchMethod')).toBe(false);
    });
});
