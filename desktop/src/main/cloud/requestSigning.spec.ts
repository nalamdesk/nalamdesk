import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { bodySha256, canonicalRequest, normalizePairingCode, signedHeaders, type Audience } from './requestSigning';

// The cloud verifier's own vectors: if either side changes the canonical
// string, one of the two test suites fails.
const vectors = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../../cloud/shared/test/vectors.json'), 'utf8'));
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const privateKey = crypto.createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(vectors.seedHex, 'hex')]), format: 'der', type: 'pkcs8'
});

describe('signed requests match the cloud verifier', () => {
    it('derives the vector public key', () => {
        expect(crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64')).toBe(vectors.publicKeyRaw);
    });

    for (const v of vectors.cases) {
        it(v.name, () => {
            const body = Buffer.from(v.body, 'utf8');
            expect(bodySha256(body)).toBe(v.bodySha256);
            expect(canonicalRequest({
                audience: v.audience as Audience, method: v.method, path: v.path, query: v.query,
                bodySha256: v.bodySha256, timestamp: v.timestamp, nonce: v.nonce, hipId: v.hipId
            })).toBe(v.canonical);
            const headers = signedHeaders({
                privateKey, deviceId: 'dev_test', audience: v.audience, method: v.method, path: v.path, query: v.query,
                body, hipId: v.hipId || undefined, nowMs: Number(v.timestamp), nonce: v.nonce
            });
            expect(headers['x-nd-signature']).toBe(v.signature);
            expect(headers['x-nd-timestamp']).toBe(v.timestamp);
            expect(headers['x-hip-id']).toBe(v.hipId || undefined);
        });
    }
});

describe('normalizePairingCode', () => {
    it('reads a code the way a person types it', () => {
        expect(normalizePairingCode(' abcd-12o4 ')).toBe('ABCD1204');
        expect(normalizePairingCode('xyzl-i000')).toBe('XYZ11000');
    });
});
