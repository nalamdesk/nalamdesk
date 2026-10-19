import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { BookingStack } from '../lib/booking-stack.js';
import { bundleApi } from '../lib/bundle.js';
import { parseStage } from '../lib/contract.js';

// Deploy cloud/core first (it owns the zone, certificate and code bucket).
// Then, from scripts/deploy.sh or by hand after building the site:
//   cdk deploy -c zoneName=example.in [-c stage=production] [-c siteDir=../web/dist]
const app = new cdk.App();
const stage = parseStage(app.node.tryGetContext('stage'));
const zoneName = app.node.tryGetContext('zoneName');
if (!zoneName) throw new Error('Pass -c zoneName=<domain> (the same zone as cloud/core).');
const here = path.dirname(fileURLToPath(import.meta.url));

new BookingStack(app, `NalamdeskBooking-${stage}`, {
    // Mumbai, so everything stays in India.
    env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'ap-south-1' },
    stage,
    zoneName,
    codeDir: bundleApi(),
    siteDir: app.node.tryGetContext('siteDir') ?? path.resolve(here, '../../web/dist')
});

cdk.Tags.of(app).add('project', 'nalamdesk');
cdk.Tags.of(app).add('stage', stage);
cdk.Tags.of(app).add('component', 'online-booking');
