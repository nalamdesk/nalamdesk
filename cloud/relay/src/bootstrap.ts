import { createDeviceAuthenticator, DynamoDeviceRegistry, DynamoNonceStore } from '@nalamdesk/cloud-shared';
import { Hono } from 'hono';
import { createRelayApp } from './app.js';
import { DynamoFacilityDirectory } from './dynamoFacilities.js';
import { resolveEnvironment } from './environments.js';
import { createGatewayJwtVerifier } from './gatewayJwt.js';
import { GatewaySession } from './gatewaySession.js';
import { DynamoPairingRateLimiter, DynamoPairingStore } from './dynamoPairing.js';
import { createOpsTokenVerifier } from './opsAuth.js';
import { PairingService } from './pairing.js';
import type { PairingRouteDeps } from './pairingRoutes.js';
import { ParameterStoreCredentials, ParameterStoreSecret } from './parameterStore.js';
import type { DeviceAuthenticator, Doorbell, FacilityDirectory, Mailbox, VendorCredentials } from './ports.js';

export interface Adapters {
    devices?: DeviceAuthenticator;
    facilities?: FacilityDirectory;
    mailbox?: Mailbox;
    doorbell?: Doorbell;
    credentials?: VendorCredentials;
    pairing?: PairingRouteDeps;
}

// Which issue supplies each adapter that is not wired from the environment yet.
const OWNERS: Record<keyof Adapters, string> = {
    devices: 'device authenticator (DEVICES_TABLE, NONCES_TABLE)',
    facilities: 'facility directory (DEVICES_TABLE)',
    mailbox: 'mailbox (#155)',
    doorbell: 'doorbell (#155)',
    credentials: 'vendor credentials (ABDM_CLIENT_ID_PARAM, ABDM_CLIENT_SECRET_PARAM)',
    pairing: 'pairing (PAIRING_TABLE, CLINIC_IDS_TABLE, PAIRING_PEPPER_PARAM, BRIDGE_URL, OPS_USER_POOL_ID, OPS_CLIENT_ID, OPS_AUTH_DOMAIN)'
};

/** Pairing and the ops console, when every name they need is set. */
export function pairingFromEnv(env: NodeJS.ProcessEnv): PairingRouteDeps | undefined {
    const { DEVICES_TABLE, NONCES_TABLE, PAIRING_TABLE, CLINIC_IDS_TABLE, PAIRING_PEPPER_PARAM, BRIDGE_URL,
        OPS_USER_POOL_ID, OPS_CLIENT_ID, OPS_AUTH_DOMAIN } = env;
    const region = env.AWS_REGION || 'ap-south-1';
    if (!DEVICES_TABLE || !NONCES_TABLE || !PAIRING_TABLE || !CLINIC_IDS_TABLE || !PAIRING_PEPPER_PARAM || !BRIDGE_URL ||
        !OPS_USER_POOL_ID || !OPS_CLIENT_ID || !OPS_AUTH_DOMAIN) return undefined;
    const pepper = new ParameterStoreSecret(PAIRING_PEPPER_PARAM);
    return {
        service: new PairingService({
            store: new DynamoPairingStore({ devices: DEVICES_TABLE, pairing: PAIRING_TABLE, clinicIds: CLINIC_IDS_TABLE }),
            ipLimiter: new DynamoPairingRateLimiter(NONCES_TABLE),
            pepper: () => pepper.load(),
            bridgeUrl: BRIDGE_URL.replace(/\/+$/, '')
        }),
        verifyOps: createOpsTokenVerifier({ region, userPoolId: OPS_USER_POOL_ID, clientId: OPS_CLIENT_ID }),
        console: { authDomain: OPS_AUTH_DOMAIN, clientId: OPS_CLIENT_ID }
    };
}

/** Adapters that can be built from environment variables alone. */
export function adaptersFromEnv(env: NodeJS.ProcessEnv): Adapters {
    return {
        pairing: pairingFromEnv(env),
        devices: env.DEVICES_TABLE && env.NONCES_TABLE
            ? createDeviceAuthenticator({
                audience: 'relay',
                devices: new DynamoDeviceRegistry(env.DEVICES_TABLE),
                nonces: new DynamoNonceStore(env.NONCES_TABLE)
            })
            : undefined,
        facilities: env.DEVICES_TABLE ? new DynamoFacilityDirectory(env.DEVICES_TABLE) : undefined,
        credentials: env.ABDM_CLIENT_ID_PARAM && env.ABDM_CLIENT_SECRET_PARAM
            ? new ParameterStoreCredentials({
                clientIdName: env.ABDM_CLIENT_ID_PARAM,
                clientSecretName: env.ABDM_CLIENT_SECRET_PARAM
            })
            : undefined
    };
}

/**
 * Builds the relay when every adapter is present. Otherwise it returns a
 * holding app that answers 503 everywhere, with /health naming what is
 * missing, so a deployed revision never runs with an open door.
 */
export function buildServerApp(env: NodeJS.ProcessEnv, adapters: Adapters): { app: Hono; missing: string[] } {
    const missing = (Object.keys(OWNERS) as (keyof Adapters)[])
        .filter((key) => !adapters[key])
        .map((key) => OWNERS[key]);
    if (missing.length) {
        const holding = new Hono();
        holding.get('/health', (c) => c.json({ ok: false, missing }, 503));
        holding.all('*', (c) => c.json({ error: 'not_ready' }, 503));
        return { app: holding, missing };
    }
    const { config } = resolveEnvironment(env.ABDM_ENV, {
        gatewayBaseUrl: env.ABDM_GATEWAY_BASE_URL,
        abhaBaseUrl: env.ABDM_ABHA_BASE_URL,
        gatewayCertsUrl: env.ABDM_GATEWAY_CERTS_URL
    });
    const app = createRelayApp({
        env: config,
        session: new GatewaySession(config, adapters.credentials!),
        devices: adapters.devices!,
        facilities: adapters.facilities!,
        mailbox: adapters.mailbox!,
        doorbell: adapters.doorbell!,
        pairing: adapters.pairing,
        verifyGatewayJwt: createGatewayJwtVerifier({
            certsUrl: config.gatewayCertsUrl,
            issuer: env.ABDM_GATEWAY_ISSUER || undefined
        })
    });
    return { app, missing };
}

/**
 * Where to listen. Lambda Web Functions pass host:port in
 * AWS_LAMBDA_HTTP_ENDPOINT and only forward requests there; locally the
 * relay falls back to PORT or 127.0.0.1:8080.
 */
export function listenAddress(env: NodeJS.ProcessEnv): { hostname: string; port: number } {
    const endpoint = String(env.AWS_LAMBDA_HTTP_ENDPOINT || '').replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '');
    const match = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(endpoint);
    if (match) return { hostname: (match[1] as string).replace(/^\[|\]$/g, ''), port: Number(match[2]) };
    return { hostname: '127.0.0.1', port: Number(env.PORT) || 8080 };
}
