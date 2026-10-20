import { Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { CfnBudget } from 'aws-cdk-lib/aws-budgets';
import type { ICertificate } from 'aws-cdk-lib/aws-certificatemanager';
import { AccountRecovery, CfnUserPoolGroup, Mfa, OAuthScope, UserPool, UserPoolClientIdentityProvider } from 'aws-cdk-lib/aws-cognito';
import { AttributeType, Billing, TableV2 } from 'aws-cdk-lib/aws-dynamodb';
import { PolicyStatement, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import type { IHostedZone } from 'aws-cdk-lib/aws-route53';
import { BlockPublicAccess, Bucket, BucketEncryption } from 'aws-cdk-lib/aws-s3';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import { coreParam, type CoreParamName, type Stage } from './contract.js';

export interface CoreStackProps extends StackProps {
    stage: Stage;
    zone: IHostedZone;
    bridgeDomain: string;
    bridgeCertificate: ICertificate;
    bookingDomain: string;
    bookingCertificate: ICertificate;
    /** Who gets the monthly budget alerts. */
    budgetEmail: string;
    /** Monthly budget in USD; alerts at 80% actual and 100% forecast. */
    budgetUsd?: number;
    /** Cognito managed login domain prefix for the ops console; globally unique. */
    opsDomainPrefix?: string;
}

/**
 * Shared ap-south-1 resources for the relay and booking stacks (#153):
 * device registry tables, the ops console user pool, the Web Function code
 * bucket and the cost alarm. Everything that holds state is retained on
 * stack deletion.
 */
export class CoreStack extends Stack {
    readonly devices: TableV2;
    readonly pairingRequests: TableV2;
    readonly nonces: TableV2;
    readonly clinicIds: TableV2;
    readonly codeBucket: Bucket;
    readonly opsUserPool: UserPool;

    constructor(scope: Construct, id: string, props: CoreStackProps) {
        super(scope, id, props);
        const { stage } = props;

        // One row per paired device. Revoked devices keep their row with
        // status=revoked, so the relay must check status on every lookup.
        this.devices = new TableV2(this, 'Devices', {
            partitionKey: { name: 'deviceId', type: AttributeType.STRING },
            billing: Billing.onDemand(),
            pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
            deletionProtection: true,
            removalPolicy: RemovalPolicy.RETAIN,
            globalSecondaryIndexes: [
                { indexName: 'byHipId', partitionKey: { name: 'hipId', type: AttributeType.STRING } },
                { indexName: 'byDataPushToken', partitionKey: { name: 'dataPushToken', type: AttributeType.STRING } }
            ]
        });

        // At most one pending request per HFR ID; expires after 24 hours.
        this.pairingRequests = new TableV2(this, 'PairingRequests', {
            partitionKey: { name: 'hfrId', type: AttributeType.STRING },
            billing: Billing.onDemand(),
            timeToLiveAttribute: 'expiresAt',
            removalPolicy: RemovalPolicy.DESTROY
        });

        // Request nonces, kept 5 minutes for replay checks.
        this.nonces = new TableV2(this, 'Nonces', {
            partitionKey: { name: 'nonceKey', type: AttributeType.STRING },
            billing: Billing.onDemand(),
            timeToLiveAttribute: 'expiresAt',
            removalPolicy: RemovalPolicy.DESTROY
        });

        // One clinic ID per HFR ID, kept when a replacement install pairs, so
        // the booking listing and slots survive it (#154).
        this.clinicIds = new TableV2(this, 'ClinicIds', {
            partitionKey: { name: 'hipId', type: AttributeType.STRING },
            billing: Billing.onDemand(),
            pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
            deletionProtection: true,
            removalPolicy: RemovalPolicy.RETAIN
        });

        // NalamDesk staff only: no self sign-up, TOTP MFA required.
        this.opsUserPool = new UserPool(this, 'OpsUserPool', {
            userPoolName: `nalamdesk-ops-${stage}`,
            selfSignUpEnabled: false,
            signInAliases: { email: true },
            mfa: Mfa.REQUIRED,
            mfaSecondFactor: { otp: true, sms: false },
            passwordPolicy: { minLength: 12, requireSymbols: false },
            accountRecovery: AccountRecovery.EMAIL_ONLY,
            deletionProtection: true,
            removalPolicy: RemovalPolicy.RETAIN
        });
        new CfnUserPoolGroup(this, 'OpsGroup', {
            userPoolId: this.opsUserPool.userPoolId,
            groupName: 'ops',
            description: 'NalamDesk staff who approve pairings and revoke devices'
        });

        // Web Function revisions must come from a versioned bucket that
        // Lambda can read; the CDK asset bucket does not qualify.
        // The ops console at https://<bridge domain>/ops/ (#154): Cognito
        // managed login, authorization code with PKCE, no client secret.
        const opsConsoleUrl = `https://${props.bridgeDomain}/ops/`;
        const opsClient = this.opsUserPool.addClient('OpsConsoleClient', {
            userPoolClientName: `nalamdesk-ops-console-${stage}`,
            generateSecret: false,
            authFlows: { userSrp: true },
            oAuth: {
                flows: { authorizationCodeGrant: true },
                scopes: [OAuthScope.OPENID],
                callbackUrls: [opsConsoleUrl],
                logoutUrls: [opsConsoleUrl]
            },
            supportedIdentityProviders: [UserPoolClientIdentityProvider.COGNITO],
            preventUserExistenceErrors: true,
            accessTokenValidity: Duration.hours(1),
            idTokenValidity: Duration.hours(1),
            refreshTokenValidity: Duration.hours(8)
        });
        const opsDomain = this.opsUserPool.addDomain('OpsDomain', {
            cognitoDomain: { domainPrefix: props.opsDomainPrefix ?? `nalamdesk-ops-${stage}` }
        });

        this.codeBucket = new Bucket(this, 'CodeBucket', {
            versioned: true,
            encryption: BucketEncryption.S3_MANAGED,
            blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
            removalPolicy: RemovalPolicy.RETAIN,
            lifecycleRules: [{ noncurrentVersionExpiration: Duration.days(30) }]
        });
        this.codeBucket.addToResourcePolicy(new PolicyStatement({
            principals: [new ServicePrincipal('lambda.amazonaws.com')],
            actions: ['s3:GetObject', 's3:GetObjectVersion'],
            resources: [this.codeBucket.arnForObjects('*')],
            conditions: { StringEquals: { 'aws:SourceAccount': this.account } }
        }));

        new CfnBudget(this, 'MonthlyBudget', {
            budget: {
                budgetName: `nalamdesk-${stage}-monthly`,
                budgetType: 'COST',
                timeUnit: 'MONTHLY',
                budgetLimit: { amount: props.budgetUsd ?? 10, unit: 'USD' }
            },
            notificationsWithSubscribers: [
                { notification: { notificationType: 'ACTUAL', comparisonOperator: 'GREATER_THAN', threshold: 80 } },
                { notification: { notificationType: 'FORECASTED', comparisonOperator: 'GREATER_THAN', threshold: 100 } }
            ].map((entry) => ({
                ...entry,
                subscribers: [{ subscriptionType: 'EMAIL', address: props.budgetEmail }]
            }))
        });

        const publish = (name: CoreParamName, value: string) =>
            new StringParameter(this, `Param-${name}`, { parameterName: coreParam(stage, name), stringValue: value });
        publish('devices-table-name', this.devices.tableName);
        publish('pairing-table-name', this.pairingRequests.tableName);
        publish('nonces-table-name', this.nonces.tableName);
        publish('clinic-ids-table-name', this.clinicIds.tableName);
        publish('code-bucket-name', this.codeBucket.bucketName);
        publish('hosted-zone-id', props.zone.hostedZoneId);
        publish('bridge-domain', props.bridgeDomain);
        publish('bridge-certificate-arn', props.bridgeCertificate.certificateArn);
        publish('booking-domain', props.bookingDomain);
        publish('booking-certificate-arn', props.bookingCertificate.certificateArn);
        publish('ops-user-pool-id', this.opsUserPool.userPoolId);
        publish('ops-client-id', opsClient.userPoolClientId);
        publish('ops-auth-domain', `${opsDomain.domainName}.auth.${this.region}.amazoncognito.com`);
    }
}
