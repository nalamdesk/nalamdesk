/**
 * 01 — Authentication + RBAC regression.
 * Covers: setup/first-login, unauthenticated guard redirects, per-role login,
 * admin-only Settings visibility + route guard, IPC-level Forbidden checks.
 */
import { test, expect } from '@playwright/test';
import {
    ADMIN_PASSWORD,
    ROLE_USERS,
    STAFF_PASSWORD,
    gotoHash,
    launchApp,
    loginViaUI,
    logout,
    provisionRoleUsers,
    sidebarHasLink,
    type RegressionApp,
} from './helpers';

test.describe.serial('Auth + RBAC', () => {
    let ctx: RegressionApp;

    test.beforeAll(async () => {
        ctx = await launchApp();
        await ctx.window.evaluate(() => localStorage.clear());
    });

    test.afterAll(async () => {
        await ctx?.close();
    });

    test('fresh device provisions via setup and admin can sign in', async () => {
        await loginViaUI(ctx.window, 'admin', ADMIN_PASSWORD);
        await expect(ctx.window.locator('app-dashboard')).toBeVisible({ timeout: 15000 });
    });

    test('role accounts can be provisioned by admin', async () => {
        await provisionRoleUsers(ctx.window);
        const names = await ctx.window.evaluate(async () => {
            const users: any[] = await (window as any).electron.db.getUsers();
            return users.map((u: any) => u.username);
        });
        for (const u of ROLE_USERS) expect(names).toContain(u.username);
    });

    test('wrong password is rejected and stays on login', async () => {
        await logout(ctx.window);
        await ctx.window.locator('input[name="username"]').fill('admin');
        await ctx.window.locator('input[name="password"]').fill('wrong-password');
        await ctx.window.click('button[type="submit"]');
        await expect(ctx.window.locator('app-main-layout')).toBeHidden();
        await expect(ctx.window.locator('input[name="username"]')).toBeVisible();
    });

    test('unauthenticated deep links redirect to login', async () => {
        await logout(ctx.window);
        await gotoHash(ctx.window, '#/dashboard');
        await expect(ctx.window.locator('input[name="username"]')).toBeVisible({ timeout: 15000 });
        await gotoHash(ctx.window, '#/settings');
        await expect(ctx.window.locator('input[name="username"]')).toBeVisible({ timeout: 15000 });
    });

    for (const u of ROLE_USERS) {
        test(`${u.role} (${u.username}) can sign in and lands in the shell`, async () => {
            await loginViaUI(ctx.window, u.username, STAFF_PASSWORD);
            await expect(ctx.window.locator('app-main-layout')).toBeVisible();
            await logout(ctx.window);
        });
    }

    test('only admin sees the Settings nav entry', async () => {
        await loginViaUI(ctx.window, 'admin', ADMIN_PASSWORD);
        expect(await sidebarHasLink(ctx.window, 'Settings')).toBe(true);
        await logout(ctx.window);

        for (const u of ROLE_USERS) {
            await loginViaUI(ctx.window, u.username, STAFF_PASSWORD);
            expect(await sidebarHasLink(ctx.window, 'Settings')).toBe(false);
            await logout(ctx.window);
        }
    });

    test('non-admin direct navigation to /settings is bounced to dashboard', async () => {
        await loginViaUI(ctx.window, 'reg_nurse', STAFF_PASSWORD);
        await gotoHash(ctx.window, '#/settings');
        await expect(ctx.window.locator('app-dashboard')).toBeVisible({ timeout: 15000 });
        await expect(ctx.window.locator('app-settings')).toBeHidden();
        await logout(ctx.window);
    });

    test('non-admin IPC user management is Forbidden', async () => {
        await loginViaUI(ctx.window, 'reg_reception', STAFF_PASSWORD);
        const outcome = await ctx.window.evaluate(async () => {
            try {
                await (window as any).electron.db.getUsers();
                return 'allowed';
            } catch (e: any) {
                return String(e?.message || e);
            }
        });
        expect(outcome).toMatch(/Forbidden/);
        await logout(ctx.window);
    });

    test('logout returns to the login screen', async () => {
        await loginViaUI(ctx.window, 'admin', ADMIN_PASSWORD);
        await logout(ctx.window);
        await expect(ctx.window.locator('input[name="username"]')).toBeVisible();
    });
});
