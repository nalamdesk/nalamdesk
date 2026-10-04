# NalamDesk landing (`landing/`)

Public marketing homepage for **nalamdesk.com**. Astro 7 served as
Cloudflare Workers Static Assets (worker `nalamdesk-landing`, assets
from `./dist`, see `wrangler.jsonc`). Persuade surface in the lightbox
world; the surface brief with the direction contract lives at
`.impeccable/surfaces/landing-index.md`.

## Commands

- `npm run dev` (local preview)
- `npm run build` (Astro build to `dist/`)
- `npm run preview` (serve `dist/`)
- `npm run deploy:dry-run` (validate worker config, no credentials)
- `npm run deploy` (build output live via Wrangler, needs Cloudflare auth)

Node 22. The `@astrojs/cloudflare` adapter emits the worker entry plus
static assets; `wrangler.jsonc` is its generated config, committed.
Fonts are self-hosted variable woff2 in `public/fonts/` (OFL, via
fontsource); no third-party requests on the page.

## Scope

Desktop only. No cloud features, no placeholders: every section renders
finished copy and demonstration content drawn from the shipped desktop
workflows (queue and triage, consult guardrails, vitals, print, receipts and
day close, vault, backups, roles).

## Landing vs docs split

Landing carries outcomes and checkable proof. Step-by-step how-tos live in the
Docusaurus site (`cloud/documentation`, deployed at
https://sankara-sabapathy.github.io/nalamdesk/), which the header Docs link
points at. The docs navbar links back to https://nalamdesk.com.

## Deploy pipeline

`.github/workflows/deploy-landing.yml` builds on every PR with a
credential-free `wrangler deploy --dry-run`, and deploys on pushes to
`master`. Required repo secrets: `CLOUDFLARE_API_TOKEN` (recommend the
“Edit Cloudflare Workers” template, covering Workers Scripts plus the
KV/Images rights behind the adapter's SESSION/IMAGES bindings) and
`CLOUDFLARE_ACCOUNT_ID`.

Why Wrangler and not `cf deploy`: `cf` (beta) cannot consume the Astro
adapter's build output yet (it demands `.cloudflare/output/v0/`),
while `wrangler deploy` validates cleanly. `cf` stays available for
account, DNS, and domain commands. Re-evaluate `cf deploy` when `cf`
leaves beta.

Custom domain (declared in `wrangler.jsonc` as a `custom_domain` route
and applied by every deploy): `nalamdesk.com` must live in the same
Cloudflare account (it does). First deploy attaches it and provisions
the certificate; the worker serves `<name>.workers.dev` until then.

## Rules carried from the brief

Light theme locked, one accent (Trust Blue `#1868db`), captions below media,
real product truth only, no testimonials, customers, benchmarks, pricing, or
deployment claims. Film art lives in plain CSS in `index.astro`, never in
Tailwind arbitrary values. Mobile first: single column below `md`, fluid
`clamp()` hero type, `min-w-0` on every grid child.
