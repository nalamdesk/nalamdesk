import { describe, expect, it } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    base32Encode, fingerprintPrefix, formatJoinCode, joinCodeIsPinned, joinCodeMatchesFingerprint,
    normalizeJoinCode, parseJoinCode
} from '../shared/join-code';
import { checkClientProtocol, PROTOCOL_VERSION } from '../shared/protocol';
import { generateSelfSignedCertificate, loadOrCreateTls } from './tls';
import { LoginLimiter, SlidingWindowLimiter } from './rate-limit';
import { EventHub, topicsForMethod } from './events';
import { buildNetworkOptions, generateJoinSecret, joinFingerprint, NO_PIN_FINGERPRINT } from './network';

const FP = 'ab'.repeat(32);

describe('join codes', () => {
    it('round-trips secret and fingerprint prefix in 4 groups of 5', () => {
        const code = formatJoinCode('ABCD2345', FP);
        expect(code).toMatch(/^[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}$/);
        expect(parseJoinCode(code)).toEqual({ secret: 'ABCD2345', fingerprintPrefix: fingerprintPrefix(FP) });
        expect(joinCodeMatchesFingerprint(code, FP)).toBe(true);
        expect(joinCodeMatchesFingerprint(code, 'cd'.repeat(32))).toBe(false);
    });

    it('forgives case, spaces and look-alike letters', () => {
        const code = formatJoinCode('10ABCDEF', FP);
        const typed = code.toLowerCase().replace(/-/g, ' ').replace(/1/g, 'l').replace(/0/g, 'o');
        expect(normalizeJoinCode(typed)).toBe(code.replace(/-/g, ''));
        expect(parseJoinCode(typed)?.secret).toBe('10ABCDEF');
    });

    it('rejects wrong lengths and characters', () => {
        expect(parseJoinCode('ABC')).toBeNull();
        expect(parseJoinCode('UUUUU-UUUUU-UUUUU-UUUUU')).toBeNull();
    });

    it('encodes base32 like Crockford', () => {
        expect(base32Encode(Buffer.from([0, 0, 0, 0, 0]))).toBe('00000000');
        expect(base32Encode(Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff]))).toBe('ZZZZZZZZ');
    });

    it('marks unpinned codes', () => {
        expect(joinCodeIsPinned(formatJoinCode('ABCD2345', FP))).toBe(true);
        expect(joinCodeIsPinned(formatJoinCode('ABCD2345', NO_PIN_FINGERPRINT))).toBe(false);
    });

    it('generates 8-character secrets', () => {
        const secret = generateJoinSecret();
        expect(secret).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
    });
});

describe('protocol handshake', () => {
    it('accepts the current version and a missing header', () => {
        expect(checkClientProtocol(String(PROTOCOL_VERSION))).toEqual({ ok: true, version: PROTOCOL_VERSION });
        expect(checkClientProtocol(undefined).ok).toBe(true);
    });

    it('tells the right side to upgrade', () => {
        expect(checkClientProtocol(String(PROTOCOL_VERSION + 1))).toMatchObject({ ok: false, upgrade: 'server' });
        expect(checkClientProtocol('0')).toMatchObject({ ok: false, upgrade: 'client' });
        expect(checkClientProtocol('abc')).toMatchObject({ ok: false, upgrade: 'client' });
    });
});

describe('TLS', () => {
    it('makes a valid self-signed certificate for the given names', () => {
        const { cert, key } = generateSelfSignedCertificate({ hostnames: ['clinic.local', '192.168.1.5', '::1'] });
        const x509 = new crypto.X509Certificate(cert);
        expect(x509.verify(x509.publicKey)).toBe(true);
        expect(x509.checkPrivateKey(crypto.createPrivateKey(key))).toBe(true);
        expect(x509.subjectAltName).toContain('DNS:clinic.local');
        expect(x509.subjectAltName).toContain('IP Address:192.168.1.5');
        expect(x509.checkHost('clinic.local')).toBe('clinic.local');
    });

    it('creates the certificate once and reuses it', () => {
        const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-tls-'));
        const first = loadOrCreateTls({ dataDir });
        const second = loadOrCreateTls({ dataDir });
        expect(first.selfSigned).toBe(true);
        expect(second.fingerprint256).toBe(first.fingerprint256);
        expect(first.fingerprint256).toMatch(/^[0-9a-f]{64}$/);
        if (process.platform !== 'win32') {
            expect(fs.statSync(path.join(dataDir, 'tls', 'server.key')).mode & 0o077).toBe(0);
        }
    });

    it('uses the operator certificate and refuses a mismatched key', () => {
        const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-tls-'));
        const a = generateSelfSignedCertificate({ hostnames: ['a'] });
        const b = generateSelfSignedCertificate({ hostnames: ['b'] });
        fs.writeFileSync(path.join(dataDir, 'a.crt'), a.cert);
        fs.writeFileSync(path.join(dataDir, 'a.key'), a.key);
        fs.writeFileSync(path.join(dataDir, 'b.key'), b.key);
        const env = { NALAMDESK_TLS_CERT: path.join(dataDir, 'a.crt'), NALAMDESK_TLS_KEY: path.join(dataDir, 'a.key') };
        const options = buildNetworkOptions({ dataDir, env });
        expect(options.tls?.selfSigned).toBe(false);
        expect(options.requireDevice).toBe(true);
        // Operator certificates are verified against system CAs, not pinned.
        expect(joinFingerprint(options)).toBe(NO_PIN_FINGERPRINT);
        expect(() => buildNetworkOptions({ dataDir, env: { ...env, NALAMDESK_TLS_KEY: path.join(dataDir, 'b.key') } }))
            .toThrow(/does not match/);
        expect(() => buildNetworkOptions({ dataDir, env: { NALAMDESK_TLS_CERT: env.NALAMDESK_TLS_CERT } }))
            .toThrow(/both/);
    });

    it('serves plain HTTP behind a TLS proxy', () => {
        const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-tls-'));
        const options = buildNetworkOptions({ dataDir, env: { NALAMDESK_TLS: 'proxy' } });
        expect(options).toMatchObject({ tls: null, behindProxy: true, requireDevice: true });
    });
});

describe('login limiter', () => {
    it('locks a username after 5 failures with doubling backoff', () => {
        let now = 0;
        const limiter = new LoginLimiter({ now: () => now });
        for (let i = 0; i < 4; i++) expect(limiter.recordFailure('1.1.1.1', 'Asha')).toBe(false);
        expect(limiter.check('1.1.1.1', 'asha').allowed).toBe(true);
        expect(limiter.recordFailure('1.1.1.1', 'asha')).toBe(true);
        expect(limiter.check('2.2.2.2', 'ASHA')).toEqual({ allowed: false, retryAfterSec: 60 });
        now += 61_000;
        expect(limiter.check('1.1.1.1', 'asha').allowed).toBe(true);
        limiter.recordFailure('1.1.1.1', 'asha');
        expect(limiter.check('1.1.1.1', 'asha')).toEqual({ allowed: false, retryAfterSec: 120 });
        now += 121_000;
        limiter.recordSuccess('1.1.1.1', 'asha');
        expect(limiter.recordFailure('1.1.1.1', 'asha')).toBe(false);
    });

    it('caps failures per address across usernames', () => {
        let now = 0;
        const limiter = new LoginLimiter({ now: () => now, perIpLimit: 3, perIpWindowMs: 1000 });
        limiter.recordFailure('9.9.9.9', 'a');
        limiter.recordFailure('9.9.9.9', 'b');
        limiter.recordFailure('9.9.9.9', 'c');
        expect(limiter.check('9.9.9.9', 'd').allowed).toBe(false);
        expect(limiter.check('8.8.8.8', 'd').allowed).toBe(true);
        now += 1001;
        expect(limiter.check('9.9.9.9', 'd').allowed).toBe(true);
    });

    it('slides its window', () => {
        let now = 0;
        const limiter = new SlidingWindowLimiter(2, 100, () => now);
        limiter.record('k');
        now = 50;
        limiter.record('k');
        expect(limiter.check('k')).toEqual({ allowed: false, retryAfterSec: 1 });
        now = 101;
        expect(limiter.check('k').allowed).toBe(true);
    });
});

describe('events', () => {
    it('maps mutating methods to topics and ignores reads', () => {
        expect(topicsForMethod('getQueue')).toEqual([]);
        expect(topicsForMethod('addToQueue')).toEqual(['queue']);
        expect(topicsForMethod('updateAppointmentRequestStatus')).toEqual(['bookings']);
        expect(topicsForMethod('checkInAppointment')).toEqual(expect.arrayContaining(['queue', 'appointments']));
        expect(topicsForMethod('abdmAckInbox')).toContain('abdm.inbox');
        expect(topicsForMethod('savePatient')).toEqual(['patients']);
        expect(topicsForMethod('recordPayment')).toEqual(['billing']);
        expect(topicsForMethod('somethingNew')).toEqual(['data']);
        expect(topicsForMethod('cloudActivatePairing')).toEqual(['cloud']);
        expect(topicsForMethod('cloudGetStatus')).toEqual([]);
        expect(topicsForMethod('cloudDecide')).toEqual(['bookings', 'appointments']);
        expect(topicsForMethod('backupRunNow')).toEqual([]);
    });

    it('numbers events and keeps a replay buffer', () => {
        const hub = new EventHub({ replaySize: 2, now: () => 5 });
        expect(hub.publish('queue', 'addToQueue')).toEqual({ id: 1, topic: 'queue', at: 5, method: 'addToQueue' });
        hub.publish('patients');
        expect(hub.publish('billing').id).toBe(3);
    });
});
