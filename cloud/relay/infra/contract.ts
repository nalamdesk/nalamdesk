// Copy of the names cloud/core publishes in Parameter Store
// (cloud/core/lib/contract.ts). Keep the two in step.
export type Stage = 'sandbox' | 'production';

export type CoreParamName =
    | 'devices-table-name'
    | 'nonces-table-name'
    | 'pairing-table-name'
    | 'clinic-ids-table-name'
    | 'ops-user-pool-id'
    | 'ops-client-id'
    | 'ops-auth-domain'
    | 'code-bucket-name'
    | 'hosted-zone-id'
    | 'bridge-certificate-arn'
    | 'mailbox-table-name'
    | 'mailbox-bucket-name'
    | 'iot-data-endpoint'
    | 'iot-policy-name'
    | 'doorbell-topic-prefix';

export const coreParam = (stage: Stage, name: CoreParamName) => `/nalamdesk/${stage}/core/${name}`;

/**
 * Vendor credentials and the pairing-code pepper, created out of band
 * (CloudFormation cannot create a SecureString).
 */
export const relayParam = (stage: Stage, name: 'abdm-client-id' | 'abdm-client-secret' | 'pairing-pepper') => `/nalamdesk/${stage}/relay/${name}`;

export function parseStage(value: unknown): Stage {
    if (value === undefined || value === 'sandbox') return 'sandbox';
    if (value === 'production') return 'production';
    throw new Error(`Unknown stage "${String(value)}"; use sandbox or production.`);
}

export function stageDomain(stage: Stage, label: string, zoneName: string): string {
    return stage === 'production' ? `${label}.${zoneName}` : `${label}-${stage}.${zoneName}`;
}
