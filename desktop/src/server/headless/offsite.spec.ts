import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import { createOffsiteTarget, encodeS3Segment, FolderTarget, OFFSITE_RETENTION_MS, S3Target, signS3Request, type S3Request } from './offsite';

const AWS_KEYS = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' };
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

describe('signS3Request', () => {
    // Test vectors from the AWS "Signature Version 4 for Amazon S3" examples.
    it('matches the AWS GET object example', () => {
        const signed = signS3Request({
            method: 'GET', canonicalUri: '/test.txt', payloadHash: EMPTY_SHA256, region: 'us-east-1',
            ...AWS_KEYS, now: new Date('2013-05-24T00:00:00Z'),
            headers: { Host: 'examplebucket.s3.amazonaws.com', Range: 'bytes=0-9', 'x-amz-content-sha256': EMPTY_SHA256 }
        });
        expect(signed['x-amz-date']).toBe('20130524T000000Z');
        expect(signed.authorization).toBe('AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, '
            + 'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, '
            + 'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
    });

    it('matches the AWS PUT object example', () => {
        const payload = crypto.createHash('sha256').update('Welcome to Amazon S3.').digest('hex');
        const signed = signS3Request({
            method: 'PUT', canonicalUri: `/${encodeS3Segment('test$file.text')}`, payloadHash: payload, region: 'us-east-1',
            ...AWS_KEYS, now: new Date('2013-05-24T00:00:00Z'),
            headers: {
                Date: 'Fri, 24 May 2013 00:00:00 GMT', Host: 'examplebucket.s3.amazonaws.com',
                'x-amz-storage-class': 'REDUCED_REDUNDANCY', 'x-amz-content-sha256': payload
            }
        });
        expect(signed.authorization).toContain('SignedHeaders=date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class');
        expect(signed.authorization).toContain('Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd');
    });

    it('encodes reserved characters in key segments', () => {
        expect(encodeS3Segment("a b!'()*~.-_")).toBe('a%20b%21%27%28%29%2A~.-_');
    });
});

describe('off-site targets', () => {
    let root: string;
    let bundle: string;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'nalamdesk-offsite-'));
        bundle = path.join(root, 'nalamdesk-auto-backup-2026.ndbackup');
        fs.writeFileSync(bundle, Buffer.from('NALAMDESK-BACKUP\nencrypted-bytes'));
    });
    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

    describe('FolderTarget', () => {
        it('copies the bundle whole and leaves no partial file', async () => {
            const share = path.join(root, 'share');
            fs.mkdirSync(share);
            const target = createOffsiteTarget({ kind: 'folder', path: share });
            expect(target.description).toBe(`folder ${share}`);
            await target.uploadFile(bundle, path.basename(bundle));
            expect(fs.readFileSync(path.join(share, path.basename(bundle)))).toEqual(fs.readFileSync(bundle));
            expect(fs.readdirSync(share)).toEqual([path.basename(bundle)]);
        });

        it('refuses a missing folder instead of creating it on the server disk', async () => {
            const unmounted = path.join(root, 'usb');
            await expect(new FolderTarget(unmounted).uploadFile(bundle, 'x.ndbackup')).rejects.toThrow('is not available');
            expect(fs.existsSync(unmounted)).toBe(false);
        });

        it('refuses a path that is a file', async () => {
            const file = path.join(root, 'file');
            fs.writeFileSync(file, '');
            await expect(new FolderTarget(file).uploadFile(bundle, 'x.ndbackup')).rejects.toThrow('is not a folder');
        });

        it('removes copies past retention but keeps other files', async () => {
            const share = path.join(root, 'share');
            fs.mkdirSync(share);
            const old = path.join(share, 'nalamdesk-auto-backup-old.ndbackup');
            const unrelated = path.join(share, 'notes.txt');
            fs.writeFileSync(old, 'old');
            fs.writeFileSync(unrelated, 'keep');
            const past = (Date.now() - OFFSITE_RETENTION_MS - 60_000) / 1000;
            fs.utimesSync(old, past, past);
            fs.utimesSync(unrelated, past, past);
            await new FolderTarget(share).uploadFile(bundle, path.basename(bundle));
            expect(fs.existsSync(old)).toBe(false);
            expect(fs.existsSync(unrelated)).toBe(true);
        });
    });

    describe('S3Target', () => {
        const config = {
            kind: 's3' as const, endpoint: 'https://s3.example.com', bucket: 'clinic-backups', region: 'ap-south-1',
            prefix: 'nalamdesk/', ...AWS_KEYS
        };

        it('PUTs the bundle path-style with a signed payload hash', async () => {
            const sent: S3Request[] = [];
            const target = new S3Target(config, {
                now: () => new Date('2026-11-02T05:00:00Z'),
                send: async (request) => { sent.push(request); return { status: 200, body: '' }; }
            });
            expect(target.description).toBe('S3 bucket clinic-backups at s3.example.com');
            await target.uploadFile(bundle, path.basename(bundle));
            expect(sent).toHaveLength(1);
            const [request] = sent;
            expect(request.method).toBe('PUT');
            expect(request.url.toString()).toBe('https://s3.example.com/clinic-backups/nalamdesk/nalamdesk-auto-backup-2026.ndbackup');
            const hash = crypto.createHash('sha256').update(fs.readFileSync(bundle)).digest('hex');
            expect(request.headers['x-amz-content-sha256']).toBe(hash);
            expect(request.headers['content-length']).toBe(String(fs.statSync(bundle).size));
            expect(request.headers.authorization).toMatch(
                /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20261102\/ap-south-1\/s3\/aws4_request, SignedHeaders=content-length;content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
            expect(JSON.stringify(request.headers)).not.toContain(AWS_KEYS.secretAccessKey);
        });

        it('keeps an endpoint path and reports the S3 error code on failure', async () => {
            const sent: S3Request[] = [];
            const target = new S3Target({ ...config, endpoint: 'https://gateway.example.com/storage/', prefix: '' }, {
                send: async (request) => {
                    sent.push(request);
                   
                    return { status: 403, body: '<Error><Code>SignatureDoesNotMatch</Code></Error>' };
                }
            });
            await expect(target.uploadFile(bundle, 'b.ndbackup')).rejects.toThrow('HTTP 403, SignatureDoesNotMatch');
            expect(sent[0].url.pathname).toBe('/storage/clinic-backups/b.ndbackup');
        });

        it('streams the file over HTTP to an S3-compatible server', async () => {
            const received: { url?: string; body?: Buffer; headers?: http.IncomingHttpHeaders } = {};
            const server = http.createServer((req, res) => {
                const chunks: Buffer[] = [];
                req.on('data', (chunk: Buffer) => chunks.push(chunk));
                req.on('end', () => {
                    Object.assign(received, { url: req.url, body: Buffer.concat(chunks), headers: req.headers });
                    res.writeHead(200).end();
                });
            });
            await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
            try {
                const { port } = server.address() as AddressInfo;
                await createOffsiteTarget({ ...config, endpoint: `http://127.0.0.1:${port}` }).uploadFile(bundle, 'c.ndbackup');
                expect(received.url).toBe('/clinic-backups/nalamdesk/c.ndbackup');
                expect(received.body).toEqual(fs.readFileSync(bundle));
                expect(received.headers?.authorization).toContain('AWS4-HMAC-SHA256');
            } finally {
                await new Promise((resolve) => server.close(resolve));
            }
        });
    });
});
