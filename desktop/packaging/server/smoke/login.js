#!/usr/bin/env node
/**
 * Smoke check for a running NalamDesk Server.
 *
 *   node login.js wait <base-url>
 *       Waits until the server answers /api/server/hello.
 *   node login.js <base-url> <username> <password-file> <join-code>
 *       Joins this "computer" with the join code, signs in with its device
 *       credential, and checks that the browser UI is served.
 *
 * The server's self-signed certificate is accepted: this runs on the server
 * itself, in CI.
 */
'use strict';

const fs = require('fs');

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const DEVICE_HEADER = 'x-nalamdesk-device';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForServer(base) {
    let lastError;
    for (let attempt = 0; attempt < 60; attempt++) {
        try {
            const hello = await fetch(`${base}/api/server/hello`);
            if (hello.ok) return;
            lastError = new Error(`hello returned ${hello.status}`);
        } catch (error) {
            lastError = error;
        }
        await sleep(1000);
    }
    throw lastError;
}

async function postJson(url, body, headers = {}) {
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body)
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`${url} returned ${response.status} ${JSON.stringify(json)}`);
    return json;
}

async function main() {
    const args = process.argv.slice(2);
    if (args[0] === 'wait') {
        await waitForServer(args[1]);
        console.log(`${args[1]} is up.`);
        return;
    }
    const [base, username, passwordFile, code] = args;
    if (!base || !username || !passwordFile || !code) {
        throw new Error('Usage: login.js <base-url> <username> <password-file> <join-code>');
    }
    const password = fs.readFileSync(passwordFile, 'utf8').replace(/\r?\n$/, '');
    await waitForServer(base);
    const joined = await postJson(`${base}/api/devices/join`, { code, name: 'Smoke test' });
    if (!joined.deviceToken) throw new Error('join returned no device token');
    const login = await postJson(`${base}/api/auth/login`, { username, password }, { [DEVICE_HEADER]: joined.deviceToken });
    if (!login.token) throw new Error('login returned no token');
    const ui = await fetch(`${base}/`);
    const html = await ui.text();
    if (ui.status !== 200 || !html.includes('<app-root')) throw new Error(`UI returned ${ui.status}`);
    console.log(`Joined, signed in as ${username} and loaded the UI from ${base}.`);
}

main().catch((error) => { console.error(`Smoke check failed: ${error.message || error}`); process.exit(1); });
