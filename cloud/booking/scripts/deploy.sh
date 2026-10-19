#!/usr/bin/env bash
# Deploys the online booking stack to ap-south-1 with the current AWS profile.
#   1. CDK: the versioned code bucket.
#   2. Bundle the API, zip it with a start script, upload it, note the version.
#   3. Build the site.
#   4. CDK: the booking stack, pointing the Web Function revision at that version.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
region=ap-south-1

(cd "$here/infra" && npm ci && npx cdk deploy NalamDeskBookingCode --require-approval never)
bucket=$(aws cloudformation describe-stacks --region "$region" --stack-name NalamDeskBookingCode \
  --query "Stacks[0].Outputs[?OutputKey=='CodeBucketName'].OutputValue" --output text)

(cd "$here/api" && npm ci && npm test && npm run bundle)
stage=$(mktemp -d)
cp "$here/api/bundle/server.mjs" "$stage/server.mjs"
printf '{\n  "type": "module",\n  "scripts": { "start": "node server.mjs" }\n}\n' > "$stage/package.json"
sha=$(cd "$stage" && cat server.mjs package.json | sha256sum | cut -c1-16)
key="booking-api/$sha.zip"
(cd "$stage" && zip -q -X api.zip server.mjs package.json)
version=$(aws s3api put-object --region "$region" --bucket "$bucket" --key "$key" --body "$stage/api.zip" \
  --query VersionId --output text)
rm -rf "$stage"

(cd "$here/web" && npm ci && npm test && npm run build)

(cd "$here/infra" && npx cdk deploy NalamDeskBooking --require-approval never \
  -c apiCodeKey="$key" -c apiCodeVersion="$version" -c siteDir="$here/web/dist")
