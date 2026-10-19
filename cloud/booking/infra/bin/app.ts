import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { BookingCodeStack, BookingStack } from '../lib/booking-stack.js';

// One environment only (the plan caps the booking API at one), in Mumbai so
// everything stays in India. Context, set by scripts/deploy.sh:
//   apiCodeKey, apiCodeVersion  the uploaded API zip (omit before the first upload)
//   siteDir                     built site, default ../web/dist
const app = new cdk.App();
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'ap-south-1' };
const here = path.dirname(fileURLToPath(import.meta.url));

const code = new BookingCodeStack(app, 'NalamDeskBookingCode', { env });

const key = app.node.tryGetContext('apiCodeKey');
const versionId = app.node.tryGetContext('apiCodeVersion');
new BookingStack(app, 'NalamDeskBooking', {
    env,
    codeBucketName: code.bucket.bucketName,
    apiCode: key && versionId ? { key, versionId } : undefined,
    siteDir: app.node.tryGetContext('siteDir') ?? path.resolve(here, '../../web/dist')
});

cdk.Tags.of(app).add('project', 'nalamdesk');
cdk.Tags.of(app).add('component', 'online-booking');
