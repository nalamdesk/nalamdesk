import { google } from 'googleapis';
import { app, BrowserWindow, shell } from 'electron';
import * as crypto from 'node:crypto';
import * as fs from 'fs';
import { pipeline } from 'node:stream/promises';
import { getApiPort } from '../../shared/runtime-config';

function getRedirectUri(): string {
    const port = getApiPort(app.isPackaged);
    return `http://localhost:${port}/oauth2callback`;
}

export class GoogleDriveService {
    private oauth2Client: any = null;
    private drive: any = null;
    private tokens: any = null;
    private clientId: string = '';
    private clientSecret: string = '';

    configureCredentials(clientId: string, clientSecret: string) {
        this.clientId = clientId;
        this.clientSecret = clientSecret;

        if (this.clientId && this.clientSecret) {
            this.oauth2Client = new google.auth.OAuth2(
                this.clientId,
                this.clientSecret,
                getRedirectUri()
            );
            this.drive = google.drive({ version: 'v3', auth: this.oauth2Client });
        }
    }

    setCredentials(tokens: any) {
        this.tokens = tokens;
        if (this.oauth2Client) {
            this.oauth2Client.setCredentials(tokens);
        }
    }

    getCredentials() {
        return this.tokens;
    }

    isAuthenticated(): boolean {
        return !!this.tokens && !!this.oauth2Client;
    }

    async authenticate(
        _mainWindow: BrowserWindow,
        waitForCallback: (state: string) => Promise<string>
    ): Promise<boolean> {
        if (!this.oauth2Client) {
            throw new Error('Google Drive Client ID and Secret not configured.');
        }

        const state = crypto.randomBytes(32).toString('hex');
        const codePromise = waitForCallback(state);

        const authUrl = this.oauth2Client.generateAuthUrl({
            access_type: 'offline',
            scope: ['https://www.googleapis.com/auth/drive.file'],
            state,
        });

        await shell.openExternal(authUrl);
        const code = await codePromise;
        const { tokens } = await this.oauth2Client.getToken(code);
        this.setCredentials(tokens);
        return true;
    }

    private async getOrCreateBackupFolder(): Promise<string> {
        if (!this.tokens) throw new Error('Not authenticated');

        const q = "mimeType = 'application/vnd.google-apps.folder' and name = 'NalamDesk Backups' and trashed = false";
        const res = await this.drive.files.list({
            q: q,
            fields: 'files(id, name)',
            spaces: 'drive'
        });

        if (res.data.files && res.data.files.length > 0) {
            return res.data.files[0].id;
        }

        const fileMetadata = {
            name: 'NalamDesk Backups',
            mimeType: 'application/vnd.google-apps.folder'
        };

        const folder = await this.drive.files.create({
            requestBody: fileMetadata,
            fields: 'id'
        });

        return folder.data.id;
    }

    async uploadFile(filePath: string, name: string) {
        if (!this.tokens) throw new Error('Not authenticated');

        await this.oauth2Client.getAccessToken();

        const folderId = await this.getOrCreateBackupFolder();

        const fileMetadata = {
            name: name,
            parents: [folderId]
        };

        const media = {
            mimeType: 'application/x-sqlite3',
            body: fs.createReadStream(filePath)
        };

        const res = await this.drive.files.create({
            requestBody: fileMetadata,
            media: media,
            fields: 'id'
        });

        return res.data;
    }

    async listBackups() {
        if (!this.tokens) throw new Error('Not authenticated');

        try {
            const folderId = await this.getOrCreateBackupFolder();

            const res = await this.drive.files.list({
                q: `'${folderId}' in parents and trashed = false`,
                fields: 'files(id, name, createdTime, size)',
                orderBy: 'createdTime desc'
            });

            return res.data.files;
        } catch (e) {
            console.error('Error listing backups:', e);
            return [];
        }
    }

    async downloadFile(fileId: string, destPath: string): Promise<void> {
        if (!this.tokens) throw new Error('Not authenticated');

        const res = await this.drive.files.get(
            { fileId, alt: 'media' },
            { responseType: 'stream' }
        );
        // Settles only once the file is flushed and closed; on failure both
        // streams are destroyed first, so no write lands after we return.
        await pipeline(res.data, fs.createWriteStream(destPath));
    }
}
