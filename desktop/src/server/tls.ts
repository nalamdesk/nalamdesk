// HTTPS for NalamDesk Server (#193). Operators bring a certificate (or put a
// reverse proxy in front). Without one the server makes a self-signed
// certificate once, keeps it in <dataDir>/tls, and clients pin it through the
// fingerprint carried in each join code.
//
// The certificate is built here with node:crypto (ECDSA P-256) so the server
// needs neither openssl on the host nor an extra dependency.

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

export interface TlsMaterial {
    key: string;
    cert: string;
    /** True when the server generated the certificate itself. */
    selfSigned: boolean;
    /** SHA-256 of the certificate DER, lowercase hex without separators. */
    fingerprint256: string;
}

export interface LoadTlsOptions {
    dataDir: string;
    /** Operator certificate and key (PEM file paths). Both or neither. */
    certFile?: string;
    keyFile?: string;
    /** Extra DNS names or IPs for a generated certificate. */
    hostnames?: string[];
    now?: Date;
}

const SELF_SIGNED_YEARS = 5;

export function certificateFingerprint(certPem: string): string {
    return new crypto.X509Certificate(certPem).fingerprint256.replace(/:/g, '').toLowerCase();
}

/** Loads the operator certificate, or the stored or a newly generated self-signed one. */
export function loadOrCreateTls(options: LoadTlsOptions): TlsMaterial {
    if (options.certFile || options.keyFile) {
        if (!options.certFile || !options.keyFile) {
            throw new Error('Set both the TLS certificate and key files, or neither.');
        }
        const cert = fs.readFileSync(options.certFile, 'utf8');
        const key = fs.readFileSync(options.keyFile, 'utf8');
        assertKeyMatchesCert(key, cert);
        return { key, cert, selfSigned: false, fingerprint256: certificateFingerprint(cert) };
    }

    const dir = path.join(options.dataDir, 'tls');
    const certPath = path.join(dir, 'server.crt');
    const keyPath = path.join(dir, 'server.key');
    if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
        const cert = fs.readFileSync(certPath, 'utf8');
        const key = fs.readFileSync(keyPath, 'utf8');
        assertKeyMatchesCert(key, cert);
        return { key, cert, selfSigned: true, fingerprint256: certificateFingerprint(cert) };
    }

    const generated = generateSelfSignedCertificate({
        hostnames: defaultHostnames(options.hostnames),
        now: options.now
    });
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(keyPath, generated.key, { mode: 0o600 });
    fs.writeFileSync(certPath, generated.cert, { mode: 0o644 });
    return { ...generated, selfSigned: true, fingerprint256: certificateFingerprint(generated.cert) };
}

function assertKeyMatchesCert(keyPem: string, certPem: string): void {
    const cert = new crypto.X509Certificate(certPem);
    if (!cert.checkPrivateKey(crypto.createPrivateKey(keyPem))) {
        throw new Error('The TLS key does not match the certificate.');
    }
}

function defaultHostnames(extra: string[] = []): string[] {
    const names = new Set<string>(['localhost', '127.0.0.1', '::1']);
    const host = os.hostname();
    if (host) {
        names.add(host);
        if (!host.includes('.')) names.add(`${host}.local`);
    }
    for (const list of Object.values(os.networkInterfaces())) {
        for (const iface of list ?? []) {
            if (!iface.internal && !iface.address.startsWith('fe80')) names.add(iface.address);
        }
    }
    for (const name of extra) if (name.trim()) names.add(name.trim());
    return [...names];
}

// --- Minimal DER encoder for one X.509 v3 certificate ---------------------

function derLength(length: number): Buffer {
    if (length < 0x80) return Buffer.from([length]);
    const bytes: number[] = [];
    for (let n = length; n > 0; n >>= 8) bytes.unshift(n & 0xff);
    return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function der(tag: number, ...content: Buffer[]): Buffer {
    const body = Buffer.concat(content);
    return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}

const seq = (...items: Buffer[]) => der(0x30, ...items);
const set = (...items: Buffer[]) => der(0x31, ...items);
const octets = (value: Buffer) => der(0x04, value);
const utf8 = (value: string) => der(0x0c, Buffer.from(value, 'utf8'));
const explicit = (n: number, value: Buffer) => der(0xa0 + n, value);

function oid(dotted: string): Buffer {
    const parts = dotted.split('.').map(Number);
    const bytes: number[] = [parts[0] * 40 + parts[1]];
    for (const part of parts.slice(2)) {
        const chunk: number[] = [part & 0x7f];
        for (let n = part >> 7; n > 0; n >>= 7) chunk.unshift((n & 0x7f) | 0x80);
        bytes.push(...chunk);
    }
    return der(0x06, Buffer.from(bytes));
}

function positiveInteger(bytes: Buffer): Buffer {
    let value = bytes;
    while (value.length > 1 && value[0] === 0) value = value.subarray(1);
    if (value[0] & 0x80) value = Buffer.concat([Buffer.from([0]), value]);
    return der(0x02, value);
}

function time(date: Date): Buffer {
    const iso = date.toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z';
    // RFC 5280: UTCTime through 2049, GeneralizedTime from 2050.
    return date.getUTCFullYear() < 2050
        ? der(0x17, Buffer.from(iso.slice(2), 'ascii'))
        : der(0x18, Buffer.from(iso, 'ascii'));
}

function subjectAltName(hostnames: string[]): Buffer {
    const names = hostnames.map((name) => {
        if (net.isIPv4(name)) return der(0x87, Buffer.from(name.split('.').map(Number)));
        if (net.isIPv6(name)) return der(0x87, ipv6Bytes(name));
        return der(0x82, Buffer.from(name, 'ascii'));
    });
    return seq(...names);
}

function ipv6Bytes(address: string): Buffer {
    const [head, tail = ''] = address.split('::');
    const headParts = head ? head.split(':') : [];
    const tailParts = address.includes('::') && tail ? tail.split(':') : [];
    const missing = 8 - headParts.length - tailParts.length;
    const groups = [...headParts, ...Array(address.includes('::') ? missing : 0).fill('0'), ...tailParts];
    const out = Buffer.alloc(16);
    groups.forEach((group, i) => out.writeUInt16BE(parseInt(group || '0', 16), i * 2));
    return out;
}

const OID_ECDSA_SHA256 = '1.2.840.10045.4.3.2';
const OID_CN = '2.5.4.3';
const OID_O = '2.5.4.10';

export function generateSelfSignedCertificate(options: { hostnames: string[]; now?: Date; commonName?: string }) {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const notBefore = new Date((options.now ?? new Date()).getTime() - 60 * 60 * 1000);
    const notAfter = new Date(notBefore);
    notAfter.setUTCFullYear(notAfter.getUTCFullYear() + SELF_SIGNED_YEARS);

    const name = seq(
        set(seq(oid(OID_O), utf8('NalamDesk Server'))),
        set(seq(oid(OID_CN), utf8(options.commonName ?? options.hostnames[0] ?? 'localhost')))
    );
    const algorithm = seq(oid(OID_ECDSA_SHA256));
    const spki = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;

    const extensions = seq(
        // basicConstraints: not a CA (critical)
        seq(oid('2.5.29.19'), der(0x01, Buffer.from([0xff])), octets(seq())),
        // keyUsage: digitalSignature (critical)
        seq(oid('2.5.29.15'), der(0x01, Buffer.from([0xff])), octets(der(0x03, Buffer.from([0x07, 0x80])))),
        // extKeyUsage: serverAuth
        seq(oid('2.5.29.37'), octets(seq(oid('1.3.6.1.5.5.7.3.1')))),
        // subjectAltName
        seq(oid('2.5.29.17'), octets(subjectAltName(options.hostnames)))
    );

    const tbs = seq(
        explicit(0, der(0x02, Buffer.from([2]))),
        positiveInteger(crypto.randomBytes(16)),
        algorithm,
        name,
        seq(time(notBefore), time(notAfter)),
        name,
        spki,
        explicit(3, extensions)
    );
    const signature = crypto.sign('sha256', tbs, privateKey);
    const certDer = seq(tbs, algorithm, der(0x03, Buffer.concat([Buffer.from([0]), signature])));

    const body = certDer.toString('base64').match(/.{1,64}/g)!.join('\n');
    return {
        cert: `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`,
        key: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
    };
}
