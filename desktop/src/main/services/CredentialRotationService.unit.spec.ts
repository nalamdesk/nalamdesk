import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as argon2 from 'argon2';
import { CredentialRotationService } from './CredentialRotationService';

/** Minimal in-memory stand-in for the users/journal/audit surface. */
function makeDb() {
    const state = {
        users: new Map<number, any>(),
        journal: null as any,
        audits: [] as any[],
    };
    const byId = (id: number) => ({ ...state.users.get(Number(id)) });
    const byUsername = (name: string) => {
        const found = [...state.users.values()].find((u) => u.username === name);
        return found ? { ...found } : undefined;
    };
    const db = {
        prepare: (sql: string) => {
            if (sql.includes('FROM users WHERE id')) return { get: byId };
            if (sql.includes('FROM users WHERE username')) return { get: byUsername };
            if (sql.includes('DELETE FROM credential_rotation_journal')) {
                return { run: () => { state.journal = null; } };
            }
            if (sql.includes('UPDATE credential_rotation_journal SET phase')) {
                return { run: () => { state.journal.phase = 'applied'; } };
            }
            if (sql.includes('FROM credential_rotation_journal')) return { get: () => state.journal };
            if (sql.includes('INSERT INTO credential_rotation_journal')) {
                return {
                    run: (username: string, prevHash: string, replHash: string, prevReset: number) => {
                        state.journal = {
                            username, previous_hash: prevHash, replacement_hash: replHash,
                            previous_reset_required: prevReset, phase: 'prepared'
                        };
                    }
                };
            }
            if (sql.includes('UPDATE users SET password')) {
                return {
                    run: (...args: any[]) => {
                        if (args.length === 4) {
                            const [next, flag, id, old] = args;
                            const u = state.users.get(Number(id));
                            if (!u || u.password !== old || u.active !== 1) return { changes: 0 };
                            u.password = next;
                            u.password_reset_required = flag;
                            return { changes: 1 };
                        }
                        const [prev, flag, name] = args;
                        const u = [...state.users.values()].find((x) => x.username === name);
                        if (u) {
                            u.password = prev;
                            u.password_reset_required = flag;
                        }
                        return { changes: 1 };
                    }
                };
            }
            if (sql.includes('INSERT INTO audit_logs')) {
                return { run: (action: string, _t: string, record: number, user: number, details: string) => {
                    state.audits.push({ action, record, user, details });
                } };
            }
            throw new Error(`unexpected SQL in fake: ${sql.slice(0, 60)}`);
        },
        transaction: (fn: () => void) => () => fn()
    };
    return { db, state };
}

describe('CredentialRotationService (unit)', () => {
    let db: any;
    let state: any;
    let steps: string[];
    let service: CredentialRotationService;

    beforeEach(async () => {
        ({ db, state } = makeDb());
        state.users.set(1, {
            id: 1, username: 'admin', password: await argon2.hash('admin-current'),
            role: 'admin', active: 1, password_reset_required: 0
        });
        state.users.set(2, {
            id: 2, username: 'doctor', password: await argon2.hash('doctor-current'),
            role: 'doctor', active: 1, password_reset_required: 0
        });
        steps = [];
        service = new CredentialRotationService({ onStep: (s) => steps.push(s) });
        service.setDb(db);
    });

    it('changes an own password and clears the reset flag', async () => {
        await service.changeOwnPassword(1, 'admin-current', 'admin-brand-new');
        const admin = state.users.get(1);
        expect(await argon2.verify(admin.password, 'admin-brand-new')).toBe(true);
        expect(admin.password_reset_required).toBe(0);
        expect(state.journal).toBeNull();
        expect(state.audits.at(-1)).toMatchObject({ action: 'LOGIN_PASSWORD_CHANGE' });
        expect(steps).toEqual(['after-hash', 'after-prepare', 'after-apply', 'after-complete']);
    });

    it('rejects wrong current, unchanged, and short passwords', async () => {
        await expect(service.changeOwnPassword(1, 'wrong', 'admin-brand-new')).rejects.toThrow('INVALID_CREDENTIALS');
        await expect(service.changeOwnPassword(1, 'admin-current', 'admin-current')).rejects.toThrow('PASSWORD_UNCHANGED');
        await expect(service.changeOwnPassword(1, 'admin-current', 'short')).rejects.toThrow('PASSWORD_TOO_SHORT');
        expect(state.journal).toBeNull();
    });

    it('refuses unknown, inactive, and locked-vault actors', async () => {
        await expect(service.changeOwnPassword(99, 'x', 'new-password')).rejects.toThrow('ACCESS_DENIED');
        state.users.get(2).active = 0;
        await expect(service.changeOwnPassword(2, 'doctor-current', 'doctor-new12')).rejects.toThrow('ACCESS_DENIED');

        const locked = new CredentialRotationService();
        await expect(locked.changeOwnPassword(1, 'a', 'b-new123')).rejects.toThrow('VAULT_LOCKED');
        expect(() => locked.reconcileInterruptedRotation()).toThrow('VAULT_LOCKED');
    });

    it('resets staff passwords as admin with a forced-reset flag', async () => {
        await service.resetUserPassword(1, 'admin-current', 2, 'temp-pass-1');
        const doctor = state.users.get(2);
        expect(await argon2.verify(doctor.password, 'temp-pass-1')).toBe(true);
        expect(doctor.password_reset_required).toBe(1);
        expect(state.audits.at(-1)).toMatchObject({ action: 'USER_PASSWORD_RESET' });
    });

    it('guards the staff-reset workflow', async () => {
        await expect(service.resetUserPassword(2, 'doctor-current', 1, 'temp-pass-1')).rejects.toThrow('FORBIDDEN');
        await expect(service.resetUserPassword(1, 'admin-current', 1, 'temp-pass-1')).rejects.toThrow('USE_SELF_PASSWORD_CHANGE');
        await expect(service.resetUserPassword(1, 'wrong-admin', 2, 'temp-pass-1')).rejects.toThrow('INVALID_CREDENTIALS');
    });

    it('detects a concurrently changed authorizer mid-rotation', async () => {
        const rotated = await argon2.hash('admin-rotated-elsewhere');
        const racing = new CredentialRotationService({
            onStep: (s) => {
                if (s === 'after-hash') state.users.get(1).password = rotated;
            }
        });
        racing.setDb(db);
        await expect(racing.resetUserPassword(1, 'admin-current', 2, 'temp-pass-1'))
            .rejects.toThrow('CREDENTIAL_CHANGED_CONCURRENTLY');
    });

    it('reconciles a prepared journal without touching the credential', () => {
        state.journal = {
            username: 'doctor', previous_hash: 'prev', replacement_hash: 'repl',
            previous_reset_required: 1, phase: 'prepared'
        };
        const before = state.users.get(2).password;
        service.reconcileInterruptedRotation();
        expect(state.journal).toBeNull();
        expect(state.users.get(2).password).toBe(before);
    });

    it('rolls an applied journal back to the previous credential', () => {
        state.journal = {
            username: 'doctor', previous_hash: 'prev-hash', replacement_hash: 'repl-hash',
            previous_reset_required: 1, phase: 'applied'
        };
        state.users.get(2).password = 'repl-hash';
        service.reconcileInterruptedRotation();
        expect(state.users.get(2).password).toBe('prev-hash');
        expect(state.users.get(2).password_reset_required).toBe(1);
        expect(state.journal).toBeNull();
    });

    it('rejects corrupt journals explicitly', () => {
        state.journal = {
            username: 'ghost', previous_hash: 'p', replacement_hash: 'r',
            previous_reset_required: 0, phase: 'prepared'
        };
        expect(() => service.reconcileInterruptedRotation()).toThrow('CREDENTIAL_JOURNAL_USER_MISSING');

        state.journal = {
            username: 'doctor', previous_hash: 'p', replacement_hash: 'r',
            previous_reset_required: 0, phase: 'applied'
        };
        state.users.get(2).password = 'something-else';
        expect(() => service.reconcileInterruptedRotation()).toThrow('CREDENTIAL_JOURNAL_STATE_MISMATCH');

        state.journal = {
            username: 'doctor', previous_hash: 'p', replacement_hash: 'r',
            previous_reset_required: 0, phase: 'weird'
        };
        expect(() => service.reconcileInterruptedRotation()).toThrow('CREDENTIAL_JOURNAL_CORRUPT');
    });

    it('cleans the journal when the apply update loses its race', async () => {
        // Simulate a concurrent change between the journal write and apply.
        const realTransaction = db.transaction;
        db.transaction = (fn: () => void) => () => {
            state.users.get(1).password = 'changed-concurrently';
            return fn();
        };
        await expect(service.changeOwnPassword(1, 'admin-current', 'admin-brand-new'))
            .rejects.toThrow('CREDENTIAL_CHANGED_CONCURRENTLY');
        expect(state.journal).toBeNull();
        db.transaction = realTransaction;
    });

    it('does nothing to reconcile without a journal', () => {
        expect(() => service.reconcileInterruptedRotation()).not.toThrow();
    });
});
