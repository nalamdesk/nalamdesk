import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseService } from '../services/DatabaseService';
import { TestDatabase } from '../testing/TestDatabase';

describe('migration safety', () => {
    let dir: string;
    let file: string;
    const open: TestDatabase[] = [];

    const connect = () => {
        const db = new TestDatabase(file);
        open.push(db);
        const service = new DatabaseService();
        service.setDb(db);
        return { db, service };
    };

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-migrate-'));
        file = path.join(dir, 'vault.db');
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => {
        for (const db of open.splice(0)) db.close();
        fs.rmSync(dir, { recursive: true, force: true });
        vi.restoreAllMocks();
    });

    /** A database left at `version` with data in it, as an older build wrote it. */
    const olderDatabase = (version: number) => {
        const { db } = connect();
        db.exec('CREATE TABLE legacy_notes (clinic_name TEXT)');
        db.prepare('INSERT INTO legacy_notes (clinic_name) VALUES (?)').run('Old Clinic');
        db.pragma(`user_version = ${version}`);
        return db;
    };

    it('refuses a database migrated by a newer build, without touching it', async () => {
        const latest = DatabaseService.latestSchemaVersion();
        const { db, service } = connect();
        db.exec('CREATE TABLE future_only (id INTEGER)');
        db.pragma(`user_version = ${latest + 1}`);

        await expect(service.migrate()).rejects.toThrow(/^SCHEMA_TOO_NEW:/);
        expect(db.pragma('user_version', { simple: true })).toBe(latest + 1);
        expect(fs.existsSync(`${file}.bak`)).toBe(false);
    });

    it('backs up before migrating and keeps the previous backup', async () => {
        fs.writeFileSync(`${file}.bak`, 'previous snapshot');
        olderDatabase(0);
        const { service } = connect();

        await service.migrate();

        expect(fs.readFileSync(`${file}.bak.prev`, 'utf8')).toBe('previous snapshot');
        const snapshot = new TestDatabase(`${file}.bak`);
        open.push(snapshot);
        expect(snapshot.pragma('user_version', { simple: true })).toBe(0);
        expect((snapshot.prepare('SELECT clinic_name FROM legacy_notes').get() as any).clinic_name).toBe('Old Clinic');
        expect(fs.existsSync(`${file}.bak.tmp`)).toBe(false);
    });

    it('does not back up when the schema is already current', async () => {
        const { service } = connect();
        await service.migrate({ skipBackup: true });
        fs.rmSync(`${file}.bak`, { force: true });

        await service.migrate();

        expect(fs.existsSync(`${file}.bak`)).toBe(false);
    });

    it('does not migrate when the backup fails, and keeps the earlier backup', async () => {
        fs.writeFileSync(`${file}.bak`, 'previous snapshot');
        olderDatabase(0);
        const { db, service } = connect();
        // The snapshot fails, and the test database has no backup API to fall back on.
        const prepare = db.prepare.bind(db);
        vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
            if (sql.startsWith('VACUUM INTO')) throw new Error('disk full');
            return prepare(sql);
        });

        await expect(service.migrate()).rejects.toThrow(/^MIGRATION_BACKUP_FAILED:.*disk full/);
        expect(db.pragma('user_version', { simple: true })).toBe(0);
        expect(fs.readFileSync(`${file}.bak`, 'utf8')).toBe('previous snapshot');
        expect(fs.existsSync(`${file}.bak.tmp`)).toBe(false);
    });

    it('skips the backup for a brand new, empty database', async () => {
        const { db, service } = connect();
        await service.migrate();
        expect(db.pragma('user_version', { simple: true })).toBe(DatabaseService.latestSchemaVersion());
        expect(fs.existsSync(`${file}.bak`)).toBe(false);
    });
});
