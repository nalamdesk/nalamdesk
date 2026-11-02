#!/usr/bin/env node
/**
 * Release notes for the GitHub Release in nalamdesk/releases (#49): one
 * clear download per computer, with the updater's files called out so
 * nobody installs them by mistake.
 *
 *   node scripts/release-notes.js v1.2.3
 */
'use strict';

function releaseNotes(tag) {
    const version = String(tag || '').replace(/^v/, '');
    if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`Not a release tag: ${tag}`);
    return [
        '## Download NalamDesk',
        '',
        'Most clinics should download from [nalamdesk.com](https://nalamdesk.com/#get), which always offers the right file.',
        '',
        '| Computer | File to download |',
        '|---|---|',
        `| Windows | \`NalamDesk-Setup-${version}.exe\` |`,
        `| Linux (Ubuntu, Debian) | \`nalamdesk-desktop_${version}_amd64.deb\`, then \`sudo apt install ./nalamdesk-desktop_${version}_amd64.deb\` |`,
        '| macOS | Not signed yet. Use the website once the Mac download is available there. |',
        '',
        '## NalamDesk Server (self-hosted)',
        '',
        '| Server | File |',
        '|---|---|',
        `| Linux, Debian or Ubuntu | \`nalamdesk-server_${version}_amd64.deb\` or \`nalamdesk-server_${version}_arm64.deb\` |`,
        `| Other Linux | \`nalamdesk-server-${version}-linux-x64.tar.gz\` or \`nalamdesk-server-${version}-linux-arm64.tar.gz\` |`,
        `| Windows | \`nalamdesk-server-${version}-windows-x64.zip\` |`,
        `| Docker | \`docker pull ghcr.io/nalamdesk/nalamdesk-server:v${version}\` (amd64 and arm64) |`,
        '',
        'See the [self-hosting guide](https://github.com/nalamdesk/nalamdesk/blob/master/docs/self-hosting.md).',
        '',
        '## Other files',
        '',
        '`latest.yml`, `latest-mac.yml`, `latest-linux.yml`, the `.blockmap` files and the `.AppImage` are read by the',
        'in-app updater. You do not need to download them.',
        ''
    ].join('\n');
}

if (require.main === module) {
    try {
        process.stdout.write(releaseNotes(process.argv[2]));
    } catch (error) {
        console.error(error.message);
        process.exit(2);
    }
}

module.exports = { releaseNotes };
