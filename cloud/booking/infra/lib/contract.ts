// Copy of the names cloud/core publishes in Parameter Store
// (cloud/core/lib/contract.ts). Keep the two in step.
export type Stage = 'sandbox' | 'production';

export type CoreParamName =
    | 'devices-table-name'
    | 'nonces-table-name'
    | 'code-bucket-name'
    | 'hosted-zone-id'
    | 'booking-certificate-arn'
    | 'mailbox-table-name'
    | 'mailbox-bucket-name'
    | 'iot-data-endpoint'
    | 'doorbell-topic-prefix';

export const coreParam = (stage: Stage, name: CoreParamName) => `/nalamdesk/${stage}/core/${name}`;

/** Phone-limit HMAC key, a SecureString created by scripts/deploy.sh (CloudFormation cannot create one). */
export const phonePepperParam = (stage: Stage) => `/nalamdesk/${stage}/booking/phone-pepper`;

export function parseStage(value: unknown): Stage {
    if (value === undefined || value === 'sandbox') return 'sandbox';
    if (value === 'production') return 'production';
    throw new Error(`Unknown stage "${String(value)}"; use sandbox or production.`);
}

/** book.<zone> in production, book-sandbox.<zone> otherwise. */
export function stageDomain(stage: Stage, label: string, zoneName: string): string {
    return stage === 'production' ? `${label}.${zoneName}` : `${label}-${stage}.${zoneName}`;
}
