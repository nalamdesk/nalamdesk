import { test, expect, _electron as electron } from '@playwright/test';
import { join } from 'path';

test('NalamDesk Full Clinical Flow', async () => {
    let app: any;
    try {
        // 1. Launch Electron Application
        // We launch the main process built file.
        // Ensure `npm run build:main` is run before this test if not automated.
        app = await electron.launch({
            args: [join(__dirname, '../dist/main/main.js')],
            env: { ...process.env, NODE_ENV: 'test' }
        });


        const window = await app.firstWindow();
        window.on('console', msg => console.log(`[Browser]: ${msg.text()}`));
        await window.waitForLoadState('domcontentloaded');
        console.log('[Content]:', await window.content());
        console.log('[Electron Available]:', await window.evaluate(() => !!(window as any).electron));

        // 2. Authentication (Administrator / Doctor)
        console.log('Step 2: Authenticating...');
        const loginHeader = window.locator('h2:has-text("NalamDesk")');
        await expect(loginHeader).toBeVisible();

        await window.locator('input[name="username"]').fill('admin');
        await window.locator('input[name="password"]').fill('admin');
        await window.click('button[type="submit"]');

        // Verify Dashboard Access
        await expect(window.locator('app-dashboard')).toBeVisible({ timeout: 10000 });
        console.log('Login Successful');

        // 3. Register New Patient
        console.log('Step 3: Registering New Patient...');
        // Wait for Dashboard content to load
        // Use networkidle to ensure stats loaded
        await window.waitForLoadState('networkidle');
        // Wait for "New Visit" text just in case
        await expect(window.locator('text=New Visit')).toBeVisible({ timeout: 10000 });

        // Click "New Visit" (Quick Action Card) to go to Patients
        await window.locator('.card', { hasText: 'New Visit' }).click();

        // Wait for Patient List Header
        await window.waitForSelector('h1:has-text("Patients")', { timeout: 10000 });

        // We are now on the Patient List page. Proceed to Add Patient.
        await expect(window.locator('app-patient-list')).toBeVisible();

        await window.click('button:has-text("Add Patient")');
        await expect(window.locator('div.fixed')).toBeVisible(); // Modal container

        const uniqueId = Date.now();
        const patientName = `Test Patient ${uniqueId}`;
        const patientMobile = '9999999999';

        await window.locator('input[name="name"]').fill(patientName);
        await window.locator('input[name="mobile"]').fill(patientMobile);
        await window.locator('input[name="age"]').fill('30');
        await window.locator('select[name="gender"]').selectOption('Male');

        // Save Patient
        await window.click('button:has-text("Save")');
        await expect(window.locator('div.fixed')).toBeHidden(); // Modal closes
        console.log(`Patient ${patientName} registered.`);

        // 4. Add Patient to Queue
        console.log('Step 4: Adding to Queue...');
        // Search for patient to ensure visibility
        // Wait for row to appear first (post-save reload)
        const row = window.locator(`tr:has-text("${patientName}")`);
        await expect(row).toBeVisible();

        // Optional: Filter to verify search works
        await window.locator('input[placeholder="Search by name or mobile..."]').fill(patientName);
        await expect(row).toBeVisible();

        // Click "Add to Queue" inside the row
        await row.locator('button:has-text("Add to Queue")').click();

        // Verify button changes to "In Queue"
        await expect(row.locator('button:has-text("In Queue")')).toBeVisible();
        console.log('Patient added to queue.');

        // 5. Medical Consultation
        console.log('Step 5: Starting Consultation...');
        await window.click('text=Queue');
        await expect(window.locator('app-queue')).toBeVisible();

        // Find patient in queue
        const queueCard = window.locator(`tr:has-text("${patientName}")`); // It's a table in queue too?
        // Looking at QueueComponent, it is a table.
        // Check Status is "Waiting"
        await expect(queueCard).toContainText('Waiting');

        // Start Consult
        await queueCard.locator('button:has-text("Start Consult")').click();

        // 6. Consult & Prescribe
        console.log('Step 6: Prescribing...');
        await expect(window.locator('app-visit')).toBeVisible();

        // Verify Patient Name on Visit Page
        await expect(window.locator(`h2:has-text("${patientName}")`)).toBeVisible();

        // Fill Diagnosis
        await window.locator('[data-testid="diagnosis-input"]').fill('Flu symptoms. Fever and cold.');

        // Prescribe Medicine (First row is auto-added)
        const firstRowMock = window.locator('app-prescription .grid').first();
        await firstRowMock.locator('[data-testid="rx-medicine-0"]').fill('Paracetamol');
        await firstRowMock.locator('input[aria-label="Duration"]').fill('3 days');

        // Save Progress
        await window.click('button:has-text("Save Progress")');
        // Verify it didn't crash
        await expect(window.locator('button:has-text("Update Record")')).toBeVisible();

        // 7. Complete Consultation
        console.log('Step 7: Completing Consultation...');
        await window.click('button:has-text("Finish & Exit")');

        // Should return to Queue
        await expect(window.locator('app-queue')).toBeVisible();

        // Verify patient is gone from "Waiting" list?
        // Queue lists everything or filters? queue().length.
        // Queue component filters? No, it shows everything? 
        // "remove" button is there.
        // Completed visits might stay or be hidden?
        // queue() comes from 'getQueue'. DatabaseService.getQueue() returns `status != 'completed'` usually?
        // Let's check DatabaseService logic for getQueue.
        // "SELECT q.* ... WHERE q.status != 'completed'" (From user terminal log earlier!)
        // So the patient should NOT be in the table anymore.

        await expect(window.locator(`tr:has-text("${patientName}")`)).toBeHidden();

        console.log('Consultation completed successfully.');

    } catch (e) {
        console.error('----------------------------------------');
        console.error('TEST FAILURE DETAIL:');
        console.error(e);
        console.error('----------------------------------------');
        throw e;
    } finally {
        if (app) await app.close();
    }
});
