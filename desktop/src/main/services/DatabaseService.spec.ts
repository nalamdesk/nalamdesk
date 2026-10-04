import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DatabaseService } from './DatabaseService';

// Mock Argon2
vi.mock('argon2', () => ({
    hash: vi.fn().mockResolvedValue('hashed_password'),
    verify: vi.fn().mockImplementation(async (hash, plain) => hash === 'hashed_password' && plain === 'password')
}));

describe('DatabaseService', () => {
    let service: DatabaseService;
    let mockDb: any;
    let mockStatement: any;

    beforeEach(() => {
        mockStatement = {
            get: vi.fn(),
            all: vi.fn(),
            run: vi.fn().mockReturnValue({ lastInsertRowid: 1, changes: 1 })
        };

        const transaction = vi.fn((fn: any) => {
            console.log('[Test] db.transaction called');
            fn.immediate = fn;
            return fn;
        });
        mockDb = {
            exec: vi.fn((sql) => console.log('[Test] db.exec called:', sql ? sql.substring(0, 50) : 'null')),
            prepare: vi.fn().mockReturnValue(mockStatement),
            pragma: vi.fn(() => { console.log('[Test] db.pragma called'); return 0; }),
            transaction,
            backup: vi.fn(),
            name: ':memory:'
        };

        service = new DatabaseService();
        service.setDb(mockDb);
    });

    describe('migrate', () => {
        it('should execute schema creation queries', async () => {
            await service.migrate();
            // Expect multiple exec calls for tables
            expect(mockDb.exec).toHaveBeenCalled();
            const calls = mockDb.exec.mock.calls.map((c: any) => c[0]);
            expect(calls.some((sql: string) => sql.includes('CREATE TABLE IF NOT EXISTS users'))).toBe(true);
            expect(calls.some((sql: string) => sql.includes('CREATE TABLE IF NOT EXISTS patients'))).toBe(true);
            expect(calls.some((sql: string) => sql.includes('CREATE TABLE IF NOT EXISTS visits'))).toBe(true);
        });

        it('should handle existing column errors gracefully during migration', async () => {
            mockDb.exec.mockImplementationOnce(() => { }).mockImplementationOnce(() => { throw new Error('duplicate column'); });
            expect(async () => await service.migrate()).not.toThrow();
        });

        it('should perform VACUUM INTO backup for file-based databases', async () => {
            mockDb.name = 'test.db'; // Simulate file-based DB
            const fs = require('node:fs');
            vi.spyOn(fs, 'existsSync').mockReturnValue(false); // No existing backup

            await service.migrate();

            expect(mockDb.prepare).toHaveBeenCalledWith('VACUUM INTO ?');
            expect(mockStatement.run).toHaveBeenCalledWith('test.db.bak');
        });

        it('should fallback to .backup() if VACUUM INTO fails', async () => {
            mockDb.name = 'test.db';
            mockDb.prepare.mockImplementation((sql: string) => {
                if (sql.includes('VACUUM INTO')) throw new Error('VACUUM failed');
                return mockStatement;
            });

            await service.migrate();

            expect(mockDb.backup).toHaveBeenCalledWith('test.db.bak');
        });
    });

    describe('User Management', () => {
        it('should save a new user with hashed password', async () => {
            const user = { username: 'test', password: 'password', role: 'admin', name: 'Test User' };

            await service.saveUser(user);

            expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO users'));
            expect(mockStatement.run).toHaveBeenCalledWith(expect.objectContaining({
                password: 'hashed_password',
                active: 1
            }));
        });

        it('should update an existing user', async () => {
            const user = { id: 1, username: 'test', role: 'doctor' };
            // Mock existing user check
            mockStatement.get.mockReturnValue({ id: 1, username: 'test', role: 'admin' });

            await service.saveUser(user);

            expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining('UPDATE users SET'));
            expect(mockStatement.run).toHaveBeenCalled();
        });

        it.each(['admin', 'doctor'])('rejects generic password mutation for an existing %s', async username => {
            mockStatement.get.mockReturnValue({ id: 1, username, role: username === 'admin' ? 'admin' : 'doctor' });
            await expect(service.saveUser({
                id: 1, username, role: username === 'admin' ? 'admin' : 'doctor', name: username,
                password: 'malicious-change'
            })).rejects.toThrow('GENERIC_PASSWORD_CHANGE_FORBIDDEN');
            expect(mockDb.prepare).not.toHaveBeenCalledWith(expect.stringContaining('password = @password'));
        });

        it('does not overwrite an existing admin credential during provisioning retries', async () => {
            mockStatement.get.mockReturnValue({ id: 1 });
            await service.ensureAdminUser('different-password');
            expect(mockStatement.run).not.toHaveBeenCalled();
        });

        it('should validate user credentials correctly', async () => {
            mockStatement.get.mockReturnValue({
                id: 1,
                username: 'test',
                password: 'hashed_password',
                role: 'admin',
                active: 1
            });

            const result = await service.validateUser('test', 'password');
            expect(result.success).toBe(true);
            expect(result.user?.username).toBe('test');
        });

        it('should return failure for invalid password', async () => {
            mockStatement.get.mockReturnValue({
                id: 1, username: 'test', password: 'hashed_password', active: 1
            });

            // Mock verify to return false for wrong password
            const argon2 = await import('argon2');
            vi.mocked(argon2.verify).mockResolvedValueOnce(false);

            const result = await service.validateUser('test', 'wrong_password');
            expect(result.success).toBe(false);
            expect(result.error).toBe('INVALID_CREDENTIALS');
        });

        it('should return failure for inactive user', async () => {
            mockStatement.get.mockReturnValue({
                id: 1, username: 'test', password: 'hashed_password', active: 0
            });

            const result = await service.validateUser('test', 'password');
            expect(result.success).toBe(false);
            expect(result.error).toBe('ACCESS_DENIED');
        });
    });

    describe('Patient Management', () => {
        it('should save a new patient with UUID', () => {
            // Mock crypto.randomUUID
            global.crypto.randomUUID = vi.fn().mockReturnValue('mock-uuid');

            const patient = { name: 'John Doe', mobile: '123', gender: 'Male' };
            service.savePatient(patient);

            expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO patients'));
            expect(mockStatement.run).toHaveBeenCalledWith(expect.objectContaining({
                uuid: 'mock-uuid',
                name: 'John Doe'
            }));
        });

        it('should search patients across names, MRN, and identifiers', () => {
            service.getPatients('John');
            expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining('name LIKE ?'));
            expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining('patient_identifiers'));
            expect(mockStatement.all).toHaveBeenCalledWith(
                expect.stringContaining('John'), expect.any(String), expect.any(String),
                expect.any(String), expect.any(String), expect.any(String));
        });
    });

    describe('Patient Identifiers', () => {
        function keyDb(rows: Record<string, any>) {
            mockDb.prepare.mockImplementation((sql: string) => ({
                get: (...args: any[]) => {
                    for (const [key, value] of Object.entries(rows)) {
                        if (sql.includes(key)) return typeof value === 'function' ? value(...args) : value;
                    }
                    return null;
                },
                all: (...args: any[]) => {
                    for (const [key, value] of Object.entries(rows)) {
                        if (sql.includes(key)) return typeof value === 'function' ? value(...args) : value;
                    }
                    return [];
                },
                run: vi.fn().mockReturnValue({ lastInsertRowid: 7, changes: 1 })
            }));
        }

        it('lists identifiers for a chart', () => {
            const rows = [{ id: 1, system: 'mrn', value: 'ND-100001' }];
            keyDb({ 'FROM patient_identifiers WHERE patient_id': rows });
            expect(service.getIdentifiers(3)).toEqual(rows);
        });

        it('saves a validated identifier and audits the add', () => {
            keyDb({});
            const result = service.saveIdentifier(3,
                { system: 'abha-number', value: '79927398713891', isPrimary: true }, 9);
            expect(result).toMatchObject({ id: 7, updated: false });
            const inserts = mockDb.prepare.mock.calls.map((c: any) => c[0]).join('\n');
            expect(inserts).toContain('INSERT INTO patient_identifiers');
            expect(inserts).toContain('UPDATE patient_identifiers SET is_primary = 0');
            expect(inserts).toContain('INSERT INTO audit_logs');
        });

        it('rejects malformed identifiers before touching the database', () => {
            keyDb({});
            expect(() => service.saveIdentifier(3, { system: 'abha-number', value: '123' } as any))
                .toThrow('14 digits');
            expect(() => service.saveIdentifier(3, { system: 'aadhaar', value: '1234' } as any))
                .toThrow('Unknown identifier system');
            expect(() => service.saveIdentifier(0, { system: 'mrn', value: 'ND-100001' } as any))
                .toThrow('chart is required');
        });

        it('rejects an identifier already held by another chart', () => {
            keyDb({ 'WHERE system = ? AND value = ?': { patient_id: 8 } });
            expect(() => service.saveIdentifier(3, { system: 'mrn', value: 'ND-100008' } as any))
                .toThrow('another chart');
        });

        it('updates an existing row instead of duplicating it', () => {
            keyDb({ 'WHERE patient_id = ? AND system = ? AND value = ?': { id: 5 } });
            const result = service.saveIdentifier(3, { system: 'insurance', value: 'POL-1' } as any);
            expect(result).toMatchObject({ id: 5, updated: true });
        });

        it('deletes identifiers with audit, but never the clinic MRN', () => {
            keyDb({ 'WHERE id = ?': { patient_id: 3, system: 'insurance', value: 'POL-1' } });
            expect(service.deleteIdentifier(11, 9)).toMatchObject({ deleted: true });
            keyDb({ 'WHERE id = ?': { patient_id: 3, system: 'mrn', value: 'ND-100001' } });
            expect(() => service.deleteIdentifier(12, 9)).toThrow('chart identity');
            keyDb({ 'WHERE id = ?': null });
            expect(() => service.deleteIdentifier(13, 9)).toThrow('not found');
        });

        it('validates ABHA numbers on registration and surfaces national collisions', () => {
            global.crypto.randomUUID = vi.fn().mockReturnValue('mock-uuid');
            keyDb({});
            expect(() => service.savePatient({ name: 'A', mobile: '1', gender: 'Male', abha_number: '123' }))
                .toThrow('14 digits');
            const clash = new Error('UNIQUE constraint failed: patients.abha_number');
            mockDb.prepare.mockImplementation((sql: string) => {
                if (sql.includes('INSERT INTO patients')) {
                    return { run: () => { throw clash; } };
                }
                return { get: () => null, all: () => [], run: vi.fn() };
            });
            expect(() => service.savePatient({ name: 'A', mobile: '1', gender: 'Male', abha_number: '79927398713891' }))
                .toThrow('already registered');
        });

        it('flags ABHA-number and registry matches as duplicate candidates', () => {
            keyDb({
                'FROM patients WHERE': [{ id: 4, abha_number: '79-9273-9871-3891', name: 'Other', mobile: '999' }],
                'FROM patient_identifiers': [{ patient_id: 4 }]
            });
            const found = service.findDuplicateCandidates({ abhaNumber: '79-9273-9871-3891', identifier: 'POL-1' });
            expect(found[0].signals).toContain('abha-number');
            expect(found[0].signals).toContain('identifier');
            expect(found[0].score).toBe(100);
        });
    });

    describe('Appointment Lifecycle', () => {
        function keyDb(rows: Record<string, any>) {
            mockDb.prepare.mockImplementation((sql: string) => ({
                get: (...args: any[]) => {
                    for (const [key, value] of Object.entries(rows)) {
                        if (sql.includes(key)) return typeof value === 'function' ? value(...args) : value;
                    }
                    return null;
                },
                all: (...args: any[]) => {
                    for (const [key, value] of Object.entries(rows)) {
                        if (sql.includes(key)) return typeof value === 'function' ? value(...args) : value;
                    }
                    return [];
                },
                run: vi.fn().mockReturnValue({ lastInsertRowid: 7, changes: 1 })
            }));
        }

        it('moves bookings through allowed transitions with history and audit', () => {
            keyDb({ 'FROM appointments WHERE id': { id: 1, status: 'booked', date: '2026-10-05', time: '10:00' } });
            const moved = service.transitionAppointment(1, 'confirmed', {}, 9);
            expect(moved).toMatchObject({ id: 1, from: 'booked', to: 'confirmed' });
            const sql = mockDb.prepare.mock.calls.map((c: any) => c[0]).join('\n');
            expect(sql).toContain('INSERT INTO appointment_history');
            expect(sql).toContain('INSERT INTO audit_logs');
        });

        it('rejects illegal jumps, unknown states, and reasonless terminals', () => {
            keyDb({ 'FROM appointments WHERE id': { id: 1, status: 'booked', date: '2026-10-05', time: '10:00' } });
            expect(() => service.transitionAppointment(1, 'fulfilled')).toThrow('Cannot move');
            expect(() => service.transitionAppointment(1, 'teleported')).toThrow('Unknown appointment status');
            expect(() => service.transitionAppointment(1, 'cancelled')).toThrow('reason is required');
            keyDb({ 'FROM appointments WHERE id': null });
            expect(() => service.transitionAppointment(99, 'confirmed')).toThrow('not found');
        });

        it('never reopens terminals', () => {
            keyDb({ 'FROM appointments WHERE id': { id: 1, status: 'fulfilled', date: '2026-10-05', time: '10:00' } });
            expect(() => service.transitionAppointment(1, 'booked')).toThrow('Cannot move');
        });

        it('blocks arrived to fulfilled except through the visit-linked path', () => {
            keyDb({ 'FROM appointments WHERE id': { id: 1, status: 'arrived', patient_id: 3 } });
            expect(() => service.transitionAppointment(1, 'fulfilled')).toThrow('Cannot move');
        });

        it('blocks arrived outside check-in, even for legacy callers', () => {
            keyDb({ 'FROM appointments WHERE id': { id: 1, status: 'CONFIRMED', date: '2026-10-05', time: '10:00' } });
            expect(() => service.transitionAppointment(1, 'CHECKED_IN')).toThrow('Cannot move');
            expect(() => service.transitionAppointment(1, 'arrived')).toThrow('Cannot move');
        });

        it('routes saveAppointment status through transitions, never raw writes', () => {
            keyDb({ 'FROM appointments WHERE id': { id: 1, status: 'confirmed', date: '2026-10-05', time: '10:00' } });
            expect(service.saveAppointment({ id: 1, status: 'cancelled', status_reason: 'patient called' }, 9))
                .toMatchObject({ to: 'cancelled' });
            const sql = mockDb.prepare.mock.calls.map((c: any) => c[0]).join('\n');
            // Status traveled the audited path: history plus audit, not a bare write.
            expect(sql).toContain('INSERT INTO appointment_history');
            expect(sql).toContain('INSERT INTO audit_logs');
            expect(service.saveAppointment({ patient_id: 3, date: '2026-10-05', time: '09:00' })).toBeTruthy();
            const after = mockDb.prepare.mock.calls.map((c: any) => c[0]).join('\n');
            expect(after).toContain("'booked'");
        });

        it('routes legacy check-in through the queue-guaranteed path', () => {
            keyDb({
                'FROM appointments WHERE id': { id: 1, status: 'confirmed', patient_id: 3, date: '2026-10-05', time: '10:00' },
                'FROM patient_queue WHERE patient_id': null
            });
            expect(service.saveAppointment({ id: 1, status: 'CHECKED_IN' }, 9)).toMatchObject({ queueEntryId: 7 });
        });

        it('records reschedules in history with originals intact', () => {
            keyDb({ 'FROM appointments WHERE id': { id: 1, status: 'booked', patient_id: 3, date: '2026-10-05', time: '10:00', original_date: null, original_time: null } });
            expect(service.saveAppointment({ id: 1, date: '2026-10-06' }, 9)).toMatchObject({ id: 1 });
            const sql = mockDb.prepare.mock.calls.map((c: any) => c[0]).join('\n');
            expect(sql).toContain('original_date = ?');
            expect(sql).toContain('original_time = ?');
            // Reschedule provenance lands in history (action travels as a
            // bound audit param, asserted via the history row instead).
            expect(sql).toContain('INSERT INTO appointment_history');
            expect(sql).toContain('INSERT INTO audit_logs');
        });

        it('refuses field edits on terminals and logs reassignments', () => {
            keyDb({ 'FROM appointments WHERE id': { id: 1, status: 'fulfilled', patient_id: 3 } });
            expect(() => service.saveAppointment({ id: 1, date: '2026-10-07' }, 9))
                .toThrow('Cannot edit a fulfilled appointment');
            keyDb({ 'FROM appointments WHERE id': { id: 1, status: 'booked', patient_id: 3, date: '2026-10-05', time: '10:00' } });
            expect(service.saveAppointment({ id: 1, patient_id: 7 }, 9)).toMatchObject({ id: 1 });
            const sql = mockDb.prepare.mock.calls.map((c: any) => c[0]).join('\n');
            expect(sql).toContain('INSERT INTO appointment_history');
        });

        it('blocks reassignment under a live queue entry', () => {
            keyDb({
                'FROM appointments WHERE id': { id: 1, status: 'arrived', patient_id: 3, queue_entry_id: 9 },
                'FROM patient_queue WHERE id': { id: 9 }
            });
            expect(() => service.saveAppointment({ id: 1, patient_id: 7 }, 9))
                .toThrow('live queue entry');
        });

        it('blocks reassignment-plus-arrive in a single status payload', () => {
            keyDb({
                'FROM appointments WHERE id': { id: 1, status: 'confirmed', patient_id: 3, queue_entry_id: 9 },
                'FROM patient_queue WHERE id': { id: 9 }
            });
            expect(() => service.saveAppointment({ id: 1, patient_id: 7, status: 'CHECKED_IN' }, 9))
                .toThrow('live queue entry');
        });

        it('rejects malformed slot inputs without matching', () => {
            keyDb({ 'FROM appointments WHERE': [] });
            expect(service.detectConflicts({ date: '2026-10-05', time: '99:99' })).toEqual([]);
            expect(service.detectConflicts({ date: 'not-a-date', time: '10:00' })).toEqual([]);
            expect(service.detectConflicts({ date: '2026-10-05', time: '10:00' })).toEqual([]);
        });

        it('stamps originals on first reschedule only', () => {
            keyDb({ 'FROM appointments WHERE id': { id: 1, status: 'booked', date: '2026-10-05', time: '10:00', original_date: null } });
            service.transitionAppointment(1, 'confirmed', { date: '2026-10-06', time: '11:00' } as any);
            const update = mockDb.prepare.mock.calls.map((c: any) => c[0]).find((s: string) => s.startsWith('UPDATE appointments SET'));
            expect(update).toContain('original_date');
        });

        it('detects same-doctor overlaps and ignores terminals', () => {
            keyDb({
                // As the real query would: terminals already filtered in SQL.
                'FROM appointments WHERE': [
                    { id: 2, time: '10:15', status: 'confirmed' },
                    { id: 3, time: '11:30', status: 'confirmed' }
                ]
            });
            const hits = service.detectConflicts({ doctorId: 5, date: '2026-10-05', time: '10:00' });
            expect(hits.map((h: any) => h.id)).toEqual([2]);
            expect(hits[0]).toMatchObject({ time: '10:15', status: 'confirmed' });
            const sql = mockDb.prepare.mock.calls.map((c: any) => c[0]).join('\n');
            expect(sql).toContain("status NOT IN ('fulfilled','cancelled','no-show')");
        });

        it('checks in once and reuses the live queue entry', () => {
            keyDb({
                'FROM appointments WHERE id': { id: 1, status: 'confirmed', patient_id: 3, date: '2026-10-05', time: '10:00' },
                'FROM patient_queue WHERE id': { id: 9 },
                'FROM patient_queue WHERE patient_id': null
            });
            // Spy addToQueue through the real method with queue-entry preset
            const first = service.checkInAppointment(1, 9);
            expect(first.queueEntryId).toBe(7);
            expect(first.reused).toBe(false);
            keyDb({
                'FROM appointments WHERE id': { id: 1, status: 'arrived', patient_id: 3, queue_entry_id: 9 },
                'FROM patient_queue WHERE id': { id: 9 }
            });
            expect(service.checkInAppointment(1, 9)).toMatchObject({ queueEntryId: 9, reused: true });
        });

        it('repairs arrived-without-queue instead of failing the retry', () => {
            keyDb({
                'FROM appointments WHERE id': { id: 1, status: 'arrived', patient_id: 3, date: '2026-10-05', time: '10:00' },
                'FROM patient_queue WHERE patient_id': null
            });
            const repaired = service.checkInAppointment(1, 9);
            expect(repaired.queueEntryId).toBe(7);
            expect(repaired.reused).toBe(false);
        });

        it('links only same-patient visits on fulfill', () => {
            keyDb({
                'FROM appointments WHERE id': { id: 1, status: 'arrived', patient_id: 3 },
                'FROM visits WHERE id': { id: 50, patient_id: 3 }
            });
            expect(service.fulfillAppointment(1, 50, 9)).toMatchObject({ to: 'fulfilled', visitId: 50 });
            keyDb({
                'FROM appointments WHERE id': { id: 1, status: 'arrived', patient_id: 3 },
                'FROM visits WHERE id': { id: 51, patient_id: 4 }
            });
            expect(() => service.fulfillAppointment(1, 51, 9)).toThrow('another patient');
            keyDb({
                'FROM appointments WHERE id': { id: 1, status: 'arrived', patient_id: 3 },
                'FROM visits WHERE id': null
            });
            expect(() => service.fulfillAppointment(1, 52, 9)).toThrow('Visit not found');
        });
    });

    describe('Queue Management', () => {
        it('should add patient to queue', () => {
            mockStatement.get.mockReturnValue(null); // Not already in queue
            service.addToQueue(1, 2, 999); // Patient 1, Priority 2, User 999

            expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO patient_queue'));
            expect(mockStatement.run).toHaveBeenCalledWith(1, 2);
        });

        it('should throw if patient already in queue', () => {
            mockStatement.get.mockReturnValue({ id: 99 }); // Already in queue
            expect(() => service.addToQueue(1, 1, 999)).toThrow('Patient already in queue');
        });

        it('should log audit when updating queue status', () => {
            mockStatement.get.mockReturnValue({ status: 'waiting' });
            service.updateQueueStatus(1, 'waiting', 999);
            // Check for Audit Log Insert
            expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO audit_logs'));
        });

        it('should reject encounter lifecycle transitions outside encounter commands', () => {
            expect(() => service.updateQueueStatus(1, 'completed', 999))
                .toThrow('Consultation queue transitions require an encounter command');
        });
    });
    describe('Visit Management', () => {
        it('should reject legacy insert paths that bypass encounter identity', () => {
            expect(() => service.saveVisit({ patient_id: 1, diagnosis: 'Test' }))
                .toThrow('New encounters must be created with beginConsultation');
        });
    });
    describe('RBAC', () => {
        it('should get permissions for a role', () => {
            const permissions = ['perm1', 'perm2'];
            mockStatement.get.mockReturnValue({ permissions: JSON.stringify(permissions) });

            const result = service.getPermissions('doctor');
            expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining('SELECT permissions FROM roles'));
            expect(result).toEqual(permissions);
        });

        it('should return empty array if role not found', () => {
            mockStatement.get.mockReturnValue(undefined);
            const result = service.getPermissions('unknown');
            expect(result).toEqual([]);
        });

        it('should save a role with permissions', () => {
            service.saveRole('nurse', ['perm1']);
            expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO roles'));
            expect(mockStatement.run).toHaveBeenCalledWith('nurse', JSON.stringify(['perm1']));
        });
    });

    describe('restore fence', () => {
        it('rejects new work with RESTORE_IN_PROGRESS and drains in-flight work', async () => {
            service.beginWork();
            const fenced = service.fence(1000);
            expect(() => service.beginWork()).toThrow('RESTORE_IN_PROGRESS');
            service.endWork();
            await fenced;
            expect(() => service.beginWork()).toThrow('RESTORE_IN_PROGRESS');
            service.unfence();
            expect(() => { service.beginWork(); service.endWork(); }).not.toThrow();
        });

        it('rejects auth:login and Drive settings work with RESTORE_IN_PROGRESS while fenced', async () => {
            await service.fence();
            const validateUser = vi.spyOn(service, 'validateUser');
            const getSettings = vi.spyOn(service, 'getSettings');
            const saveSettings = vi.spyOn(service, 'saveSettings');
            await expect(service.runWork(() => service.validateUser('admin', 'password')))
                .rejects.toThrow('RESTORE_IN_PROGRESS');
            await expect(service.runWork(() => service.getSettings()))
                .rejects.toThrow('RESTORE_IN_PROGRESS');
            await expect(service.runWork(() => service.saveSettings({ drive_tokens: '' })))
                .rejects.toThrow('RESTORE_IN_PROGRESS');
            expect(validateUser).not.toHaveBeenCalled();
            expect(getSettings).not.toHaveBeenCalled();
            expect(saveSettings).not.toHaveBeenCalled();
        });

        it('times out a stuck drain without unfencing', async () => {
            service.beginWork();
            await expect(service.fence(20)).rejects.toThrow('RESTORE_DRAIN_TIMEOUT');
            expect(() => service.beginWork()).toThrow('RESTORE_IN_PROGRESS');
            service.unfence();
            service.endWork();
            expect(() => { service.beginWork(); service.endWork(); }).not.toThrow();
        });
    });
});
