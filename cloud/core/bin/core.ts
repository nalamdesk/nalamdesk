import { App, Tags } from 'aws-cdk-lib';
import { parseStage, stageDomain } from '../lib/contract.js';
import { CoreEdgeStack } from '../lib/edge-stack.js';
import { CoreStack } from '../lib/core-stack.js';

// cdk deploy --all -c zoneName=example.in -c budgetEmail=ops@example.in [-c stage=production] [-c hostedZoneId=Z123] [-c opsDomainPrefix=...]
const app = new App();
const stage = parseStage(app.node.tryGetContext('stage'));
const zoneName = app.node.tryGetContext('zoneName');
const budgetEmail = app.node.tryGetContext('budgetEmail');
if (!zoneName || !budgetEmail) {
    throw new Error('Pass -c zoneName=<domain> and -c budgetEmail=<address>.');
}
const account = process.env.CDK_DEFAULT_ACCOUNT;
const bridgeDomain = stageDomain(stage, 'abdm', zoneName);
const bookingDomain = stageDomain(stage, 'book', zoneName);

const edge = new CoreEdgeStack(app, `NalamdeskCoreEdge-${stage}`, {
    env: { account, region: 'us-east-1' },
    crossRegionReferences: true,
    zoneName,
    hostedZoneId: app.node.tryGetContext('hostedZoneId'),
    bridgeDomain,
    bookingDomain
});

new CoreStack(app, `NalamdeskCore-${stage}`, {
    env: { account, region: 'ap-south-1' },
    crossRegionReferences: true,
    stage,
    zone: edge.zone,
    bridgeDomain,
    bridgeCertificate: edge.bridgeCertificate,
    bookingDomain,
    bookingCertificate: edge.bookingCertificate,
    budgetEmail,
    opsDomainPrefix: app.node.tryGetContext('opsDomainPrefix')
});

Tags.of(app).add('project', 'nalamdesk');
Tags.of(app).add('stage', stage);
