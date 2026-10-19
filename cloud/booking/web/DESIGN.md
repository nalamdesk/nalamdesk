---
name: NalamDesk Booking
description: Public clinic booking site — calm, legible, one clear action per screen.
colors:
  primary: "#1659c7"
  primary-deep: "#0f3f8f"
  primary-content: "#ffffff"
  accent: "#d98a1c"
  accent-wash: "#fbefd9"
  ground: "#eef2f7"
  surface: "#fcfdff"
  ink: "#1b2230"
  ink-soft: "#4a5263"
  muted: "#5b6170"
  line: "#d5dce6"
  field-border: "#a3adbd"
  placeholder: "#646b7a"
  success: "#2b6e47"
  error: "#a8261d"
  error-wash: "#fbeceb"
typography:
  display-lg:
    fontFamily: "'Newsreader', Georgia, serif"
    fontWeight: 500
    fontSize: "52px"
    lineHeight: 1.08
  display:
    fontFamily: "'Newsreader', Georgia, serif"
    fontWeight: 500
    fontSize: "40px"
    lineHeight: 1.08
  headline-lg:
    fontFamily: "'Newsreader', Georgia, serif"
    fontWeight: 600
    fontSize: "28px"
    lineHeight: 1.2
  headline:
    fontFamily: "'Newsreader', Georgia, serif"
    fontWeight: 600
    fontSize: "24px"
    lineHeight: 1.25
  title:
    fontFamily: "'Newsreader', Georgia, serif"
    fontWeight: 600
    fontSize: "22px"
    lineHeight: 1.3
  body:
    fontFamily: "'Atkinson Hyperlegible Next', system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "'Atkinson Hyperlegible Next', system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 600
rounded:
  control: "6px"
  panel: "10px"
  full: "9999px"
spacing:
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-content}"
    rounded: "{rounded.control}"
    padding: "10px 18px"
    minHeight: "44px"
  slot:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    minHeight: "44px"
  slot-selected:
    backgroundColor: "{colors.accent-wash}"
    borderColor: "{colors.accent}"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "10px 12px"
---

# Design System: NalamDesk Booking

> Scope: the public booking site in `cloud/booking/web`. The desktop console has its own
> `desktop/DESIGN.md`; the two share the trust-blue lineage, not the rest.

## Overview

**Creative North Star: "The clinic's front desk, on a phone"**

A patient, often on a mid-range phone and sometimes on behalf of a parent, should find the
clinic and send a request in under a minute. The page reads like a well-run reception: plain
words, one obvious next step, and no claims the clinic has not made. Product principles live in
`cloud/PRODUCT.md` (intake only, honest presence, no record leakage).

**Key characteristics**
- Cool, brand-tinted ground (`#eef2f7`) with near-white surfaces; no gradients, no hero imagery.
- A warm serif (Newsreader) for headings, Atkinson Hyperlegible Next for everything else, chosen
  for low-vision legibility and clear digits in phone numbers and references.
- Trust blue for the single primary action; marigold only to mark the patient's own selection.
- Directory as divided rows, not a grid of cards.

## Colors

- **Primary** `#1659c7` (hover `#0f3f8f`): the one primary button per view, links, focus rings.
- **Accent** `#d98a1c` on `#fbefd9`: the selected time or call-back choice, and the "waiting" status. Never text colour.
- **Ink** `#1b2230` body text; **Ink soft** `#4a5263` secondary text; **Muted** `#5b6170` small print.
- **Success** `#2b6e47`: "Open on NalamDesk now" and Accepted. **Error** `#a8261d` on `#fbeceb`: alerts and Declined.
- All text pairs meet WCAG AA on both ground and surface; placeholders use `#646b7a` (4.5:1 on surface); field borders `#a3adbd` (3:1, non-text contrast).

## Typography

- Display (page h1): Newsreader 500, 40px mobile / 52px desktop, tight leading, balanced wrap.
- Headline-lg ("Request sent", the reference): 28px. Headline (dialog title): 24px. Title (clinic names): 22px.
- Body: Atkinson Hyperlegible Next 400, 16px (18px for lead paragraphs), 1.55 line height.
- Labels and buttons: Atkinson 600, 15–16px. References use tabular figures with 0.12em tracking.
- Prose is capped near 52–54ch so lines stay under about 75 characters.
- Fonts are self-hosted (Latin subset, two weights each) so the CSP stays `font-src 'self'`.

## Layout

Single column, `max-w-3xl`, 20px side padding on phones. Header, intro + search, clinic rows,
privacy footer. The booking dialog is a full-screen sheet below 640px and a 512px panel above.
Every tap target is at least 44px.

## Components

- **Clinic row**: name (serif), "Specialty · City", presence line with a dot and words (colour is never the only signal), and "Request a time" (its accessible name includes the clinic).
- **Booking dialog**: native `<dialog>` with `showModal()`, so focus is trapped and Escape closes it. Steps: choose a time → details → sent. Day buttons and time buttons use `aria-pressed`.
- **Consent**: an explicit checkbox naming the clinic, stating that details are locked on the device and deleted after 48 hours if uncollected (DPDP Act).
- **Status card**: reference, a status chip with words (Waiting for the clinic / Accepted / Declined) and one sentence on what happens next.

## Do's and Don'ts

- **Do** keep one primary button per view.
- **Do** say what the clinic will do next ("will call you to confirm"); never imply instant booking.
- **Do** run `npm run lint:design` (Impeccable detector) on the source, and on the dev server for the full rule set: `IMPECCABLE_BROWSER=<chrome> npx impeccable detect http://localhost:5173/`.
- **Don't** add ratings, "top-rated" claims, testimonials or prices; none of that data exists.
- **Don't** use gradients, glassmorphism, cream backgrounds or purple accents.
- **Don't** load anything from a third-party origin; the CSP forbids it.
