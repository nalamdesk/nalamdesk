import { X509Certificate } from 'node:crypto';
import {
    AttachPolicyCommand, AttachThingPrincipalCommand, CreateCertificateFromCsrCommand, CreateThingCommand, DeleteCertificateCommand,
    DeleteThingCommand, DetachPolicyCommand, DetachThingPrincipalCommand, IoTClient, ListThingPrincipalsCommand, UpdateCertificateCommand,
    UpdateThingCommand
} from '@aws-sdk/client-iot';
import type { DeviceCertificates } from './ports.js';

// IoT Core identities for the doorbell (#155). Each paired device is a thing
// named by its device ID, carrying its clinic ID as an attribute, with one
// active certificate issued from a CSR the desktop makes (so the private key
// never leaves the computer). The static policy lets a connection use only
// its own thing name as client ID and subscribe only to its own clinic's
// topic, read from that attribute; nothing may publish.

type Client = Pick<IoTClient, 'send'>;

export class CertificateError extends Error {
    constructor(readonly code: 'bad_csr', message: string) {
        super(message);
    }
}

const named = (error: unknown, name: string) => (error as { name?: string })?.name === name;

export class IotDeviceCertificates implements DeviceCertificates {
    private readonly client: Client;

    constructor(private readonly policyName: string, options: { client?: Client } = {}) {
        this.client = options.client ?? new IoTClient({});
    }

    async issue(device: { deviceId: string; clinicId: string }, csrPem: string): Promise<{ certificatePem: string }> {
        let created;
        try {
            created = await this.client.send(new CreateCertificateFromCsrCommand({ certificateSigningRequest: csrPem, setAsActive: true }));
        } catch (error) {
            if (named(error, 'InvalidRequestException')) throw new CertificateError('bad_csr', 'The CSR was not accepted.');
            throw error;
        }
        const { certificateArn, certificateId, certificatePem } = created;
        if (!certificateArn || !certificateId || !certificatePem) throw new Error('IoT returned no certificate.');
        // Only P-256 keys: the desktop makes them, and nothing else should get a certificate.
        if (new X509Certificate(certificatePem).publicKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
            await this.retire(certificateArn, certificateId);
            throw new CertificateError('bad_csr', 'The CSR must be for a P-256 key.');
        }

        const attributePayload = { attributes: { clinicId: device.clinicId }, merge: false };
        try {
            await this.client.send(new CreateThingCommand({ thingName: device.deviceId, attributePayload }));
        } catch (error) {
            if (!named(error, 'ResourceAlreadyExistsException')) throw error;
            await this.client.send(new UpdateThingCommand({ thingName: device.deviceId, attributePayload }));
        }
        await this.client.send(new AttachPolicyCommand({ policyName: this.policyName, target: certificateArn }));
        await this.client.send(new AttachThingPrincipalCommand({ thingName: device.deviceId, principal: certificateArn }));

        // One certificate per device: retire any earlier one.
        for (const principal of await this.principals(device.deviceId)) {
            if (principal !== certificateArn) await this.detachAndRetire(device.deviceId, principal);
        }
        return { certificatePem };
    }

    async revoke(deviceId: string): Promise<void> {
        for (const principal of await this.principals(deviceId)) await this.detachAndRetire(deviceId, principal);
        // A thing left behind (detaching is eventually consistent) has no
        // certificate, so nothing can connect as it.
        await this.client.send(new DeleteThingCommand({ thingName: deviceId })).catch(() => undefined);
    }

    private async principals(thingName: string): Promise<string[]> {
        const out: string[] = [];
        let nextToken: string | undefined;
        try {
            do {
                const page = await this.client.send(new ListThingPrincipalsCommand({ thingName, nextToken }));
                out.push(...(page.principals ?? []));
                nextToken = page.nextToken;
            } while (nextToken);
        } catch (error) {
            if (named(error, 'ResourceNotFoundException')) return [];
            throw error;
        }
        return out;
    }

    private async detachAndRetire(thingName: string, certificateArn: string): Promise<void> {
        await this.client.send(new DetachThingPrincipalCommand({ thingName, principal: certificateArn }));
        const certificateId = certificateArn.split('/').pop() as string;
        await this.retire(certificateArn, certificateId);
    }

    /** Detaches the policy, revokes and deletes; a revoked certificate cannot connect even if the delete fails. */
    private async retire(certificateArn: string, certificateId: string): Promise<void> {
        await this.client.send(new DetachPolicyCommand({ policyName: this.policyName, target: certificateArn })).catch((error) => {
            if (!named(error, 'ResourceNotFoundException')) throw error;
        });
        await this.client.send(new UpdateCertificateCommand({ certificateId, newStatus: 'REVOKED' }));
        await this.client.send(new DeleteCertificateCommand({ certificateId })).catch(() => undefined);
    }
}
