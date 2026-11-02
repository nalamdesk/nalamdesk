import { Injectable, NgZone, signal } from '@angular/core';

export interface AppUpdateStatus {
    state: string;
    source?: 'startup' | 'manual';
    reason?: string;
    currentVersion?: string;
    availableVersion?: string;
    releaseNotes?: string;
    percent?: number;
    error?: string;
    applyMode?: string;
    canQuitAndInstall?: boolean;
    downloadPageUrl?: string;
    verifiedSignature?: boolean;
    integrityNote?: string;
    packaged?: boolean;
}

export interface AppUpdatesApi {
    check(opts?: { source?: 'startup' | 'manual' }): Promise<AppUpdateStatus>;
    download(): Promise<AppUpdateStatus>;
    install(): Promise<AppUpdateStatus>;
    cancel(): Promise<AppUpdateStatus>;
    getStatus(): Promise<AppUpdateStatus>;
    onEvent(callback: (status: AppUpdateStatus) => void): () => void;
}

/**
 * The app's updater: the single-PC preload's `electron.updates`, or the
 * client-mode preload's `nalamdeskClient.updates` (#211). Browsers have none.
 */
export function appUpdatesApi(): AppUpdatesApi | null {
    const g = globalThis as { electron?: { updates?: AppUpdatesApi }; nalamdeskClient?: { updates?: AppUpdatesApi } };
    return g.electron?.updates ?? g.nalamdeskClient?.updates ?? null;
}

@Injectable({ providedIn: 'root' })
export class AppUpdateService {
    readonly status = signal<AppUpdateStatus>({ state: 'idle' });
    readonly promptOpen = signal(false);
    private unsubscribe: (() => void) | null = null;
    private started = false;

    constructor(private readonly ngZone: NgZone) { }

    /** True when this app can update itself (not in a browser). */
    get available(): boolean {
        return !!appUpdatesApi();
    }

    init(): void {
        if (this.started) return;
        this.started = true;
        const api = appUpdatesApi();
        if (!api) return;
        this.unsubscribe = api.onEvent((status: AppUpdateStatus) => {
            this.ngZone.run(() => this.applyStatus(status));
        });
        this.checkStartup().catch(() => undefined);
    }

    destroy(): void {
        this.unsubscribe?.();
        this.unsubscribe = null;
    }

    async check(source: 'startup' | 'manual' = 'manual'): Promise<AppUpdateStatus> {
        const api = appUpdatesApi();
        if (!api) return this.status();
        const status = await api.check({ source });
        this.applyStatus(status);
        return status;
    }

    async updateNow(): Promise<void> {
        const api = appUpdatesApi();
        if (!api) return;
        const afterDownload = await api.download();
        this.applyStatus(afterDownload);
        if (afterDownload.state === 'downloaded') {
            await this.install();
        }
    }

    async install(): Promise<void> {
        const api = appUpdatesApi();
        if (!api) return;
        const status = await api.install();
        this.applyStatus(status);
    }

    later(): void {
        this.promptOpen.set(false);
    }

    async cancelDownload(): Promise<void> {
        const api = appUpdatesApi();
        if (!api) return;
        const status = await api.cancel();
        this.applyStatus(status);
    }

    private async checkStartup(): Promise<void> {
        try {
            const electron = (globalThis as any).electron;
            const info = electron?.getAppVersion
                ? await electron.getAppVersion()
                : await appUpdatesApi()?.getStatus();
            if (!info?.packaged) return;
            await this.check('startup');
        } catch {
            // Launch check is best-effort; the running app stays usable.
        }
    }

    private applyStatus(status: AppUpdateStatus): void {
        this.status.set(status || { state: 'idle' });
        const state = status?.state;
        const manual = status?.source === 'manual';
        const shouldPrompt = state === 'available'
            || state === 'downloading'
            || state === 'downloaded'
            || state === 'error'
            || (manual && (state === 'up-to-date' || state === 'skipped'));
        if (shouldPrompt) this.promptOpen.set(true);
    }
}
