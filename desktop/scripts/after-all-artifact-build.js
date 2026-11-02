'use strict';

const fs = require('node:fs');
const path = require('node:path');

function loadMainModule(name) {
    const compiled = path.join(__dirname, '..', 'dist', 'main', name);
    return require(compiled);
}

/**
 * Writes the Linux helper notes next to the build output, for local builds
 * and support. It returns nothing to publish: the GitHub Release lists only
 * installers and the files the in-app updater reads (#49), and the release
 * notes carry the install guidance.
 */
async function afterAllArtifactBuild(buildResult) {
    const extra = [];
    const artifacts = buildResult.artifactPaths || [];
    const outDir = buildResult.outDir || (artifacts[0] ? path.dirname(artifacts[0]) : path.join(__dirname, '..', 'release'));
    const pkg = require('../package.json');
    const debs = artifacts.filter((file) => file.endsWith('.deb'));
    const appImages = artifacts.filter((file) => file.endsWith('.AppImage'));

    if (appImages.length > 0 && debs.length === 0) {
        throw new Error('Linux AppImage was built without the primary .deb clinic artifact');
    }
    if (debs.length === 0 && appImages.length === 0) {
        return [];
    }

    const { linuxClinicInstallInstructions, appImageFuseGuardScript, formatMissingFuseMessage } =
        loadMainModule('linuxFuseGuard.js');

    const installPath = path.join(outDir, 'LINUX-INSTALL.txt');
    fs.writeFileSync(installPath, linuxClinicInstallInstructions(pkg.version));
    extra.push(installPath);

    if (appImages.length > 0) {
        const appImageFileName = path.basename(appImages[0]);
        const guardPath = path.join(outDir, 'run-nalamdesk-appimage.sh');
        fs.writeFileSync(guardPath, appImageFuseGuardScript({
            version: pkg.version,
            appImageFileName
        }), { mode: 0o755 });
        extra.push(guardPath);

        const fuseNotePath = path.join(outDir, 'APPIMAGE-FUSE.txt');
        fs.writeFileSync(fuseNotePath, `${formatMissingFuseMessage({ version: pkg.version })}\n`);
        extra.push(fuseNotePath);
    }

    console.log(`Wrote ${extra.map((file) => path.basename(file)).join(', ')} (not published)`);
    return [];
}

module.exports = afterAllArtifactBuild;
module.exports.default = afterAllArtifactBuild;
