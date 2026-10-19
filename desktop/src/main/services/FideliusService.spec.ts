import { describe, it, expect, vi } from 'vitest';
import * as crypto from 'node:crypto';
import {
    FideliusService,
    fideliusOpen,
    fideliusSeal,
    fideliusSharedSecret,
    parseFideliusPublicKey,
    parseKeyMaterial,
    toFideliusPublicKey,
    type FideliusKeyMaterial
} from './FideliusService';

// Test-only model of NHA's reference Fidelius (mgrmtech/fidelius-cli, which
// uses BouncyCastle's Weierstrass "curve25519"), written independently of
// FideliusService. It does unclamped scalar multiplication with a BigInt
// Montgomery ladder, so it can use the reference's own private keys; it is
// not constant-time and must never handle real keys.
const P = 2n ** 255n - 19n;
const A = 486662n;
const mod = (x: bigint) => ((x % P) + P) % P;
const pow = (b: bigint, e: bigint): bigint => {
    let r = 1n;
    b = mod(b);
    for (; e > 0n; e >>= 1n) {
        if (e & 1n) r = (r * b) % P;
        b = (b * b) % P;
    }
    return r;
};
const inv = (x: bigint) => pow(x, P - 2n);
const A3 = (A * inv(3n)) % P;
const be = (b: Buffer) => BigInt(`0x${b.toString('hex') || '0'}`);
const toBE = (n: bigint) => Buffer.from(n.toString(16).padStart(64, '0'), 'hex');

/** Order of the prime subgroup; the reference picks private keys below it. */
const CURVE_ORDER = 2n ** 252n + 27742317777372353535851937790883648493n;

function ladder(k: bigint, u: bigint): bigint {
    let x2 = 1n, z2 = 0n, x3 = u, z3 = 1n, swap = 0n;
    const a24 = (A - 2n) / 4n;
    for (let t = 255n; t >= 0n; t--) {
        const bit = (k >> t) & 1n;
        if (swap ^ bit) { [x2, x3] = [x3, x2]; [z2, z3] = [z3, z2]; }
        swap = bit;
        const a = mod(x2 + z2), aa = (a * a) % P, b = mod(x2 - z2), bb = (b * b) % P, e = mod(aa - bb);
        const c = mod(x3 + z3), d = mod(x3 - z3), da = (d * a) % P, cb = (c * b) % P;
        x3 = mod((da + cb) ** 2n);
        z3 = mod(u * mod((da - cb) ** 2n));
        x2 = (aa * bb) % P;
        z2 = mod(e * mod(aa + a24 * e));
    }
    if (swap) { [x2, x3] = [x3, x2]; [z2, z3] = [z3, z2]; }
    return (x2 * inv(z2)) % P;
}

function pointX(publicKey: string): bigint {
    const raw = Buffer.from(publicKey, 'base64');
    return be((raw.length === 65 ? raw : raw.subarray(-65)).subarray(1, 33));
}

/** The reference's computeSharedSecret: Weierstrass x of d*Q, 32 bytes big-endian. */
function referenceSharedSecret(privateKey: string, publicKey: string): Buffer {
    const d = be(Buffer.from(privateKey, 'base64'));
    return toBE(mod(ladder(d, mod(pointX(publicKey) - A3)) + A3));
}

/** The reference's key pair: private key as BigInteger bytes, public key as 65-byte 04||X||Y. */
function referenceKeyPair(): { privateKey: string; publicKey: string } {
    let d = 0n;
    while (d === 0n) d = be(crypto.randomBytes(32)) % CURVE_ORDER;
    const x = mod(ladder(d, 9n) + A3);
    const wa = mod((3n - A * A) * inv(3n));
    const wb = mod((2n * A ** 3n - 9n * A) * inv(27n));
    const rhs = mod(x ** 3n + wa * x + wb);
    let y = pow(rhs, (P + 3n) / 8n);
    if ((y * y) % P !== rhs) y = (y * pow(2n, (P - 1n) / 4n)) % P;
    return {
        privateKey: Buffer.from(d.toString(16).padStart(64, '0'), 'hex').toString('base64'),
        publicKey: Buffer.concat([Buffer.from([4]), toBE(x), toBE(y)]).toString('base64')
    };
}

function session(shared: Buffer, nonceA: string, nonceB: string) {
    const a = Buffer.from(nonceA, 'base64'), b = Buffer.from(nonceB, 'base64');
    const xor = Buffer.from(a.map((v, i) => v ^ b[i % b.length]));
    const key = Buffer.from(crypto.hkdfSync('sha256', shared, xor.subarray(0, 20), Buffer.alloc(0), 32));
    return { key, iv: xor.subarray(xor.length - 12) };
}

/** The reference's encrypt command. */
function referenceEncrypt(text: string, senderNonce: string, requesterNonce: string,
    senderPrivateKey: string, requesterPublicKey: string): string {
    const { key, iv } = session(referenceSharedSecret(senderPrivateKey, requesterPublicKey), senderNonce, requesterNonce);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    return Buffer.concat([cipher.update(text, 'utf8'), cipher.final(), cipher.getAuthTag()]).toString('base64');
}

/** The reference's decrypt command. */
function referenceDecrypt(encryptedData: string, requesterNonce: string, senderNonce: string,
    requesterPrivateKey: string, senderPublicKey: string): string {
    const data = Buffer.from(encryptedData, 'base64');
    const { key, iv } = session(referenceSharedSecret(requesterPrivateKey, senderPublicKey), senderNonce, requesterNonce);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(data.subarray(-16));
    return Buffer.concat([decipher.update(data.subarray(0, -16)), decipher.final()]).toString('utf8');
}

// Published example from NHA's reference README (mgrmtech/fidelius-cli).
const NHA = {
    requester: {
        privateKey: 'DMxHPri8d7IT23KgLk281zZenMfVHSdeamq0RhwlIBk=',
        publicKey: 'BAheD5rUqTy4V5xR4/6HWmYpopu5CO+KO8BECS0udNqUTSNo91TIqIIy1A4Vh+F94c+n9vAcwXU2bGcfsI5f69Y=',
        x509PublicKey: 'MIIBMTCB6gYHKoZIzj0CATCB3gIBATArBgcqhkjOPQEBAiB/////////////////////////////////////////7TBEBCAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqYSRShRAQge0Je0Je0Je0Je0Je0Je0Je0Je0Je0Je0JgtenHcQyGQEQQQqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq0kWiCuGaG4oIa04B7dLHdI0UySPU1+bXxhsinpxaJ+ztPZAiAQAAAAAAAAAAAAAAAAAAAAFN753qL3nNZYEmMaXPXT7QIBCANCAAQIXg+a1Kk8uFecUeP+h1pmKaKbuQjvijvARAktLnTalE0jaPdUyKiCMtQOFYfhfeHPp/bwHMF1NmxnH7COX+vW',
        nonce: '6uj1RdDUbcpI3lVMZvijkMC8Te20O4Bcyz0SyivX8Eg='
    },
    sender: {
        privateKey: 'AYhVZpbVeX4KS5Qm/W0+9Ye2q3rnVVGmqRICmseWni4=',
        publicKey: 'BABVt+mpRLMXiQpIfEq6bj8hlXsdtXIxLsspmMgLNI1SR5mHgDVbjHO2A+U4QlMddGzqyEidzm1AkhtSxSO2Ahg=',
        x509PublicKey: 'MIIBMTCB6gYHKoZIzj0CATCB3gIBATArBgcqhkjOPQEBAiB/////////////////////////////////////////7TBEBCAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqYSRShRAQge0Je0Je0Je0Je0Je0Je0Je0Je0Je0Je0JgtenHcQyGQEQQQqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq0kWiCuGaG4oIa04B7dLHdI0UySPU1+bXxhsinpxaJ+ztPZAiAQAAAAAAAAAAAAAAAAAAAAFN753qL3nNZYEmMaXPXT7QIBCANCAAQAVbfpqUSzF4kKSHxKum4/IZV7HbVyMS7LKZjICzSNUkeZh4A1W4xztgPlOEJTHXRs6shInc5tQJIbUsUjtgIY',
        nonce: 'lmXgblZwotx+DfBgKJF0lZXtAXgBEYr5khh79Zytr2Y='
    },
    plaintext: "Wormtail should never have been Potter cottage's secret keeper.",
    encryptedData: 'pzMvVZNNVtJzqPkkxcCbBUWgDEBy/mBXIeT2dJWI16ZAQnnXUb9lI+S4k8XK6mgZSKKSRIHkcNvJpllnBg548wUgavBa0vCRRwdL6kY6Yw=='
};

function keyMaterial(keyValue: string, nonce: string): FideliusKeyMaterial {
    return {
        cryptoAlg: 'ECDH',
        curve: 'Curve25519',
        dhPublicKey: { expiry: '2026-12-31T00:00:00.000Z', parameters: 'Curve25519/32byte random key', keyValue },
        nonce
    };
}

function recipient() {
    return new FideliusService().generateKeyMaterial();
}

describe('Fidelius interop with NHA\'s reference', () => {
    it('reproduces the published ciphertext byte for byte', () => {
        const shared = referenceSharedSecret(NHA.sender.privateKey, NHA.requester.publicKey);
        const sealed = fideliusSeal(shared, NHA.sender.nonce, NHA.requester.nonce, Buffer.from(NHA.plaintext));
        expect(sealed).toBe(NHA.encryptedData);
    });

    it('opens the published ciphertext with the sender\'s X.509 key', () => {
        const shared = referenceSharedSecret(NHA.requester.privateKey, NHA.sender.x509PublicKey);
        const opened = fideliusOpen(shared, NHA.sender.nonce, NHA.requester.nonce, NHA.encryptedData);
        expect(opened.toString('utf8')).toBe(NHA.plaintext);
    });

    it('reads both of the reference\'s public key encodings as the same key', () => {
        for (const side of [NHA.requester, NHA.sender]) {
            const fromRaw = parseFideliusPublicKey(side.publicKey).export({ type: 'spki', format: 'der' });
            const fromX509 = parseFideliusPublicKey(side.x509PublicKey).export({ type: 'spki', format: 'der' });
            expect(fromRaw.equals(fromX509)).toBe(true);
        }
    });

    it('re-emits the reference\'s X.509 key for the same point', () => {
        // Same x and DER prefix; y is either root, which ECDH treats alike.
        const encoded = Buffer.from(toFideliusPublicKey(parseFideliusPublicKey(NHA.requester.publicKey)), 'base64');
        const original = Buffer.from(NHA.requester.x509PublicKey, 'base64');
        expect(encoded.length).toBe(original.length);
        expect(encoded.subarray(0, -32).equals(original.subarray(0, -32))).toBe(true);
    });

    it('agrees on the shared secret with the reference\'s keys', () => {
        const ours = crypto.generateKeyPairSync('x25519');
        const theirs = referenceKeyPair();
        const ourSecret = fideliusSharedSecret(ours.privateKey, theirs.publicKey);
        const theirSecret = referenceSharedSecret(theirs.privateKey, toFideliusPublicKey(ours.publicKey));
        expect(ourSecret.equals(theirSecret)).toBe(true);
    });

    it('encrypts bundles the reference decrypts', () => {
        const hiu = referenceKeyPair();
        const nonce = crypto.randomBytes(32).toString('base64');
        const bundle = { resourceType: 'Bundle', entry: [{ id: 'அ' }] };
        const envelope = new FideliusService().encryptBundle(bundle, keyMaterial(hiu.publicKey, nonce));
        const text = referenceDecrypt(envelope.encryptedData, nonce, envelope.keyMaterial.nonce,
            hiu.privateKey, envelope.keyMaterial.dhPublicKey.keyValue);
        expect(JSON.parse(text)).toEqual(bundle);
    });

    it('decrypts bundles the reference encrypts', () => {
        const svc = new FideliusService();
        const hiu = svc.generateKeyMaterial();
        const hip = referenceKeyPair();
        const hipNonce = crypto.randomBytes(32).toString('base64');
        const encryptedData = referenceEncrypt(JSON.stringify({ ok: true }), hipNonce, hiu.keyMaterial.nonce,
            hip.privateKey, hiu.keyMaterial.dhPublicKey.keyValue);
        const envelope = { keyMaterial: keyMaterial(hip.publicKey, hipNonce), encryptedData, keyId: '' };
        expect(svc.decryptEnvelope(envelope, hiu.privateKeyPem, hiu.keyMaterial.nonce)).toEqual({ ok: true });
    });
});

describe('FideliusService', () => {
    it('round-trips a bundle through encrypt and decrypt', () => {
        const svc = new FideliusService();
        const keys = recipient();
        const bundle = { resourceType: 'Bundle', entry: [{ id: 1 }] };

        const envelope = svc.encryptBundle(bundle, keys.keyMaterial);

        expect(Buffer.from(envelope.encryptedData, 'base64').toString('utf8')).not.toContain('Bundle');
        expect(envelope.keyId).toHaveLength(16);
        expect(envelope.keyMaterial).toMatchObject({ cryptoAlg: 'ECDH', curve: 'Curve25519' });
        expect(svc.decryptEnvelope(envelope, keys.privateKeyPem, keys.keyMaterial.nonce)).toEqual(bundle);
    });

    it('uses a fresh ephemeral key and nonce per transfer', () => {
        const svc = new FideliusService();
        const keys = recipient();
        const first = svc.encryptBundle({ n: 1 }, keys.keyMaterial);
        const second = svc.encryptBundle({ n: 1 }, keys.keyMaterial);
        expect(first.keyMaterial.dhPublicKey.keyValue).not.toBe(second.keyMaterial.dhPublicKey.keyValue);
        expect(first.keyMaterial.nonce).not.toBe(second.keyMaterial.nonce);
        expect(first.encryptedData).not.toBe(second.encryptedData);
    });

    it('rejects tampered envelopes', () => {
        const svc = new FideliusService();
        const keys = recipient();
        const envelope = svc.encryptBundle({ secret: true }, keys.keyMaterial);
        const data = Buffer.from(envelope.encryptedData, 'base64');
        data[0] ^= 1;
        const tampered = { ...envelope, encryptedData: data.toString('base64') };
        expect(() => svc.decryptEnvelope(tampered, keys.privateKeyPem, keys.keyMaterial.nonce)).toThrow();
        expect(() => svc.decryptEnvelope(envelope, keys.privateKeyPem, crypto.randomBytes(32).toString('base64')))
            .toThrow();
    });

    it('rejects public keys that are not on the curve', () => {
        const point = Buffer.from(NHA.requester.publicKey, 'base64');
        point[64] ^= 1;
        expect(() => parseFideliusPublicKey(point.toString('base64'))).toThrow('not on Curve25519');
        const x509 = Buffer.from(NHA.requester.x509PublicKey, 'base64');
        x509[10] ^= 1;
        expect(() => parseFideliusPublicKey(x509.toString('base64'))).toThrow('X.509');
        expect(() => parseFideliusPublicKey(crypto.randomBytes(32).toString('base64'))).toThrow('X.509');
    });

    it('validates key material without leaking it', () => {
        const svc = new FideliusService();
        expect(() => svc.encryptBundle({ a: 1 }, 'not-json' as any)).toThrow('keyMaterial JSON');
        expect(() => parseKeyMaterial({ nonce: NHA.requester.nonce })).toThrow('dhPublicKey.keyValue');
        expect(() => parseKeyMaterial(keyMaterial(NHA.requester.publicKey, 'c2hvcnQ='))).toThrow('32 bytes');
        expect(() => parseKeyMaterial({ ...keyMaterial(NHA.requester.publicKey, NHA.requester.nonce), curve: 'P-256' }))
            .toThrow('Curve25519');
        const parsed = parseKeyMaterial(JSON.stringify(keyMaterial(NHA.requester.x509PublicKey, NHA.requester.nonce)));
        expect(parsed.dhPublicKey.keyValue).toBe(NHA.requester.x509PublicKey);
    });

    it('loopbacks without an endpoint, flagged on the receipt', async () => {
        const svc = new FideliusService({ nowMs: () => 1_000_000 });
        const keys = recipient();
        const receipt = await svc.pushBundle({ hello: 'world' }, keys.keyMaterial);
        expect(receipt).toMatchObject({ status: 'mock-loopback', endpoint: 'mock-loopback' });
        expect(receipt.bytes).toBeGreaterThan(0);
    });

    it('accepts stored key material as JSON', async () => {
        const svc = new FideliusService();
        const keys = recipient();
        const receipt = await svc.pushBundle({ a: 1 }, JSON.stringify(keys.keyMaterial));
        expect(receipt.status).toBe('mock-loopback');
    });

    it('posts the envelope to a live endpoint', async () => {
        const fetchFn = vi.fn().mockResolvedValue({ ok: true });
        const svc = new FideliusService({ fetchFn, nowMs: () => 1_000_000 });
        const keys = recipient();
        const receipt = await svc.pushBundle({ hello: 'world' }, keys.keyMaterial, 'https://hip.example/push');
        expect(receipt).toMatchObject({ status: 'delivered', endpoint: 'https://hip.example/push' });
        const sent = JSON.parse(fetchFn.mock.calls[0][1].body);
        expect(sent.envelope.encryptedData).toBeTruthy();
        expect(sent.envelope.keyMaterial.dhPublicKey.keyValue).toBeTruthy();
        expect(JSON.stringify(sent)).not.toContain('hello');
    });

    it('reports unreachable endpoints plainly', async () => {
        const fetchFn = vi.fn().mockRejectedValue(new Error('socket hang up'));
        const svc = new FideliusService({ fetchFn });
        const keys = recipient();
        await expect(svc.pushBundle({ a: 1 }, keys.keyMaterial, 'https://down.example'))
            .rejects.toThrow('unreachable');
    });

    it('bounds live transfers with a timeout signal', async () => {
        const seen: any[] = [];
        const fetchFn = vi.fn().mockImplementation(async (_url: string, init: any) => {
            seen.push(init);
            return { ok: true };
        });
        const svc = new FideliusService({ fetchFn });
        const keys = recipient();
        await svc.pushBundle({ a: 1 }, keys.keyMaterial, 'https://hip.example/push');
        expect(seen[0]?.signal).toBeTruthy();
    });

    it('maps aborted transfers to a timeout message', async () => {
        const abortError = new Error('The operation was aborted');
        abortError.name = 'AbortError';
        const fetchFn = vi.fn().mockRejectedValue(abortError);
        const svc = new FideliusService({ fetchFn });
        const keys = recipient();
        await expect(svc.pushBundle({ a: 1 }, keys.keyMaterial, 'https://slow.example'))
            .rejects.toThrow('timed out');
    });
});
