import { ConditionalCheckFailedException, DynamoDBClient, GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import type { CertificateLedger } from './ports.js';

type Client = Pick<DynamoDBClient, 'send'>;

const conditionFailed = (error: unknown) =>
    error instanceof ConditionalCheckFailedException || (error as { name?: string })?.name === 'ConditionalCheckFailedException';

/**
 * The device row's `iotCertArns` string set: every IoT certificate issued to
 * the device and not yet retired. A certificate is recorded, conditional on
 * the device still being active, before it is attached to anything, and
 * revocation reads the set consistently after marking the device revoked.
 * DynamoDB orders the two writes, so either the record fails or revocation
 * sees the certificate.
 */
export class DynamoCertificateLedger implements CertificateLedger {
    private readonly client: Client;

    constructor(private readonly devicesTable: string, options: { client?: Client } = {}) {
        this.client = options.client ?? new DynamoDBClient({});
    }

    async record(deviceId: string, certificateArn: string): Promise<string[] | null> {
        try {
            const result = await this.client.send(new UpdateItemCommand({
                TableName: this.devicesTable,
                Key: { deviceId: { S: deviceId } },
                UpdateExpression: 'ADD iotCertArns :arn',
                ConditionExpression: '#status = :active',
                ExpressionAttributeNames: { '#status': 'status' },
                ExpressionAttributeValues: { ':arn': { SS: [certificateArn] }, ':active': { S: 'active' } },
                ReturnValues: 'ALL_OLD'
            }));
            return result.Attributes?.iotCertArns?.SS ?? [];
        } catch (error) {
            if (conditionFailed(error)) return null;
            throw error;
        }
    }

    async recorded(deviceId: string): Promise<string[]> {
        const result = await this.client.send(new GetItemCommand({
            TableName: this.devicesTable,
            Key: { deviceId: { S: deviceId } },
            ProjectionExpression: 'iotCertArns',
            ConsistentRead: true
        }));
        return result.Item?.iotCertArns?.SS ?? [];
    }

    async forget(deviceId: string, certificateArns: string[]): Promise<void> {
        if (!certificateArns.length) return;
        await this.client.send(new UpdateItemCommand({
            TableName: this.devicesTable,
            Key: { deviceId: { S: deviceId } },
            UpdateExpression: 'DELETE iotCertArns :arns',
            ConditionExpression: 'attribute_exists(deviceId)',
            ExpressionAttributeValues: { ':arns': { SS: certificateArns } }
        })).catch((error) => {
            if (!conditionFailed(error)) throw error;
        });
    }
}
