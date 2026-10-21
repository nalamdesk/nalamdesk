/**
 * In-app update feed configuration.
 *
 * Default: generic provider at `DEFAULT_UPDATE_FEED_URL`. nalamdesk.com
 * redirects that path to the public `nalamdesk/releases` GitHub Releases
 * (see `landing/src/pages/updates/desktop/[file].ts`), so the hosting can
 * move without shipping a new app.
 *
 * Overrides: `NALAMDESK_UPDATE_FEED_URL` points at another generic feed
 * (HTTPS; HTTP only for localhost). `NALAMDESK_UPDATE_PROVIDER=github`
 * reads GitHub Releases directly. `NALAMDESK_UPDATE_PROVIDER=generic`
 * without a feed URL disables updates.
 */

export type UpdateProviderKind = 'generic' | 'github';
export type SignatureMode = 'feed-checksum' | 'release-signed';
export type OsApplyMode = 'nsis' | 'dmg' | 'appimage-updater' | 'open-download-page';

export interface GenericUpdateFeed {
    provider: 'generic';
    url: string;
    signatureMode: 'feed-checksum';
    downloadPageUrl: string;
}

export interface GithubUpdateFeed {
    provider: 'github';
    owner: string;
    repo: string;
    signatureMode: SignatureMode;
    downloadPageUrl: string;
}

export type UpdateFeedConfig = GenericUpdateFeed | GithubUpdateFeed;

export const DEFAULT_UPDATE_FEED_URL = 'https://nalamdesk.com/updates/desktop';
export const DEFAULT_UPDATE_DOWNLOAD_PAGE = 'https://nalamdesk.com/#get';

export function resolveUpdateFeedConfig(env: NodeJS.Dict<string> = process.env): UpdateFeedConfig | null {
    const downloadPageUrl = trimSlash(env['NALAMDESK_UPDATE_DOWNLOAD_PAGE'] || DEFAULT_UPDATE_DOWNLOAD_PAGE);
    const provider = (env['NALAMDESK_UPDATE_PROVIDER'] || '').trim().toLowerCase();

    if (provider === 'github') {
        return {
            provider: 'github',
            owner: (env['NALAMDESK_UPDATE_GITHUB_OWNER'] || 'nalamdesk').trim(),
            repo: (env['NALAMDESK_UPDATE_GITHUB_REPO'] || 'releases').trim(),
            signatureMode: env['NALAMDESK_UPDATE_RELEASE_SIGNED'] === '1' ? 'release-signed' : 'feed-checksum',
            downloadPageUrl
        };
    }

    if (provider && provider !== 'generic') return null;
    const configured = (env['NALAMDESK_UPDATE_FEED_URL'] || '').trim();
    if (!configured && provider) return null;
    const url = configured || DEFAULT_UPDATE_FEED_URL;
    if (!isAllowedGenericFeedUrl(url)) return null;
    return {
        provider: 'generic',
        url: trimSlash(url),
        signatureMode: 'feed-checksum',
        downloadPageUrl
    };
}

export function toElectronUpdaterOptions(config: UpdateFeedConfig): Record<string, string> {
    if (config.provider === 'github') {
        return { provider: 'github', owner: config.owner, repo: config.repo };
    }
    return { provider: 'generic', url: config.url };
}

export function isNewerVersion(latest: string, current: string): boolean {
    return compareSemVer(latest, current) > 0;
}

export function hasInsecureUpdateArtifact(
    updateInfo: { files?: Array<{ url?: string }>; path?: string } | null | undefined
): boolean {
    const names = [updateInfo?.path || '', ...(updateInfo?.files || []).map((file) => file.url || '')];
    return names.some((name) => isAbsoluteInsecureUrl(name));
}

export function feedHasAppImage(updateInfo: { files?: Array<{ url?: string }>; path?: string } | null | undefined): boolean {
    const names = [updateInfo?.path || '', ...(updateInfo?.files || []).map((file) => file.url || '')];
    return names.some((name) => /\.AppImage(\?|$)/i.test(name));
}

export function resolveOsApplyPath(input: {
    platform: string;
    isAppImage: boolean;
    feedHasAppImage: boolean;
}): { mode: OsApplyMode; canQuitAndInstall: boolean } {
    if (input.platform === 'win32') return { mode: 'nsis', canQuitAndInstall: true };
    // Squirrel.Mac only installs signed apps; macOS builds are unsigned until notarization lands.
    if (input.platform === 'darwin') return { mode: 'open-download-page', canQuitAndInstall: false };
    if (input.platform === 'linux' && input.isAppImage && input.feedHasAppImage) {
        return { mode: 'appimage-updater', canQuitAndInstall: true };
    }
    return { mode: 'open-download-page', canQuitAndInstall: false };
}

export function signatureClaim(_mode?: SignatureMode): { verifiedSignature: boolean; integrityNote: string } {
    return {
        verifiedSignature: false,
        integrityNote: 'This feed lists package checksums. NalamDesk does not claim full code-signature verification.'
    };
}

export function plainUpdateError(error: unknown): string {
    const message = errorMessage(error);
    if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|net::ERR|offline|getaddrinfo/i.test(message)) {
        return 'Could not reach the update feed. Check the network and try again.';
    }
    if (/YAMLException|Cannot find channel|latest.*\.yml|status code 404|404 Not Found/i.test(message)) {
        return 'The update feed is missing or invalid.';
    }
    if (/SHA512|checksum|code signature|not signed/i.test(message)) {
        return 'The downloaded update did not match the feed checksum.';
    }
    if (/cancel/i.test(message)) {
        return 'Update download cancelled.';
    }
    const trimmed = message.trim();
    return trimmed || 'Update failed.';
}

export function formatReleaseNotes(notes: string | Array<{ note?: string }> | undefined): string {
    if (!notes) return '';
    if (typeof notes === 'string') return notes.trim();
    return notes.map((item) => String(item?.note || '').trim()).filter(Boolean).join('\n');
}

function compareSemVer(latest: string, current: string): number {
    const next = parseSemVer(latest);
    const running = parseSemVer(current);
    for (let i = 0; i < 3; i++) {
        if (next.core[i] !== running.core[i]) return next.core[i] > running.core[i] ? 1 : -1;
    }
    if (next.pre.length === 0 && running.pre.length === 0) return 0;
    if (next.pre.length === 0) return 1;
    if (running.pre.length === 0) return -1;
    return comparePrerelease(next.pre, running.pre);
}

function comparePrerelease(left: Array<string | number>, right: Array<string | number>): number {
    const len = Math.max(left.length, right.length);
    for (let i = 0; i < len; i++) {
        if (i >= left.length) return -1;
        if (i >= right.length) return 1;
        const l = left[i];
        const r = right[i];
        if (l === r) continue;
        if (typeof l === 'number' && typeof r === 'number') return l > r ? 1 : -1;
        if (typeof l === 'number') return -1;
        if (typeof r === 'number') return 1;
        return String(l) > String(r) ? 1 : -1;
    }
    return 0;
}

function parseSemVer(value: string): { core: [number, number, number]; pre: Array<string | number> } {
    const raw = String(value || '').replace(/^v/i, '').trim();
    const dash = raw.indexOf('-');
    const corePart = dash === -1 ? raw : raw.slice(0, dash);
    const prePart = dash === -1 ? '' : raw.slice(dash + 1);
    const coreNums = corePart.split('.');
    const core: [number, number, number] = [toInt(coreNums[0]), toInt(coreNums[1]), toInt(coreNums[2])];
    if (!prePart) return { core, pre: [] };
    const pre = prePart.split('.').map((id) => (/^\d+$/.test(id) ? toInt(id) : id));
    return { core, pre };
}

function isAbsoluteInsecureUrl(value: string): boolean {
    try {
        return new URL(value).protocol !== 'https:';
    } catch {
        return false;
    }
}

function toInt(part: string | undefined): number {
    const parsed = Number.parseInt(part || '0', 10);
    return Number.isFinite(parsed) ? parsed : 0;
}

function trimSlash(url: string): string {
    let end = url.length;
    while (end > 0 && url.charAt(end - 1) === '/') end -= 1;
    return url.slice(0, end);
}

function errorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (typeof error === 'string') return error;
    return '';
}

function isAllowedGenericFeedUrl(url: string): boolean {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return false;
    }
    if (parsed.protocol === 'https:') return true;
    if (parsed.protocol !== 'http:') return false;
    const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}
