import { GetParametersCommand, SSMClient } from '@aws-sdk/client-ssm';
import type { VendorCredentials } from './ports.js';

const CACHE_MS = 5 * 60 * 1000;

export interface ParameterStoreOptions {
    /** Parameter holding the vendor Client ID (String or SecureString). */
    clientIdName: string;
    /** SecureString parameter holding the vendor client secret. */
    clientSecretName: string;
    client?: Pick<SSMClient, 'send'>;
    nowMs?: () => number;
}

/**
 * Vendor credentials from SSM Parameter Store, read in one decrypted
 * GetParameters call and kept in memory for five minutes, so a rotated
 * secret is picked up without a redeploy. Values are never logged.
 */
export class ParameterStoreCredentials implements VendorCredentials {
    private cached: { clientId: string; clientSecret: string; at: number } | null = null;
    private readonly client: Pick<SSMClient, 'send'>;
    private readonly nowMs: () => number;

    constructor(private readonly options: ParameterStoreOptions) {
        this.client = options.client ?? new SSMClient({});
        this.nowMs = options.nowMs ?? Date.now;
    }

    async load(): Promise<{ clientId: string; clientSecret: string }> {
        const cached = this.cached;
        if (cached && this.nowMs() - cached.at < CACHE_MS) {
            return { clientId: cached.clientId, clientSecret: cached.clientSecret };
        }
        const { clientIdName, clientSecretName } = this.options;
        const result = await this.client.send(new GetParametersCommand({
            Names: [clientIdName, clientSecretName],
            WithDecryption: true
        }));
        const values = new Map((result.Parameters ?? []).map((p) => [p.Name, p.Value]));
        const clientId = String(values.get(clientIdName) ?? '').trim();
        const clientSecret = String(values.get(clientSecretName) ?? '');
        if (!clientId || !clientSecret) throw new Error('vendor_credentials_missing');
        this.cached = { clientId, clientSecret, at: this.nowMs() };
        return { clientId, clientSecret };
    }
}

/**
 * One SecureString read through Parameter Store, kept in memory for five
 * minutes, such as the pairing-code pepper (#154). It must hold at least
 * 32 characters.
 */
export class ParameterStoreSecret {
    private cached: { value: Buffer; at: number } | null = null;
    private readonly client: Pick<SSMClient, 'send'>;
    private readonly nowMs: () => number;

    constructor(private readonly name: string, options: { client?: Pick<SSMClient, 'send'>; nowMs?: () => number } = {}) {
        this.client = options.client ?? new SSMClient({});
        this.nowMs = options.nowMs ?? Date.now;
    }

    async load(): Promise<Buffer> {
        if (this.cached && this.nowMs() - this.cached.at < CACHE_MS) return this.cached.value;
        const result = await this.client.send(new GetParametersCommand({ Names: [this.name], WithDecryption: true }));
        const value = Buffer.from(String(result.Parameters?.[0]?.Value ?? ''), 'utf8');
        if (value.length < 32) throw new Error('secret_parameter_missing');
        this.cached = { value, at: this.nowMs() };
        return value;
    }
}
