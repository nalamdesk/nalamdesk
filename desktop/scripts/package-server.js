#!/usr/bin/env node
/**
 * Packages NalamDesk Server (ADR 0001, #197) from an existing build.
 *
 *   npm run build:server && npm run build:web    (or `npm run build`)
 *   node scripts/package-server.js stage [--bundle-node] [--out <dir>]
 *   node scripts/package-server.js tar|deb|win-zip [--out <dir>]
 *
 * `stage` lays out a self-contained install:
 *   app/dist/server/...       compiled server
 *   app/dist/nalamdesk/...    the browser UI the server serves
 *   app/node_modules          production dependencies of the server only
 *   bin/nalamdesk-server      launcher (and .cmd on Windows)
 *   runtime/node[.exe]        the Node binary running this script (--bundle-node)
 *
 * Native modules (SQLCipher, argon2) are built for the Node that runs this
 * script, so package each platform on that platform, with the Node you bundle.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PACKAGING = path.join(ROOT, 'packaging', 'server');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

/** Packages the compiled server loads. Everything else in package.json is the desktop app's. */
const SERVER_DEPENDENCIES = [
    '@cedar-policy/cedar-wasm',
    '@fastify/cors',
    '@fastify/static',
    'argon2',
    'better-sqlite3-multiple-ciphers',
    'cron',
    'dotenv',
    // Cloud link logging (works without Electron) and the doorbell connection (#196).
    'electron-log',
    'fastify',
    'fflate',
    'jsonwebtoken',
    'mqtt',
    'tslib'
];
/** Required only by desktop modules that the server build compiles but never loads. */
const DESKTOP_ONLY = new Set(['electron', 'electron-updater', 'googleapis', 'open']);
const NATIVE = ['better-sqlite3-multiple-ciphers', 'argon2'];

function parseArgs(argv) {
    const flags = { bundleNode: false, out: path.join(ROOT, 'release', 'server') };
    const positional = [];
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--bundle-node') flags.bundleNode = true;
        else if (argv[i] === '--out') flags.out = path.resolve(argv[++i]);
        else positional.push(argv[i]);
    }
    return { command: positional[0], flags };
}

function run(command, args, options = {}) {
    execFileSync(command, args, { stdio: 'inherit', shell: process.platform === 'win32', ...options });
}

function packageName(specifier) {
    const parts = specifier.split('/');
    return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/** Fails the build when the server starts requiring a package nobody classified. */
function assertDependenciesClassified(serverDist) {
    const builtins = new Set(require('module').builtinModules);
    const found = new Set();
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const file = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(file);
            else if (entry.name.endsWith('.js')) {
                for (const match of fs.readFileSync(file, 'utf8').matchAll(/require\("([^".][^"]*)"\)/g)) {
                    const name = packageName(match[1].replace(/^node:/, ''));
                    if (!builtins.has(name) && !match[1].startsWith('node:')) found.add(name);
                }
            }
        }
    };
    walk(serverDist);
    const unknown = [...found].filter((name) => !SERVER_DEPENDENCIES.includes(name) && !DESKTOP_ONLY.has(name));
    if (unknown.length) {
        throw new Error(`The server build requires ${unknown.join(', ')}. Add each to SERVER_DEPENDENCIES ` +
            `(or DESKTOP_ONLY if the server never loads it) in scripts/package-server.js.`);
    }
}

function copyDir(from, to) {
    fs.cpSync(from, to, { recursive: true, filter: (source) => !source.endsWith('.map') });
}

function stage(flags) {
    const serverDist = path.join(ROOT, 'dist', 'server');
    const webDist = path.join(ROOT, 'dist', 'nalamdesk', 'browser');
    for (const required of [serverDist, webDist]) {
        if (!fs.existsSync(required)) throw new Error(`${path.relative(ROOT, required)} is missing. Run npm run build:server and the web build first.`);
    }
    assertDependenciesClassified(serverDist);

    const dir = path.join(flags.out, 'nalamdesk-server');
    fs.rmSync(dir, { recursive: true, force: true });
    const app = path.join(dir, 'app');
    copyDir(serverDist, path.join(app, 'dist', 'server'));
    copyDir(webDist, path.join(app, 'dist', 'nalamdesk', 'browser'));

    // A package.json listing only the server's dependencies, resolved through
    // the desktop lockfile so versions match what CI tested.
    const dependencies = {};
    for (const name of SERVER_DEPENDENCIES) {
        if (!pkg.dependencies[name]) throw new Error(`${name} is not a dependency in package.json.`);
        dependencies[name] = pkg.dependencies[name];
    }
    const serverPkg = {
        name: 'nalamdesk-server', version: pkg.version, private: true, license: pkg.license,
        description: 'NalamDesk Server: the self-hosted clinic server', engines: pkg.engines, dependencies
    };
    if (pkg.overrides) serverPkg.overrides = pkg.overrides;
    fs.writeFileSync(path.join(app, 'package.json'), `${JSON.stringify(serverPkg, null, 2)}\n`);
    fs.copyFileSync(path.join(ROOT, 'package-lock.json'), path.join(app, 'package-lock.json'));
    // --ignore-scripts skips Electron's and electron-builder's hooks; the
    // native modules are then built (or fetched prebuilt) for this Node.
    run('npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock'], { cwd: app });
    run('npm', ['rebuild', ...NATIVE], { cwd: app });
    fs.rmSync(path.join(app, 'package-lock.json'), { force: true });

    fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
    const launcher = process.platform === 'win32' ? 'nalamdesk-server.cmd' : 'nalamdesk-server';
    fs.copyFileSync(path.join(PACKAGING, 'bin', launcher), path.join(dir, 'bin', launcher));
    if (process.platform !== 'win32') fs.chmodSync(path.join(dir, 'bin', launcher), 0o755);
    if (flags.bundleNode) {
        fs.mkdirSync(path.join(dir, 'runtime'), { recursive: true });
        const target = path.join(dir, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');
        fs.copyFileSync(process.execPath, target);
        fs.chmodSync(target, 0o755);
    }
    // Release identity (version, commit, NalamDesk Cloud addresses) from `stamp:build-identity`.
    const identity = path.join(ROOT, 'build-identity.json');
    if (fs.existsSync(identity)) fs.copyFileSync(identity, path.join(app, 'build-identity.json'));
    for (const file of ['LICENSE', 'NOTICE']) {
        if (fs.existsSync(path.join(ROOT, file))) fs.copyFileSync(path.join(ROOT, file), path.join(dir, file));
    }
    fs.writeFileSync(path.join(dir, 'VERSION'), `${pkg.version}\n`);
    console.log(`Staged NalamDesk Server ${pkg.version} in ${dir}`);
    return dir;
}

function debArch() {
    return { x64: 'amd64', arm64: 'arm64' }[process.arch] || process.arch;
}

function buildTar(flags) {
    const dir = stage({ ...flags, bundleNode: true });
    const name = `nalamdesk-server-${pkg.version}-linux-${process.arch}.tar.gz`;
    run('tar', ['-czf', path.join(flags.out, name), '-C', flags.out, '--owner=0', '--group=0', path.basename(dir)]);
    console.log(`Wrote ${name}`);
}

function buildDeb(flags) {
    const dir = stage({ ...flags, bundleNode: true });
    const root = path.join(flags.out, 'deb-root');
    fs.rmSync(root, { recursive: true, force: true });
    const install = path.join(root, 'opt', 'nalamdesk-server');
    fs.mkdirSync(path.dirname(install), { recursive: true });
    fs.renameSync(dir, install);

    const put = (relative, source, mode = 0o644) => {
        const target = path.join(root, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(source, target);
        fs.chmodSync(target, mode);
    };
    put('lib/systemd/system/nalamdesk-server.service', path.join(PACKAGING, 'linux', 'nalamdesk-server.service'));
    put('etc/nalamdesk/server.json', path.join(PACKAGING, 'linux', 'server.json'), 0o640);
    put('etc/default/nalamdesk-server', path.join(PACKAGING, 'linux', 'default'));
    fs.mkdirSync(path.join(root, 'usr', 'bin'), { recursive: true });
    fs.symlinkSync('/opt/nalamdesk-server/bin/nalamdesk-server', path.join(root, 'usr', 'bin', 'nalamdesk-server'));

    const debian = path.join(root, 'DEBIAN');
    fs.mkdirSync(debian, { recursive: true });
    for (const script of ['postinst', 'prerm', 'postrm']) put(`DEBIAN/${script}`, path.join(PACKAGING, 'linux', script), 0o755);
    fs.writeFileSync(path.join(debian, 'conffiles'), '/etc/nalamdesk/server.json\n/etc/default/nalamdesk-server\n');
    const sizeKb = Math.ceil(Number(execFileSync('du', ['-sk', install]).toString().split('\t')[0]));
    fs.writeFileSync(path.join(debian, 'control'), [
        'Package: nalamdesk-server',
        `Version: ${pkg.version}`,
        'Section: misc',
        'Priority: optional',
        `Architecture: ${debArch()}`,
        `Maintainer: ${pkg.author}`,
        `Installed-Size: ${sizeKb}`,
        'Depends: adduser, libc6 (>= 2.28), libstdc++6',
        `Homepage: ${pkg.homepage}`,
        'Description: NalamDesk Server, the self-hosted clinic server',
        ' Runs the NalamDesk clinic database, API and browser UI as a system',
        ' service. Clinic computers connect with the NalamDesk app or a browser.',
        ''
    ].join('\n'));
    const name = `nalamdesk-server_${pkg.version}_${debArch()}.deb`;
    run('dpkg-deb', ['--root-owner-group', '-Zxz', '--build', root, path.join(flags.out, name)]);
    fs.rmSync(root, { recursive: true, force: true });
    console.log(`Wrote ${name}`);
}

function buildWinZip(flags) {
    const dir = stage({ ...flags, bundleNode: true });
    const service = path.join(dir, 'service');
    fs.mkdirSync(service, { recursive: true });
    for (const file of fs.readdirSync(path.join(PACKAGING, 'windows'))) {
        fs.copyFileSync(path.join(PACKAGING, 'windows', file), path.join(service, file));
    }
    const winsw = process.env['WINSW_EXE'];
    if (!winsw || !fs.existsSync(winsw)) throw new Error('Set WINSW_EXE to a verified WinSW-x64.exe.');
    fs.copyFileSync(winsw, path.join(service, 'nalamdesk-server-service.exe'));
    const name = `nalamdesk-server-${pkg.version}-windows-${process.arch}.zip`;
    // Paths go through the environment, so a quote in a folder name cannot change the command.
    run('powershell', ['-NoProfile', '-Command',
        'Compress-Archive -LiteralPath $env:ND_ZIP_SOURCE -DestinationPath $env:ND_ZIP_DEST -Force'], {
        shell: false,
        env: { ...process.env, ND_ZIP_SOURCE: dir, ND_ZIP_DEST: path.join(flags.out, name) }
    });
    console.log(`Wrote ${name}`);
}

function main() {
    const { command, flags } = parseArgs(process.argv.slice(2));
    fs.mkdirSync(flags.out, { recursive: true });
    switch (command) {
        case 'stage': return stage(flags);
        case 'tar': return buildTar(flags);
        case 'deb': return buildDeb(flags);
        case 'win-zip': return buildWinZip(flags);
        default:
            console.error('Usage: node scripts/package-server.js stage|tar|deb|win-zip [--bundle-node] [--out <dir>]');
            process.exit(2);
    }
}

if (require.main === module) {
    try { main(); } catch (error) { console.error(error.message || error); process.exit(1); }
}

module.exports = { SERVER_DEPENDENCIES, assertDependenciesClassified };
