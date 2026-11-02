import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as path from 'path';
import { pipeline } from 'stream/promises';
import type { OffsiteCopyTarget } from '../../main/services/BackupService';

/**
 * Off-site copy of the server's scheduled backups (#216). Each copy is the
 * `.ndbackup` bundle exactly as written to `<dataDir>/backups`: the database
 * inside is SQLCipher-encrypted and the key slots are wrapped, so nothing
 * readable leaves the server. Restoring a copy still needs the recovery code.
 */
export type OffsiteTargetConfig =
    | { kind: 'folder'; path: string }
    | {
        kind: 's3';
        endpoint: string;
        bucket: string;
        region: string;
        prefix: string;
        accessKeyId: string;
        secretAccessKey: string;
    };

/** `description` says where copies go and is shown to admins, so it never includes secrets. */
export type OffsiteTarget = OffsiteCopyTarget;

/** Copies older than this are removed from a folder target, matching local retention. */
export const OFFSITE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const AUTO_BACKUP = /^nalamdesk-auto-backup-.+\.ndbackup$/;

export function createOffsiteTarget(config: OffsiteTargetConfig, deps: S3Deps = {}): OffsiteTarget {
    return config.kind === 'folder' ? new FolderTarget(config.path) : new S3Target(config, deps);
}

/** A mounted network share, USB drive or second disk. */
export class FolderTarget implements OffsiteTarget {
    readonly description: string;

    constructor(private readonly folder: string, private readonly now: () => number = Date.now) {
        this.description = `folder ${folder}`;
    }

    async uploadFile(filePath: string, name: string): Promise<void> {
        // Never create the folder: an unmounted USB drive or share would
        // otherwise silently receive copies on the server's own disk.
        let stats: fs.Stats;
        try {
            stats = fs.statSync(this.folder);
        } catch {
            throw new Error(`${this.folder} is not available. Check that the drive or network share is mounted.`);
        }
        if (!stats.isDirectory()) throw new Error(`${this.folder} is not a folder.`);

        const destination = path.join(this.folder, path.basename(name));
        const partial = `${destination}.partial`;
        try {
            await pipeline(fs.createReadStream(filePath), fs.createWriteStream(partial, { flags: 'w' }));
            const fd = fs.openSync(partial, 'r');
            try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
            fs.renameSync(partial, destination);
        } catch (error) {
            fs.rmSync(partial, { force: true });
            throw error;
        }
        this.prune();
    }

    private prune(): void {
        try {
            for (const file of fs.readdirSync(this.folder)) {
                if (!AUTO_BACKUP.test(file)) continue;
                const target = path.join(this.folder, file);
                if (this.now() - fs.statSync(target).mtimeMs > OFFSITE_RETENTION_MS) fs.unlinkSync(target);
            }
        } catch (error) {
            console.error('[Backup] Failed to prune old off-site copies:', error);
        }
    }
}

export interface S3Request {
    method: string;
    url: URL;
    headers: Record<string, string>;
    /** Streamed as the request body. */
    filePath: string;
}
export interface S3Response { status: number; body: string }
export interface S3Deps {
    send?: (request: S3Request) => Promise<S3Response>;
    now?: () => Date;
}

/** Any S3-compatible object store: AWS S3, Cloudflare R2, Backblaze B2, Wasabi, MinIO. */
export class S3Target implements OffsiteTarget {
    readonly description: string;
    private readonly send: (request: S3Request) => Promise<S3Response>;
    private readonly now: () => Date;

    constructor(private readonly config: Extract<OffsiteTargetConfig, { kind: 's3' }>, deps: S3Deps = {}) {
        this.description = `S3 bucket ${config.bucket} at ${new URL(config.endpoint).host}`;
        this.send = deps.send ?? sendHttp;
        this.now = deps.now ?? (() => new Date());
    }

    async uploadFile(filePath: string, name: string): Promise<void> {
        const payloadHash = await sha256File(filePath);
        const size = fs.statSync(filePath).size;
        const base = new URL(this.config.endpoint);
        const basePath = base.pathname.replace(/\/+$/, '');
        // Path-style addressing works with every S3-compatible store.
        const key = `${this.config.prefix}${path.basename(name)}`;
        const url = new URL(base.origin);
        url.pathname = `${basePath}/${encodeS3Segment(this.config.bucket)}/${key.split('/').map(encodeS3Segment).join('/')}`;

        const headers: Record<string, string> = {
            'content-length': String(size),
            'content-type': 'application/octet-stream',
            host: url.host,
            'x-amz-content-sha256': payloadHash
        };
        const signed = signS3Request({
            method: 'PUT', canonicalUri: url.pathname, headers, payloadHash,
            region: this.config.region, accessKeyId: this.config.accessKeyId,
            secretAccessKey: this.config.secretAccessKey, now: this.now()
        });
        const response = await this.send({ method: 'PUT', url, headers: signed, filePath });
        if (response.status < 200 || response.status >= 300) {
            throw new Error(`The bucket refused the upload (HTTP ${response.status}${s3ErrorCode(response.body)}).`);
        }
    }
}

export interface SignInput {
    method: string;
    canonicalUri: string;
    canonicalQuery?: string;
    headers: Record<string, string>;
    payloadHash: string;
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
    now: Date;
    service?: string;
}

/** AWS Signature Version 4, header form. Returns the headers to send, with x-amz-date and Authorization added. */
export function signS3Request(input: SignInput): Record<string, string> {
    const service = input.service ?? 's3';
    const amzDate = input.now.toISOString().replace(/[:-]/g, '').replace(/\.\d{3}/, '');
    const day = amzDate.slice(0, 8);
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(input.headers)) headers[name.toLowerCase()] = value;
    headers['x-amz-date'] = amzDate;

    // Byte order, not locale order: SigV4 compares header names as ASCII.
    const names = Object.keys(headers).sort(compareAscii);
    const canonicalHeaders = names.map((name) => `${name}:${headers[name].trim().replace(/\s+/g, ' ')}\n`).join('');
    const signedHeaders = names.join(';');
    const canonicalRequest = [
        input.method, input.canonicalUri, input.canonicalQuery ?? '', canonicalHeaders, signedHeaders, input.payloadHash
    ].join('\n');
    const scope = `${day}/${input.region}/${service}/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');

    let key: Buffer = hmac(`AWS4${input.secretAccessKey}`, day);
    for (const part of [input.region, service, 'aws4_request']) key = hmac(key, part);
    const signature = hmac(key, stringToSign).toString('hex');

    return {
        ...headers,
        authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
    };
}

/** RFC 3986 encoding as SigV4 requires: everything but unreserved characters. */
export function encodeS3Segment(segment: string): string {
    return encodeURIComponent(segment).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function compareAscii(a: string, b: string): number {
    if (a === b) return 0;
    return a < b ? -1 : 1;
}

function hmac(key: string | Buffer, data: string): Buffer {
    return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

function sha256Hex(text: string): string {
    return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

async function sha256File(filePath: string): Promise<string> {
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk as Buffer);
    return hash.digest('hex');
}

function s3ErrorCode(body: string): string {
    const code = /<Code>([^<]{1,100})<\/Code>/.exec(body)?.[1];
    return code ? `, ${code}` : '';
}

const UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;

function sendHttp(request: S3Request): Promise<S3Response> {
    const transport = request.url.protocol === 'http:' ? http : https;
    return new Promise((resolve, reject) => {
        const req = transport.request(request.url, { method: request.method, headers: request.headers, timeout: UPLOAD_TIMEOUT_MS }, (res) => {
            const chunks: Buffer[] = [];
            let length = 0;
            res.on('data', (chunk: Buffer) => {
                // Only an error document is expected back; keep a bounded prefix.
                if (length < 64 * 1024) { chunks.push(chunk); length += chunk.length; }
            });
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
            res.on('error', reject);
        });
        req.on('timeout', () => req.destroy(new Error('The upload timed out.')));
        req.on('error', reject);
        const body = fs.createReadStream(request.filePath);
        body.on('error', (error) => req.destroy(error));
        body.pipe(req);
    });
}
