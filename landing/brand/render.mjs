// Render the brand SVGs (from build_svgs.py) to PNG and ICO.
// Usage (from landing/): NODE_PATH=$(npm root -g) node brand/render.mjs
// Needs Playwright with Chromium available (not a landing dependency).
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// createRequire so a globally installed Playwright works via NODE_PATH.
const { chromium } = createRequire(import.meta.url)('playwright');
const here = dirname(fileURLToPath(import.meta.url));
const pub = join(here, '..', 'public');
const brand = join(pub, 'brand');

// [source svg, output png, width] ; height follows the SVG's aspect ratio.
const jobs = [
  ...[16, 32, 48, 64, 128, 256, 512, 1024].map((s) => ['nalamdesk-mark.svg', `nalamdesk-mark-${s}.png`, s]),
  ...[256, 512, 1024].map((s) => ['nalamdesk-mark-dark.svg', `nalamdesk-mark-dark-${s}.png`, s]),
  ...[512].map((s) => ['nalamdesk-mark-black.svg', `nalamdesk-mark-black-${s}.png`, s]),
  ...[512].map((s) => ['nalamdesk-mark-white.svg', `nalamdesk-mark-white-${s}.png`, s]),
  ...[192, 512, 1024].map((s) => ['nalamdesk-icon.svg', `nalamdesk-icon-${s}.png`, s]),
  ...[512, 1024].map((s) => ['nalamdesk-icon-dark.svg', `nalamdesk-icon-dark-${s}.png`, s]),
  ...[180, 512, 1024].map((s) => ['nalamdesk-icon-square.svg', `nalamdesk-icon-square-${s}.png`, s]),
  ...[192, 512].map((s) => ['nalamdesk-maskable.svg', `nalamdesk-maskable-${s}.png`, s]),
  ['nalamdesk-logo.svg', 'nalamdesk-logo-1200.png', 1200],
  ['nalamdesk-logo-dark.svg', 'nalamdesk-logo-dark-1200.png', 1200],
  ['nalamdesk-logo.svg', 'nalamdesk-logo-600.png', 600],
  ['nalamdesk-logo-dark.svg', 'nalamdesk-logo-dark-600.png', 600],
];

const browser = await chromium.launch();
const page = await browser.newPage();
async function render(svgFile, width) {
  const svg = readFileSync(join(brand, svgFile), 'utf8');
  const [, , vw, vh] = svg.match(/viewBox="([^"]+)"/)[1].split(' ').map(Number);
  const height = Math.round((width * vh) / vw);
  await page.setViewportSize({ width, height });
  const src = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
  await page.setContent(
    `<html><body style="margin:0;background:transparent"><img src="${src}" width="${width}" height="${height}" style="display:block"></body></html>`,
  );
  await page.waitForFunction(() => document.images[0].complete);
  return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width, height } });
}

const out = {};
for (const [src, name, w] of jobs) {
  out[name] = await render(src, w);
  writeFileSync(join(brand, name), out[name]);
}

// Root-level icons browsers and platforms look for by convention.
writeFileSync(join(pub, 'apple-touch-icon.png'), out['nalamdesk-icon-square-180.png']);
writeFileSync(join(pub, 'icon-192.png'), out['nalamdesk-icon-192.png']);
writeFileSync(join(pub, 'icon-512.png'), out['nalamdesk-icon-512.png']);
writeFileSync(join(pub, 'logo-192.png'), out['nalamdesk-icon-192.png']); // legacy path, kept working

// favicon.ico with PNG-compressed 16, 32 and 48 px entries.
const icoSizes = [16, 32, 48];
const pngs = await Promise.all(icoSizes.map((s) => render('nalamdesk-mark.svg', s)));
const header = Buffer.alloc(6 + 16 * pngs.length);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(pngs.length, 4);
let offset = header.length;
pngs.forEach((png, i) => {
  const e = 6 + 16 * i;
  header.writeUInt8(icoSizes[i], e);
  header.writeUInt8(icoSizes[i], e + 1);
  header.writeUInt16LE(1, e + 4);
  header.writeUInt16LE(32, e + 6);
  header.writeUInt32LE(png.length, e + 8);
  header.writeUInt32LE(offset, e + 12);
  offset += png.length;
});
writeFileSync(join(pub, 'favicon.ico'), Buffer.concat([header, ...pngs]));

await browser.close();
console.log(`rendered ${jobs.length} PNGs, favicon.ico, apple-touch-icon.png, icon-192/512.png`);
