import { IoTDataPlaneClient, PublishCommand } from '@aws-sdk/client-iot-data-plane';

// The doorbell (#155): an empty MQTT message on the clinic's IoT Core topic
// that tells its paired desktop to fetch the mailbox. It carries nothing,
// so a lost or spoofed ring costs one fetch at most; the desktop also
// fetches on connect and every 30 minutes.

/** `nalamdesk/<stage>/clinic/<clinicId>/mail`; the device policy allows only its own clinic's topic. */
export const doorbellTopic = (prefix: string, clinicId: string) => `${prefix}/${clinicId}/mail`;

export class IotDoorbell {
    private readonly client: Pick<IoTDataPlaneClient, 'send'>;

    /**
     * @param endpoint IoT data endpoint host (`xxxx-ats.iot.<region>.amazonaws.com`).
     * @param topicPrefix `nalamdesk/<stage>/clinic`.
     */
    constructor(endpoint: string, private readonly topicPrefix: string, options: { client?: Pick<IoTDataPlaneClient, 'send'> } = {}) {
        this.client = options.client ?? new IoTDataPlaneClient({ endpoint: `https://${endpoint}` });
    }

    async ring(clinicId: string): Promise<void> {
        await this.client.send(new PublishCommand({ topic: doorbellTopic(this.topicPrefix, clinicId), qos: 0, payload: new Uint8Array() }));
    }
}
