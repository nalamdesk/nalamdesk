import { Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { CfnBudget } from 'aws-cdk-lib/aws-budgets';
import type { ICertificate } from 'aws-cdk-lib/aws-certificatemanager';
import { AccountRecovery, CfnUserPoolGroup, Mfa, OAuthScope, UserPool, UserPoolClientIdentityProvider } from 'aws-cdk-lib/aws-cognito';
import { Alarm, ComparisonOperator, Metric, TreatMissingData } from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import { AttributeType, Billing, TableV2 } from 'aws-cdk-lib/aws-dynamodb';
import { PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { CfnPolicy as CfnIotPolicy, CfnTopicRule } from 'aws-cdk-lib/aws-iot';
import type { IHostedZone } from 'aws-cdk-lib/aws-route53';
import { BlockPublicAccess, Bucket, BucketEncryption } from 'aws-cdk-lib/aws-s3';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { EmailSubscription } from 'aws-cdk-lib/aws-sns-subscriptions';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { AwsCustomResource, AwsCustomResourcePolicy, PhysicalResourceId } from 'aws-cdk-lib/custom-resources';
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
 * stack deletion, except the 48-hour mailbox (#155), whose contents expire
 * on their own.
 */
export class CoreStack extends Stack {
    readonly devices: TableV2;
    readonly pairingRequests: TableV2;
    readonly nonces: TableV2;
    readonly clinicIds: TableV2;
    readonly codeBucket: Bucket;
    readonly opsUserPool: UserPool;
    readonly mailbox: TableV2;
    readonly mailboxBucket: Bucket;
    readonly devicePresence: TableV2;

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

        // The 48-hour mailbox (#155): sealed items for a clinic, listed and
        // acknowledged by its paired desktop. Items over 300 KB go to the
        // bucket. TTL and the lifecycle rule drop anything left behind.
        this.mailbox = new TableV2(this, 'Mailbox', {
            partitionKey: { name: 'clinicId', type: AttributeType.STRING },
            sortKey: { name: 'itemId', type: AttributeType.STRING },
            billing: Billing.onDemand(),
            timeToLiveAttribute: 'expiresAt',
            removalPolicy: RemovalPolicy.DESTROY
        });
        this.mailboxBucket = new Bucket(this, 'MailboxBucket', {
            encryption: BucketEncryption.S3_MANAGED,
            blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
            removalPolicy: RemovalPolicy.DESTROY,
            lifecycleRules: [{ prefix: 'mailbox/', expiration: Duration.days(2) }]
        });

        // The doorbell: each paired desktop holds an IoT certificate for a
        // thing named by its device ID, with the clinic ID as an attribute.
        // It may connect only as itself and receive only its clinic's
        // empty pings; it can publish nothing.
        const topicPrefix = `nalamdesk/${stage}/clinic`;
        const iotPolicyName = `nalamdesk-${stage}-device`;
        const clinicTopic = `${topicPrefix}/\${iot:Connection.Thing.Attributes[clinicId]}/mail`;
        new CfnIotPolicy(this, 'DevicePolicy', {
            policyName: iotPolicyName,
            policyDocument: {
                Version: '2012-10-17',
                Statement: [
                    {
                        Effect: 'Allow',
                        Action: 'iot:Connect',
                        Resource: `arn:aws:iot:${this.region}:${this.account}:client/\${iot:Connection.Thing.ThingName}`,
                        Condition: { Bool: { 'iot:Connection.Thing.IsAttached': 'true' } }
                    },
                    { Effect: 'Allow', Action: 'iot:Subscribe', Resource: `arn:aws:iot:${this.region}:${this.account}:topicfilter/${clinicTopic}` },
                    { Effect: 'Allow', Action: 'iot:Receive', Resource: `arn:aws:iot:${this.region}:${this.account}:topic/${clinicTopic}` }
                ]
            }
        });
        const iotEndpoint = new AwsCustomResource(this, 'IotDataEndpoint', {
            onUpdate: {
                service: 'Iot',
                action: 'describeEndpoint',
                parameters: { endpointType: 'iot:Data-ATS' },
                physicalResourceId: PhysicalResourceId.of(`iot-data-ats-${this.region}`)
            },
            policy: AwsCustomResourcePolicy.fromStatements([new PolicyStatement({ actions: ['iot:DescribeEndpoint'], resources: ['*'] })]),
            installLatestAwsSdk: false
        }).getResponseField('endpointAddress');

        // Last connect or disconnect per device, so support can see whether a
        // clinic's desktop is online; a row that stops changing expires after
        // 30 days.
        this.devicePresence = new TableV2(this, 'DevicePresence', {
            partitionKey: { name: 'clientId', type: AttributeType.STRING },
            billing: Billing.onDemand(),
            timeToLiveAttribute: 'expiresAt',
            removalPolicy: RemovalPolicy.DESTROY
        });
        const presenceRole = new Role(this, 'PresenceRuleRole', { assumedBy: new ServicePrincipal('iot.amazonaws.com') });
        this.devicePresence.grant(presenceRole, 'dynamodb:PutItem');
        new CfnTopicRule(this, 'PresenceRule', {
            topicRulePayload: {
                sql: "SELECT clientId, eventType, timestamp, ipAddress, disconnectReason, floor(timestamp / 1000) + 2592000 AS expiresAt FROM '$aws/events/presence/+/+'",
                awsIotSqlVersion: '2016-03-23',
                ruleDisabled: false,
                actions: [{ dynamoDBv2: { putItem: { tableName: this.devicePresence.tableName }, roleArn: presenceRole.roleArn } }]
            }
        });

        // A burst of refused device logins alerts the budget contact.
        const alerts = new Topic(this, 'OpsAlerts', { topicName: `nalamdesk-${stage}-alerts` });
        alerts.addSubscription(new EmailSubscription(props.budgetEmail));
        const iotMetric = (metricName: string) => new Metric({
            namespace: 'AWS/IoT', metricName, dimensionsMap: { Protocol: 'MQTT' }, statistic: 'Sum', period: Duration.hours(1)
        });
        new Alarm(this, 'IotAuthFailures', {
            alarmName: `nalamdesk-${stage}-iot-auth-failures`,
            alarmDescription: 'Many refused IoT connections: a revoked desktop retrying, or someone probing.',
            metric: iotMetric('Connection.AuthNError'),
            threshold: 50,
            evaluationPeriods: 1,
            comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
            treatMissingData: TreatMissingData.NOT_BREACHING
        }).addAlarmAction(new SnsAction(alerts));

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
        publish('mailbox-table-name', this.mailbox.tableName);
        publish('mailbox-bucket-name', this.mailboxBucket.bucketName);
        publish('iot-data-endpoint', iotEndpoint);
        publish('iot-policy-name', iotPolicyName);
        publish('doorbell-topic-prefix', topicPrefix);
        publish('device-presence-table-name', this.devicePresence.tableName);
    }
}
