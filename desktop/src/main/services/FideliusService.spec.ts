import { describe, it, expect, vi } from 'vitest';
import { FideliusService } from './FideliusService';
import * as crypto from 'node:crypto';

function recipient() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519', {
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });
    const raw = crypto.createPublicKey(publicKey)
        .export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
    return { publicKey: raw, privateKey };
}

describe('FideliusService', () => {
    it('round-trips a bundle through encrypt and decrypt', () => {
        const svc = new FideliusService();
        const keys = recipient();
        const bundle = { resourceType: 'Bundle', entry: [{ id: 1 }] };

        const envelope = svc.encryptBundle(bundle, keys.publicKey);

        expect(envelope.ciphertext).not.toContain('Bundle');
        expect(envelope.keyId).toHaveLength(16);
        expect(svc.decryptEnvelope(envelope, keys.privateKey)).toEqual(bundle);
    });

    it('uses a fresh ephemeral key per transfer', () => {
        const svc = new FideliusService();
        const keys = recipient();
        const first = svc.encryptBundle({ n: 1 }, keys.publicKey);
        const second = svc.encryptBundle({ n: 1 }, keys.publicKey);
        expect(first.ephemeralPublicKey).not.toBe(second.ephemeralPublicKey);
        expect(first.ciphertext).not.toBe(second.ciphertext);
    });

    it('rejects tampered envelopes', () => {
        const svc = new FideliusService();
        const keys = recipient();
        const envelope = svc.encryptBundle({ secret: true }, keys.publicKey);
        const tampered = { ...envelope, ciphertext: Buffer.from('tampered').toString('base64') };
        expect(() => svc.decryptEnvelope(tampered, keys.privateKey)).toThrow();
    });

    it('rejects malformed recipient keys without leaking material', () => {
        const svc = new FideliusService();
        expect(() => svc.encryptBundle({ a: 1 }, 'not-a-key')).toThrow('32-byte');
        expect(() => svc.encryptBundle({ a: 1 }, '')).toThrow();
    });

    it('loopbacks without an endpoint, flagged on the receipt', async () => {
        const svc = new FideliusService({ nowMs: () => 1_000_000 });
        const keys = recipient();
        const receipt = await svc.pushBundle({ hello: 'world' }, keys.publicKey);
        expect(receipt).toMatchObject({ status: 'mock-loopback', endpoint: 'mock-loopback' });
        expect(receipt.bytes).toBeGreaterThan(0);
    });

    it('posts the envelope to a live endpoint', async () => {
        const fetchFn = vi.fn().mockResolvedValue({ ok: true });
        const svc = new FideliusService({ fetchFn, nowMs: () => 1_000_000 });
        const keys = recipient();
        const receipt = await svc.pushBundle({ hello: 'world' }, keys.publicKey, 'https://hip.example/push');
        expect(receipt).toMatchObject({ status: 'delivered', endpoint: 'https://hip.example/push' });
        const sent = JSON.parse(fetchFn.mock.calls[0][1].body);
        expect(sent.envelope.ciphertext).toBeTruthy();
        expect(JSON.stringify(sent)).not.toContain('hello');
    });

    it('reports unreachable endpoints plainly', async () => {
        const fetchFn = vi.fn().mockRejectedValue(new Error('socket hang up'));
        const svc = new FideliusService({ fetchFn });
        const keys = recipient();
        await expect(svc.pushBundle({ a: 1 }, keys.publicKey, 'https://down.example'))
            .rejects.toThrow('unreachable');
    });
});
