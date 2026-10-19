import * as crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { certificateRequest, newDoorbellKey } from './iotCsr';

/** Reads one DER element: its tag, its whole encoding and its contents. */
function element(buf: Buffer, at = 0) {
    const tag = buf[at]!;
    let length = buf[at + 1]!;
    let header = 2;
    if (length & 0x80) {
        const bytes = length & 0x7f;
        length = 0;
        for (let i = 0; i < bytes; i++) length = (length << 8) | buf[at + 2 + i]!;
        header += bytes;
    }
    return { tag, whole: buf.subarray(at, at + header + length), body: buf.subarray(at + header, at + header + length) };
}

describe('doorbell certificate request', () => {
    it('is a PKCS#10 request for a P-256 key, signed by that key, naming the device', () => {
        const key = newDoorbellKey();
        expect(key.asymmetricKeyDetails?.namedCurve).toBe('prime256v1');
        const pem = certificateRequest(key, 'dev_abcdefghjkmnpqrs');
        expect(pem).toMatch(/^-----BEGIN CERTIFICATE REQUEST-----\n[A-Za-z0-9+/=\n]+-----END CERTIFICATE REQUEST-----\n$/);

        const der = Buffer.from(pem.replace(/-----[^-]+-----|\n/g, ''), 'base64');
        const outer = element(der);
        const info = element(outer.body);
        const algorithm = element(outer.body, info.whole.length);
        const signature = element(outer.body, info.whole.length + algorithm.whole.length);
        expect(algorithm.body.toString('hex')).toBe('06082a8648ce3d040302');
        expect(crypto.verify('sha256', info.whole, { key: crypto.createPublicKey(key), dsaEncoding: 'der' }, signature.body.subarray(1))).toBe(true);
        expect(info.whole.includes(Buffer.from('dev_abcdefghjkmnpqrs'))).toBe(true);
        expect(info.whole.includes(crypto.createPublicKey(key).export({ type: 'spki', format: 'der' }))).toBe(true);
    });
});
