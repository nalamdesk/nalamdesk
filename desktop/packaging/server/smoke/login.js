#!/usr/bin/env node
/**
 * Smoke check for a running NalamDesk Server: waits for it, signs in, and
 * checks that the browser UI is served.
 *   node login.js <base-url> <username> <password-file>
 * Self-signed HTTPS is accepted (NODE_TLS_REJECT_UNAUTHORIZED is set by the caller if needed).
 */
'use strict';

const fs = require('fs');

async function main() {
    const [base, username, passwordFile] = process.argv.slice(2);
    const password = fs.readFileSync(passwordFile, 'utf8').replace(/\r?\n$/, '');
    let lastError;
    for (let attempt = 0; attempt < 60; attempt++) {
        try {
            const login = await fetch(`${base}/api/auth/login`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ username, password })
            });
            const body = await login.json();
            if (login.status !== 200 || !body.token) throw new Error(`login returned ${login.status}`);
            const ui = await fetch(`${base}/`);
            const html = await ui.text();
            if (ui.status !== 200 || !html.includes('<app-root')) throw new Error(`UI returned ${ui.status}`);
            console.log(`Signed in as ${username} and loaded the UI from ${base}.`);
            return;
        } catch (error) {
            lastError = error;
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }
    }
    throw lastError;
}

main().catch((error) => { console.error(`Smoke check failed: ${error.message || error}`); process.exit(1); });
