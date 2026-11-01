import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { joinFingerprint, NO_PIN_FINGERPRINT } from '../network';
import { describeServingState, pinOptions, readServingState, servingStateFrom, writeServingState } from './serving-state';

const FP = 'ab'.repeat(32);

describe('serving state', () => {
    let dir: string;
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nalamdesk-serving-')); });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('records what start serves and pins the same certificate for join codes', () => {
        const state = servingStateFrom({ tls: { key: 'k', cert: 'c', selfSigned: true, fingerprint256: FP } }, 1000);
        writeServingState(dir, state);
        if (process.platform !== 'win32') expect(fs.statSync(path.join(dir, 'serving.json')).mode & 0o777).toBe(0o600);
        const read = readServingState(dir)!;
        expect(read).toEqual({ mode: 'self-signed', fingerprint256: FP, recordedAt: 1000 });
        expect(joinFingerprint(pinOptions(read))).toBe(FP);
        expect(describeServingState(read)).toContain(FP);
    });

    it('never pins an operator certificate or a proxy', () => {
        for (const options of [{ tls: { key: 'k', cert: 'c', selfSigned: false, fingerprint256: FP } }, { tls: null, behindProxy: true }]) {
            writeServingState(dir, servingStateFrom(options, 1));
            expect(joinFingerprint(pinOptions(readServingState(dir)!))).toBe(NO_PIN_FINGERPRINT);
        }
        expect(readServingState(dir)!.mode).toBe('proxy');
    });

    it('treats a missing or malformed record as not started', () => {
        expect(readServingState(dir)).toBeNull();
        fs.writeFileSync(path.join(dir, 'serving.json'), JSON.stringify({ mode: 'self-signed', fingerprint256: 'nope', recordedAt: 1 }));
        expect(readServingState(dir)).toBeNull();
        fs.writeFileSync(path.join(dir, 'serving.json'), '{');
        expect(readServingState(dir)).toBeNull();
    });
});
