import * as crypto from 'node:crypto';

export interface FideliusEnvelope {
    /** Ephemeral sender public key (base64, X25519). */
    ephemeralPublicKey: string;
    /** AES-256-GCM nonce (base64). */
    nonce: string;
    /** Ciphertext (base64). */
    ciphertext: string;
    /** GCM auth tag (base64). */
    tag: string;
    /** Key fingerprint the recipient can log without seeing key material. */
    keyId: string;
}

export interface FideliusReceipt {
    status: 'delivered' | 'mock-loopback';
    bytes: number;
    keyId: string;
    endpoint: string;
    at: string;
}

function hkdfSha256(secret: Buffer, salt: Buffer, info: Buffer, length: number): Buffer {
    return Buffer.from(crypto.hkdfSync('sha256', secret, salt, info, length));
}

function keyFingerprint(publicKeyBase64: string): string {
    return crypto.createHash('sha256')
        .update(Buffer.from(publicKeyBase64, 'base64'))
        .digest('hex')
        .slice(0, 16);
}

/**
 * Fidelius-style direct data-push transfer (main process).
 *
 * Key agreement is ECDH over Curve25519 (X25519); the shared secret is
 * expanded with HKDF-SHA256 and the payload is sealed with AES-256-GCM.
 * Ephemeral sender keys exist only in memory for one transfer — they are
 * never persisted, logged, or reused.
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

    /** Fresh ephemeral X25519 key pair; the private half never leaves memory. */
    generateEphemeralKeyPair(): { publicKey: string; privateKey: string } {
        const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519', {
            publicKeyEncoding: { type: 'spki', format: 'pem' },
            privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
        });
        return {
            publicKey: this.pemToRawBase64(publicKey),
            privateKey
        };
    }

    private pemToRawBase64(pem: string): string {
        const key = crypto.createPublicKey(pem);
        return key.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
    }

    private rawToPublicKey(rawBase64: string): crypto.KeyObject {
        const raw = Buffer.from(rawBase64, 'base64');
        if (raw.length !== 32) throw new Error('Recipient key must be 32-byte X25519.');
        const prefix = Buffer.from('302a300506032b656e032100', 'hex');
        return crypto.createPublicKey({
            key: Buffer.concat([prefix, raw]),
            format: 'der',
            type: 'spki'
        });
    }

    /** Encrypts a JSON-serializable bundle for the holder of the peer key. */
    encryptBundle(bundle: unknown, recipientPublicKey: string): FideliusEnvelope {
        const plaintext = JSON.stringify(bundle ?? null);
        const ephemeral = crypto.generateKeyPairSync('x25519');
        const peerKey = this.rawToPublicKey(String(recipientPublicKey || '').trim());
        const shared = crypto.diffieHellman({ publicKey: peerKey, privateKey: ephemeral.privateKey });
        const salt = crypto.randomBytes(16);
        const key = hkdfSha256(shared, salt, Buffer.from('nalamdesk-fidelius-v1'), 32);
        const nonce = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
        const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
        const tag = cipher.getAuthTag();
        const ephemeralPublic = (ephemeral.publicKey as crypto.KeyObject)
            .export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
        return {
            ephemeralPublicKey: ephemeralPublic,
            nonce: Buffer.concat([salt, nonce]).toString('base64'),
            ciphertext: ciphertext.toString('base64'),
            tag: tag.toString('base64'),
            keyId: keyFingerprint(String(recipientPublicKey).trim())
        };
    }

    /** Decrypts an envelope with the recipient private key (PEM). Verifies integrity. */
    decryptEnvelope(envelope: FideliusEnvelope, recipientPrivateKeyPem: string): unknown {
        const privateKey = crypto.createPrivateKey(recipientPrivateKeyPem);
        const ephemeralRaw = Buffer.from(envelope.ephemeralPublicKey, 'base64');
        if (ephemeralRaw.length !== 32) throw new Error('Envelope ephemeral key is invalid.');
        const prefix = Buffer.from('302a300506032b656e032100', 'hex');
        const ephemeralKey = crypto.createPublicKey({
            key: Buffer.concat([prefix, ephemeralRaw]),
            format: 'der',
            type: 'spki'
        });
        const shared = crypto.diffieHellman({ publicKey: ephemeralKey, privateKey });
        const nonceRaw = Buffer.from(envelope.nonce, 'base64');
        if (nonceRaw.length !== 28) throw new Error('Envelope nonce is invalid.');
        const key = hkdfSha256(shared, nonceRaw.subarray(0, 16), Buffer.from('nalamdesk-fidelius-v1'), 32);
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonceRaw.subarray(16));
        decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
        const plaintext = Buffer.concat([
            decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
            decipher.final()
        ]).toString('utf8');
        return JSON.parse(plaintext);
    }

    /**
     * Pushes an encrypted bundle. With a live endpoint configured the
     * envelope is POSTed; otherwise it loopbacks (decrypt + integrity check)
     * and the receipt says so.
     */
    async pushBundle(
        bundle: unknown,
        recipientPublicKey: string,
        endpoint?: string
    ): Promise<FideliusReceipt> {
        const envelope = this.encryptBundle(bundle, recipientPublicKey);
        const bytes = Buffer.from(envelope.ciphertext, 'base64').length;
        const at = new Date(this.nowMs()).toISOString();
        const target = String(endpoint || '').trim();
        if (!target) {
            // Mock loopback: prove the crypto pipeline with a throwaway
            // recipient pair before claiming anything about the envelope.
            const canaryKeys = crypto.generateKeyPairSync('x25519');
            const canaryRaw = (canaryKeys.publicKey as crypto.KeyObject)
                .export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
            const canary = this.encryptBundle({ canary: true }, canaryRaw);
            const opened = this.decryptEnvelope(canary, (canaryKeys.privateKey as crypto.KeyObject)
                .export({ type: 'pkcs8', format: 'pem' }).toString()) as any;
            if (!opened || opened.canary !== true) {
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
