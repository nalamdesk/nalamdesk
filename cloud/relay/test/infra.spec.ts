import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { bundleRelay } from '../infra/bundle.js';
import { RelayStack } from '../infra/relay-stack.js';

function synth() {
    const codeDir = mkdtempSync(join(tmpdir(), 'relay-code-'));
    writeFileSync(join(codeDir, 'index.js'), '// test bundle');
    const app = new App();
    const stack = new RelayStack(app, 'Relay', {
        env: { account: '123456789012', region: 'ap-south-1' },
        stage: 'sandbox',
        zoneName: 'example.in',
        codeDir
    });
    return Template.fromStack(stack);
}

describe('Relay stack', () => {
    const template = synth();
    const text = JSON.stringify(template.toJSON());

    it('runs the relay on a Web Function capped at 2 environments behind IAM auth', () => {
        template.hasResourceProperties('AWS::Lambda::WebFunction', { FunctionName: 'nalamdesk-abdm-relay-sandbox' });
        template.hasResourceProperties('AWS::Lambda::WebFunctionEndpoint', {
            EndpointType: 'HomeRegion',
            AuthType: 'IamAuth',
            ScalingConfig: { MaxEnvironments: 2 },
            RevisionWeights: [{ RevisionId: { 'Fn::GetAtt': ['Revision', 'RevisionId'] }, Weight: 100 }]
        });
    });

    it('builds the revision from the versioned code bucket on Node 24', () => {
        template.hasResourceProperties('AWS::Lambda::WebFunctionRevision', {
            BuildConfig: {
                RuntimeConfig: { Runtime: 'nodejs24.x' },
                CodeConfig: { S3Object: Match.objectLike({ VersionId: Match.anyValue() }) }
            },
            ServiceConfig: Match.objectLike({
                EnvironmentVariables: Match.objectLike({
                    ABDM_ENV: 'sandbox',
                    ABDM_CLIENT_ID_PARAM: '/nalamdesk/sandbox/relay/abdm-client-id',
                    ABDM_CLIENT_SECRET_PARAM: '/nalamdesk/sandbox/relay/abdm-client-secret'
                })
            })
        });
        template.hasResourceProperties('Custom::CDKBucketDeployment', { Extract: false });
    });

    it('keeps logs for 30 days', () => {
        template.hasResourceProperties('AWS::Logs::LogGroup', {
            LogGroupName: '/aws/lambda/web/nalamdesk-abdm-relay-sandbox',
            RetentionInDays: 30
        });
    });

    it('fronts the endpoint with CloudFront on the bridge domain, signing every origin request', () => {
        template.hasResourceProperties('AWS::CloudFront::OriginAccessControl', {
            OriginAccessControlConfig: Match.objectLike({ OriginAccessControlOriginType: 'lambda', SigningBehavior: 'always-amz-auth' })
        });
        template.hasResourceProperties('AWS::CloudFront::Distribution', {
            DistributionConfig: Match.objectLike({
                Aliases: ['abdm-sandbox.example.in'],
                Origins: [Match.objectLike({
                    DomainName: { 'Fn::GetAtt': ['Endpoint', 'DomainName'] },
                    OriginAccessControlId: { 'Fn::GetAtt': ['OriginAccessControl', 'Id'] }
                })],
                DefaultCacheBehavior: Match.objectLike({ ViewerProtocolPolicy: 'https-only' })
            })
        });
        template.resourceCountIs('AWS::Route53::RecordSet', 2);
    });

    it('lets only that distribution invoke the endpoint', () => {
        template.hasResourceProperties('AWS::Lambda::ResourcePolicy', {
            PolicyDocument: {
                Version: '2012-10-17',
                Statement: [Match.objectLike({
                    Principal: { Service: 'cloudfront.amazonaws.com' },
                    Action: 'lambda:InvokeWebFunctionEndpoint',
                    Condition: { ArnLike: { 'aws:SourceArn': Match.anyValue() } }
                })]
            }
        });
    });

    it('reads vendor credentials from Parameter Store only, and never Secrets Manager', () => {
        expect(text).toContain('ssm:GetParameters');
        expect(text).toContain('parameter/nalamdesk/sandbox/relay/abdm-client-secret');
        expect(text).toContain('ssm.ap-south-1.amazonaws.com');
        expect(text.toLowerCase()).not.toContain('secretsmanager');
    });

    it('queries the device indexes, reads devices by ID and writes only nonces', () => {
        expect(text).toContain('dynamodb:Query');
        expect(text).toContain('dynamodb:GetItem');
        expect(text).toContain('/nalamdesk/sandbox/core/nonces-table-name');
        expect(text).not.toMatch(/dynamodb:(UpdateItem|DeleteItem|Scan|\*)/);
        const statements = Object.values(template.findResources('AWS::IAM::Policy'))
            .flatMap((policy: any) => policy.Properties.PolicyDocument.Statement);
        const put = statements.find((s: any) => s.Action === 'dynamodb:PutItem');
        expect(JSON.stringify(put.Resource)).toContain('noncestablename');
        expect(JSON.stringify(put.Resource)).not.toContain('devicestablename');
    });
});

describe('bundle', () => {
    it('produces a single index.js', () => {
        const dir = bundleRelay();
        expect(dir.endsWith(join('build', 'relay'))).toBe(true);
    });
});
