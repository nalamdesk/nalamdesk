import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

export interface OpsUser {
    /** Cognito user ID (sub); recorded on approvals and revocations. */
    sub: string;
    username: string;
}

export type OpsTokenVerifier = (authorization: string | undefined) => Promise<OpsUser | null>;

export interface OpsAuthOptions {
    region: string;
    userPoolId: string;
    /** The ops console app client; tokens for any other client are refused. */
    clientId: string;
    /** Test hook: a local key set instead of the pool's published keys. */
    keys?: JWTVerifyGetKey;
}

/**
 * Checks a Cognito access token from the ops user pool (#153): signature
 * against the pool's published keys, issuer, expiry, `token_use` access,
 * the console's app client, and membership of the `ops` group. The pool
 * itself requires TOTP MFA and has no self sign-up.
 */
export function createOpsTokenVerifier(options: OpsAuthOptions): OpsTokenVerifier {
    const issuer = `https://cognito-idp.${options.region}.amazonaws.com/${options.userPoolId}`;
    const keys = options.keys ?? createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
    return async (authorization) => {
        const match = /^Bearer ([A-Za-z0-9._-]+)$/.exec(authorization ?? '');
        if (!match) return null;
        try {
            const { payload } = await jwtVerify(match[1] as string, keys, { issuer, algorithms: ['RS256'] });
            if (payload.token_use !== 'access' || payload.client_id !== options.clientId) return null;
            const groups = payload['cognito:groups'];
            if (!Array.isArray(groups) || !groups.includes('ops')) return null;
            if (typeof payload.sub !== 'string') return null;
            return { sub: payload.sub, username: typeof payload.username === 'string' ? payload.username : payload.sub };
        } catch {
            return null;
        }
    };
}
