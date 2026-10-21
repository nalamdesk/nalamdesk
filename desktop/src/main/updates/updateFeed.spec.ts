import { describe, expect, it } from 'vitest';
import {
    feedHasAppImage,
    formatReleaseNotes,
    hasInsecureUpdateArtifact,
    isNewerVersion,
    plainUpdateError,
    resolveOsApplyPath,
    resolveUpdateFeedConfig,
    signatureClaim,
    toElectronUpdaterOptions
} from './updateFeed';

describe('update feed resolver', () => {
    it('defaults to the nalamdesk.com feed when nothing is configured', () => {
        expect(resolveUpdateFeedConfig({})).toEqual({
            provider: 'generic',
            url: 'https://nalamdesk.com/updates/desktop',
            signatureMode: 'feed-checksum',
            downloadPageUrl: 'https://nalamdesk.com/#get'
        });
    });

    it('fails closed for an explicit generic provider without a feed URL', () => {
        expect(resolveUpdateFeedConfig({ NALAMDESK_UPDATE_PROVIDER: 'generic' })).toBeNull();
        expect(resolveUpdateFeedConfig({ NALAMDESK_UPDATE_PROVIDER: 'generic', NALAMDESK_UPDATE_FEED_URL: ' ' })).toBeNull();
    });

    it('fails closed for an unknown provider even with a feed URL', () => {
        expect(resolveUpdateFeedConfig({
            NALAMDESK_UPDATE_PROVIDER: 'gitub',
            NALAMDESK_UPDATE_FEED_URL: 'https://updates.example.clinic/nalamdesk'
        })).toBeNull();
    });

    it('uses the documented generic feed URL without GitHub Releases', () => {
        const config = resolveUpdateFeedConfig({
            NALAMDESK_UPDATE_FEED_URL: 'https://updates.example.clinic/nalamdesk/'
        });
        expect(config).toEqual({
            provider: 'generic',
            url: 'https://updates.example.clinic/nalamdesk',
            signatureMode: 'feed-checksum',
            downloadPageUrl: 'https://nalamdesk.com/#get'
        });
        expect(toElectronUpdaterOptions(config!)).toEqual({
            provider: 'generic',
            url: 'https://updates.example.clinic/nalamdesk'
        });
        expect(signatureClaim(config!.signatureMode).verifiedSignature).toBe(false);
    });

    it('rejects plaintext HTTP generic feeds except localhost', () => {
        expect(resolveUpdateFeedConfig({
            NALAMDESK_UPDATE_FEED_URL: 'http://updates.example.clinic/nalamdesk'
        })).toBeNull();
        expect(resolveUpdateFeedConfig({
            NALAMDESK_UPDATE_FEED_URL: 'ftp://updates.example.clinic/nalamdesk'
        })).toBeNull();
        expect(resolveUpdateFeedConfig({
            NALAMDESK_UPDATE_FEED_URL: 'not a url'
        })).toBeNull();

        const loopback = resolveUpdateFeedConfig({
            NALAMDESK_UPDATE_FEED_URL: 'http://127.0.0.1:8080/nalamdesk/'
        });
        expect(loopback).toEqual({
            provider: 'generic',
            url: 'http://127.0.0.1:8080/nalamdesk',
            signatureMode: 'feed-checksum',
            downloadPageUrl: 'https://nalamdesk.com/#get'
        });
        expect(resolveUpdateFeedConfig({
            NALAMDESK_UPDATE_FEED_URL: 'http://localhost/nalamdesk'
        })?.url).toBe('http://localhost/nalamdesk');
    });

    it('leaves a github provider seam without rewriting IPC', () => {
        const config = resolveUpdateFeedConfig({
            NALAMDESK_UPDATE_PROVIDER: 'github',
            NALAMDESK_UPDATE_RELEASE_SIGNED: '1',
            NALAMDESK_UPDATE_DOWNLOAD_PAGE: 'https://clinic.example/download'
        });
        expect(config?.provider).toBe('github');
        expect(toElectronUpdaterOptions(config!)).toEqual({
            provider: 'github',
            owner: 'nalamdesk',
            repo: 'releases'
        });
        expect(signatureClaim(config!.signatureMode).verifiedSignature).toBe(false);
    });
});

describe('version compare and OS apply path', () => {
    it('detects a newer feed version', () => {
        expect(isNewerVersion('0.0.9', '0.0.8')).toBe(true);
        expect(isNewerVersion('0.0.8', '0.0.8')).toBe(false);
        expect(isNewerVersion('0.0.7', '0.0.8')).toBe(false);
        expect(isNewerVersion('1.0.0-rc.2', '1.0.0-rc.1')).toBe(true);
        expect(isNewerVersion('1.0.0', '1.0.0-rc.1')).toBe(true);
        expect(isNewerVersion('1.0.0-rc.1', '1.0.0')).toBe(false);
    });

    it('applies Windows NSIS and Linux AppImage in-app', () => {
        expect(resolveOsApplyPath({ platform: 'win32', isAppImage: false, feedHasAppImage: false }))
            .toEqual({ mode: 'nsis', canQuitAndInstall: true });
        expect(resolveOsApplyPath({ platform: 'linux', isAppImage: true, feedHasAppImage: true }))
            .toEqual({ mode: 'appimage-updater', canQuitAndInstall: true });
    });

    it('falls back to the download page for unsigned macOS builds', () => {
        expect(resolveOsApplyPath({ platform: 'darwin', isAppImage: false, feedHasAppImage: false }))
            .toEqual({ mode: 'open-download-page', canQuitAndInstall: false });
    });

    it('falls back to the download page for Linux .deb or a missing AppImage', () => {
        expect(resolveOsApplyPath({ platform: 'linux', isAppImage: false, feedHasAppImage: true }).mode)
            .toBe('open-download-page');
        expect(resolveOsApplyPath({ platform: 'linux', isAppImage: true, feedHasAppImage: false }).mode)
            .toBe('open-download-page');
        expect(feedHasAppImage({ path: 'NalamDesk-0.0.9.AppImage' })).toBe(true);
        expect(feedHasAppImage({ files: [{ url: 'nalamdesk-desktop_0.0.9_amd64.deb' }] })).toBe(false);
        expect(hasInsecureUpdateArtifact({ path: 'NalamDesk-Setup-0.0.9.exe' })).toBe(false);
        expect(hasInsecureUpdateArtifact({ files: [{ url: 'https://updates.example.clinic/nalamdesk.exe' }] })).toBe(false);
        expect(hasInsecureUpdateArtifact({ files: [{ url: 'http://evil.example/nalamdesk.exe' }] })).toBe(true);
        expect(hasInsecureUpdateArtifact({ files: [{ url: 'http://127.0.0.1/nalamdesk.exe' }] })).toBe(true);
    });
});

describe('plain update errors', () => {
    it('maps offline and bad-feed failures without technical noise', () => {
        expect(plainUpdateError(new Error('getaddrinfo ENOTFOUND updates.example'))).toMatch(/network/i);
        expect(plainUpdateError(new Error('Cannot find channel latest.yml'))).toMatch(/feed/i);
        expect(plainUpdateError(new Error('SHA512 checksum mismatch'))).toMatch(/checksum/i);
        expect(formatReleaseNotes([{ note: 'Fix queue' }, { note: 'Rx typeahead' }])).toContain('Fix queue');
    });
});
