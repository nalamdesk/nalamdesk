/**
 * Access conformance: every allowlisted LAN method resolves to an explicit
 * allow or deny for every role. Uses a real migrated database so the verdicts
 * reflect shipped grants, not stubs. Any new method or grant Shows up here:
 * unknown roles must deny everywhere, destructive/secret methods must deny
 * off-admin, and admins must never hit the permission gate.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const JWT_SECRET = vi.hoisted(() => {
    const secret = process.env['JWT_SECRET'] || 'ipc-conformance-test-secret';
    process.env['JWT_SECRET'] = secret;
    return secret;
});

import * as jwt from 'jsonwebtoken';
import * as os from 'node:os';
import { ApiServer, ALLOWED_IPC_METHODS } from './app';
import { DatabaseService } from '../main/services/DatabaseService';

const { DatabaseSync } = require('node:sqlite');

class ConformanceDatabase {
    private readonly sqlite = new DatabaseSync(':memory:');
    exec(sql: string) { return this.sqlite.exec(sql); }
    prepare(sql: string) { return this.sqlite.prepare(sql); }
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

const DESTRUCTIVE = [
    'deletePatient', 'deleteVisit', 'deleteUser', 'saveUser',
    'saveSettings', 'deleteUserOverride', 'updateUserPassword',
    'seedDemoData', 'clearDemoData'
];

describe('LAN access conformance', () => {
    let server: ApiServer;

    beforeEach(async () => {
        const raw: any = new ConformanceDatabase();
        const db = new DatabaseService();
        db.setDb(raw);
        await db.migrate();
        (db as any).beginWork = () => undefined;
        (db as any).endWork = () => undefined;
        server = new ApiServer(db, os.tmpdir());
    });

    it('grants desk billing to doctor and receptionist, never nurses', async () => {
        for (const method of ['createInvoice', 'recordPayment', 'refundPayment', 'voidInvoice']) {
            for (const role of ['doctor', 'receptionist']) {
                const response = await postIpc(method, role);
                expect(response.statusCode, `${method}/${role}`).not.toBe(403);
            }
            const denied = await postIpc(method, 'nurse');
            expect(denied.statusCode, `${method}/nurse`).toBe(403);
        }
    }, 120000);

    afterEach(async () => {
        await server.close();
    });

    function postIpc(method: string, role: string, id = 7) {
        const token = jwt.sign({ id, role, username: `${role}-probe` }, JWT_SECRET, { expiresIn: '1h' });
        return server.inject({
            method: 'POST',
            url: `/api/ipc/${method}`,
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            payload: []
        });
    }

    it('never denies admins at the permission gate', async () => {
        for (const method of ALLOWED_IPC_METHODS) {
            const response = await postIpc(method, 'admin');
            // 403 is the gate; anything else (200/400/404/500) passed it.
            expect(response.statusCode, method).not.toBe(403);
        }
    }, 120000);

    it('denies unknown roles everywhere (default deny)', async () => {
        for (const method of ALLOWED_IPC_METHODS) {
            const response = await postIpc(method, 'intruder');
            expect(response.statusCode, method).toBe(403);
        }
    }, 120000);

    it('denies destructive and secret methods off-admin', async () => {
        for (const method of DESTRUCTIVE) {
            expect(ALLOWED_IPC_METHODS).toContain(method);
            for (const role of ['doctor', 'receptionist', 'nurse']) {
                const response = await postIpc(method, role);
                expect(response.statusCode, `${method}/${role}`).toBe(403);
            }
        }
    }, 120000);
});
