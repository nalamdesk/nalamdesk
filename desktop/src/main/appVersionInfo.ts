import * as fs from 'node:fs';
import * as path from 'node:path';

export interface BuildIdentity {
    version?: string;
    commit?: string | null;
    buildId?: string | null;
    /** NalamDesk Cloud addresses for this release (#154). */
    relayUrl?: string | null;
    bookingApiUrl?: string | null;
}

export interface AppVersionInfo {
    version: string;
    commit: string | null;
    buildId: string | null;
    isDev: boolean;
    packaged: boolean;
    display: string;
}

export function buildIdentityPath(appPath: string): string {
    return path.join(appPath, 'build-identity.json');
}

export function readBuildIdentityFile(identityPath: string, readFile = (file: string) => fs.readFileSync(file, 'utf8')): BuildIdentity | null {
    try {
        const parsed = JSON.parse(readFile(identityPath)) as BuildIdentity;
        if (!parsed || typeof parsed !== 'object') return null;
        return parsed;
    } catch {
        return null;
    }
}

export function shortCommit(commit: string | null | undefined): string | null {
    if (!commit || typeof commit !== 'string') return null;
    const trimmed = commit.trim();
    if (!trimmed) return null;
    return trimmed.slice(0, 7);
}

export function formatAppVersionDisplay(input: {
    version: string;
    isDev: boolean;
    commit?: string | null;
}): string {
    const sha = shortCommit(input.commit);
    if (input.isDev) {
        return sha ? `${input.version} (development, ${sha})` : `${input.version} (development)`;
    }
    return sha ? `${input.version} (${sha})` : input.version;
}

export function resolveAppVersionInfo(input: {
    version: string;
    isPackaged: boolean;
    isDev: boolean;
    identity?: BuildIdentity | null;
}): AppVersionInfo {
    const commit = input.identity?.commit || null;
    const buildId = input.identity?.buildId || null;
    return {
        version: input.version,
        commit,
        buildId,
        isDev: input.isDev,
        packaged: input.isPackaged,
        display: formatAppVersionDisplay({
            version: input.version,
            isDev: input.isDev,
            commit
        })
    };
}

export function loadAppVersionInfo(app: {
    getVersion(): string;
    isPackaged: boolean;
    getAppPath(): string;
}, isDev: boolean): AppVersionInfo {
    const identity = readBuildIdentityFile(buildIdentityPath(app.getAppPath()));
    return resolveAppVersionInfo({
        version: app.getVersion(),
        isPackaged: app.isPackaged,
        isDev,
        identity
    });
}

const SEMVER_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

/**
 * Reads a semver version from `<dir>/package.json`. Used to pin
 * `app.setVersion()` for unpacked dev runs on platforms without bundled
 * version metadata (Linux), where `app.getVersion()` would otherwise resolve
 * to "0.0" and crash electron-updater at first access. Returns null unless a
 * valid semver version is found, so callers never pin a bad value.
 */
export function readPackageVersion(packageDir: string, readFile = (p: string) => fs.readFileSync(p, 'utf8')): string | null {
    try {
        const parsed = JSON.parse(readFile(path.join(packageDir, 'package.json'))) as { version?: unknown };
        const version = typeof parsed?.version === 'string' ? parsed.version.trim() : '';
        return SEMVER_RE.test(version) ? version : null;
    } catch {
        return null;
    }
}
