import { CfnOutput, Fn, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { Certificate } from 'aws-cdk-lib/aws-certificatemanager';
import {
    AllowedMethods, CachePolicy, CfnOriginAccessControl, Distribution, HttpVersion,
    OriginProtocolPolicy, OriginRequestPolicy, PriceClass, SecurityPolicyProtocol, ViewerProtocolPolicy
} from 'aws-cdk-lib/aws-cloudfront';
import { HttpOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { Effect, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { CfnResourcePolicy, CfnWebFunction, CfnWebFunctionEndpoint, CfnWebFunctionRevision } from 'aws-cdk-lib/aws-lambda';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { AaaaRecord, ARecord, HostedZone, RecordTarget } from 'aws-cdk-lib/aws-route53';
import { CloudFrontTarget } from 'aws-cdk-lib/aws-route53-targets';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { BucketDeployment, Source } from 'aws-cdk-lib/aws-s3-deployment';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import { coreParam, relayParam, stageDomain, type Stage } from './contract.js';

export interface RelayStackProps extends StackProps {
    stage: Stage;
    zoneName: string;
    /** Directory holding the bundled index.js (see infra/bundle.ts). */
    codeDir: string;
    /** Expected `iss` on gateway callback JWTs, once NHA confirms it (#152). */
    gatewayIssuer?: string;
}

export const RELAY_LIMITS = {
    // ABDM does not resend a dropped callback, so the relay gets two
    // environments where the booking API gets one.
    maxEnvironments: 2,
    maxConcurrencyPerEnvironment: 64,
    timeoutSeconds: 30,
    rateLimitPerSecond: 100
};

/**
 * The ABDM relay (#159) in ap-south-1: a Lambda Web Function running the
 * Hono app, an IamAuth endpoint only CloudFront can call, CloudFront on the
 * bridge domain, metadata-only logs kept 30 days, and read access to the
 * vendor credentials in Parameter Store and to the Core device registry.
 * Shared resources come from the Core stack through Parameter Store.
 */
export class RelayStack extends Stack {
    constructor(scope: Construct, id: string, props: RelayStackProps) {
        super(scope, id, props);
        const { stage } = props;
        const core = (name: Parameters<typeof coreParam>[1]) =>
            StringParameter.valueForStringParameter(this, coreParam(stage, name));

        const functionName = `nalamdesk-abdm-relay-${stage}`;
        const bridgeDomain = stageDomain(stage, 'abdm', props.zoneName);
        const devicesTableName = core('devices-table-name');
        const noncesTableName = core('nonces-table-name');
        const codeBucket = Bucket.fromBucketName(this, 'CodeBucket', core('code-bucket-name'));

        const logGroup = new LogGroup(this, 'Logs', {
            logGroupName: `/aws/lambda/web/${functionName}`,
            retention: RetentionDays.ONE_MONTH,
            removalPolicy: RemovalPolicy.DESTROY
        });

        const role = new Role(this, 'ExecutionRole', {
            assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
            description: 'ABDM relay Web Function'
        });
        logGroup.grantWrite(role);
        role.addToPolicy(new PolicyStatement({
            actions: ['ssm:GetParameters'],
            resources: (['abdm-client-id', 'abdm-client-secret'] as const).map((name) =>
                this.formatArn({ service: 'ssm', resource: 'parameter', resourceName: relayParam(stage, name).slice(1) }))
        }));
        // SecureString with the AWS managed aws/ssm key, only through SSM.
        role.addToPolicy(new PolicyStatement({
            actions: ['kms:Decrypt'],
            resources: [this.formatArn({ service: 'kms', resource: 'key', resourceName: '*' })],
            conditions: { StringEquals: { 'kms:ViaService': `ssm.${this.region}.amazonaws.com` } }
        }));
        const devicesTableArn = this.formatArn({ service: 'dynamodb', resource: 'table', resourceName: devicesTableName });
        role.addToPolicy(new PolicyStatement({
            actions: ['dynamodb:Query'],
            resources: [`${devicesTableArn}/index/byHipId`, `${devicesTableArn}/index/byDataPushToken`]
        }));
        // Signed desktop requests: read the device by ID, record each nonce.
        role.addToPolicy(new PolicyStatement({ actions: ['dynamodb:GetItem'], resources: [devicesTableArn] }));
        role.addToPolicy(new PolicyStatement({
            actions: ['dynamodb:PutItem'],
            resources: [this.formatArn({ service: 'dynamodb', resource: 'table', resourceName: noncesTableName })]
        }));

        // Each build is uploaded once, named by its content hash, at the
        // bucket root (objectKeys reports keys without a prefix). The
        // revision pins that object's version, so a new build means a new
        // revision.
        const code = new BucketDeployment(this, 'Code', {
            sources: [Source.asset(props.codeDir)],
            destinationBucket: codeBucket,
            extract: false,
            prune: false,
            retainOnDelete: true
        });

        const webFunction = new CfnWebFunction(this, 'Function', { functionName });

        const revision = new CfnWebFunctionRevision(this, 'Revision', {
            functionName,
            description: 'ABDM relay',
            buildConfig: {
                codeConfig: {
                    s3Object: {
                        bucket: codeBucket.bucketName,
                        key: Fn.select(0, code.objectKeys),
                        versionId: Fn.select(0, code.objectVersionIds)
                    }
                },
                runtimeConfig: { runtime: 'nodejs24.x' }
            },
            serviceConfig: {
                executionRoleArn: role.roleArn,
                timeoutSeconds: RELAY_LIMITS.timeoutSeconds,
                maxConcurrencyPerEnvironment: RELAY_LIMITS.maxConcurrencyPerEnvironment,
                environmentVariables: {
                    ABDM_ENV: stage === 'production' ? 'production' : 'sandbox',
                    ABDM_CLIENT_ID_PARAM: relayParam(stage, 'abdm-client-id'),
                    ABDM_CLIENT_SECRET_PARAM: relayParam(stage, 'abdm-client-secret'),
                    DEVICES_TABLE: devicesTableName,
                    NONCES_TABLE: noncesTableName,
                    ...(props.gatewayIssuer ? { ABDM_GATEWAY_ISSUER: props.gatewayIssuer } : {})
                },
                telemetryConfig: {
                    loggingConfig: { logGroup: logGroup.logGroupName, applicationLogLevel: 'INFO', systemLogLevel: 'WARN' }
                }
            }
        });
        revision.node.addDependency(webFunction);
        revision.node.addDependency(code, role);

        // HomeRegion keeps a VPC connector with NAT possible if ABDM ever
        // asks for fixed egress IPs.
        const endpoint = new CfnWebFunctionEndpoint(this, 'Endpoint', {
            functionName,
            endpointName: 'bridge',
            endpointType: 'HomeRegion',
            authType: 'IamAuth',
            revisionWeights: [{ revisionId: revision.attrRevisionId, weight: 100 }],
            scalingConfig: { maxEnvironments: RELAY_LIMITS.maxEnvironments },
            throttleConfig: { rateLimit: RELAY_LIMITS.rateLimitPerSecond }
        });
        endpoint.node.addDependency(webFunction);

        // CloudFront signs every origin request (SigV4) and keeps the
        // caller's own Authorization header, which carries ABDM's JWT.
        const oac = new CfnOriginAccessControl(this, 'OriginAccessControl', {
            originAccessControlConfig: {
                name: `${functionName}-oac`,
                originAccessControlOriginType: 'lambda',
                signingBehavior: 'always-amz-auth',
                signingProtocol: 'sigv4'
            }
        });

        const distribution = new Distribution(this, 'Distribution', {
            comment: `NalamDesk ABDM bridge (${stage})`,
            domainNames: [bridgeDomain],
            certificate: Certificate.fromCertificateArn(this, 'Certificate', core('bridge-certificate-arn')),
            minimumProtocolVersion: SecurityPolicyProtocol.TLS_V1_2_2021,
            httpVersion: HttpVersion.HTTP2_AND_3,
            priceClass: PriceClass.PRICE_CLASS_200,
            enableLogging: false,
            defaultBehavior: {
                origin: new HttpOrigin(endpoint.attrDomainName, {
                    protocolPolicy: OriginProtocolPolicy.HTTPS_ONLY
                }),
                allowedMethods: AllowedMethods.ALLOW_ALL,
                viewerProtocolPolicy: ViewerProtocolPolicy.HTTPS_ONLY,
                cachePolicy: CachePolicy.CACHING_DISABLED,
                // Lambda routes on Host, so the viewer's Host must not reach it.
                originRequestPolicy: OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
                compress: false
            }
        });
        const cfnDistribution = distribution.node.defaultChild as import('aws-cdk-lib/aws-cloudfront').CfnDistribution;
        cfnDistribution.addPropertyOverride('DistributionConfig.Origins.0.OriginAccessControlId', oac.attrId);

        // Only this distribution may invoke the endpoint.
        new CfnResourcePolicy(this, 'InvokePolicy', {
            resourceArn: webFunction.attrFunctionArn,
            policyDocument: {
                Version: '2012-10-17',
                Statement: [{
                    Sid: 'CloudFrontOnly',
                    Effect: Effect.ALLOW,
                    Principal: { Service: 'cloudfront.amazonaws.com' },
                    Action: 'lambda:InvokeWebFunctionEndpoint',
                    Resource: webFunction.attrFunctionArn,
                    Condition: { ArnLike: { 'aws:SourceArn': distribution.distributionArn } }
                }]
            }
        }).node.addDependency(endpoint);

        const zone = HostedZone.fromHostedZoneAttributes(this, 'Zone', {
            hostedZoneId: core('hosted-zone-id'),
            zoneName: props.zoneName
        });
        const target = RecordTarget.fromAlias(new CloudFrontTarget(distribution));
        new ARecord(this, 'BridgeA', { zone, recordName: bridgeDomain, target });
        new AaaaRecord(this, 'BridgeAaaa', { zone, recordName: bridgeDomain, target });

        new CfnOutput(this, 'BridgeUrl', { value: `https://${bridgeDomain}`, description: 'Register this as the bridge URL for the ABDM Client ID' });
        new CfnOutput(this, 'EndpointDomain', { value: endpoint.attrDomainName });
        new CfnOutput(this, 'DistributionId', { value: distribution.distributionId });
        new CfnOutput(this, 'CredentialParameters', {
            value: `${relayParam(stage, 'abdm-client-id')} ${relayParam(stage, 'abdm-client-secret')}`,
            description: 'Create both before first use: aws ssm put-parameter --type SecureString'
        });
    }
}
