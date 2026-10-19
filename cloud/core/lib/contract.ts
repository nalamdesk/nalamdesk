// Names the Core stack publishes in Parameter Store (ap-south-1) so the
// Relay and Booking CDK apps can find shared resources without
// CloudFormation exports tying their lifecycles together. The Relay app
// keeps a copy of this list in cloud/relay/infra/contract.ts and the
// Booking app in cloud/booking/infra/lib/contract.ts; keep them
// in step.
export type Stage = 'sandbox' | 'production';

export const coreParam = (stage: Stage, name: CoreParamName) => `/nalamdesk/${stage}/core/${name}`;

export type CoreParamName =
    | 'devices-table-name'
    | 'pairing-table-name'
    | 'nonces-table-name'
    | 'clinic-ids-table-name'
    | 'code-bucket-name'
    | 'hosted-zone-id'
    | 'bridge-domain'
    | 'bridge-certificate-arn'
    | 'booking-domain'
    | 'booking-certificate-arn'
    | 'ops-user-pool-id'
    | 'ops-client-id'
    | 'ops-auth-domain'
    | 'mailbox-table-name'
    | 'mailbox-bucket-name'
    | 'iot-data-endpoint'
    | 'iot-policy-name'
    | 'doorbell-topic-prefix'
    | 'device-presence-table-name';

export function parseStage(value: unknown): Stage {
    if (value === undefined || value === 'sandbox') return 'sandbox';
    if (value === 'production') return 'production';
    throw new Error(`Unknown stage "${String(value)}"; use sandbox or production.`);
}

/** abdm.<zone> in production, abdm-sandbox.<zone> otherwise. */
export function stageDomain(stage: Stage, label: string, zoneName: string): string {
    return stage === 'production' ? `${label}.${zoneName}` : `${label}-${stage}.${zoneName}`;
}
