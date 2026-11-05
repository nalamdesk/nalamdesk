import * as fs from 'fs';
import * as path from 'path';
import { FolderTarget } from '../../server/headless/offsite';

/**
 * The folder each daily backup is also copied to on the desktop: the one an
 * admin chose, such as a Google Drive for desktop or OneDrive folder, a USB
 * disk or a network share. It replaces the retired Google Drive upload, and
 * uses the same folder target as NalamDesk Server's off-site copy (#216).
 *
 * None when unset, when it is the app's own backup folder, or when an older
 * setup saved a placeholder name instead of a folder.
 */
export function backupCopyTarget(folder: unknown, appBackupFolder: string): FolderTarget | null {
    const chosen = typeof folder === 'string' ? folder.trim() : '';
    if (!chosen || !path.isAbsolute(chosen)) return null;
    if (path.resolve(chosen) === path.resolve(appBackupFolder)) return null;
    return new FolderTarget(chosen);
}

/** Refuses a backup folder that is not an existing folder, before it is saved. Empty is allowed. */
export function assertBackupFolder(folder: unknown): void {
    if (folder == null || folder === '') return;
    const chosen = typeof folder === 'string' ? folder.trim() : '';
    if (!chosen || !path.isAbsolute(chosen)) throw new Error('Choose a backup folder.');
    let isFolder = false;
    try { isFolder = fs.statSync(chosen).isDirectory(); } catch { /* reported below */ }
    if (!isFolder) throw new Error(`${chosen} is not an available folder. Check that the drive is connected.`);
}
