import { serve } from '@hono/node-server';
import { createRelayApp } from './app.js';
import { resolveEnvironment } from './environments.js';
import { createGatewayJwtVerifier } from './gatewayJwt.js';
import { GatewaySession } from './gatewaySession.js';
import { ParameterStoreCredentials } from './parameterStore.js';
import type { DeviceAuthenticator, Doorbell, FacilityDirectory, Mailbox, VendorCredentials } from './ports.js';

// Entry point for the Web Function (a plain Node HTTP server on $PORT).
// The device registry, mailbox and doorbell adapters arrive with #153, #154
// and #155; until they are wired in, the relay refuses to start rather than
// run with an open door. Vendor credentials come from Parameter Store.
function notWired(name: string, issue: string): never {
    throw new Error(`ABDM relay: ${name} adapter is not wired yet (${issue}).`);
}

const adapters: {
    devices?: DeviceAuthenticator;
    facilities?: FacilityDirectory;
    mailbox?: Mailbox;
    doorbell?: Doorbell;
    credentials?: VendorCredentials;
} = {
    credentials: process.env.ABDM_CLIENT_ID_PARAM && process.env.ABDM_CLIENT_SECRET_PARAM
        ? new ParameterStoreCredentials({
            clientIdName: process.env.ABDM_CLIENT_ID_PARAM,
            clientSecretName: process.env.ABDM_CLIENT_SECRET_PARAM
        })
        : undefined
};

const { config } = resolveEnvironment(process.env.ABDM_ENV, {
    gatewayBaseUrl: process.env.ABDM_GATEWAY_BASE_URL,
    abhaBaseUrl: process.env.ABDM_ABHA_BASE_URL,
    gatewayCertsUrl: process.env.ABDM_GATEWAY_CERTS_URL
});

const app = createRelayApp({
    env: config,
    session: new GatewaySession(config, adapters.credentials ?? notWired('vendor credentials', 'set ABDM_CLIENT_ID_PARAM and ABDM_CLIENT_SECRET_PARAM')),
    devices: adapters.devices ?? notWired('device authenticator', '#154'),
    facilities: adapters.facilities ?? notWired('facility directory', '#153'),
    mailbox: adapters.mailbox ?? notWired('mailbox', '#155'),
    doorbell: adapters.doorbell ?? notWired('doorbell', '#155'),
    verifyGatewayJwt: createGatewayJwtVerifier({
        certsUrl: config.gatewayCertsUrl,
        issuer: process.env.ABDM_GATEWAY_ISSUER || undefined
    })
});

serve({ fetch: app.fetch, port: Number(process.env.PORT) || 8080 });
