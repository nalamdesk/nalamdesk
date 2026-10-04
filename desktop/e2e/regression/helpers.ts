/**
 * Shared helpers for the full-feature regression suite.
 *
 * Strategy (real local test):
 *  1. Playwright `webServer` starts `ng serve` locally (real renderer build).
 *  2. `global-setup` ensures the Electron main process is built (`dist/main/main.js`).
 *  3. Each spec launches the REAL Electron app with NODE_ENV=test and an
 *     isolated `--user-data-dir`, so it uses a transient `nalamdesk-test.db`.
 *  4. Tests drive the real UI (login form, sidebar, forms) plus the real IPC
 *     layer (`window.electron`) for setup/role provisioning.
 */
import { _electron as electron, expect } from '@playwright/test';
import { join } from 'path';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';

export const ADMIN_PASSWORD = process.env['REGRESSION_ADMIN_PASSWORD'] || 'RegTest-Admin-123';
export const STAFF_PASSWORD = process.env['REGRESSION_STAFF_PASSWORD'] || 'RegTest-Staff-123';
export const STAFF_NEW_PASSWORD = process.env['REGRESSION_STAFF_NEW_PASSWORD'] || 'RegTest-Staff-456';

/** Usernames that already completed first-login password rotation in this app instance. */
const rotatedPasswords = new Set<string>();

export const ROLE_USERS = [
    { username: 'reg_doctor', password: STAFF_PASSWORD, role: 'doctor', name: 'Reg Doctor' },
    { username: 'reg_reception', password: STAFF_PASSWORD, role: 'receptionist', name: 'Reg Receptionist' },
    { username: 'reg_nurse', password: STAFF_PASSWORD, role: 'nurse', name: 'Reg Nurse' },
] as const;

export interface RegressionApp {
    app: any;
    window: any;
    userDataDir: string;
    close: () => Promise<void>;
}

/** Launch the real Electron app against the local dev renderer with isolated state. */
export async function launchApp(): Promise<RegressionApp> {
    // Fresh isolated DB per launch, so prior password rotations do not carry over.
    rotatedPasswords.clear();
    // NOTE: `--user-data-dir` alone is NOT enough: main.ts overrides userData
    // with the shared dev dir, so isolation goes through NALAMDESK_E2E_USER_DATA.
    const userDataDir = mkdtempSync(join(tmpdir(), 'nalamdesk-reg-'));
    const app = await electron.launch({
        args: [join(__dirname, '../../dist/main/main.js')],
        env: { ...process.env, NODE_ENV: 'test', NALAMDESK_E2E_USER_DATA: userDataDir },
    });
    const window = await app.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    // Dev Electron docks DevTools on the right, shrinking the page below the
    // md: breakpoint (cards layout). Force a desktop viewport so specs cover
    // the desktop grid layout that packaged users see.
    try {
        await window.setViewportSize({ width: 1440, height: 900 });
    } catch {
        /* Electron may ignore this; specs tolerate either layout */
    }
    return {
        app,
        window,
        userDataDir,
        close: async () => {
            try {
                await app.close();
            } catch {
                /* already closed */
            }
        },
    };
}

/** Run first-time device setup via IPC if needed (fresh test DB). */
export async function ensureSetup(window: any): Promise<void> {
    const isSetup = await window.evaluate(async () => {
        try {
            return (await (window as any).electron.checkSetup())?.isSetup === true;
        } catch {
            return true; // IPC unavailable in this context; assume setup done
        }
    });
    if (isSetup) return;
    const result = await window.evaluate(async (password: string) => {
        return (window as any).electron.setup({
            password,
            clinicDetails: { clinic_name: 'Regression Clinic', city: 'Test City' },
            adminDetails: {},
        });
    }, ADMIN_PASSWORD);
    if (!result?.success) {
        throw new Error(`Device setup failed: ${result?.error || 'unknown error'}`);
    }
    // Dismiss the recovery-code gate if the login screen shows one.
    await window.waitForLoadState('domcontentloaded');
}

/** Log in through the real login form. Handles setup-redirect automatically. */
export async function loginViaUI(window: any, username: string, password: string): Promise<void> {
    // Deterministic device-state check via IPC (works before Angular boots —
    // text sniffing raced the setup wizard and lost).
    await window.waitForFunction(() => !!(window as any).electron, { timeout: 30000 });
    const setupState = await window.evaluate(async () => {
        try {
            return await (window as any).electron.checkSetup();
        } catch {
            return { isSetup: true };
        }
    });
    if (!setupState?.isSetup) {
        await ensureSetup(window);
        // Reload keeps the #/setup hash, so route explicitly to login.
        await window.evaluate(() => {
            location.hash = '#/login';
        });
        await window.reload();
        await window.waitForLoadState('domcontentloaded');
        await window.evaluate(() => {
            if (!location.hash.includes('login')) location.hash = '#/login';
        });
    }
    await expect(window.locator('input[name="username"]')).toBeVisible({ timeout: 30000 });
    // Staff rotate to the new password on first login; reuse it afterwards.
    const currentPassword = rotatedPasswords.has(username) ? STAFF_NEW_PASSWORD : password;
    await window.locator('input[name="username"]').fill(username);
    await window.locator('input[name="password"]').fill(currentPassword);
    await window.click('button[type="submit"]');
    // Fresh provisioning returns a one-time recovery code that must be
    // acknowledged before the shell unlocks (see LoginComponent). The gate
    // renders only after the login round-trip, so wait for either outcome.
    // New staff are additionally forced through change-password rotation.
    const shell = window.locator('app-main-layout');
    const ack = window.locator('button:has-text("I have saved this code")');
    const rotate = window.locator('h2:has-text("Change Password")');
    await expect(ack.or(shell).or(rotate)).toBeVisible({ timeout: 30000 });
    if (await rotate.isVisible().catch(() => false)) {
        await window.locator('input[name="currentPassword"]').fill(currentPassword);
        await window.locator('input[name="password"]').fill(STAFF_NEW_PASSWORD);
        await window.locator('input[name="confirmPassword"]').fill(STAFF_NEW_PASSWORD);
        await window.click('button:has-text("Set Password")');
        rotatedPasswords.add(username);
    } else if (await ack.isVisible().catch(() => false)) {
        await ack.click();
    }
    await expect(shell).toBeVisible({ timeout: 30000 });
}

/** Log out (clears main-process session + renderer storage) and land on login. */
export async function logout(window: any): Promise<void> {
    await window.evaluate(async () => {
        try {
            await (window as any).electron.logout();
        } catch {
            /* session may already be clear */
        }
        localStorage.removeItem('nalamdesk_user');
        localStorage.removeItem('nalamdesk_token');
        location.hash = '#/login';
    });
    await expect(window.locator('input[name="username"]')).toBeVisible({ timeout: 15000 });
}

/** Create doctor/receptionist/nurse accounts via guarded IPC (call while logged in as admin). */
export async function provisionRoleUsers(window: any): Promise<void> {
    await window.evaluate(async (users: readonly { username: string; password: string; role: string; name: string }[]) => {
        const api = (window as any).electron.db;
        const existing: any[] = await api.getUsers();
        for (const u of users) {
            if (!existing.some((e: any) => e.username === u.username)) {
                await api.saveUser({ username: u.username, password: u.password, role: u.role, name: u.name });
            }
        }
    }, ROLE_USERS as unknown as { username: string; password: string; role: string; name: string }[]);
}

/** Navigate by hash route and wait for the shell to settle. */
export async function gotoHash(window: any, hash: string): Promise<void> {
    await window.evaluate((h: string) => {
        location.hash = h;
    }, hash);
    await window.waitForLoadState('domcontentloaded');
}

/** Sidebar link visibility check (role-based nav). */
export async function sidebarHasLink(window: any, name: string): Promise<boolean> {
    return window.getByRole('link', { name }).count().then((n: number) => n > 0);
}

export interface NewPatient {
    name: string;
    mobile: string;
    age: string;
    gender: string;
}

/**
 * Register a patient through the real Add Patient modal.
 * Selectors verified against patient-list.component.ts (reactive form, so
 * placeholders — not name attributes — plus the "Save only" footer button).
 * Desktop viewports render an AG Grid, so rows are `.ag-row`, not `tr`.
 */
export async function registerPatientViaModal(window: any, p: NewPatient): Promise<void> {
    await window.click('button:has-text("Add Patient")');
    const modal = window.locator('div.fixed');
    await expect(modal).toBeVisible({ timeout: 15000 });

    await modal.locator('input[placeholder="John Doe"]').fill(p.name);
    await modal.locator('input[placeholder="9876543210"]').fill(p.mobile);
    await modal.locator('input[placeholder="30"]').fill(p.age);
    // Essentials section has a single select (gender); blood-group lives in
    // the collapsed "Additional details" section and is not rendered.
    await modal.locator('select').first().selectOption(p.gender);

    await modal.locator('button:has-text("Save only")').click();
    await expect(modal).toBeHidden({ timeout: 15000 });
}

/** AG Grid row containing the given text (desktop list rendering). */
export function gridRow(window: any, text: string): any {
    return window.locator(`.ag-row:has-text("${text}")`);
}
