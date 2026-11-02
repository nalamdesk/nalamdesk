import type { IpcMain } from 'electron';
import {
    feedHasAppImage,
    formatReleaseNotes,
    hasInsecureUpdateArtifact,
    isNewerVersion,
    plainUpdateError,
    resolveOsApplyPath,
    resolveUpdateFeedConfig,
    signatureClaim,
    toElectronUpdaterOptions,
    type OsApplyMode,
    type SignatureMode,
    type UpdateFeedConfig
} from './updateFeed';

export type UpdateCheckSource = 'startup' | 'manual';
export type UpdateState =
    | 'idle'
    | 'skipped'
    | 'checking'
    | 'up-to-date'
    | 'available'
    | 'downloading'
    | 'downloaded'
    | 'error';

export interface UpdateInfoLike {
    version: string;
    releaseNotes?: string | Array<{ note?: string }>;
    files?: Array<{ url?: string }>;
    path?: string;
}

export interface UpdaterPort {
    autoDownload: boolean;
    autoInstallOnAppQuit: boolean;
    setFeedURL(options: unknown): void;
    checkForUpdates(): Promise<{ updateInfo: UpdateInfoLike } | null>;
    downloadUpdate(cancelToken?: CancelToken): Promise<unknown>;
    quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
    on(event: string, listener: (...args: any[]) => void): void;
    logger?: unknown;
}

export interface CancelToken {
    cancelled: boolean;
    cancel(): void;
}

export interface UpdateStatus {
    state: UpdateState;
    source: UpdateCheckSource;
    reason?: string;
    currentVersion: string;
    availableVersion?: string;
    releaseNotes?: string;
    percent?: number;
    error?: string;
    applyMode: OsApplyMode;
    canQuitAndInstall: boolean;
    downloadPageUrl?: string;
    verifiedSignature: boolean;
    integrityNote: string;
    packaged: boolean;
}

export interface UpdateServiceDeps {
    updater: UpdaterPort;
    isPackaged: boolean;
    env: NodeJS.Dict<string>;
    platform: string;
    isAppImage: boolean;
    getVersion: () => string;
    send: (channel: string, payload: UpdateStatus) => void;
    openExternal: (url: string) => Promise<void> | void;
}

function createCancelToken(): CancelToken {
    try {
        const runtime = require('builder-util-runtime') as { CancellationToken: new () => CancelToken };
        return new runtime.CancellationToken();
    } catch {
        const token: CancelToken = {
            cancelled: false,
            cancel() {
                token.cancelled = true;
            }
        };
        return token;
    }
}

export class DesktopUpdateService {
    private status: UpdateStatus;
    private readonly feed: UpdateFeedConfig | null;
    private cancelToken: CancelToken | null = null;
    private lastInfo: UpdateInfoLike | null = null;
    private configured = false;

    constructor(private readonly deps: UpdateServiceDeps) {
        this.feed = resolveUpdateFeedConfig(deps.env);
        this.status = this.baseStatus('idle');
        this.wireUpdaterEvents();
    }

    getStatus(): UpdateStatus {
        return { ...this.status };
    }

    async check(opts?: { source?: UpdateCheckSource }): Promise<UpdateStatus> {
        const source = opts?.source || 'manual';
        if (!this.deps.isPackaged) {
            return this.publish(this.baseStatus('skipped', source, 'unpackaged'));
        }
        if (!this.feed) {
            return this.publish(this.baseStatus('skipped', source, 'no-feed'));
        }

        this.configureUpdater();
        this.publish({ ...this.baseStatus('checking', source) });
        try {
            const result = await this.deps.updater.checkForUpdates();
            return this.applyCheckResult(result?.updateInfo, source);
        } catch (error) {
            return this.fail(source, error);
        }
    }

    async download(): Promise<UpdateStatus> {
        if (!this.deps.isPackaged || !this.feed) {
            return this.check({ source: 'manual' });
        }
        if (this.status.state === 'downloading' || this.status.state === 'downloaded') {
            return this.getStatus();
        }
        if (this.status.state !== 'available') {
            return this.fail('manual', new Error('No update is ready to download.'));
        }
        if (!this.status.canQuitAndInstall) {
            const url = this.status.downloadPageUrl;
            if (url) await this.deps.openExternal(url);
            return this.getStatus();
        }
        if (!this.lastInfo) {
            return this.fail('manual', new Error('No update is ready to download.'));
        }

        this.configureUpdater();
        this.cancelToken = createCancelToken();
        this.publish({ ...this.status, state: 'downloading', percent: 0, error: undefined });
        try {
            await this.deps.updater.downloadUpdate(this.cancelToken);
            if (this.cancelToken.cancelled) {
                return this.publish({ ...this.status, state: 'available', percent: undefined });
            }
            return this.publish({ ...this.status, state: 'downloaded', percent: 100 });
        } catch (error) {
            if (this.cancelToken?.cancelled) {
                return this.publish({ ...this.status, state: 'available', percent: undefined, error: undefined });
            }
            return this.fail(this.status.source, error);
        }
    }

    async install(): Promise<UpdateStatus> {
        if (this.status.state === 'downloaded' && this.status.canQuitAndInstall) {
            this.deps.updater.quitAndInstall(false, true);
            return this.getStatus();
        }
        if (!this.status.canQuitAndInstall) {
            const url = this.status.downloadPageUrl;
            if (url) await this.deps.openExternal(url);
        }
        return this.getStatus();
    }

    cancel(): UpdateStatus {
        this.cancelToken?.cancel();
        if (this.status.state === 'downloading') {
            return this.publish({ ...this.status, state: 'available', percent: undefined });
        }
        return this.getStatus();
    }

    private applyCheckResult(info: UpdateInfoLike | undefined, source: UpdateCheckSource): UpdateStatus {
        this.lastInfo = info || null;
        if (hasInsecureUpdateArtifact(info)) {
            return this.fail(source, new Error('The update feed listed an insecure HTTP download.'));
        }
        const currentVersion = this.deps.getVersion();
        const availableVersion = info?.version || '';
        const apply = resolveOsApplyPath({
            platform: this.deps.platform,
            isAppImage: this.deps.isAppImage,
            feedHasAppImage: feedHasAppImage(info)
        });
        const claim = signatureClaim(this.signatureMode());
        if (!availableVersion || !isNewerVersion(availableVersion, currentVersion)) {
            return this.publish({
                ...this.baseStatus('up-to-date', source),
                ...claim,
                applyMode: apply.mode,
                canQuitAndInstall: apply.canQuitAndInstall
            });
        }
        return this.publish({
            ...this.baseStatus('available', source),
            availableVersion,
            releaseNotes: formatReleaseNotes(info?.releaseNotes),
            applyMode: apply.mode,
            canQuitAndInstall: apply.canQuitAndInstall,
            ...claim
        });
    }

    private configureUpdater(): void {
        if (this.configured || !this.feed) return;
        this.deps.updater.autoDownload = false;
        this.deps.updater.autoInstallOnAppQuit = false;
        this.deps.updater.setFeedURL(toElectronUpdaterOptions(this.feed));
        this.configured = true;
    }

    private wireUpdaterEvents(): void {
        this.deps.updater.on('download-progress', (progress: { percent?: number }) => {
            if (this.status.state !== 'downloading') return;
            this.publish({ ...this.status, percent: Math.round(progress?.percent || 0) });
        });
        this.deps.updater.on('update-downloaded', () => {
            if (this.cancelToken?.cancelled) return;
            if (this.status.state !== 'downloading' && this.status.state !== 'downloaded') return;
            this.publish({ ...this.status, state: 'downloaded', percent: 100 });
        });
        this.deps.updater.on('error', (error: unknown) => {
            if (this.cancelToken?.cancelled) return;
            this.fail(this.status.source, error);
        });
    }

    private fail(source: UpdateCheckSource, error: unknown): UpdateStatus {
        const claim = signatureClaim(this.signatureMode());
        return this.publish({
            ...this.baseStatus('error', source),
            error: plainUpdateError(error),
            ...claim
        });
    }

    private baseStatus(state: UpdateState, source: UpdateCheckSource = 'manual', reason?: string): UpdateStatus {
        const claim = signatureClaim(this.signatureMode());
        return {
            state,
            source,
            reason,
            currentVersion: this.deps.getVersion(),
            applyMode: 'open-download-page',
            canQuitAndInstall: false,
            downloadPageUrl: this.feed?.downloadPageUrl,
            packaged: this.deps.isPackaged,
            ...claim
        };
    }

    private signatureMode(): SignatureMode {
        return this.feed?.signatureMode || 'feed-checksum';
    }

    private publish(status: UpdateStatus): UpdateStatus {
        this.status = status;
        this.deps.send('updates:event', status);
        return this.getStatus();
    }
}

export function createUpdateService(deps: UpdateServiceDeps): DesktopUpdateService {
    return new DesktopUpdateService(deps);
}

/**
 * Binds the renderer's update calls. `allow` rejects calls from any page
 * other than the app's own window (client mode passes one, #211).
 */
export function bindUpdateIpc(
    ipcMain: Pick<IpcMain, 'handle'>,
    service: DesktopUpdateService,
    allow: (event: unknown) => boolean = () => true
): void {
    const guard = <T>(run: (opts?: unknown) => T) => (event: unknown, opts?: unknown): T | UpdateStatus =>
        allow(event) ? run(opts) : service.getStatus();
    ipcMain.handle('updates:check', guard((opts) => service.check(opts as { source?: UpdateCheckSource } | undefined)));
    ipcMain.handle('updates:download', guard(() => service.download()));
    ipcMain.handle('updates:install', guard(() => service.install()));
    ipcMain.handle('updates:cancel', guard(() => service.cancel()));
    ipcMain.handle('updates:status', guard(() => service.getStatus()));
}
