import { serve } from '@hono/node-server';
import { adaptersFromEnv, buildServerApp, listenAddress } from './bootstrap.js';

// Entry point for the Web Function revision (bundled to index.js). The
// mailbox and doorbell adapters arrive with #155; until then the relay
// serves only a 503 holding page.
const { app, missing } = buildServerApp(process.env, adaptersFromEnv(process.env));
const { hostname, port } = listenAddress(process.env);

serve({ fetch: app.fetch, hostname, port }, () => {
    process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), route: 'startup', ready: missing.length === 0, missing })}\n`);
});
