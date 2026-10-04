import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

// Static output for Cloudflare Pages. No SSR adapter.
export default defineConfig({
  site: 'https://nalamdesk.com',
  vite: {
    plugins: [tailwindcss()],
  },
});
