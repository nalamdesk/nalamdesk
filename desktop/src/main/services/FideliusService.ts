import * as crypto from 'node:crypto';

/**
 * ABDM key material, exactly as the HIE-CM APIs carry it: the requester's
 * (HIU's) half arrives with a health-information request, the sender's
 * (HIP's) half goes back with the encrypted data.
 */
export interface FideliusKeyMaterial {
    cryptoAlg: 'ECDH';
    curve: 'Curve25519';
    dhPublicKey: {
        expiry: string;
        parameters: 'Curve25519/32byte random key';
        /** X.509 SubjectPublicKeyInfo (base64), as NHA's reference emits. */
        keyValue: string;
    };
    /** 32 random bytes (base64). */
    nonce: string;
}

export interface FideliusEnvelope {
    /** The sender's key material; the requester needs it to decrypt. */
    keyMaterial: FideliusKeyMaterial;
    /** AES-256-GCM ciphertext followed by the 16-byte tag (base64). */
    encryptedData: string;
    /** Requester-key fingerprint the recipient can log without seeing key material. */
    keyId: string;
}

export interface FideliusReceipt {
    status: 'delivered' | 'mock-loopback';
    bytes: number;
    keyId: string;
    endpoint: string;
    at: string;
}

// NHA's reference (mgrmtech/fidelius-cli) runs ECDH on BouncyCastle's
// "curve25519": the short-Weierstrass form of the X25519 curve. A point maps
// between the two forms by x = u + A/3 (mod p), with y carried alongside,
// so Node's constant-time X25519 does the scalar multiplication and keys are
// only converted on the way in and out. Node clamps X25519 scalars, which is
// harmless for our own keys: a clamped scalar is a valid Weierstrass scalar.
// BigInt() rather than literals: the main process targets ES2018.
const _0n = BigInt(0), _1n = BigInt(1), _2n = BigInt(2), _3n = BigInt(3), _4n = BigInt(4);
const _8n = BigInt(8), _9n = BigInt(9), _19n = BigInt(19), _27n = BigInt(27), _255n = BigInt(255);
const P = _2n ** _255n - _19n;
const MONT_A = BigInt(486662);
const mod = (x: bigint) => ((x % P) + P) % P;

function powMod(base: bigint, exp: bigint): bigint {
    let result = _1n;
    let b = mod(base);
    let e = exp;
    while (e > _0n) {
        if (e & _1n) result = (result * b) % P;
        b = (b * b) % P;
        e >>= _1n;
    }
    return result;
}

const inv = (x: bigint) => powMod(x, P - _2n);
const A_OVER_3 = (MONT_A * inv(_3n)) % P;
// Weierstrass coefficients for B = 1: a = (3 - A^2) / 3, b = (2A^3 - 9A) / 27.
const WEI_A = mod((_3n - MONT_A * MONT_A) * inv(_3n));
const WEI_B = mod((_2n * MONT_A ** _3n - _9n * MONT_A) * inv(_27n));
const SQRT_MINUS_ONE = powMod(_2n, (P - _1n) / _4n);

// DER prefix BouncyCastle writes for a curve25519 public key: explicit curve
// parameters, then the 65-byte uncompressed point. Identical for every key.
const X509_PREFIX = Buffer.from(
    '308201313081ea06072a8648ce3d02013081de020101302b06072a8648ce3d010102'
    + '207fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffed30'
    + '4404202aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa984914a1'
    + '4404207b425ed097b425ed097b425ed097b425ed097b425ed097b4260b5e9c7710c8'
    + '640441042aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaad'
    + '245a20ae19a1b8a086b4e01edd2c7748d14c923d4d7e6d7c61b229e9c5a27eced3d9'
    + '02201000000000000000000000000000000014def9dea2f79cd65812631a5cf5d3ed'
    + '020108034200',
    'hex'
);
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const KEY_PARAMETERS = 'Curve25519/32byte random key';

const toBigBE = (bytes: Buffer) => BigInt(`0x${bytes.toString('hex') || '0'}`);
const toBufBE = (n: bigint) => Buffer.from(n.toString(16).padStart(64, '0'), 'hex');
const toBufLE = (n: bigint) => toBufBE(n).reverse();
const fromBufLE = (bytes: Buffer) => toBigBE(Buffer.from(bytes).reverse());

function curveRhs(x: bigint): bigint {
    return mod(x * x * x + WEI_A * x + WEI_B);
}

function sqrtMod(v: bigint): bigint | null {
    // p = 5 (mod 8): candidate v^((p+3)/8), fixed up by sqrt(-1) if needed.
    let r = powMod(v, (P + _3n) / _8n);
    if ((r * r) % P !== v) r = (r * SQRT_MINUS_ONE) % P;
    return (r * r) % P === v ? r : null;
}

/** Base64 of 32 fresh random bytes, the nonce each side contributes. */
export function generateNonce(): string {
    return crypto.randomBytes(32).toString('base64');
}

/** Encodes an X25519 public key as the X.509 key NHA's reference reads. */
export function toFideliusPublicKey(publicKey: crypto.KeyObject): string {
    const raw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
    const x = mod(fromBufLE(raw) + A_OVER_3);
    const y = sqrtMod(curveRhs(x));
    if (y === null) throw new Error('Public key is not on Curve25519.');
    // Either root is the same key for ECDH, which uses x alone; pick the even one.
    const yEven = y % _2n === _0n ? y : P - y;
    return Buffer.concat([X509_PREFIX, Buffer.from([4]), toBufBE(x), toBufBE(yEven)]).toString('base64');
}

/**
 * Reads a Fidelius public key (X.509, or the bare 65-byte uncompressed
 * point) into an X25519 key, rejecting anything not on the curve.
 */
export function parseFideliusPublicKey(base64: string): crypto.KeyObject {
    const bytes = Buffer.from(String(base64 || '').trim(), 'base64');
    let point: Buffer;
    if (bytes.length === 65) {
        point = bytes;
    } else if (bytes.length === X509_PREFIX.length + 65
        && bytes.subarray(0, X509_PREFIX.length).equals(X509_PREFIX)) {
        point = bytes.subarray(X509_PREFIX.length);
    } else {
        throw new Error('Public key must be a Curve25519 key in X.509 or uncompressed form.');
    }
    if (point[0] !== 4) throw new Error('Public key must be an uncompressed Curve25519 point.');
    const x = toBigBE(point.subarray(1, 33));
    const y = toBigBE(point.subarray(33));
    if (x >= P || y >= P || (y * y) % P !== curveRhs(x)) {
        throw new Error('Public key is not on Curve25519.');
    }
    const u = mod(x - A_OVER_3);
    return crypto.createPublicKey({
        key: Buffer.concat([X25519_SPKI_PREFIX, toBufLE(u)]),
        format: 'der',
        type: 'spki'
    });
}

/** ECDH shared secret as the reference computes it: the Weierstrass x, 32 bytes big-endian. */
export function fideliusSharedSecret(privateKey: crypto.KeyObject, peerPublicKey: string): Buffer {
    const peer = parseFideliusPublicKey(peerPublicKey);
    let u: Buffer;
    try {
        u = crypto.diffieHellman({ privateKey, publicKey: peer });
    } catch {
        // OpenSSL refuses an all-zero result, i.e. a low-order peer point.
        throw new Error('Public key cannot be used for key agreement.');
    }
    return toBufBE(mod(fromBufLE(u) + A_OVER_3));
}

function nonceBytes(nonce: string, label: string): Buffer {
    const bytes = Buffer.from(String(nonce || '').trim(), 'base64');
    if (bytes.length !== 32) throw new Error(`${label} nonce must be 32 bytes.`);
    return bytes;
}

// XOR of the two nonces: first 20 bytes salt the HKDF, last 12 are the GCM IV.
function sessionParams(sharedSecret: Buffer, senderNonce: string, requesterNonce: string) {
    const a = nonceBytes(senderNonce, 'Sender');
    const b = nonceBytes(requesterNonce, 'Requester');
    const xor = Buffer.alloc(32);
    for (let i = 0; i < 32; i++) xor[i] = a[i] ^ b[i];
    const key = Buffer.from(crypto.hkdfSync('sha256', sharedSecret, xor.subarray(0, 20), Buffer.alloc(0), 32));
    return { key, iv: xor.subarray(20) };
}

/** AES-256-GCM seal under the session key; returns base64 ciphertext||tag. */
export function fideliusSeal(sharedSecret: Buffer, senderNonce: string, requesterNonce: string, plaintext: Buffer): string {
    const { key, iv } = sessionParams(sharedSecret, senderNonce, requesterNonce);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]).toString('base64');
}

/** Opens base64 ciphertext||tag; throws if it was tampered with. */
export function fideliusOpen(sharedSecret: Buffer, senderNonce: string, requesterNonce: string, encryptedData: string): Buffer {
    const data = Buffer.from(String(encryptedData || ''), 'base64');
    if (data.length < 16) throw new Error('Encrypted data is too short.');
    const { key, iv } = sessionParams(sharedSecret, senderNonce, requesterNonce);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(data.subarray(-16));
    return Buffer.concat([decipher.update(data.subarray(0, -16)), decipher.final()]);
}

/** Validates key material from a request or a settings paste (object or JSON). */
export function parseKeyMaterial(input: unknown): FideliusKeyMaterial {
    let value: any = input;
    if (typeof input === 'string') {
        try {
            value = JSON.parse(input);
        } catch {
            throw new Error('Key material must be the ABDM keyMaterial JSON, with dhPublicKey and nonce.');
        }
    }
    const keyValue = String(value?.dhPublicKey?.keyValue || '').trim();
    const nonce = String(value?.nonce || '').trim();
    if (!keyValue || !nonce) throw new Error('Key material needs dhPublicKey.keyValue and nonce.');
    if (value?.curve && String(value.curve).toLowerCase() !== 'curve25519') {
        throw new Error('Key material must use Curve25519.');
    }
    parseFideliusPublicKey(keyValue);
    nonceBytes(nonce, 'Key material');
    return {
        cryptoAlg: 'ECDH',
        curve: 'Curve25519',
        dhPublicKey: {
            expiry: String(value?.dhPublicKey?.expiry || ''),
            parameters: KEY_PARAMETERS,
            keyValue
        },
        nonce
    };
}

function keyFingerprint(keyValue: string): string {
    return crypto.createHash('sha256')
        .update(Buffer.from(keyValue, 'base64'))
        .digest('hex')
        .slice(0, 16);
}

/**
 * ABDM Fidelius data transfer (main process), byte-compatible with NHA's
 * reference implementation: ECDH on Curve25519, HKDF-SHA256 salted by the
 * XOR of both sides' nonces, AES-256-GCM. Ephemeral sender keys exist only
 * in memory for one transfer — they are never persisted, logged, or reused.
 *
 * Without a configured live endpoint every push loopbacks through the mock
 * responder (encrypt → decrypt → integrity check), flagged on the receipt.
 */
export class FideliusService {
    constructor(
        private readonly deps: {
            fetchFn?: (url: string, init?: any) => Promise<any>;
            nowMs?: () => number;
        } = {}
    ) { }

    private nowMs(): number {
        return this.deps.nowMs ? this.deps.nowMs() : Date.now();
    }

    /** Fresh key pair and nonce; the private half (PKCS#8 PEM) never leaves memory. */
    generateKeyMaterial(expiry = new Date(this.nowMs() + 24 * 60 * 60 * 1000).toISOString()): {
        keyMaterial: FideliusKeyMaterial;
        privateKeyPem: string;
    } {
        const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
        return {
            keyMaterial: {
                cryptoAlg: 'ECDH',
                curve: 'Curve25519',
                dhPublicKey: { expiry, parameters: KEY_PARAMETERS, keyValue: toFideliusPublicKey(publicKey) },
                nonce: generateNonce()
            },
            privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
        };
    }

    /** Encrypts a JSON-serializable bundle for the holder of the requester's key material. */
    encryptBundle(bundle: unknown, requester: FideliusKeyMaterial): FideliusEnvelope {
        const peer = parseKeyMaterial(requester);
        const plaintext = Buffer.from(JSON.stringify(bundle ?? null), 'utf8');
        const ephemeral = crypto.generateKeyPairSync('x25519');
        const senderNonce = generateNonce();
        const shared = fideliusSharedSecret(ephemeral.privateKey, peer.dhPublicKey.keyValue);
        return {
            keyMaterial: {
                cryptoAlg: 'ECDH',
                curve: 'Curve25519',
                dhPublicKey: {
                    expiry: peer.dhPublicKey.expiry,
                    parameters: KEY_PARAMETERS,
                    keyValue: toFideliusPublicKey(ephemeral.publicKey)
                },
                nonce: senderNonce
            },
            encryptedData: fideliusSeal(shared, senderNonce, peer.nonce, plaintext),
            keyId: keyFingerprint(peer.dhPublicKey.keyValue)
        };
    }

    /** Decrypts an envelope with the requester's private key (PEM) and nonce. Verifies integrity. */
    decryptEnvelope(envelope: FideliusEnvelope, requesterPrivateKeyPem: string, requesterNonce: string): unknown {
        const sender = parseKeyMaterial(envelope?.keyMaterial);
        const privateKey = crypto.createPrivateKey(requesterPrivateKeyPem);
        const shared = fideliusSharedSecret(privateKey, sender.dhPublicKey.keyValue);
        const plaintext = fideliusOpen(shared, sender.nonce, requesterNonce, envelope.encryptedData);
        return JSON.parse(plaintext.toString('utf8'));
    }

    /**
     * Pushes an encrypted bundle. With a live endpoint configured the
     * envelope is POSTed; otherwise it loopbacks (decrypt + integrity check)
     * and the receipt says so.
     */
    async pushBundle(
        bundle: unknown,
        requester: FideliusKeyMaterial | string,
        endpoint?: string
    ): Promise<FideliusReceipt> {
        const envelope = this.encryptBundle(bundle, parseKeyMaterial(requester));
        const bytes = Buffer.from(envelope.encryptedData, 'base64').length;
        const at = new Date(this.nowMs()).toISOString();
        const target = String(endpoint || '').trim();
        if (!target) {
            // Mock loopback: prove THIS bundle round-trips by sealing it to a
            // throwaway requester and opening it again. A mismatch means the
            // payload itself cannot survive the pipeline — reported, not
            // delivered.
            const test = this.generateKeyMaterial();
            const testEnvelope = this.encryptBundle(bundle, test.keyMaterial);
            const opened = this.decryptEnvelope(testEnvelope, test.privateKeyPem, test.keyMaterial.nonce);
            if (JSON.stringify(opened) !== JSON.stringify(bundle ?? null)) {
                throw new Error('Local crypto self-test failed; transfer aborted.');
            }
            return { status: 'mock-loopback', bytes, keyId: envelope.keyId, endpoint: 'mock-loopback', at };
        }
        const fetchFn = this.deps.fetchFn || fetch;
        const timeoutSupported = typeof AbortSignal !== 'undefined'
            && typeof (AbortSignal as any).timeout === 'function';
        const signal = timeoutSupported ? (AbortSignal as any).timeout(30_000) : undefined;
        let response: any;
        try {
            response = await fetchFn(target, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ envelope }),
                ...(signal ? { signal } : {})
            });
        } catch (error) {
            const timedOut = error instanceof Error && /abort|timeout/i.test(error.message);
            throw new Error(timedOut
                ? 'Transfer timed out after 30 seconds. Retry when the receiving system responds.'
                : `Transfer endpoint unreachable: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (!response || !response.ok) {
            throw new Error(`Transfer rejected (HTTP ${response?.status || 'unknown'}).`);
        }
        return { status: 'delivered', bytes, keyId: envelope.keyId, endpoint: target, at };
    }
}
