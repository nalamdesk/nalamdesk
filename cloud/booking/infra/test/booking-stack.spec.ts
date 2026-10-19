import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { BookingStack, SITE_CSP } from '../lib/booking-stack.js';

function synth(withApi: boolean) {
    const app = new cdk.App();
    const stack = new BookingStack(app, 'Test', {
        env: { account: '111111111111', region: 'ap-south-1' },
        codeBucketName: 'code-bucket',
        apiCode: withApi ? { key: 'booking-api/abc.zip', versionId: 'v1' } : undefined
    });
    return Template.fromStack(stack);
}

describe('BookingStack', () => {
    const t = synth(true);

    it('keeps the site bucket private behind CloudFront', () => {
        t.hasResourceProperties('AWS::S3::Bucket', {
            PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true }
        });
        t.resourceCountIs('AWS::CloudFront::OriginAccessControl', 2);
    });

    it('caps the API at one environment behind IAM auth, with code from the versioned bucket', () => {
        t.hasResourceProperties('AWS::Lambda::WebFunctionEndpoint', {
            AuthType: 'IamAuth',
            EndpointType: 'HomeRegion',
            ScalingConfig: { MaxEnvironments: 1 }
        });
        t.hasResourceProperties('AWS::Lambda::WebFunctionRevision', {
            BuildConfig: {
                CodeConfig: { S3Object: { Bucket: 'code-bucket', Key: 'booking-api/abc.zip', VersionId: 'v1' } },
                RuntimeConfig: { Runtime: 'nodejs24.x' }
            }
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

    it('gives the API role table and secret access only', () => {
        const policies = JSON.stringify(t.findResources('AWS::IAM::Policy'));
        expect(policies).toContain('dynamodb:PutItem');
        expect(policies).toContain('secretsmanager:GetSecretValue');
        expect(policies).not.toContain('"Action":"*"');
    });

    it('deploys only the site and tables before the first API upload', () => {
        const siteOnly = synth(false);
        siteOnly.resourceCountIs('AWS::Lambda::WebFunction', 0);
        siteOnly.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
        siteOnly.resourceCountIs('AWS::DynamoDB::Table', 3);
    });
});
