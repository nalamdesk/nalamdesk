# NalamDesk brand assets

Vector redraw of the original raster logo (`desktop/src/renderer/assets/logo.png`):
the medical cross, the leaf, and the brain with circuit nodes. Sources live here;
the generated files are committed under `public/brand/` and served from
`https://nalamdesk.com/brand/`.

## Public URLs

| Use | URL |
| --- | --- |
| Logo for partner portals (ABDM sandbox etc.) | https://nalamdesk.com/brand/nalamdesk-icon-512.png |
| Square logo on white, no transparency | https://nalamdesk.com/brand/nalamdesk-icon-square-512.png |
| Mark, transparent SVG | https://nalamdesk.com/brand/nalamdesk-mark.svg |
| Horizontal logo with wordmark | https://nalamdesk.com/brand/nalamdesk-logo.svg (PNG: `nalamdesk-logo-1200.png`) |
| Favicon | https://nalamdesk.com/favicon.ico, https://nalamdesk.com/favicon.svg |

## Files in `public/brand/`

- `nalamdesk-mark*.svg|png`: the mark alone, transparent. `-dark` for dark
  backgrounds, `-black` / `-white` single colour. PNG at 16 to 1024 px.
- `nalamdesk-icon*.svg|png`: mark on a rounded tile (app icon). `-dark` tile,
  `-square` full-bleed white (iOS, portals that need no transparency).
- `nalamdesk-maskable*.svg|png`: full-bleed with the mark inside the 80% safe zone
  (PWA / Android adaptive icons).
- `nalamdesk-logo*.svg|png`: mark plus "NalamDesk" wordmark (Plus Jakarta Sans
  Bold, outlined to paths so no font is needed). `-dark`, `-black`, `-white`.

Root files: `favicon.ico` (16/32/48), `favicon.svg` (follows light/dark),
`apple-touch-icon.png` (180), `icon-192.png`, `icon-512.png`,
`site.webmanifest`. `logo-192.png` is kept as an alias of the 192 px icon.

## Colours

| Token | Light | Dark |
| --- | --- | --- |
| Cross | `#13508A` | `#4F93DD` |
| Leaf | `#28A4A2` | `#3CC2B4` |
| Brain gradient | `#1E5FA6` to `#2E8AD8` | `#3D86D8` to `#6FB5F0` |
| Wordmark | `#0F172A` | `#F1F5F9` |

## Regenerating

From `landing/`:

```sh
pip install fonttools brotli uharfbuzz
python3 brand/build_svgs.py
NODE_PATH=$(npm root -g) node brand/render.mjs   # needs Playwright + Chromium
```

`VARIANT` at the top of `build_svgs.py` picks the design (A detailed, B balanced,
C minimal).
