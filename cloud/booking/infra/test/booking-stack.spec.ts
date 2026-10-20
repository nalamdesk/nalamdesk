import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BookingStack, SITE_CSP } from '../lib/booking-stack.js';

function synth(stage: 'sandbox' | 'production' = 'sandbox') {
    const codeDir = mkdtempSync(join(tmpdir(), 'booking-code-'));
    writeFileSync(join(codeDir, 'index.js'), '');
    const app = new cdk.App();
    const stack = new BookingStack(app, 'Test', {
        env: { account: '111111111111', region: 'ap-south-1' },
        stage,
        zoneName: 'example.in',
        codeDir
    });
    return Template.fromStack(stack);
}

describe('BookingStack', () => {
    const t = synth();

    it('keeps the site bucket private behind CloudFront', () => {
        t.hasResourceProperties('AWS::S3::Bucket', {
            PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true }
        });
        t.resourceCountIs('AWS::CloudFront::OriginAccessControl', 2);
    });

    it('caps the API at one environment behind IAM auth, with code pinned in the Core code bucket', () => {
        t.hasResourceProperties('AWS::Lambda::WebFunctionEndpoint', {
            AuthType: 'IamAuth',
            EndpointType: 'HomeRegion',
            ScalingConfig: { MaxEnvironments: 1 },
            ThrottleConfig: { RateLimit: 20 }
        });
        const revision = Object.values(t.findResources('AWS::Lambda::WebFunctionRevision'))[0] as any;
        const s3Object = revision.Properties.BuildConfig.CodeConfig.S3Object;
        expect(JSON.stringify(s3Object.Bucket)).toContain('SsmParameterValuenalamdesksandboxcorecodebucketname');
        expect(s3Object.VersionId).toBeDefined();
        expect(revision.Properties.BuildConfig.RuntimeConfig).toEqual({ Runtime: 'nodejs24.x' });
    });

    it('lets only its own distribution invoke the API', () => {
        t.hasResourceProperties('AWS::Lambda::ResourcePolicy', {
            PolicyDocument: Match.objectLike({
                Statement: [Match.objectLike({
                    Principal: { Service: 'cloudfront.amazonaws.com' },
                    Action: 'lambda:InvokeWebFunctionEndpoint',
                    Condition: { ArnLike: { 'aws:SourceArn': Match.anyValue() } }
                })]
            })
        });
    });

    it('serves the stage domain with the Core certificate and alias records', () => {
        t.hasResourceProperties('AWS::CloudFront::Distribution', {
            DistributionConfig: Match.objectLike({ Aliases: ['book-sandbox.example.in'] })
        });
        t.hasResourceProperties('AWS::Route53::RecordSet', { Name: 'book-sandbox.example.in.', Type: 'A' });
        t.hasResourceProperties('AWS::Route53::RecordSet', { Name: 'book-sandbox.example.in.', Type: 'AAAA' });
        synth('production').hasResourceProperties('AWS::CloudFront::Distribution', {
            DistributionConfig: Match.objectLike({ Aliases: ['book.example.in'] })
        });
    });

    it('signs API origin requests with a Lambda origin access control', () => {
        t.hasResourceProperties('AWS::CloudFront::OriginAccessControl', {
            OriginAccessControlConfig: Match.objectLike({ OriginAccessControlOriginType: 'lambda', SigningBehavior: 'always' })
        });
        const dist = Object.values(t.findResources('AWS::CloudFront::Distribution'))[0] as any;
        const apiOrigin = dist.Properties.DistributionConfig.Origins.find((o: any) => o.Id === 'booking-api');
        expect(apiOrigin.OriginAccessControlId).toBeDefined();
    });

    it('routes /api/* uncached and caches the public lists for 30 seconds', () => {
        const dist = Object.values(t.findResources('AWS::CloudFront::Distribution'))[0] as any;
        const behaviors = dist.Properties.DistributionConfig.CacheBehaviors as any[];
        expect(behaviors.map((b) => b.PathPattern)).toEqual(['/api/clinics', '/api/slots/*', '/api/*']);
        expect(behaviors.every((b) => b.TargetOriginId === 'booking-api')).toBe(true);
        t.hasResourceProperties('AWS::CloudFront::CachePolicy', {
            CachePolicyConfig: Match.objectLike({ DefaultTTL: 30, MaxTTL: 30, MinTTL: 0 })
        });
    });

    it('sends a strict CSP and HSTS with every response', () => {
        t.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
            ResponseHeadersPolicyConfig: Match.objectLike({
                SecurityHeadersConfig: Match.objectLike({
                    ContentSecurityPolicy: { ContentSecurityPolicy: SITE_CSP, Override: true },
                    StrictTransportSecurity: Match.objectLike({ AccessControlMaxAgeSec: 31536000 })
                })
            })
        });
        expect(SITE_CSP).not.toContain('unsafe');
    });

    it('expires booking status records with TTL and indexes the phone key', () => {
        t.hasResourceProperties('AWS::DynamoDB::Table', {
            KeySchema: [{ AttributeName: 'ref', KeyType: 'HASH' }],
            TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
            GlobalSecondaryIndexes: [Match.objectLike({ IndexName: 'byPhone' })]
        });
        t.hasResourceProperties('AWS::DynamoDB::Table', {
            KeySchema: [{ AttributeName: 'clinicId', KeyType: 'HASH' }, { AttributeName: 'slotId', KeyType: 'RANGE' }]
        });
    });

    it('lets the API read devices by ID and record nonces, from the Core tables', () => {
        const statements = Object.values(t.findResources('AWS::IAM::Policy'))
            .flatMap((policy: any) => policy.Properties.PolicyDocument.Statement);
        const get = statements.find((s: any) => s.Action === 'dynamodb:GetItem');
        const put = statements.find((s: any) => s.Action === 'dynamodb:PutItem' && JSON.stringify(s.Resource).includes('noncestablename'));
        expect(JSON.stringify(get.Resource)).toContain('devicestablename');
        expect(put).toBeDefined();
        t.hasResourceProperties('AWS::Lambda::WebFunctionRevision', {
            ServiceConfig: { EnvironmentVariables: { DEVICES_TABLE: { Ref: Match.stringLikeRegexp('devicestablename') }, NONCES_TABLE: { Ref: Match.stringLikeRegexp('noncestablename') } } }
        });
    });

    it('lets the API put and take back sealed requests in the mailbox and ring clinic doorbells, and nothing more', () => {
        const statements = Object.values(t.findResources('AWS::IAM::Policy'))
            .flatMap((policy: any) => policy.Properties.PolicyDocument.Statement);
        const on = (fragment: string) => statements.filter((s: any) => JSON.stringify(s.Resource).includes(fragment)).flatMap((s: any) => [s.Action].flat());
        expect(on('mailboxtablename')).toEqual(['dynamodb:PutItem', 'dynamodb:DeleteItem']);
        expect(on('/mailbox/*')).toEqual(['s3:PutObject']);
        const publish = statements.find((s: any) => s.Action === 'iot:Publish');
        expect(JSON.stringify(publish.Resource)).toContain(':topic/');
        t.hasResourceProperties('AWS::Lambda::WebFunctionRevision', {
            ServiceConfig: Match.objectLike({
                EnvironmentVariables: Match.objectLike({
                    MAILBOX_TABLE: Match.anyValue(), MAILBOX_BUCKET: Match.anyValue(), IOT_DATA_ENDPOINT: Match.anyValue(), DOORBELL_TOPIC_PREFIX: Match.anyValue()
                })
            })
        });
    });

    it('gives the API role table and pepper-parameter access only', () => {
        const policies = JSON.stringify(t.findResources('AWS::IAM::Policy'));
        expect(policies).toContain('dynamodb:PutItem');
        expect(policies).toContain('ssm:GetParameter');
        expect(policies).toContain('parameter/nalamdesk/sandbox/booking/phone-pepper');
        expect(policies).toContain('kms:ViaService');
        expect(policies).not.toContain('"Action":"*"');
    });
});
