/**
 * 03 — Patients module regression: register, validate, search, details.
 */
import { test, expect } from '@playwright/test';
import {
    ADMIN_PASSWORD,
    gotoHash,
    gridRow,
    launchApp,
    loginViaUI,
    registerPatientViaModal,
    type RegressionApp,
} from './helpers';

test.describe.serial('Patients module', () => {
    let ctx: RegressionApp;
    const patientName = `Reg Patient ${Date.now()}`;

    test.beforeAll(async () => {
        ctx = await launchApp();
        await loginViaUI(ctx.window, 'admin', ADMIN_PASSWORD);
    });

    test.afterAll(async () => {
        await ctx?.close();
    });

    test('patients list loads', async () => {
        await gotoHash(ctx.window, '#/patients');
        await expect(ctx.window.locator('app-patient-list')).toBeVisible({ timeout: 15000 });
        await expect(ctx.window.locator('h1:has-text("Patients")')).toBeVisible();
    });

    test('register a new patient via the Add Patient modal', async () => {
        await gotoHash(ctx.window, '#/patients');
        await registerPatientViaModal(ctx.window, {
            name: patientName,
            mobile: '9888888888',
            age: '33',
            gender: 'Female',
        });
        await expect(gridRow(ctx.window, patientName)).toBeVisible({ timeout: 15000 });
    });

    test('search filters the patient list', async () => {
        await gotoHash(ctx.window, '#/patients');
        await ctx.window.locator('input[placeholder="Search by name or mobile..."]').fill(patientName);
        await expect(gridRow(ctx.window, patientName)).toBeVisible({ timeout: 15000 });
    });

    test('patient details page shows chart + history', async () => {
        await gotoHash(ctx.window, '#/patients');
        await ctx.window.locator('input[placeholder="Search by name or mobile..."]').fill(patientName);
        const row = gridRow(ctx.window, patientName);
        await expect(row).toBeVisible({ timeout: 15000 });
        // Row click routes to the chart (checkbox + action buttons don't
        // fire rowClicked, so click the name cell).
        await row.locator('div.ag-cell[col-id="name"]').click();
        await expect(ctx.window.locator('app-patient-details')).toBeVisible({ timeout: 15000 });
        await expect(ctx.window.locator(`h1:has-text("${patientName}")`)).toBeVisible({ timeout: 15000 });
    });

    test('empty patient name is rejected by validation', async () => {
        await gotoHash(ctx.window, '#/patients');
        await expect(ctx.window.locator('app-patient-list')).toBeVisible();
        const countBefore: number = await ctx.window.evaluate(async () => {
            return ((await (window as any).electron.db.getPatients('')) || []).length;
        });
        await ctx.window.click('button:has-text("Add Patient")');
        const modal = ctx.window.locator('div.fixed');
        await expect(modal).toBeVisible();
        // Name left empty: reactive-form validation keeps Save disabled.
        await modal.locator('input[placeholder="9876543210"]').fill('9777777777');
        await expect(modal.locator('button:has-text("Save only")')).toBeDisabled();
        await modal.locator('button:has-text("Cancel")').click();
        await expect(modal).toBeHidden();
        const countAfter: number = await ctx.window.evaluate(async () => {
            return ((await (window as any).electron.db.getPatients('')) || []).length;
        });
        expect(countAfter).toBe(countBefore);
    });
});
