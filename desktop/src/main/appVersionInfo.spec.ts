import { describe, expect, it } from 'vitest';
import {
    formatAppVersionDisplay,
    loadAppVersionInfo,
    readBuildIdentityFile,
    readPackageVersion,
    resolveAppVersionInfo,
    shortCommit
} from './appVersionInfo';

describe('app version display', () => {
    it('labels development builds and never uses a hard-coded 0.0.0', () => {
        expect(formatAppVersionDisplay({ version: '0.0.8', isDev: true })).toBe('0.0.8 (development)');
        expect(formatAppVersionDisplay({
            version: '0.0.8',
            isDev: true,
            commit: 'abcdef1234567890'
        })).toBe('0.0.8 (development, abcdef1)');
        expect(formatAppVersionDisplay({ version: '0.0.8', isDev: false })).toBe('0.0.8');
        expect(formatAppVersionDisplay({
            version: '0.0.8',
            isDev: false,
            commit: 'abcdef1234567890'
        })).toBe('0.0.8 (abcdef1)');
    });

    it('reads packaged app.getVersion() plus embedded commit/build id', () => {
        const info = resolveAppVersionInfo({
            version: '0.0.8',
            isPackaged: true,
            isDev: false,
            identity: { version: '0.0.8', commit: 'deadbeefcafebabe', buildId: '12345' }
        });
        expect(info.version).toBe('0.0.8');
        expect(info.packaged).toBe(true);
        expect(info.isDev).toBe(false);
        expect(info.commit).toBe('deadbeefcafebabe');
        expect(info.buildId).toBe('12345');
        expect(info.display).toBe('0.0.8 (deadbee)');
        expect(shortCommit('deadbeefcafebabe')).toBe('deadbee');
    });

    it('loads identity from the packaged app path', () => {
        const identityPath = '/tmp/nalamdesk-app/build-identity.json';
        const info = loadAppVersionInfo({
            getVersion: () => '0.0.8',
            isPackaged: true,
            getAppPath: () => '/tmp/nalamdesk-app'
        }, false);
        expect(info.version).toBe('0.0.8');
        expect(info.display).toBe('0.0.8');
        expect(identityPath.endsWith('build-identity.json')).toBe(true);
    });

    it('returns parsed identity objects and rejects non-objects', () => {
        expect(readBuildIdentityFile('identity.json', () => JSON.stringify({
            version: '0.0.8',
            commit: 'abcdef1'
        }))).toEqual({ version: '0.0.8', commit: 'abcdef1' });
        expect(readBuildIdentityFile('identity.json', () => 'null')).toBeNull();
        expect(readBuildIdentityFile('identity.json', () => '"not-an-object"')).toBeNull();
    });

    it('reads a semver package version for unpacked-run pinning', () => {
        const read = (content: string) => () => content;
        expect(readPackageVersion('/any', read(JSON.stringify({ version: '0.0.11' })))).toBe('0.0.11');
        expect(readPackageVersion('/any', read(JSON.stringify({ version: ' 1.2.3-beta.1 ' })))).toBe('1.2.3-beta.1');
    });

    it('rejects missing, malformed, or non-semver versions instead of pinning them', () => {
        const read = (content: string) => () => content;
        expect(readPackageVersion('/any', read(JSON.stringify({ version: '0.0' })))).toBeNull();
        expect(readPackageVersion('/any', read(JSON.stringify({ name: 'x' })))).toBeNull();
        expect(readPackageVersion('/any', read('not json'))).toBeNull();
        expect(readPackageVersion('/any', () => { throw new Error('unreadable'); })).toBeNull();
    });
});
