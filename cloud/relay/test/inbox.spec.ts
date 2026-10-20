import { execFileSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import {
    AttachPolicyCommand, AttachThingPrincipalCommand, CreateCertificateFromCsrCommand, CreateThingCommand, DeleteThingCommand,
    DetachThingPrincipalCommand, ListThingPrincipalsCommand, UpdateCertificateCommand, UpdateThingCommand
} from '@aws-sdk/client-iot';
import { createDeviceAuthenticator, ed25519PublicKeyRaw, newMailboxItemId, signRequest } from '@nalamdesk/cloud-shared';
import { describe, expect, it, vi } from 'vitest';
import { CertificateError, IotDeviceCertificates } from '../src/iotCertificates.js';
import type { InboxItem } from '../src/ports.js';
import { CLINIC_ID, harness, HIP_ID } from './helpers.js';

const CSR = '-----BEGIN CERTIFICATE REQUEST-----\nMIIBAA==\n-----END CERTIFICATE REQUEST-----\n';

async function signedInbox() {
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    const now = Date.UTC(2026, 9, 19, 6, 0);
    const devices = createDeviceAuthenticator({
        audience: 'relay',
        devices: {
            get: async (id) => (id === 'dev_clinic1_main'
                ? { deviceId: id, clinicId: CLINIC_ID, hipId: HIP_ID, status: 'active', signingPublicKey: ed25519PublicKeyRaw(privateKey) }
                : null)
        },
        nonces: { claim: async () => true },
        nowMs: () => now
    });
    const stored: InboxItem[] = [{ id: newMailboxItemId(now), type: 'booking-request', createdAt: now, sealed: 'abc' }];
    const inbox = {
        list: vi.fn(async () => ({ items: stored, more: false })),
        ack: vi.fn(async () => undefined),
        purge: vi.fn(async () => 0)
    };
    const certificates = { issue: vi.fn(async () => ({ certificatePem: 'PEM' })), revoke: vi.fn(async () => undefined) };
    const h = await harness({
        devices, nowMs: () => now,
        inbox: {
            inbox, certificates, doorbell: { endpoint: 'x-ats.iot.ap-south-1.amazonaws.com', topicPrefix: 'nalamdesk/sandbox/clinic' }
        }
    });
    const call = (method: 'GET' | 'POST', path: string, body?: unknown) => {
        const bytes = body === undefined ? undefined : new TextEncoder().encode(JSON.stringify(body));
        const headers = signRequest({ privateKey, deviceId: 'dev_clinic1_main', audience: 'relay', method, path, body: bytes, nowMs: now });
        return h.app.request(path, { method, headers: { 'content-type': 'application/json', ...headers }, body: bytes ? Buffer.from(bytes) : undefined });
    };
    return { h, call, inbox, certificates, stored };
}

describe('the desktop\'s mailbox endpoints', () => {
    it('lists the authenticated clinic\'s mail and acknowledges it', async () => {
        const { call, inbox, stored } = await signedInbox();
        const listed = await call('GET', '/inbox');
        expect(listed.status).toBe(200);
        expect(await listed.json()).toEqual({ items: stored, more: false });
        expect(inbox.list).toHaveBeenCalledWith(CLINIC_ID);

        expect((await call('POST', '/inbox/ack', { ids: [stored[0]!.id] })).status).toBe(204);
        expect(inbox.ack).toHaveBeenCalledWith(CLINIC_ID, [stored[0]!.id]);
    });

    it('refuses unsigned calls and malformed acknowledgements', async () => {
        const { h, call, inbox } = await signedInbox();
        expect((await h.app.request('/inbox')).status).toBe(401);
        expect((await call('POST', '/inbox/ack', { ids: ['../other'] })).status).toBe(400);
        expect((await call('POST', '/inbox/ack', { ids: [] })).status).toBe(400);
        expect(inbox.ack).not.toHaveBeenCalled();
    });

    it('answers 503 when the mailbox is down, so the desktop retries', async () => {
        const { call, inbox } = await signedInbox();
        inbox.list.mockRejectedValueOnce(new Error('down'));
        expect((await call('GET', '/inbox')).status).toBe(503);
    });

    it('issues a doorbell certificate for the device and names its own clinic topic', async () => {
        const { call, certificates } = await signedInbox();
        const response = await call('POST', '/device/iot-certificate', { csr: CSR });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            certificatePem: 'PEM', endpoint: 'x-ats.iot.ap-south-1.amazonaws.com', clientId: 'dev_clinic1_main',
            topic: `nalamdesk/sandbox/clinic/${CLINIC_ID}/mail`
        });
        expect(certificates.issue).toHaveBeenCalledWith({ deviceId: 'dev_clinic1_main', clinicId: CLINIC_ID }, CSR);
        expect((await call('POST', '/device/iot-certificate', { csr: 'not a csr' })).status).toBe(400);
    });

    it('answers 401 when the device was revoked while its certificate was issued', async () => {
        const { call, certificates } = await signedInbox();
        certificates.issue.mockRejectedValueOnce(new CertificateError('device_revoked', 'revoked'));
        const response = await call('POST', '/device/iot-certificate', { csr: CSR });
        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ error: 'device_revoked' });
    });
});

describe('IotDeviceCertificates', () => {
    const p256 = () => {
        // A self-signed P-256 certificate stands in for what IoT Core returns.
        return execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', '/dev/null', '-subj', '/CN=t', '-days', '1'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    };

    /** The device row, as DynamoCertificateLedger keeps it: a status and a set of certificate ARNs. */
    function ledger(arns: string[] = []) {
        const row = { status: 'active' as 'active' | 'revoked', arns: new Set(arns) };
        return {
            row,
            record: async (_: string, arn: string) => {
                if (row.status !== 'active') return null;
                const before = [...row.arns];
                row.arns.add(arn);
                return before;
            },
            recorded: async () => [...row.arns],
            forget: async (_: string, gone: string[]) => { for (const arn of gone) row.arns.delete(arn); }
        };
    }

    function client(principals: string[], pem: string, during: (command: any) => Promise<void> | void = () => undefined) {
        const sent: any[] = [];
        return {
            sent,
            send: async (command: any) => {
                sent.push(command);
                await during(command);
                if (command instanceof CreateCertificateFromCsrCommand) {
                    return { certificateArn: 'arn:aws:iot:ap-south-1:1:cert/new', certificateId: 'new', certificatePem: pem };
                }
                if (command instanceof CreateThingCommand) throw Object.assign(new Error('exists'), { name: 'ResourceAlreadyExistsException' });
                if (command instanceof ListThingPrincipalsCommand) return { principals };
                return {};
            }
        };
    }

    it('creates the thing with its clinic, attaches the policy and retires the previous certificate', async () => {
        const iot = client(['arn:aws:iot:ap-south-1:1:cert/new', 'arn:aws:iot:ap-south-1:1:cert/old'], p256());
        const issued = await new IotDeviceCertificates('policy', ledger(), { client: iot as never }).issue({ deviceId: 'dev_1', clinicId: 'cln_1' }, CSR);
        expect(issued.certificatePem).toContain('BEGIN CERTIFICATE');
        const update = iot.sent.find((c) => c instanceof UpdateThingCommand) as UpdateThingCommand;
        expect(update.input.attributePayload?.attributes).toEqual({ clinicId: 'cln_1' });
        expect(iot.sent.find((c) => c instanceof AttachPolicyCommand)?.input).toEqual({ policyName: 'policy', target: 'arn:aws:iot:ap-south-1:1:cert/new' });
        expect(iot.sent.find((c) => c instanceof AttachThingPrincipalCommand)?.input.thingName).toBe('dev_1');
        const revoked = iot.sent.filter((c) => c instanceof UpdateCertificateCommand).map((c) => c.input);
        expect(revoked).toEqual([{ certificateId: 'old', newStatus: 'REVOKED' }]);
    });

    it('refuses a certificate for anything but a P-256 key', async () => {
        const rsa = execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', '/dev/null', '-subj', '/CN=t', '-days', '1'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        const iot = client([], rsa);
        await expect(new IotDeviceCertificates('policy', ledger(), { client: iot as never }).issue({ deviceId: 'dev_1', clinicId: 'cln_1' }, CSR))
            .rejects.toMatchObject({ code: 'bad_csr' });
        expect(iot.sent.filter((c) => c instanceof UpdateCertificateCommand).map((c) => c.input)).toEqual([{ certificateId: 'new', newStatus: 'REVOKED' }]);
        expect(iot.sent.some((c) => c instanceof AttachThingPrincipalCommand)).toBe(false);
    });

    it('records the certificate on the device row before attaching it, and forgets the one it retires', async () => {
        const iot = client(['arn:aws:iot:ap-south-1:1:cert/new'], p256());
        const row = ledger(['arn:aws:iot:ap-south-1:1:cert/old']);
        const record = vi.fn(row.record);
        let sentBeforeRecord: any[] = [];
        row.record = (id, arn) => (sentBeforeRecord = [...iot.sent], record(id, arn));
        await new IotDeviceCertificates('policy', row, { client: iot as never }).issue({ deviceId: 'dev_1', clinicId: 'cln_1' }, CSR);
        expect(record).toHaveBeenCalledWith('dev_1', 'arn:aws:iot:ap-south-1:1:cert/new');
        expect(sentBeforeRecord.some((c) => c instanceof AttachPolicyCommand || c instanceof AttachThingPrincipalCommand)).toBe(false);
        expect(iot.sent.filter((c) => c instanceof UpdateCertificateCommand).map((c) => c.input)).toEqual([{ certificateId: 'old', newStatus: 'REVOKED' }]);
        expect([...row.row.arns]).toEqual(['arn:aws:iot:ap-south-1:1:cert/new']);
    });

    it('leaves a certificate recorded by a newer, overlapping issue alone', async () => {
        const newer = 'arn:aws:iot:ap-south-1:1:cert/newer';
        const row = ledger(['arn:aws:iot:ap-south-1:1:cert/old']);
        // The newer issue records and attaches its certificate while this one attaches.
        const iot = client(['arn:aws:iot:ap-south-1:1:cert/new', newer, 'arn:aws:iot:ap-south-1:1:cert/old', 'arn:aws:iot:ap-south-1:1:cert/stray'], p256(), (command) => {
            if (command instanceof AttachThingPrincipalCommand) row.row.arns.add(newer);
        });
        await new IotDeviceCertificates('policy', row, { client: iot as never }).issue({ deviceId: 'dev_1', clinicId: 'cln_1' }, CSR);
        expect(iot.sent.filter((c) => c instanceof UpdateCertificateCommand).map((c) => c.input.certificateId).sort()).toEqual(['old', 'stray']);
        expect(row.row.arns.has(newer)).toBe(true);
    });

    it('refuses and retires the certificate when the revocation was written first', async () => {
        const iot = client([], p256());
        const row = ledger();
        row.row.status = 'revoked';
        await expect(new IotDeviceCertificates('policy', row, { client: iot as never }).issue({ deviceId: 'dev_1', clinicId: 'cln_1' }, CSR))
            .rejects.toMatchObject({ code: 'device_revoked' });
        expect(iot.sent.filter((c) => c instanceof UpdateCertificateCommand).map((c) => c.input)).toEqual([{ certificateId: 'new', newStatus: 'REVOKED' }]);
        expect(iot.sent.some((c) => c instanceof AttachPolicyCommand || c instanceof AttachThingPrincipalCommand || c instanceof CreateThingCommand)).toBe(false);
        expect(row.row.arns.size).toBe(0);
    });

    it('lets a revocation written after the record retire the certificate, even before it is attached', async () => {
        const row = ledger();
        let certificates: IotDeviceCertificates;
        let revocation: Promise<void> | undefined;
        // The revocation lands while the issue is creating the thing: the
        // certificate is recorded but not attached, so IoT lists no principal.
        const iot = client([], p256(), (command) => {
            if (command instanceof CreateThingCommand && !revocation) {
                row.row.status = 'revoked';
                revocation = certificates.revoke('dev_1');
                return revocation;
            }
        });
        certificates = new IotDeviceCertificates('policy', row, { client: iot as never });
        await certificates.issue({ deviceId: 'dev_1', clinicId: 'cln_1' }, CSR).catch(() => undefined);
        await revocation;
        const revoked = iot.sent.filter((c) => c instanceof UpdateCertificateCommand).map((c) => c.input);
        expect(revoked).toContainEqual({ certificateId: 'new', newStatus: 'REVOKED' });
    });

    it('fails the revocation, keeping its cleanup pending, while a recorded certificate cannot be revoked', async () => {
        const row = ledger(['arn:aws:iot:ap-south-1:1:cert/a']);
        const iot = client([], '', (command) => {
            if (command instanceof UpdateCertificateCommand) throw Object.assign(new Error('throttled'), { name: 'ThrottlingException' });
        });
        await expect(new IotDeviceCertificates('policy', row, { client: iot as never }).revoke('dev_1')).rejects.toThrow('throttled');
        expect([...row.row.arns]).toEqual(['arn:aws:iot:ap-south-1:1:cert/a']);
    });

    it('treats a recorded certificate that is already gone as retired', async () => {
        const row = ledger(['arn:aws:iot:ap-south-1:1:cert/a']);
        const iot = client([], '', (command) => {
            if (command instanceof DetachThingPrincipalCommand || command instanceof UpdateCertificateCommand) {
                throw Object.assign(new Error('gone'), { name: 'ResourceNotFoundException' });
            }
        });
        await new IotDeviceCertificates('policy', row, { client: iot as never }).revoke('dev_1');
        expect(row.row.arns.size).toBe(0);
    });

    it('revokes every certificate and deletes the thing', async () => {
        const iot = client(['arn:aws:iot:ap-south-1:1:cert/a'], '');
        await new IotDeviceCertificates('policy', ledger(), { client: iot as never }).revoke('dev_1');
        expect(iot.sent.some((c) => c instanceof DetachThingPrincipalCommand)).toBe(true);
        expect(iot.sent.find((c) => c instanceof UpdateCertificateCommand)?.input).toEqual({ certificateId: 'a', newStatus: 'REVOKED' });
        expect(iot.sent.at(-1)).toBeInstanceOf(DeleteThingCommand);
    });
});
