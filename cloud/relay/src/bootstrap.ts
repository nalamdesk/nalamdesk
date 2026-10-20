import { createDeviceAuthenticator, DynamoDeviceRegistry, DynamoNonceStore, IotDoorbell } from '@nalamdesk/cloud-shared';
import { Hono } from 'hono';
import { createRelayApp } from './app.js';
import { DynamoCertificateLedger } from './certificateLedger.js';
import { DynamoFacilityDirectory } from './dynamoFacilities.js';
import { resolveEnvironment } from './environments.js';
import { createGatewayJwtVerifier } from './gatewayJwt.js';
import { GatewaySession } from './gatewaySession.js';
import { DynamoPairingRateLimiter, DynamoPairingStore } from './dynamoPairing.js';
import type { InboxRouteDeps } from './inboxRoutes.js';
import { IotDeviceCertificates } from './iotCertificates.js';
import { RelayMailbox } from './mailboxAdapters.js';
import { createOpsTokenVerifier } from './opsAuth.js';
import { PairingService, type DeviceLifecycle } from './pairing.js';
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
    inbox?: InboxRouteDeps;
}

// Which issue supplies each adapter that is not wired from the environment yet.
const OWNERS: Record<keyof Adapters, string> = {
    devices: 'device authenticator (DEVICES_TABLE, NONCES_TABLE)',
    facilities: 'facility directory (DEVICES_TABLE)',
    mailbox: 'mailbox (MAILBOX_TABLE, MAILBOX_BUCKET)',
    doorbell: 'doorbell (IOT_DATA_ENDPOINT, DOORBELL_TOPIC_PREFIX)',
    inbox: 'inbox and IoT certificates (MAILBOX_TABLE, MAILBOX_BUCKET, IOT_DATA_ENDPOINT, DOORBELL_TOPIC_PREFIX, IOT_POLICY_NAME, DEVICES_TABLE)',
    credentials: 'vendor credentials (ABDM_CLIENT_ID_PARAM, ABDM_CLIENT_SECRET_PARAM)',
    pairing: 'pairing (PAIRING_TABLE, CLINIC_IDS_TABLE, PAIRING_PEPPER_PARAM, BRIDGE_URL, OPS_USER_POOL_ID, OPS_CLIENT_ID, OPS_AUTH_DOMAIN)'
};

/** Pairing and the ops console, when every name they need is set. */
export function pairingFromEnv(env: NodeJS.ProcessEnv, lifecycle?: DeviceLifecycle): PairingRouteDeps | undefined {
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
            bridgeUrl: BRIDGE_URL.replace(/\/+$/, ''),
            lifecycle
        }),
        verifyOps: createOpsTokenVerifier({ region, userPoolId: OPS_USER_POOL_ID, clientId: OPS_CLIENT_ID }),
        console: { authDomain: OPS_AUTH_DOMAIN, clientId: OPS_CLIENT_ID }
    };
}

/**
 * When a device is replaced or revoked: its IoT certificate stops working and
 * mail stored before then, sealed to a key no paired device holds any more,
 * is dropped.
 */
export function revocationLifecycle(inbox: InboxRouteDeps, nowMs: () => number = Date.now): DeviceLifecycle {
    return {
        // Independent steps: a failed certificate revoke must not leave the mail.
        revoked: async (device) => {
            const results = await Promise.allSettled([
                inbox.certificates.revoke(device.deviceId),
                inbox.inbox.purge(device.clinicId, device.revokedAt ?? nowMs())
            ]);
            const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
            if (failed) throw failed.reason;
        }
    };
}

/** Adapters that can be built from environment variables alone. */
export function adaptersFromEnv(env: NodeJS.ProcessEnv): Adapters {
    const { MAILBOX_TABLE, MAILBOX_BUCKET, IOT_DATA_ENDPOINT, DOORBELL_TOPIC_PREFIX, IOT_POLICY_NAME } = env;
    const mailbox = MAILBOX_TABLE && MAILBOX_BUCKET ? new RelayMailbox({ table: MAILBOX_TABLE, bucket: MAILBOX_BUCKET }) : undefined;
    const doorbellReady = !!(IOT_DATA_ENDPOINT && DOORBELL_TOPIC_PREFIX);
    const inbox: InboxRouteDeps | undefined = mailbox && doorbellReady && IOT_POLICY_NAME && env.DEVICES_TABLE
        ? {
            inbox: mailbox,
            // Certificates are recorded on the device rows, so a revocation finds them all.
            certificates: new IotDeviceCertificates(IOT_POLICY_NAME, new DynamoCertificateLedger(env.DEVICES_TABLE)),
            doorbell: { endpoint: IOT_DATA_ENDPOINT as string, topicPrefix: DOORBELL_TOPIC_PREFIX as string }
        }
        : undefined;
    return {
        pairing: pairingFromEnv(env, inbox ? revocationLifecycle(inbox) : undefined),
        devices: env.DEVICES_TABLE && env.NONCES_TABLE
            ? createDeviceAuthenticator({
                audience: 'relay',
                devices: new DynamoDeviceRegistry(env.DEVICES_TABLE),
                nonces: new DynamoNonceStore(env.NONCES_TABLE)
            })
            : undefined,
        facilities: env.DEVICES_TABLE ? new DynamoFacilityDirectory(env.DEVICES_TABLE) : undefined,
        mailbox,
        doorbell: doorbellReady ? new IotDoorbell(IOT_DATA_ENDPOINT as string, DOORBELL_TOPIC_PREFIX as string) : undefined,
        inbox,
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
        inbox: adapters.inbox,
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
