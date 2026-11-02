import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as os from 'node:os';
import * as jwt from 'jsonwebtoken';
import { DatabaseService } from '../main/services/DatabaseService';
import { TestDatabase } from '../main/testing/TestDatabase';
import { chooseFacility } from '../main/services/FacilitySession';
import { ApiServer } from './app';
import { DEVICE_HEADER } from '../shared/protocol';

delete process.env['JWT_SECRET'];

const PASSWORD = 'correct horse battery staple';

describe('chooseFacility', () => {
    const grants = [
        { id: 2, code: 'ANN', name: 'Anna Nagar', kind: 'hospital', role: 'doctor' },
        { id: 1, code: 'MAIN', name: 'Main', kind: 'clinic', role: 'receptionist' }
    ];
    it('prefers the requested facility, then facility 1, then the first grant', () => {
        expect(chooseFacility(grants, 2)?.id).toBe(2);
        expect(chooseFacility(grants, '2')?.id).toBe(2);
        expect(chooseFacility(grants)?.id).toBe(1);
        expect(chooseFacility([grants[0]])?.id).toBe(2);
    });
    it('refuses a facility without a grant, and users without any', () => {
        expect(chooseFacility(grants, 9)).toBeNull();
        expect(chooseFacility([])).toBeNull();
    });
});

describe('sign-in per facility (#195)', () => {
    let raw: TestDatabase;
    let service: DatabaseService;
    let server: ApiServer;
    let deviceToken: string;

    beforeEach(async () => {
        raw = new TestDatabase();
        service = new DatabaseService();
        service.setDb(raw);
        await service.migrate({ skipBackup: true });
        await service.ensureAdminUser(PASSWORD);
        const argon2 = await import('argon2');
        const hash = await argon2.hash(PASSWORD);
        raw.prepare("INSERT INTO facilities (id, code, name, kind) VALUES (2, 'ANN', 'Anna Nagar', 'hospital')").run();
        raw.prepare("INSERT INTO users (id, username, password, role, name, active) VALUES (50, 'asha', ?, 'doctor', 'Dr. Asha', 1)").run(hash);
        raw.prepare("INSERT INTO users (id, username, password, role, name, active) VALUES (51, 'ravi', ?, 'receptionist', 'Ravi', 1)").run(hash);
        raw.prepare(`INSERT INTO user_facility_roles (user_id, facility_id, role) VALUES
            (50, 1, 'doctor'), (50, 2, 'admin'), (51, 2, 'receptionist')`).run();
        server = new ApiServer(service, os.tmpdir(), undefined, undefined, { requireDevice: true });
        const { code } = server.issueJoinCode({ createdBy: null });
        const joined = await post('/api/devices/join', { code, name: 'Front desk' });
        deviceToken = joined.json().deviceToken;
    });

    afterEach(async () => {
        await server.close();
    });

    function post(url: string, payload: unknown, token?: string) {
        return server.inject({
            method: 'POST', url, payload: payload as any,
            headers: {
                'content-type': 'application/json',
                ...(deviceToken ? { [DEVICE_HEADER]: deviceToken } : {}),
                ...(token ? { authorization: `Bearer ${token}` } : {})
            }
        });
    }

    const claims = (token: string) => jwt.decode(token) as any;

    it('starts in facility 1 by default and lists the facilities the user can use', async () => {
        const res = await post('/api/auth/login', { username: 'asha', password: PASSWORD });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.facilityId).toBe(1);
        expect(body.user.role).toBe('doctor');
        expect(body.facilities.map((f: any) => [f.id, f.role])).toEqual([[1, 'doctor'], [2, 'admin']]);
        expect(claims(body.token).facility_id).toBe(1);
    });

    it('signs in to a requested facility with the role held there', async () => {
        const res = await post('/api/auth/login', { username: 'asha', password: PASSWORD, facilityId: 2 });
        expect(res.json()).toMatchObject({ facilityId: 2, user: { role: 'admin' } });
        // Ravi only works at the branch, so that is where he lands.
        const ravi = await post('/api/auth/login', { username: 'ravi', password: PASSWORD });
        expect(ravi.json()).toMatchObject({ facilityId: 2, user: { role: 'receptionist' } });
        const refused = await post('/api/auth/login', { username: 'ravi', password: PASSWORD, facilityId: 1 });
        expect(refused.statusCode).toBe(403);
        expect(refused.json()).toEqual({ error: 'NO_FACILITY_ACCESS' });
    });

    it('switches facility, keeps it across refresh, and serves that facility', async () => {
        const login = (await post('/api/auth/login', { username: 'asha', password: PASSWORD })).json();
        raw.prepare("INSERT INTO patients (id, uuid, name) VALUES (1, 'p-1', 'Meena')").run();
        raw.prepare('INSERT INTO patient_queue (patient_id, facility_id) VALUES (1, 2)').run();

        const switched = await post('/api/auth/facility', { facilityId: 2 }, login.token);
        expect(switched.statusCode).toBe(200);
        expect(switched.json()).toMatchObject({ facilityId: 2, role: 'admin' });
        expect(claims(switched.json().token).facility_id).toBe(2);
        const queue = await post('/api/ipc/getQueue', [], switched.json().token);
        expect(queue.json().map((q: any) => q.patient_id)).toEqual([1]);

        const refreshed = (await post('/api/auth/refresh', { refreshToken: login.refreshToken })).json();
        expect(refreshed).toMatchObject({ facilityId: 2, user: { role: 'admin' } });
        expect(claims(refreshed.token).facility_id).toBe(2);

        const bad = await post('/api/auth/facility', { facilityId: 9 }, switched.json().token);
        expect(bad.statusCode).toBe(403);
        const missing = await post('/api/auth/facility', {}, switched.json().token);
        expect(missing.statusCode).toBe(400);
    });

    it('serves organisation admin to organisation admins only, with readable refusals (#214)', async () => {
        // Asha is admin at the branch but not an organisation admin.
        const asha = (await post('/api/auth/login', { username: 'asha', password: PASSWORD, facilityId: 2 })).json();
        const refused = await post('/api/ipc/getFacilityAdmin', [], asha.token);
        expect(refused.statusCode).toBe(403);

        const admin = (await post('/api/auth/login', { username: 'admin', password: PASSWORD })).json();
        const view = await post('/api/ipc/getFacilityAdmin', [], admin.token);
        expect(view.statusCode).toBe(200);
        expect(view.json().facilities.map((f: any) => f.code)).toEqual(['MAIN', 'ANN']);

        const granted = await post('/api/ipc/grantFacilityRole', [{ userId: 51, facilityId: 1, role: 'nurse' }], admin.token);
        expect(granted.statusCode).toBe(200);
        expect(service.getFacilityRole(51, 1)).toBe('nurse');

        const clash = await post('/api/ipc/saveFacility', [{ code: 'ann', name: 'Duplicate' }], admin.token);
        expect(clash.statusCode).toBe(400);
        expect(clash.json()).toEqual({ error: 'That code is already in use.' });
    });

    it('ends the session at refresh once access to its facility is removed', async () => {
        const login = (await post('/api/auth/login', { username: 'ravi', password: PASSWORD })).json();
        raw.prepare('DELETE FROM user_facility_roles WHERE user_id = 51').run();
        const refreshed = await post('/api/auth/refresh', { refreshToken: login.refreshToken });
        expect(refreshed.statusCode).toBe(401);
        // The revoked session also stops the access token it issued.
        const call = await post('/api/ipc/getQueue', [], login.token);
        expect(call.statusCode).toBe(401);
    });
});
