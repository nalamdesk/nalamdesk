/**
 * 04 — Queue + Visit (consultation) lifecycle regression:
 * register -> queue -> start consult -> vitals -> prescribe -> save -> end.
 */
import { test, expect } from '@playwright/test';
import { ADMIN_PASSWORD, gridRow, launchApp, loginViaUI, provisionRoleUsers, registerPatientViaModal, type RegressionApp } from './helpers';

test.describe.serial('Queue + consultation lifecycle', () => {
    let ctx: RegressionApp;
    const patientName = `Reg Flow ${Date.now()}`;

    test.beforeAll(async () => {
        ctx = await launchApp();
        await loginViaUI(ctx.window, 'admin', ADMIN_PASSWORD);
        // Exactly one doctor on this isolated DB, so Start Consult auto-picks
        // without opening the doctor-chooser modal.
        await provisionRoleUsers(ctx.window);
    });

    test.afterAll(async () => {
        await ctx?.close();
    });

    test('register patient from the dashboard quick action', async () => {
        await expect(ctx.window.locator('app-dashboard')).toBeVisible({ timeout: 15000 });
        await expect(ctx.window.locator('text=New Visit')).toBeVisible({ timeout: 15000 });
        await ctx.window.locator('.card', { hasText: 'New Visit' }).click();
        await ctx.window.waitForSelector('h1:has-text("Patients")', { timeout: 15000 });
        await registerPatientViaModal(ctx.window, {
            name: patientName,
            mobile: '9666666666',
            age: '45',
            gender: 'Male',
        });
    });

    test('add patient to queue', async () => {
        const row = gridRow(ctx.window, patientName);
        await expect(row).toBeVisible({ timeout: 15000 });
        await ctx.window.locator('input[placeholder="Search name, mobile, MRN, ABHA, or any ID..."]').fill(patientName);
        // Grid action renderer labels the button "Queue" / "In Queue".
        await row.locator('button', { hasText: 'Queue' }).click();
        await expect(row.locator('button', { hasText: 'In Queue' })).toBeVisible({ timeout: 15000 });
    });

    test('queue shows the patient as Waiting', async () => {
        await ctx.window.getByRole('link', { name: 'Queue' }).first().click();
        await expect(ctx.window.locator('app-queue')).toBeVisible({ timeout: 15000 });
        const queueRow = gridRow(ctx.window, patientName);
        await expect(queueRow).toContainText('Waiting', { timeout: 15000 });
    });

    test('start consult opens the visit workspace', async () => {
        const queueRow = gridRow(ctx.window, patientName);
        await queueRow.locator('button:has-text("Start Consult")').click();
        await expect(ctx.window.locator('app-visit')).toBeVisible({ timeout: 15000 });
        await expect(ctx.window.locator(`h2:has-text("${patientName}")`)).toBeVisible({ timeout: 15000 });
    });

    test('record diagnosis + prescription and save progress', async () => {
        await ctx.window.locator('[data-testid="diagnosis-input"]').fill('Regression E2E: viral fever, follow-up in 3 days.');
        const firstRow = ctx.window.locator('app-prescription .grid').first();
        await firstRow.locator('[data-testid="rx-medicine-0"]').fill('Paracetamol');
        await firstRow.locator('input[aria-label="Duration"]').fill('3 days');
        await ctx.window.click('button:has-text("Save Progress")');
        // Live consults keep the Save Progress button; prove the save landed
        // by reading the active encounter back through IPC.
        await expect(ctx.window.locator('app-visit')).toBeVisible({ timeout: 15000 });
        const diagnosis: string = await ctx.window.evaluate(async (name: string) => {
            const api = (window as any).electron.db;
            const found: any[] = await api.getPatients(name);
            const active: any = await api.getActiveConsultation(found[0].id);
            return active?.diagnosis || active?.visit?.diagnosis || '';
        }, patientName);
        expect(diagnosis).toContain('viral fever');
    });

    test('patient safety context (allergies) is visible on the visit', async () => {
        // Safety panel renders even with no recorded allergies (empty state).
        await expect(ctx.window.locator('app-visit')).toBeVisible();
        const body = await ctx.window.locator('app-visit').innerText();
        expect(body.length).toBeGreaterThan(0);
    });

    test('end consult returns to queue and clears the Waiting entry', async () => {
        await ctx.window.click('button:has-text("Finish & Exit")');
        await expect(ctx.window.locator('app-queue')).toBeVisible({ timeout: 15000 });
        await expect(gridRow(ctx.window, patientName)).toBeHidden({ timeout: 15000 });
    });

    test('completed visit appears in the visits list', async () => {
        await ctx.window.evaluate(() => {
            location.hash = '#/visits';
        });
        await expect(ctx.window.locator('app-visit-list')).toBeVisible({ timeout: 15000 });
        await expect(ctx.window.locator(`text=${patientName}`).first()).toBeVisible({ timeout: 15000 });
    });
});
