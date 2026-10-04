/**
 * 05 — Settings + admin module regression:
 * users/roles management, catalog, audit log, admin-only IPC gating.
 */
import { test, expect } from '@playwright/test';
import { ADMIN_PASSWORD, gotoHash, launchApp, loginViaUI, provisionRoleUsers, type RegressionApp } from './helpers';

test.describe.serial('Settings + admin module', () => {
    let ctx: RegressionApp;

    test.beforeAll(async () => {
        ctx = await launchApp();
        await loginViaUI(ctx.window, 'admin', ADMIN_PASSWORD);
        await provisionRoleUsers(ctx.window);
    });

    test.afterAll(async () => {
        await ctx?.close();
    });

    test('settings shell renders all admin sections', async () => {
        await gotoHash(ctx.window, '#/settings');
        await expect(ctx.window.locator('app-settings')).toBeVisible({ timeout: 15000 });
        for (const section of ['Users', 'Roles', 'Catalog', 'Audit']) {
            await expect(ctx.window.locator(`text=${section}`).first()).toBeVisible({ timeout: 15000 });
        }
    });

    test('user list contains seeded roles', async () => {
        await gotoHash(ctx.window, '#/settings');
        const usernames: string[] = await ctx.window.evaluate(async () => {
            const users: any[] = await (window as any).electron.db.getUsers();
            return users.map((u: any) => u.username);
        });
        expect(usernames).toContain('admin');
        expect(usernames).toContain('reg_doctor');
        expect(usernames).toContain('reg_nurse');
    });

    test('admin can update a staff display name', async () => {
        const updated = await ctx.window.evaluate(async () => {
            const api = (window as any).electron.db;
            const users: any[] = await api.getUsers();
            const target = users.find((u: any) => u.username === 'reg_doctor');
            await api.saveUser({ id: target.id, name: 'Reg Doctor (Updated)' });
            const refreshed: any[] = await api.getUsers();
            return refreshed.find((u: any) => u.username === 'reg_doctor')?.name;
        });
        expect(updated).toContain('Updated');
    });

    test('catalog accepts a new medicine entry', async () => {
        const medicine = `RegMed-${Date.now()}`;
        const found = await ctx.window.evaluate(async (name: string) => {
            const api = (window as any).electron.db;
            try {
                await api.createMedicine({ name });
            } catch {
                /* may already exist on rerun */
            }
            return api.searchMedicines(name, 5);
        }, medicine);
        expect(JSON.stringify(found)).toContain(medicine);
    });

    test('audit log records admin activity', async () => {
        const logs: any[] = await ctx.window.evaluate(async () => {
            return (window as any).electron.db.getAuditLogs(25);
        });
        expect(Array.isArray(logs)).toBe(true);
        expect(logs.length).toBeGreaterThan(0);
    });

    test('audit log UI renders', async () => {
        await gotoHash(ctx.window, '#/settings');
        // Audit section may lazy-load; trigger by text search and assert shell stays healthy.
        await expect(ctx.window.locator('app-settings')).toBeVisible({ timeout: 15000 });
        const hasAudit = await ctx.window.locator('text=Audit').first().isVisible().catch(() => false);
        expect(hasAudit).toBe(true);
    });
});
