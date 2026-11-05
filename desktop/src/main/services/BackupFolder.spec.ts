import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { assertBackupFolder, backupCopyTarget } from './BackupFolder';
import { FolderTarget } from '../../server/headless/offsite';

describe('desktop backup copy folder', () => {
    let root: string;
    let appFolder: string;
    let chosen: string;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-backup-folder-'));
        appFolder = path.join(root, 'app', 'backups');
        chosen = path.join(root, 'Google Drive', 'NalamDesk');
        fs.mkdirSync(appFolder, { recursive: true });
        fs.mkdirSync(chosen, { recursive: true });
    });
    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

    it('copies to a chosen folder, and to none for unset, placeholder or app folders', () => {
        const target = backupCopyTarget(` ${chosen} `, appFolder);
        expect(target).toBeInstanceOf(FolderTarget);
        expect(target!.description).toBe(`folder ${chosen}`);
        for (const none of [undefined, null, '', '   ', 'NalamDesk_Backups', appFolder, `${appFolder}${path.sep}`, 42]) {
            expect(backupCopyTarget(none, appFolder)).toBeNull();
        }
    });

    it('copies a backup bundle into the chosen folder', async () => {
        const bundle = path.join(appFolder, 'nalamdesk-auto-backup-2026-11-05.ndbackup');
        fs.writeFileSync(bundle, 'encrypted');
        await backupCopyTarget(chosen, appFolder)!.uploadFile(bundle, path.basename(bundle));
        expect(fs.readFileSync(path.join(chosen, path.basename(bundle)), 'utf8')).toBe('encrypted');
    });

    it('accepts an existing folder or empty, and refuses anything else before saving', () => {
        expect(() => assertBackupFolder(chosen)).not.toThrow();
        expect(() => assertBackupFolder('')).not.toThrow();
        expect(() => assertBackupFolder(null)).not.toThrow();
        expect(() => assertBackupFolder('NalamDesk_Backups')).toThrow('Choose a backup folder.');
        expect(() => assertBackupFolder(42)).toThrow('Choose a backup folder.');
        expect(() => assertBackupFolder(path.join(root, 'unplugged'))).toThrow('is not an available folder');
        const file = path.join(root, 'file.txt');
        fs.writeFileSync(file, 'x');
        expect(() => assertBackupFolder(file)).toThrow('is not an available folder');
    });
});
