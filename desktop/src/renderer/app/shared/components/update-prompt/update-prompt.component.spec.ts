/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { UpdatePromptComponent } from './update-prompt.component';
import { AppUpdateService } from '../../../services/update.service';
import { inject } from '@angular/core';

vi.mock('@angular/core', async () => {
    const actual = await vi.importActual('@angular/core');
    return { ...actual as any, inject: vi.fn() };
});

describe('UpdatePromptComponent', () => {
    let component: UpdatePromptComponent;
    let updates: AppUpdateService;

    beforeEach(() => {
        updates = {
            init: vi.fn(),
            destroy: vi.fn(),
            later: vi.fn(),
            updateNow: vi.fn(),
            install: vi.fn(),
            cancelDownload: vi.fn(),
            promptOpen: () => true,
            status: () => ({
                state: 'available',
                currentVersion: '0.0.8',
                availableVersion: '0.0.9',
                releaseNotes: 'Notes',
                canQuitAndInstall: true,
                verifiedSignature: false,
                integrityNote: 'This feed lists package checksums. NalamDesk does not claim full code-signature verification.'
            })
        } as any;
        vi.mocked(inject).mockReturnValue(updates);
        component = new UpdatePromptComponent();
        component.ngOnInit();
    });

    it('shows current vs new version without claiming signature verify', () => {
        expect(component.body).toContain('0.0.8');
        expect(component.body).toContain('0.0.9');
        expect(component.status.verifiedSignature).toBe(false);
        expect(component.status.integrityNote).not.toMatch(/full code-signature verification is complete/i);
        component.later();
        expect(updates.later).toHaveBeenCalled();
    });

    it('covers prompt titles, install, cancel, and keyboard dismiss', () => {
        updates.status = () => ({ state: 'error', error: 'Could not reach the update feed.' });
        expect(component.title).toMatch(/failed/i);
        expect(component.body).toMatch(/reach/i);
        updates.status = () => ({ state: 'up-to-date', currentVersion: '0.0.8' });
        expect(component.title).toMatch(/up to date/i);
        expect(component.body).toContain('0.0.8');
        updates.status = () => ({ state: 'skipped', reason: 'unpackaged' });
        expect(component.body).toMatch(/packaged/i);
        updates.status = () => ({ state: 'skipped', reason: 'no-feed' });
        expect(component.body).toMatch(/feed/i);
        updates.status = () => ({ state: 'downloading', percent: 40 });
        expect(component.title).toMatch(/Downloading/i);
        component.cancel();
        expect(updates.cancelDownload).toHaveBeenCalled();
        component.updateNow();
        expect(updates.updateNow).toHaveBeenCalled();
        const event = { key: 'Escape', preventDefault: vi.fn() } as any;
        component.onPromptKeydown(event);
        expect(event.preventDefault).toHaveBeenCalled();
        component.ngAfterViewChecked();
        component.ngOnDestroy();
    });

    it('installs a downloaded update from the prompt', () => {
        updates.status = () => ({
            state: 'downloaded',
            currentVersion: '0.0.8',
            availableVersion: '0.0.9',
            canQuitAndInstall: true,
            verifiedSignature: false
        });
        expect(component.title).toMatch(/downloaded/i);
        component.install();
        expect(updates.install).toHaveBeenCalled();
    });

    it('titles every state and falls back on missing fields', () => {
        updates.status = () => ({ state: 'skipped', reason: 'x' });
        expect(component.title).toBe('Updates');
        updates.status = () => ({ state: 'available' });
        expect(component.title).toBe('Update available');
        expect(component.body).toContain('unknown');
        updates.status = () => ({ state: 'error' });
        expect(component.body).toBe('Update failed.');
        updates.status = () => ({ state: 'up-to-date' });
        expect(component.body).toContain('current');
        updates.promptOpen = () => false;
        expect(component.showPrompt).toBe(false);
        component.ngAfterViewChecked();
    });

    it('traps focus and restores it on dismiss', () => {
        const anchor = document.createElement('button');
        anchor.id = 'update-prompt-primary';
        document.body.appendChild(anchor);
        try {
            updates.promptOpen = () => true;
            const before = document.createElement('button');
            document.body.appendChild(before);
            before.focus();
            component.ngAfterViewChecked();
            expect(document.activeElement).toBe(anchor);
            component.later();
            expect(document.activeElement).toBe(before);
            expect(updates.later).toHaveBeenCalled();
            before.remove();
        } finally {
            anchor.remove();
        }
    });

    it('wraps tab focus inside the dialog', () => {
        const dialog = document.createElement('div');
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');
        const first = document.createElement('button');
        const last = document.createElement('button');
        dialog.append(first, last);
        document.body.appendChild(dialog);
        try {
            first.focus();
            const shift = { key: 'Tab', shiftKey: true, preventDefault: vi.fn() } as any;
            component.onPromptKeydown(shift);
            expect(document.activeElement).toBe(last);
            expect(shift.preventDefault).toHaveBeenCalled();

            last.focus();
            const plain = { key: 'Tab', shiftKey: false, preventDefault: vi.fn() } as any;
            component.onPromptKeydown(plain);
            expect(document.activeElement).toBe(first);
        } finally {
            dialog.remove();
        }
    });

    it('ignores tab without dialog buttons or unrelated keys', () => {
        document.querySelectorAll('[role="dialog"]').forEach((d) => d.remove());
        const tab = { key: 'Tab', shiftKey: false, preventDefault: vi.fn() } as any;
        component.onPromptKeydown(tab);
        expect(tab.preventDefault).not.toHaveBeenCalled();
        component.onPromptKeydown({ key: 'Enter', preventDefault: vi.fn() } as any);
    });
});
