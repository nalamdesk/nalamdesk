import { App, Tags } from 'aws-cdk-lib';
import { bundleRelay } from './bundle.js';
import { parseStage } from './contract.js';
import { RelayStack } from './relay-stack.js';

// Deploy cloud/core first. Then:
// cdk deploy -c zoneName=example.in [-c stage=production] [-c gatewayIssuer=...]
const app = new App();
const stage = parseStage(app.node.tryGetContext('stage'));
const zoneName = app.node.tryGetContext('zoneName');
if (!zoneName) throw new Error('Pass -c zoneName=<domain> (the same zone as cloud/core).');

new RelayStack(app, `NalamdeskRelay-${stage}`, {
    env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'ap-south-1' },
    stage,
    zoneName,
    codeDir: bundleRelay(),
    gatewayIssuer: app.node.tryGetContext('gatewayIssuer')
});

Tags.of(app).add('project', 'nalamdesk');
Tags.of(app).add('stage', stage);
