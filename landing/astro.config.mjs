import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

import cloudflare from '@astrojs/cloudflare';

// Workers deployment via the Astro Cloudflare adapter (cf deploy).
// Static-first page served as Worker assets from ./dist (see wrangler.jsonc).
export default defineConfig({
  site: 'https://nalamdesk.com',

  vite: {
    plugins: [tailwindcss()],
  },

  // No sessions: otherwise the adapter adds a SESSION KV binding and the
  // deploy tries to create a namespace that already exists.
  session: false,

  adapter: cloudflare(),
});