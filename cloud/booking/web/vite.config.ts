/// <reference types="vitest/config" />
import { createHash } from 'node:crypto';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/**
 * Adds Subresource Integrity to every script, module preload and stylesheet
 * that index.html loads, so a tampered asset in S3 or at the edge is refused
 * by the browser. Asset names are content-hashed and cached as immutable.
 */
function subresourceIntegrity(): Plugin {
    return {
        name: 'nalamdesk-sri',
        apply: 'build',
        enforce: 'post',
        generateBundle(_options, bundle) {
            const html = bundle['index.html'];
            if (!html || html.type !== 'asset') return;
            const integrityOf = (url: string) => {
                const file = bundle[url.replace(/^\//, '')];
                if (!file) throw new Error(`SRI: ${url} is not in the bundle.`);
                const source = file.type === 'chunk' ? file.code : file.source;
                return `sha384-${createHash('sha384').update(source).digest('base64')}`;
            };
            html.source = String(html.source).replace(
                /<(script|link)\b([^>]*?)\s(src|href)="([^"]+)"([^>]*)>/g,
                (tag, name: string, before: string, attr: string, url: string, after: string) => {
                    if (!url.startsWith('/assets/')) return tag;
                    if (name === 'link' && !/rel="(stylesheet|modulepreload)"/.test(tag)) return tag;
                    const crossorigin = /\bcrossorigin\b/.test(tag) ? '' : ' crossorigin';
                    return `<${name}${before} ${attr}="${url}" integrity="${integrityOf(url)}"${crossorigin}${after}>`;
                }
            );
        }
    };
}

export default defineConfig({
    plugins: [react(), tailwindcss(), subresourceIntegrity()],
    build: {
        target: 'es2022',
        sourcemap: false,
        assetsInlineLimit: 0
    },
    server: {
        // `npm run dev` in ../api serves an in-memory booking API here.
        proxy: { '/api': 'http://localhost:8787' }
    },
    test: {
        environment: 'happy-dom',
        include: ['test/**/*.spec.{ts,tsx}']
    }
});
