import { describe, expect, it } from 'vitest';
import { AbdmMailboxProcessor } from '../cloud/AbdmMailboxProcessor';
import { MIGRATIONS } from '../schema/migrations';
import { DatabaseService } from './DatabaseService';

const { DatabaseSync } = require('node:sqlite');

/** Minimal better-sqlite3-compatible adapter backed by Node's real SQLite engine. */
class TestDatabase {
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

describe('cloud mailbox ABDM items on a real database', () => {
    it('saves an item once after every migration, beside the older callback queue', async () => {
        const db = new TestDatabase();
        const service = new DatabaseService();
        service.setDb(db);
        await service.migrate();
        const row = { id: 'm1', type: 'abdm-callback' as const, path: '/api/v3/hip/patient/share', request_id: 'r1', received_at: '2026-10-19T00:00:00Z', payload: '{}' };
        service.saveAbdmInboxItem(row);
        service.saveAbdmInboxItem(row);
        expect(db.prepare('SELECT id, type, path, status FROM abdm_mailbox').all())
            .toEqual([{ id: 'm1', type: 'abdm-callback', path: '/api/v3/hip/patient/share', status: 'new' }]);
        // v20's queue keeps working as before.
        service.receiveInboxCallback('consent-notify', { requestId: 'q1' });
        expect(service.getPendingInbox()).toHaveLength(1);
        db.close();
    });

    it('applies a scan from the mailbox once, as a front-desk token', async () => {
        const db = new TestDatabase();
        const service = new DatabaseService();
        service.setDb(db);
        await service.migrate();
        const share = {
            metaData: { context: 'Counter-1' },
            profile: { patient: { name: 'Ramesh Kumar', gender: 'M', abhaAddress: 'ramesh@sbx' } }
        };
        const payload = JSON.stringify({ headers: { 'request-id': 'r1' }, body: JSON.stringify(share) });
        for (const id of ['m1', 'm2']) {
            service.saveAbdmInboxItem({ id, type: 'abdm-callback', path: '/api/v3/hip/patient/share', request_id: 'r1', received_at: null, payload });
        }
        const send = async () => ({ status: 202, body: null });
        const processor = new AbdmMailboxProcessor({
            store: service,
            hiu: { handleNotify: () => undefined, decryptRecord: () => ({}) },
            relay: () => send
        });

        expect(await processor.drain()).toEqual({ processed: 2, failed: 0 });

        expect(service.getPendingShareTokens()).toMatchObject([{ token_no: 1, patient_name: 'Ramesh Kumar', gender: 'Male', abha_address: 'ramesh@sbx' }]);
        expect(db.prepare('SELECT id, status FROM abdm_mailbox ORDER BY id').all())
            .toEqual([{ id: 'm1', status: 'processed' }, { id: 'm2', status: 'processed' }]);
        expect(service.getNewAbdmMailboxItems(10)).toEqual([]);
        db.close();
    });
});

describe('ABDM credentials after the move to the relay', () => {
    it('clears the Client ID, secret, callback password and gateway choice from an existing install', async () => {
        const db = new TestDatabase();
        const service = new DatabaseService();
        service.setDb(db);
        await service.migrate();
        db.prepare(`INSERT INTO settings (clinic_name, abdm_client_id, abdm_client_secret_protected, abdm_callback_secret, abdm_gateway_env, abdm_mock, abdm_hip_id)
            VALUES ('Clinic', 'CID', 'wrapped', 'shared-password-123', 'production', 1, 'H1')`).run();

        MIGRATIONS.find((m) => m.version === 46)!.up(db);
        MIGRATIONS.find((m) => m.version === 47)!.up(db);

        expect(db.prepare(`SELECT clinic_name, abdm_client_id, abdm_client_secret_protected, abdm_callback_secret, abdm_gateway_env, abdm_mock, abdm_hip_id
            FROM settings`).get()).toEqual({
            clinic_name: 'Clinic', abdm_client_id: null, abdm_client_secret_protected: null, abdm_callback_secret: null,
            abdm_gateway_env: null, abdm_mock: null, abdm_hip_id: 'H1'
        });
        // Generic reads and writes no longer carry the old columns either.
        service.saveSettings({ abdm_client_id: 'again', abdm_gateway_env: 'staging' });
        expect(db.prepare('SELECT abdm_client_id, abdm_gateway_env FROM settings').get()).toEqual({ abdm_client_id: null, abdm_gateway_env: null });
        expect(service.getSettings()).not.toHaveProperty('abdm_client_id');
        db.close();
    });
});
