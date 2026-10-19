import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import { coreParam, phonePepperParam, stageDomain, type Stage } from './contract.js';

export interface BookingStackProps extends cdk.StackProps {
    stage: Stage;
    /** The zone cloud/core manages; the site is book.<zone> (book-sandbox.<zone> in sandbox). */
    zoneName: string;
    /** Directory holding the bundled index.js (see lib/bundle.ts). */
    codeDir: string;
    /** Built site (cloud/booking/web/dist). Omit in tests. */
    siteDir?: string;
}

export const BOOKING_LIMITS = {
    // The plan caps the booking API at one environment; a request that
    // cannot get in is retried by the browser, unlike an ABDM callback.
    maxEnvironments: 1,
    timeoutSeconds: 10,
    rateLimitPerSecond: 20
};

// Content-Security-Policy for the site. Everything is self-hosted (fonts
// included), so the browser may load and call nothing but this origin.
export const SITE_CSP = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    'upgrade-insecure-requests'
].join('; ');

// Viewer-request rewrite so client routes such as /booking/ABCD load the
// app. Files (anything with a dot in the last segment) pass through. This
// keeps 404s from S3 or the API as real 404s, unlike distribution-wide
// error pages.
const SPA_REWRITE = `function handler(event) {
  var request = event.request;
  var last = request.uri.split('/').pop();
  if (last.indexOf('.') === -1) request.uri = '/index.html';
  return request;
}`;

/**
 * The online booking stack (#156): a private S3 bucket and CloudFront for the
 * React site, `/api/*` routed to the booking Web Function, and the clinics,
 * slots and booking-request tables. Patient details never reach it in plain
 * text; the sealed requests themselves live in the shared mailbox (#155).
 */
export class BookingStack extends cdk.Stack {
    readonly distribution: cloudfront.Distribution;
    readonly tables: { clinics: dynamodb.Table; slots: dynamodb.Table; bookings: dynamodb.Table };

    constructor(scope: Construct, id: string, props: BookingStackProps) {
        super(scope, id, props);
        const { stage } = props;
        // Shared resources come from the Core stack (#153) through Parameter Store.
        const core = (name: Parameters<typeof coreParam>[1]) =>
            ssm.StringParameter.valueForStringParameter(this, coreParam(stage, name));
        const bookingDomain = stageDomain(stage, 'book', props.zoneName);
        const codeBucket = s3.Bucket.fromBucketName(this, 'CodeBucket', core('code-bucket-name'));
        const phonePepper = phonePepperParam(stage);

        // ---- Tables ----
        const clinics = new dynamodb.Table(this, 'Clinics', {
            partitionKey: { name: 'clinicId', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
            removalPolicy: cdk.RemovalPolicy.RETAIN
        });
        const slots = new dynamodb.Table(this, 'Slots', {
            partitionKey: { name: 'clinicId', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'slotId', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            removalPolicy: cdk.RemovalPolicy.RETAIN
        });
        // Status records only (reference, clinic, slot, status, a keyed phone
        // hash). The sealed patient details are in the mailbox, not here.
        const bookings = new dynamodb.Table(this, 'BookingRequests', {
            partitionKey: { name: 'ref', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            timeToLiveAttribute: 'ttl',
            removalPolicy: cdk.RemovalPolicy.DESTROY
        });
        bookings.addGlobalSecondaryIndex({
            indexName: 'byPhone',
            partitionKey: { name: 'phoneIndex', type: dynamodb.AttributeType.STRING },
            projectionType: dynamodb.ProjectionType.INCLUDE,
            nonKeyAttributes: ['status', 'expiresAt']
        });
        this.tables = { clinics, slots, bookings };

        // HMAC key that turns the browser's phone digest into a per-clinic key
        // the tables can hold. A SecureString parameter, like the relay's
        // vendor secret; CloudFormation cannot create SecureStrings, so
        // scripts/deploy.sh puts a random one there on first deploy.
        const phonePepperArn = this.formatArn({
            service: 'ssm',
            resource: 'parameter',
            resourceName: phonePepper.slice(1)
        });

        // ---- Site bucket ----
        const site = new s3.Bucket(this, 'Site', {
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            encryption: s3.BucketEncryption.S3_MANAGED,
            enforceSSL: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true
        });

        const securityHeaders = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
            securityHeadersBehavior: {
                contentSecurityPolicy: { contentSecurityPolicy: SITE_CSP, override: true },
                contentTypeOptions: { override: true },
                frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
                referrerPolicy: { referrerPolicy: cloudfront.HeadersReferrerPolicy.NO_REFERRER, override: true },
                strictTransportSecurity: { accessControlMaxAge: cdk.Duration.days(365), includeSubdomains: true, preload: true, override: true }
            },
            customHeadersBehavior: {
                customHeaders: [{ header: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()', override: true }]
            }
        });

        const spaRewrite = new cloudfront.Function(this, 'SpaRewrite', {
            code: cloudfront.FunctionCode.fromInline(SPA_REWRITE),
            runtime: cloudfront.FunctionRuntime.JS_2_0
        });

        const additionalBehaviors: Record<string, cloudfront.BehaviorOptions> = {};

        // ---- Booking API (Lambda Web Function) ----
        const functionName = `nalamdesk-booking-api-${stage}`;
        const logGroup = new logs.LogGroup(this, 'ApiLogs', {
            logGroupName: `/aws/lambda/web/${functionName}`,
            retention: logs.RetentionDays.ONE_MONTH,
            removalPolicy: cdk.RemovalPolicy.DESTROY
        });
        const role = new iam.Role(this, 'ApiRole', {
            assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
            description: 'NalamDesk booking API Web Function'
        });
        clinics.grantReadWriteData(role);
        slots.grantReadWriteData(role);
        bookings.grantReadWriteData(role);
        role.addToPolicy(new iam.PolicyStatement({ actions: ['ssm:GetParameter'], resources: [phonePepperArn] }));
        // SecureStrings use the account's aws/ssm key; decrypt only via SSM.
        role.addToPolicy(new iam.PolicyStatement({
            actions: ['kms:Decrypt'],
            resources: [this.formatArn({ service: 'kms', resource: 'alias', resourceName: 'aws/ssm' }), this.formatArn({ service: 'kms', resource: 'key', resourceName: '*' })],
            conditions: { StringEquals: { 'kms:ViaService': `ssm.${this.region}.amazonaws.com` } }
        }));
        logGroup.grantWrite(role);
        // Signed clinic requests (#154): read the device by ID, record each nonce.
        const devicesTable = core('devices-table-name');
        const noncesTable = core('nonces-table-name');
        role.addToPolicy(new iam.PolicyStatement({
            actions: ['dynamodb:GetItem'],
            resources: [this.formatArn({ service: 'dynamodb', resource: 'table', resourceName: devicesTable })]
        }));
        role.addToPolicy(new iam.PolicyStatement({
            actions: ['dynamodb:PutItem'],
            resources: [this.formatArn({ service: 'dynamodb', resource: 'table', resourceName: noncesTable })]
        }));
        // Sealed booking requests go to the clinic's 48-hour mailbox, then
        // the doorbell rings (#155). Put only: the desktop reads through the relay.
        const mailboxTable = core('mailbox-table-name');
        const mailboxBucket = s3.Bucket.fromBucketName(this, 'MailboxBucket', core('mailbox-bucket-name'));
        const doorbellTopicPrefix = core('doorbell-topic-prefix');
        role.addToPolicy(new iam.PolicyStatement({
            actions: ['dynamodb:PutItem'],
            resources: [this.formatArn({ service: 'dynamodb', resource: 'table', resourceName: mailboxTable })]
        }));
        role.addToPolicy(new iam.PolicyStatement({ actions: ['s3:PutObject'], resources: [mailboxBucket.arnForObjects('mailbox/*')] }));
        role.addToPolicy(new iam.PolicyStatement({
            actions: ['iot:Publish'],
            resources: [this.formatArn({ service: 'iot', resource: 'topic', resourceName: `${doorbellTopicPrefix}/*` })]
        }));

        // Each build is uploaded once to the Core code bucket, named by its
        // content hash; the revision pins that object's version, so a new
        // build means a new revision.
        const code = new s3deploy.BucketDeployment(this, 'ApiCode', {
            sources: [s3deploy.Source.asset(props.codeDir)],
            destinationBucket: codeBucket,
            extract: false,
            prune: false,
            retainOnDelete: true
        });
        const fn = new lambda.CfnWebFunction(this, 'Api', { functionName });
        const revision = new lambda.CfnWebFunctionRevision(this, 'ApiRevision', {
            functionName,
            description: 'NalamBook booking API',
            buildConfig: {
                codeConfig: {
                    s3Object: {
                        bucket: codeBucket.bucketName,
                        key: cdk.Fn.select(0, code.objectKeys),
                        versionId: cdk.Fn.select(0, code.objectVersionIds)
                    }
                },
                runtimeConfig: { runtime: 'nodejs24.x' }
            },
            serviceConfig: {
                executionRoleArn: role.roleArn,
                timeoutSeconds: BOOKING_LIMITS.timeoutSeconds,
                environmentVariables: {
                    NODE_ENV: 'production',
                    BOOKING_CLINICS_TABLE: clinics.tableName,
                    BOOKING_SLOTS_TABLE: slots.tableName,
                    BOOKING_REQUESTS_TABLE: bookings.tableName,
                    BOOKING_PHONE_PEPPER_PARAM: phonePepper,
                    DEVICES_TABLE: devicesTable,
                    NONCES_TABLE: noncesTable,
                    MAILBOX_TABLE: mailboxTable,
                    MAILBOX_BUCKET: mailboxBucket.bucketName,
                    IOT_DATA_ENDPOINT: core('iot-data-endpoint'),
                    DOORBELL_TOPIC_PREFIX: doorbellTopicPrefix
                },
                telemetryConfig: { loggingConfig: { logGroup: logGroup.logGroupName, applicationLogLevel: 'INFO', systemLogLevel: 'WARN' } }
            }
        });
        revision.node.addDependency(fn);
        revision.node.addDependency(code, role);
        const endpoint = new lambda.CfnWebFunctionEndpoint(this, 'ApiEndpoint', {
            functionName,
            endpointName: 'public',
            endpointType: 'HomeRegion',
            // Only CloudFront, signing with its origin access control, may call it.
            authType: 'IamAuth',
            revisionWeights: [{ revisionId: revision.attrRevisionId, weight: 100 }],
            scalingConfig: { maxEnvironments: BOOKING_LIMITS.maxEnvironments },
            throttleConfig: { rateLimit: BOOKING_LIMITS.rateLimitPerSecond }
        });
        endpoint.node.addDependency(fn);

        const apiOac = new cloudfront.CfnOriginAccessControl(this, 'ApiOac', {
            originAccessControlConfig: {
                name: `${this.stackName}-api`,
                originAccessControlOriginType: 'lambda',
                signingBehavior: 'always',
                signingProtocol: 'sigv4'
            }
        });
        const apiOrigin = new origins.HttpOrigin(endpoint.attrDomainName, {
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
            originId: 'booking-api'
        });

        // The directory and slot lists change rarely; 30 seconds at the edge
        // keeps search traffic off the function. The API sets the same max-age.
        const publicLists = new cloudfront.CachePolicy(this, 'PublicListCache', {
            defaultTtl: cdk.Duration.seconds(30),
            maxTtl: cdk.Duration.seconds(30),
            minTtl: cdk.Duration.seconds(0),
            queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
            headerBehavior: cloudfront.CacheHeaderBehavior.none(),
            cookieBehavior: cloudfront.CacheCookieBehavior.none(),
            enableAcceptEncodingGzip: true,
            enableAcceptEncodingBrotli: true
        });
        const listBehavior: cloudfront.BehaviorOptions = {
            origin: apiOrigin,
            viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
            allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
            cachePolicy: publicLists,
            responseHeadersPolicy: securityHeaders
        };
        additionalBehaviors['/api/clinics'] = listBehavior;
        additionalBehaviors['/api/slots/*'] = listBehavior;
        additionalBehaviors['/api/*'] = {
            origin: apiOrigin,
            viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
            allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
            cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
            originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
            responseHeadersPolicy: securityHeaders
        };

        new cdk.CfnOutput(this, 'ApiEndpointDomain', { value: endpoint.attrDomainName });

        this.distribution = new cloudfront.Distribution(this, 'Distribution', {
            comment: `NalamBook, NalamDesk online booking (${stage})`,
            domainNames: [bookingDomain],
            certificate: acm.Certificate.fromCertificateArn(this, 'Certificate', core('booking-certificate-arn')),
            defaultRootObject: 'index.html',
            httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
            priceClass: cloudfront.PriceClass.PRICE_CLASS_200,
            minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
            defaultBehavior: {
                origin: origins.S3BucketOrigin.withOriginAccessControl(site),
                viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
                responseHeadersPolicy: securityHeaders,
                functionAssociations: [{ function: spaRewrite, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }]
            },
            additionalBehaviors
        });

        // The L2 HttpOrigin has no OAC slot, so attach it on the L1. Origins
        // are listed in first-use order: the site bucket, then the API.
        const cfn = this.distribution.node.defaultChild as cloudfront.CfnDistribution;
        cfn.addPropertyOverride('DistributionConfig.Origins.1.OriginAccessControlId', apiOac.attrId);

        // Only this distribution may invoke the API endpoint.
        new lambda.CfnResourcePolicy(this, 'ApiInvokePolicy', {
            resourceArn: fn.attrFunctionArn,
            policyDocument: {
                Version: '2012-10-17',
                Statement: [{
                    Sid: 'CloudFrontOnly',
                    Effect: 'Allow',
                    Principal: { Service: 'cloudfront.amazonaws.com' },
                    Action: 'lambda:InvokeWebFunctionEndpoint',
                    Resource: fn.attrFunctionArn,
                    Condition: { ArnLike: { 'aws:SourceArn': this.distribution.distributionArn } }
                }]
            }
        }).node.addDependency(endpoint);

        const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', {
            hostedZoneId: core('hosted-zone-id'),
            zoneName: props.zoneName
        });
        const target = route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(this.distribution));
        new route53.ARecord(this, 'SiteA', { zone, recordName: bookingDomain, target });
        new route53.AaaaRecord(this, 'SiteAaaa', { zone, recordName: bookingDomain, target });

        if (props.siteDir) {
            // Hashed assets never change, so they cache for a year; index.html
            // is revalidated every time so a deploy takes effect at once.
            new s3deploy.BucketDeployment(this, 'SiteAssets', {
                sources: [s3deploy.Source.asset(props.siteDir, { exclude: ['index.html'] })],
                destinationBucket: site,
                cacheControl: [s3deploy.CacheControl.fromString('public, max-age=31536000, immutable')],
                prune: false
            });
            new s3deploy.BucketDeployment(this, 'SiteIndex', {
                sources: [s3deploy.Source.asset(props.siteDir, { exclude: ['*', '!index.html'] })],
                destinationBucket: site,
                cacheControl: [s3deploy.CacheControl.fromString('no-cache')],
                prune: false,
                distribution: this.distribution,
                distributionPaths: ['/index.html']
            });
        }

        new cdk.CfnOutput(this, 'SiteUrl', { value: `https://${bookingDomain}` });
        new cdk.CfnOutput(this, 'DistributionId', { value: this.distribution.distributionId });
        new cdk.CfnOutput(this, 'PhonePepperParameter', {
            value: phonePepper,
            description: 'Create before first use: aws ssm put-parameter --type SecureString (scripts/deploy.sh does this)'
        });
    }
}
