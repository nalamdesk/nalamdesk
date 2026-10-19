import * as crypto from 'node:crypto';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createRelayApp, type RelayDeps } from '../src/app.js';
import { ABDM_ENVIRONMENTS } from '../src/environments.js';
import { createGatewayJwtVerifier } from '../src/gatewayJwt.js';
import type { RelayLogEntry } from '../src/log.js';
import type { DeviceAuthResult, Facility, MailboxItem } from '../src/ports.js';

export const HIP_ID = 'IN2710000123';
export const CLINIC_ID = 'clinic-1';
export const PUSH_TOKEN = 'p'.repeat(40);

export function clinicKeys() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
    return {
        privateKey,
        publicRaw: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64')
    };
}

export async function gatewaySigner() {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(publicKey)), kid: 'gw-1', alg: 'RS256' };
    const keys = createLocalJWKSet({ keys: [jwk] });
    const sign = (claims: Record<string, unknown> = {}, expiresIn: string | number = '5m') =>
        new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'gw-1' }).setIssuedAt().setExpirationTime(expiresIn).sign(privateKey);
    return { keys, sign };
}

export interface Harness {
    app: ReturnType<typeof createRelayApp>;
    upstreamCalls: { url: string; init: RequestInit }[];
    mailbox: MailboxItem[];
    rings: string[];
    logs: RelayLogEntry[];
    clinic: ReturnType<typeof clinicKeys>;
    sign: Awaited<ReturnType<typeof gatewaySigner>>['sign'];
    setAuth(result: DeviceAuthResult): void;
    setUpstream(respond: (url: string, init: RequestInit) => Response | Promise<Response>): void;
    setFacility(facility: Facility | null): void;
    failMailbox(): void;
    failDoorbell(): void;
    tokens: { issued: number; invalidated: number };
}

export async function harness(overrides: Partial<RelayDeps> = {}): Promise<Harness> {
    const clinic = clinicKeys();
    const { keys, sign } = await gatewaySigner();
    let auth: DeviceAuthResult = { ok: true, deviceId: 'dev-1', clinicId: CLINIC_ID, hipId: HIP_ID };
    let respond: (url: string, init: RequestInit) => Response | Promise<Response> =
        () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    let facility: Facility | null = { clinicId: CLINIC_ID, hipId: HIP_ID, sealingPublicKey: clinic.publicRaw, linkedToBridge: true };
    let mailboxFails = false;
    let doorbellFails = false;
    const upstreamCalls: Harness['upstreamCalls'] = [];
    const mailbox: MailboxItem[] = [];
    const rings: string[] = [];
    const logs: RelayLogEntry[] = [];
    const tokens = { issued: 0, invalidated: 0 };

    const app = createRelayApp({
        env: ABDM_ENVIRONMENTS.sandbox,
        session: {
            token: async () => `vendor-token-${++tokens.issued}`,
            invalidate: () => { tokens.invalidated++; }
        },
        devices: { authenticate: async () => auth },
        facilities: {
            byHipId: async (hipId) => (facility && facility.hipId === hipId ? facility : null),
            byDataPushToken: async (token) => (token === PUSH_TOKEN ? facility : null)
        },
        mailbox: {
            put: async (item) => {
                if (mailboxFails) throw new Error('down');
                mailbox.push(item);
                return `item-${mailbox.length}`;
            }
        },
        doorbell: {
            ring: async (clinicId) => {
                if (doorbellFails) throw new Error('iot down');
                rings.push(clinicId);
            }
        },
        verifyGatewayJwt: createGatewayJwtVerifier({ certsUrl: 'https://example.invalid/certs', keys }),
        logger: (entry) => logs.push(entry),
        fetchFn: async (url, init) => {
            upstreamCalls.push({ url: String(url), init: init ?? {} });
            return respond(String(url), init ?? {});
        },
        ...overrides
    });

    return {
        app, upstreamCalls, mailbox, rings, logs, clinic, sign, tokens,
        setAuth: (result) => { auth = result; },
        setUpstream: (fn) => { respond = fn; },
        setFacility: (value) => { facility = value; },
        failMailbox: () => { mailboxFails = true; },
        failDoorbell: () => { doorbellFails = true; }
    };
}
