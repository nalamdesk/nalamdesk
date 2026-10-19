// @vitest-environment node
import * as crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hasWebCryptoX25519, seal } from '../src/lib/seal';
import { open } from './sealReference';

function clinicKeys() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
    return { privateKey, publicRaw: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64') };
}

const payload = new TextEncoder().encode(JSON.stringify({ name: 'Asha', phone: '9876543210', reason: 'Fever' }));

describe('browser sealing', () => {
    it('produces envelopes the clinic opens with the relay format', async () => {
        expect(await hasWebCryptoX25519()).toBe(true);
        const clinic = clinicKeys();
        const sealed = await seal(payload, clinic.publicRaw, 'clinic-1');
        expect(JSON.parse(open(sealed, clinic.privateKey, 'clinic-1', 'booking-request').toString())).toEqual({ name: 'Asha', phone: '9876543210', reason: 'Fever' });
    });

    it('works the same through the @noble/curves fallback for older browsers', async () => {
        const clinic = clinicKeys();
        const sealed = await seal(payload, clinic.publicRaw, 'clinic-1', { forceFallback: true });
        expect(open(sealed, clinic.privateKey, 'clinic-1', 'booking-request').toString()).toContain('Asha');
    });

    it('binds the clinic and item type, and leaks nothing in the envelope', async () => {
        const clinic = clinicKeys();
        const sealed = await seal(payload, clinic.publicRaw, 'clinic-1');
        expect(() => open(sealed, clinic.privateKey, 'clinic-2', 'booking-request')).toThrow();
        expect(() => open(sealed, clinic.privateKey, 'clinic-1', 'abdm-callback')).toThrow();
        expect(() => open(sealed, clinicKeys().privateKey, 'clinic-1', 'booking-request')).toThrow();
        const decoded = Buffer.from(sealed, 'base64').toString();
        expect(decoded).not.toContain('Asha');
        expect(decoded).not.toContain('9876543210');
        const envelope = JSON.parse(decoded);
        expect(Object.keys(envelope).sort()).toEqual(['ct', 'epk', 'iv', 'salt', 'tag', 'v']);
    });

    it('uses a fresh ephemeral key every time', async () => {
        const clinic = clinicKeys();
        const a = JSON.parse(Buffer.from(await seal(payload, clinic.publicRaw, 'c'), 'base64').toString());
        const b = JSON.parse(Buffer.from(await seal(payload, clinic.publicRaw, 'c'), 'base64').toString());
        expect(a.epk).not.toBe(b.epk);
        expect(a.iv).not.toBe(b.iv);
    });

    it('refuses a clinic key that is not 32 bytes', async () => {
        await expect(seal(payload, 'AAAA', 'c')).rejects.toThrow('32-byte');
    });
});
