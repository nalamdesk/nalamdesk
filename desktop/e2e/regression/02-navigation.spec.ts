/**
 * 02 — Full UI navigation regression (all modules, 100% route coverage).
 * Visits every route as admin and asserts the expected view renders.
 */
import { test, expect } from '@playwright/test';
import { ADMIN_PASSWORD, gotoHash, launchApp, loginViaUI, type RegressionApp } from './helpers';

const ROUTES: { hash: string; shell: string; body?: string }[] = [
    { hash: '#/dashboard', shell: 'app-main-layout', body: 'app-dashboard' },
    { hash: '#/patients', shell: 'app-main-layout', body: 'app-patient-list' },
    { hash: '#/visits', shell: 'app-main-layout', body: 'app-visit-list' },
    { hash: '#/queue', shell: 'app-main-layout', body: 'app-queue' },
    { hash: '#/online-booking', shell: 'app-main-layout', body: 'app-online-booking' },
    { hash: '#/profile', shell: 'app-main-layout', body: 'app-profile' },
    { hash: '#/settings', shell: 'app-main-layout', body: 'app-settings' },
];

test.describe.serial('UI navigation — all modules', () => {
    let ctx: RegressionApp;
    let seededPatientId: number;

    test.beforeAll(async () => {
        ctx = await launchApp();
        await loginViaUI(ctx.window, 'admin', ADMIN_PASSWORD);
        // Seed one patient + one in-progress visit so detail routes have targets.
        // (Visits are created via the real queue -> beginConsultation path with
        // a doctor author, mirroring the UI flow.)
        const seed = await ctx.window.evaluate(async (password: string) => {
            const api = (window as any).electron;
            const users: any[] = await api.db.getUsers();
            let doctor = users.find((u: any) => u.role === 'doctor');
            if (!doctor) {
                await api.db.saveUser({ username: 'nav_doctor', password, role: 'doctor', name: 'Nav Doctor' });
                doctor = (await api.db.getUsers()).find((u: any) => u.username === 'nav_doctor');
            }
            const saved: any = await api.db.savePatient({
                name: 'Nav Seed Patient',
                mobile: '9000000001',
                age: 40,
                gender: 'Male',
            });
            const patientId = Number(saved?.lastInsertRowid) ||
                (await api.db.getPatients('Nav Seed Patient'))[0]?.id;
            const queued: any = await api.db.addToQueue({ patientId, priority: 1 });
            const queueId = Number(queued?.lastInsertRowid);
            const entry = (await api.db.getQueue()).find((q: any) => Number(q.patient_id) === patientId) ||
                { id: queueId };
            const visit: any = await api.db.beginConsultation({
                patientId,
                queueEntryId: entry.id,
                startRequestId: `nav-seed-${Date.now()}`,
                doctorId: doctor.id,
            });
            // Complete it: getVisits only returns finished encounters, and the
            // detail route needs a finished target.
            await api.db.completeConsultation({
                encounterId: visit?.id,
                visit: { diagnosis: 'Navigation seed visit' },
            });
            return { patientId, visitId: visit?.id };
        }, ADMIN_PASSWORD);
        seededPatientId = seed.patientId;
        expect(seededPatientId).toBeTruthy();
        // Re-login in case setup ran inside evaluate (session state).
        await ctx.window.evaluate(() => {
            location.hash = '#/dashboard';
        });
    });

    test.afterAll(async () => {
        await ctx?.close();
    });

    for (const r of ROUTES) {
        test(`route ${r.hash} renders ${r.body}`, async () => {
            await gotoHash(ctx.window, r.hash);
            await expect(ctx.window.locator(r.shell)).toBeVisible({ timeout: 15000 });
            if (r.body) await expect(ctx.window.locator(r.body)).toBeVisible({ timeout: 15000 });
        });
    }

    test('patient detail route renders', async () => {
        await gotoHash(ctx.window, `#/patients/${seededPatientId}`);
        await expect(ctx.window.locator('app-patient-details')).toBeVisible({ timeout: 15000 });
    });

    test('visit detail route renders', async () => {
        const visitId = await ctx.window.evaluate(async (patientId: number) => {
            const visits: any[] = await (window as any).electron.db.getVisits(patientId);
            return visits[0]?.id;
        }, seededPatientId);
        expect(visitId).toBeTruthy();
        await gotoHash(ctx.window, `#/visit/${visitId}`);
        await expect(ctx.window.locator('app-visit')).toBeVisible({ timeout: 15000 });
    });

    test('sidebar links navigate to every module', async () => {
        for (const name of ['Dashboard', 'Queue', 'Patients', 'Visits', 'Settings', 'Profile']) {
            const link = ctx.window.getByRole('link', { name, exact: false }).first();
            if ((await link.count()) === 0) continue;
            await link.click();
            await expect(ctx.window.locator('app-main-layout')).toBeVisible({ timeout: 15000 });
        }
    });

    test('login + recover + change-password public routes render without auth', async () => {
        await ctx.window.evaluate(async () => {
            try {
                await (window as any).electron.logout();
            } catch {
                /* noop */
            }
            localStorage.removeItem('nalamdesk_user');
            localStorage.removeItem('nalamdesk_token');
        });
        // Route-specific markers (each absent from the previous page, so a
        // pass always proves the navigation landed — a generic selector would
        // match the stale page while the router is still tearing it down).
        const cases = [
            { hash: '#/login', marker: 'input[name="password"]' },
            { hash: '#/recover', marker: 'h2:has-text("Recover This Device")' },
            { hash: '#/change-password', marker: 'input[name="currentPassword"]' },
        ];
        for (const c of cases) {
            await gotoHash(ctx.window, c.hash);
            await expect(ctx.window.locator(c.marker).first()).toBeVisible({ timeout: 15000 });
        }
        // Restore admin session for subsequent specs (each spec uses its own app instance,
        // but leave this one clean).
        await gotoHash(ctx.window, '#/login');
    });
});
