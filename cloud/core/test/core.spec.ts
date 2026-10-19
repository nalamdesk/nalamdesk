import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { CoreEdgeStack } from '../lib/edge-stack.js';
import { CoreStack } from '../lib/core-stack.js';

function synth() {
    const app = new App();
    const env = { account: '123456789012' };
    const edge = new CoreEdgeStack(app, 'Edge', {
        env: { ...env, region: 'us-east-1' }, crossRegionReferences: true,
        zoneName: 'example.in', bridgeDomain: 'abdm-sandbox.example.in', bookingDomain: 'book-sandbox.example.in'
    });
    const core = new CoreStack(app, 'Core', {
        env: { ...env, region: 'ap-south-1' }, crossRegionReferences: true,
        stage: 'sandbox', zone: edge.zone,
        bridgeDomain: 'abdm-sandbox.example.in', bridgeCertificate: edge.bridgeCertificate,
        bookingDomain: 'book-sandbox.example.in', bookingCertificate: edge.bookingCertificate,
        budgetEmail: 'ops@example.in'
    });
    return { edge: Template.fromStack(edge), core: Template.fromStack(core) };
}

describe('Core stacks', () => {
    const { edge, core } = synth();

    it('creates the zone and DNS-validated certificates in us-east-1', () => {
        edge.resourceCountIs('AWS::Route53::HostedZone', 1);
        edge.hasResourceProperties('AWS::CertificateManager::Certificate', { DomainName: 'abdm-sandbox.example.in', ValidationMethod: 'DNS' });
        edge.hasResourceProperties('AWS::CertificateManager::Certificate', { DomainName: 'book-sandbox.example.in', ValidationMethod: 'DNS' });
    });

    it('keeps the device registry with lookups by HIP ID and data push token', () => {
        core.hasResource('AWS::DynamoDB::GlobalTable', {
            DeletionPolicy: 'Retain',
            Properties: Match.objectLike({
                KeySchema: [{ AttributeName: 'deviceId', KeyType: 'HASH' }],
                GlobalSecondaryIndexes: Match.arrayWith([
                    Match.objectLike({ IndexName: 'byHipId' }),
                    Match.objectLike({ IndexName: 'byDataPushToken' })
                ])
            })
        });
    });

    it('expires pairing requests and nonces by TTL', () => {
        for (const key of ['hfrId', 'nonceKey']) {
            core.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
                KeySchema: [{ AttributeName: key, KeyType: 'HASH' }],
                TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true }
            });
        }
    });

    it('requires TOTP MFA on the ops pool and has no self sign-up', () => {
        core.hasResourceProperties('AWS::Cognito::UserPool', {
            MfaConfiguration: 'ON',
            EnabledMfas: ['SOFTWARE_TOKEN_MFA'],
            AdminCreateUserConfig: { AllowAdminCreateUserOnly: true }
        });
        core.hasResourceProperties('AWS::Cognito::UserPoolGroup', { GroupName: 'ops' });
    });

    it('keeps one clinic ID per HFR ID, retained', () => {
        core.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
            KeySchema: [{ AttributeName: 'hipId', KeyType: 'HASH' }],
            Replicas: [Match.objectLike({ DeletionProtectionEnabled: true })]
        });
    });

    it('gives the ops console a public PKCE client and a managed login domain', () => {
        core.hasResourceProperties('AWS::Cognito::UserPoolClient', {
            GenerateSecret: false,
            AllowedOAuthFlows: ['code'],
            AllowedOAuthScopes: ['openid'],
            CallbackURLs: ['https://abdm-sandbox.example.in/ops/'],
            SupportedIdentityProviders: ['COGNITO'],
            PreventUserExistenceErrors: 'ENABLED'
        });
        core.hasResourceProperties('AWS::Cognito::UserPoolDomain', { Domain: 'nalamdesk-ops-sandbox' });
    });

    it('makes a versioned, SSE-S3, private code bucket that Lambda can read', () => {
        core.hasResourceProperties('AWS::S3::Bucket', {
            VersioningConfiguration: { Status: 'Enabled' },
            BucketEncryption: { ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }] },
            PublicAccessBlockConfiguration: Match.objectLike({ BlockPublicPolicy: true, RestrictPublicBuckets: true })
        });
        const policy = JSON.stringify(core.findResources('AWS::S3::BucketPolicy'));
        expect(policy).toContain('lambda.amazonaws.com');
        expect(policy).toContain('s3:GetObjectVersion');
    });

    it('alerts on a $10 monthly budget', () => {
        core.hasResourceProperties('AWS::Budgets::Budget', {
            Budget: Match.objectLike({ BudgetLimit: { Amount: 10, Unit: 'USD' }, TimeUnit: 'MONTHLY' })
        });
    });

    it('publishes the shared names in Parameter Store', () => {
        for (const name of ['devices-table-name', 'code-bucket-name', 'hosted-zone-id', 'bridge-certificate-arn', 'bridge-domain', 'clinic-ids-table-name', 'ops-client-id', 'ops-auth-domain']) {
            core.hasResourceProperties('AWS::SSM::Parameter', { Name: `/nalamdesk/sandbox/core/${name}` });
        }
    });
});
