import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

export interface GatewayJwtOptions {
    /** JWKS URL the gateway signs callbacks with. */
    certsUrl: string;
    /** Expected `iss`; enforced when set. Confirm the v3 value with NHA (#152). */
    issuer?: string;
    /** Test hook: supply keys directly instead of fetching the JWKS. */
    keys?: JWTVerifyGetKey;
}

export type GatewayJwtVerifier = (authorization: string | undefined) => Promise<boolean>;

/**
 * Verifies the bearer JWT ABDM puts on every callback: signature against the
 * gateway's published keys, expiry, and issuer when configured. Anything
 * missing or malformed is a plain rejection; nothing about the failure is
 * echoed to the caller.
 */
export function createGatewayJwtVerifier(options: GatewayJwtOptions): GatewayJwtVerifier {
    const keys = options.keys ?? createRemoteJWKSet(new URL(options.certsUrl), {
        cacheMaxAge: 10 * 60 * 1000,
        cooldownDuration: 30 * 1000,
        timeoutDuration: 5 * 1000
    });
    return async (authorization) => {
        const match = /^Bearer\s+([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(String(authorization || '').trim());
        if (!match) return false;
        try {
            await jwtVerify(match[1] as string, keys, {
                algorithms: ['RS256', 'RS384', 'RS512', 'PS256', 'ES256'],
                requiredClaims: ['exp'],
                clockTolerance: 30,
                ...(options.issuer ? { issuer: options.issuer } : {})
            });
            return true;
        } catch {
            return false;
        }
    };
}
