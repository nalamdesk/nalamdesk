# NalamDesk landing (`landing/`)

Public marketing homepage for **nalamdesk.com**. Astro 7 static build,
deployed to Cloudflare Pages. Persuade surface in the lightbox world; the
surface brief with the direction contract lives at
`.impeccable/surfaces/landing-index.md`.

## Commands

- `npm run dev` (local preview)
- `npm run build` (`dist/`, deploy this to Cloudflare Pages)
- `npm run preview` (serve `dist/`)

Node 22. No SSR adapter; output is static by default.

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

## Rules carried from the brief

Light theme locked, one accent (Trust Blue `#1868db`), captions below media,
real product truth only, no testimonials, customers, benchmarks, pricing, or
deployment claims. Film art lives in plain CSS in `index.astro`, never in
Tailwind arbitrary values. Mobile first: single column below `md`, fluid
`clamp()` hero type, `min-w-0` on every grid child.
