#!/usr/bin/env node
'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');

// Cloud Agent shells may set ELECTRON_RUN_AS_NODE; unset before launching the app.
delete process.env.ELECTRON_RUN_AS_NODE;

const electronBinary = require('electron');
const appEntry = path.resolve(__dirname, '../dist/main/entry.js');

const child = spawn(electronBinary, [appEntry], {
    stdio: 'inherit',
    env: process.env,
});

child.on('exit', (code, signal) => {
    if (signal) {
        process.kill(process.pid, signal);
        return;
    }
    process.exit(code ?? 0);
});
