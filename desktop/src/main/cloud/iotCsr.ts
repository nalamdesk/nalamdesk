import * as crypto from 'node:crypto';

// The doorbell certificate request (#155). The relay asks IoT Core to sign a
// CSR this computer makes, so the doorbell's private key never leaves it.
// Node can make the P-256 key and the signature but not the CSR itself, so
// the few DER structures PKCS#10 needs are written out here.

const der = (tag: number, body: Buffer): Buffer => {
    const length = body.length;
    let header: Buffer;
    if (length < 0x80) header = Buffer.from([tag, length]);
    else if (length < 0x100) header = Buffer.from([tag, 0x81, length]);
    else header = Buffer.from([tag, 0x82, length >> 8, length & 0xff]);
    return Buffer.concat([header, body]);
};
const sequence = (...parts: Buffer[]) => der(0x30, Buffer.concat(parts));

// 2.5.4.3 commonName, 1.2.840.10045.4.3.2 ecdsa-with-SHA256
const OID_COMMON_NAME = Buffer.from('0603550403', 'hex');
const OID_ECDSA_SHA256 = Buffer.from('06082a8648ce3d040302', 'hex');

/** A new P-256 key; IoT Core accepts it and the relay refuses anything else. */
export function newDoorbellKey(): crypto.KeyObject {
    return crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
}

/** PKCS#10 request with subject CN=<commonName>, signed by `privateKey`. */
export function certificateRequest(privateKey: crypto.KeyObject, commonName: string): string {
    const spki = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
    const subject = sequence(der(0x31, sequence(OID_COMMON_NAME, der(0x0c, Buffer.from(commonName, 'utf8')))));
    const info = sequence(der(0x02, Buffer.from([0])), subject, spki, der(0xa0, Buffer.alloc(0)));
    const signature = crypto.sign('sha256', info, { key: privateKey, dsaEncoding: 'der' });
    const request = sequence(info, sequence(OID_ECDSA_SHA256), der(0x03, Buffer.concat([Buffer.from([0]), signature])));
    const lines = request.toString('base64').match(/.{1,64}/g) ?? [];
    return `-----BEGIN CERTIFICATE REQUEST-----\n${lines.join('\n')}\n-----END CERTIFICATE REQUEST-----\n`;
}
