import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import type { Construct } from 'constructs';

/** A Web Function code zip already uploaded to the versioned code bucket. */
export interface ApiCodeLocation {
    key: string;
    versionId: string;
}

export interface BookingStackProps extends cdk.StackProps {
    /** Versioned, SSE-S3 bucket that holds the API zip (BookingCodeStack). */
    codeBucketName: string;
    /** Omit to deploy only the site and tables, before the first API upload. */
    apiCode?: ApiCodeLocation;
    /** Built site (cloud/booking/web/dist). Omit in tests. */
    siteDir?: string;
}

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

        // Turns the browser's phone digest into a per-clinic key the tables can hold.
        const phonePepper = new secretsmanager.Secret(this, 'PhonePepper', {
            description: 'NalamDesk booking: HMAC key for the per-clinic phone limit.',
            generateSecretString: { passwordLength: 64, excludePunctuation: true }
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
        let apiOac: cloudfront.CfnOriginAccessControl | undefined;

        // ---- Booking API (Lambda Web Function) ----
        if (props.apiCode) {
            const logGroup = new logs.LogGroup(this, 'ApiLogs', {
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
            phonePepper.grantRead(role);
            logGroup.grantWrite(role);

            const functionName = 'nalamdesk-booking-api';
            const fn = new lambda.CfnWebFunction(this, 'Api', { functionName });
            const revision = new lambda.CfnWebFunctionRevision(this, 'ApiRevision', {
                functionName,
                description: `Booking API ${props.apiCode.key}`,
                buildConfig: {
                    codeConfig: {
                        s3Object: { bucket: props.codeBucketName, key: props.apiCode.key, versionId: props.apiCode.versionId }
                    },
                    runtimeConfig: { runtime: 'nodejs24.x' }
                },
                serviceConfig: {
                    executionRoleArn: role.roleArn,
                    timeoutSeconds: 10,
                    environmentVariables: {
                        NODE_ENV: 'production',
                        BOOKING_CLINICS_TABLE: clinics.tableName,
                        BOOKING_SLOTS_TABLE: slots.tableName,
                        BOOKING_REQUESTS_TABLE: bookings.tableName,
                        BOOKING_PHONE_PEPPER_SECRET: phonePepper.secretArn
                    },
                    telemetryConfig: { loggingConfig: { logGroup: logGroup.logGroupName, applicationLogLevel: 'INFO', systemLogLevel: 'WARN' } }
                }
            });
            revision.addDependency(fn);
            const endpoint = new lambda.CfnWebFunctionEndpoint(this, 'ApiEndpoint', {
                functionName,
                endpointName: 'public',
                endpointType: 'HomeRegion',
                // Only CloudFront, signing with its origin access control, may call it.
                authType: 'IamAuth',
                revisionWeights: [{ revisionId: revision.attrRevisionId, weight: 100 }],
                scalingConfig: { maxEnvironments: 1 }
            });
            endpoint.addDependency(fn);

            apiOac = new cloudfront.CfnOriginAccessControl(this, 'ApiOac', {
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
        }

        this.distribution = new cloudfront.Distribution(this, 'Distribution', {
            comment: 'NalamDesk online booking',
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

        if (apiOac) {
            // The L2 HttpOrigin has no OAC slot, so attach it on the L1. Origins
            // are listed in first-use order: the site bucket, then the API.
            const cfn = this.distribution.node.defaultChild as cloudfront.CfnDistribution;
            cfn.addPropertyOverride('DistributionConfig.Origins.1.OriginAccessControlId', apiOac.attrId);
        }

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

        new cdk.CfnOutput(this, 'SiteUrl', { value: `https://${this.distribution.distributionDomainName}` });
    }
}

/**
 * Versioned, SSE-S3 bucket for Web Function code. A Web Function revision
 * must point at a specific object version here, not at the CDK asset bucket,
 * so the API zip is uploaded between deploying this stack and BookingStack
 * (see scripts/deploy.sh).
 */
export class BookingCodeStack extends cdk.Stack {
    readonly bucket: s3.Bucket;

    constructor(scope: Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props);
        this.bucket = new s3.Bucket(this, 'Code', {
            versioned: true,
            encryption: s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
            lifecycleRules: [{ noncurrentVersionExpiration: cdk.Duration.days(90) }],
            removalPolicy: cdk.RemovalPolicy.RETAIN
        });
        new cdk.CfnOutput(this, 'CodeBucketName', { value: this.bucket.bucketName });
    }
}
