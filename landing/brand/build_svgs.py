"""Generate the NalamDesk brand SVGs into landing/public/brand/.

The mark is a vector redraw of the original raster logo (desktop/src/renderer/
assets/logo.png): a medical cross, a leaf, and a brain with circuit nodes.
Everything is drawn on a 512x512 grid. Gaps between shapes are real
knockouts (SVG masks), so the mark works on any background.

Usage (from landing/):  python3 brand/build_svgs.py
Requires: fonttools, brotli, uharfbuzz (only for the wordmark outline).
Then run:  node brand/render.mjs   to produce the PNG and ICO files.
"""
import os

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'public', 'brand')
PUBLIC = os.path.join(HERE, '..', 'public')
FONT = os.path.join(PUBLIC, 'fonts', 'jakarta-var-latin.woff2')

VARIANT = 'B'  # A detailed, B balanced, C minimal (see OPT below)

CROSS = ("M210 40h92a24 24 0 0 1 24 24v122h122a24 24 0 0 1 24 24v92a24 24 0 0 1-24 24H326v122"
         "a24 24 0 0 1-24 24h-92a24 24 0 0 1-24-24V326H64a24 24 0 0 1-24-24v-92a24 24 0 0 1 24-24h122V64"
         "a24 24 0 0 1 24-24z")
LEAF = "M248 352C214 236 282 62 472 40C484 206 418 318 248 352Z"
BRAIN = [(256, 232, 50), (216, 206, 28), (252, 184, 30), (292, 194, 28), (314, 232, 26),
         (302, 270, 28), (262, 286, 28), (222, 276, 28), (200, 240, 28)]
GAP = 10

OPT = {
    'A': dict(brain=True,
              ext_lines=["176,248 94,248", "182,222 148,222 134,210", "182,274 148,274 134,286",
                         "238,310 238,370 222,390", "276,312 276,402", "300,176 330,146",
                         "318,198 352,198 386,164", "326,226 380,226 404,202", "322,252 352,252 370,240"],
              ext_rings=[(82, 248, 12), (126, 203, 10), (126, 293, 10), (214, 400, 11), (276, 416, 12),
                         (338, 136, 11), (394, 154, 11), (412, 192, 11), (379, 234, 11)],
              int_lines=["230,200 240,212 240,236", "222,250 238,262", "218,226 228,226",
                         "272,196 280,206 280,226", "284,252 272,264 272,282", "296,232 284,240"],
              int_dots=[(226, 196), (216, 250), (212, 226), (268, 190), (290, 252), (300, 228), (232, 288)]),
    'B': dict(brain=True,
              ext_lines=["178,240 96,240", "262,312 262,398", "318,206 386,150", "324,244 392,226"],
              ext_rings=[(82, 240, 13), (262, 412, 13), (397, 141, 13), (405, 222, 13)],
              int_lines=[], int_dots=[]),
    'C': dict(brain=False,
              ext_lines=["262,330 300,250 360,170 430,82", "300,250 350,250", "330,210 330,150", "360,170 410,170"],
              ext_rings=[(362, 250, 12), (330, 138, 12), (422, 170, 12)],
              int_lines=[], int_dots=[]),
}

# Palettes: cross, leaf, brain gradient start, brain gradient end, brain circuit
LIGHT = ("#13508A", "#28A4A2", "#1E5FA6", "#2E8AD8", "#5FE0D2")
DARK = ("#4F93DD", "#3CC2B4", "#3D86D8", "#6FB5F0", "#B5FFF4")
BLACK = ("#0F172A",) * 5
WHITE = ("#FFFFFF",) * 5

INK = "#0F172A"       # wordmark on light
INK_DARK = "#F1F5F9"  # wordmark on dark
TILE_DARK = "#0E1626"


def _circles(fill, stroke=None, sw=0):
    s = f' stroke="{stroke}" stroke-width="{sw}"' if stroke else ''
    return ''.join(f'<circle cx="{x}" cy="{y}" r="{r}" fill="{fill}"{s}/>' for x, y, r in BRAIN)


def _traces(lines, rings, color, w):
    out = ''.join(f'<polyline points="{p}" fill="none" stroke="{color}" stroke-width="{w}" '
                  f'stroke-linecap="round" stroke-linejoin="round"/>' for p in lines)
    out += ''.join(f'<circle cx="{x}" cy="{y}" r="{r}" fill="none" stroke="{color}" stroke-width="{w}"/>'
                   for x, y, r in rings)
    return out


def mark(uid, pal, o=None):
    """The mark's SVG elements on the 512 grid. uid keeps ids unique when inlined."""
    o = o or OPT[VARIANT]
    navy, teal, b1, b2, cyan = pal
    m = 'maskUnits="userSpaceOnUse" x="0" y="0" width="512" height="512"'
    ext = _traces(o['ext_lines'], o['ext_rings'], '#000', 8)
    brain_cut = _circles('#000', '#000', GAP * 2) if o['brain'] else ''
    d = (f'<defs><linearGradient id="{uid}g" x1="0" y1="0" x2="1" y2="1">'
         f'<stop offset="0" stop-color="{b1}"/><stop offset="1" stop-color="{b2}"/></linearGradient>'
         f'<mask id="{uid}c" {m}><rect width="512" height="512" fill="#fff"/>'
         f'<path d="{LEAF}" fill="#000" stroke="#000" stroke-width="{GAP * 2}" stroke-linejoin="round"/>'
         f'{brain_cut}{ext}</mask>'
         f'<mask id="{uid}l" {m}><rect width="512" height="512" fill="#fff"/>{brain_cut}{ext}</mask>')
    if o['brain']:
        d += (f'<mask id="{uid}b" {m}><rect width="512" height="512" fill="#fff"/>'
              f'<line x1="256" y1="166" x2="256" y2="304" stroke="#000" stroke-width="7" '
              f'stroke-linecap="round"/></mask>')
    d += '</defs>'
    s = d + (f'<path d="{CROSS}" fill="{navy}" mask="url(#{uid}c)"/>'
             f'<path d="{LEAF}" fill="{teal}" mask="url(#{uid}l)"/>')
    if o['brain']:
        inner = _traces(o['int_lines'], [], cyan, 6)
        inner += ''.join(f'<circle cx="{x}" cy="{y}" r="6" fill="{cyan}"/>' for x, y in o['int_dots'])
        s += f'<g mask="url(#{uid}b)">{_circles(f"url(#{uid}g)")}{inner}</g>'
    return s


def svg(inner, vb="0 0 512 512", title="NalamDesk"):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb}" role="img" aria-label="{title}">'
            f'<title>{title}</title>{inner}</svg>\n')


def tile(uid, pal, bg, scale=0.72, radius=112, full_bleed=False):
    """Mark centred on a square background. full_bleed for iOS/maskable icons."""
    off = 256 * (1 - scale)
    r = 0 if full_bleed else radius
    return (f'<rect width="512" height="512" rx="{r}" fill="{bg}"/>'
            f'<g transform="translate({off:.2f} {off:.2f}) scale({scale})">{mark(uid, pal)}</g>')


def wordmark_path(text="NalamDesk", weight=700):
    import uharfbuzz as hb
    from fontTools.ttLib import TTFont
    from fontTools.varLib.instancer import instantiateVariableFont
    from fontTools.pens.svgPathPen import SVGPathPen
    from fontTools.pens.transformPen import TransformPen
    font = instantiateVariableFont(TTFont(FONT), {"wght": weight})
    import io
    font.flavor = None  # harfbuzz needs plain sfnt, not woff2
    buf = io.BytesIO()
    font.save(buf)
    data = buf.getvalue()
    hbfont = hb.Font(hb.Face(data))
    b = hb.Buffer()
    b.add_str(text)
    b.guess_segment_properties()
    hb.shape(hbfont, b, {"kern": True, "liga": True})
    gs = font.getGlyphSet()
    order = font.getGlyphOrder()
    pen = SVGPathPen(gs)
    x = 0
    for info, pos in zip(b.glyph_infos, b.glyph_positions):
        name = order[info.codepoint]
        gs[name].draw(TransformPen(pen, (1, 0, 0, -1, x + pos.x_offset, -pos.y_offset)))
        x += pos.x_advance
    return pen.getCommands(), x, font['OS/2'].sCapHeight


def lockup(uid, pal, ink, word):
    """Horizontal logo: mark + NalamDesk wordmark. Height 512 units."""
    d, adv, cap = word
    fs = 512 * 0.40 / cap  # font units -> grid units
    gap = 512 * 0.20
    tx = 512 + gap
    ty = 256 + (cap * fs) / 2  # baseline so caps are vertically centred
    width = tx + adv * fs + 8
    inner = (mark(uid, pal) +
             f'<path transform="translate({tx:.1f} {ty:.1f}) scale({fs:.5f})" d="{d}" fill="{ink}"/>')
    return svg(inner, vb=f"0 0 {width:.0f} 512", title="NalamDesk")


FAVICON_STYLE = ("<style>:root{--c:%s;--l:%s;--b1:%s;--b2:%s}"
                 "@media (prefers-color-scheme:dark){:root{--c:%s;--l:%s;--b1:%s;--b2:%s}}</style>"
                 % (LIGHT[:4] + DARK[:4]))


def favicon_svg():
    s = mark('f', ("FILLC", "FILLL", "STOP1", "STOP2", "CYAN"))
    s = (s.replace('fill="FILLC"', 'style="fill:var(--c)"').replace('fill="FILLL"', 'style="fill:var(--l)"')
          .replace('stop-color="STOP1"', 'style="stop-color:var(--b1)"')
          .replace('stop-color="STOP2"', 'style="stop-color:var(--b2)"').replace('CYAN', LIGHT[4]))
    return svg(FAVICON_STYLE + s)


def main():
    os.makedirs(OUT, exist_ok=True)
    w = lambda name, content: open(os.path.join(OUT, name), 'w').write(content)
    w('nalamdesk-mark.svg', svg(mark('m', LIGHT)))
    w('nalamdesk-mark-dark.svg', svg(mark('m', DARK)))
    w('nalamdesk-mark-black.svg', svg(mark('m', BLACK)))
    w('nalamdesk-mark-white.svg', svg(mark('m', WHITE)))
    w('nalamdesk-icon.svg', svg(tile('t', LIGHT, "#FFFFFF")))
    w('nalamdesk-icon-dark.svg', svg(tile('t', DARK, TILE_DARK)))
    w('nalamdesk-icon-square.svg', svg(tile('t', LIGHT, "#FFFFFF", scale=0.74, full_bleed=True)))
    w('nalamdesk-maskable.svg', svg(tile('t', LIGHT, "#FFFFFF", scale=0.60, full_bleed=True)))
    word = wordmark_path()
    w('nalamdesk-logo.svg', lockup('w', LIGHT, INK, word))
    w('nalamdesk-logo-dark.svg', lockup('w', DARK, INK_DARK, word))
    w('nalamdesk-logo-black.svg', lockup('w', BLACK, BLACK[0], word))
    w('nalamdesk-logo-white.svg', lockup('w', WHITE, "#FFFFFF", word))
    open(os.path.join(PUBLIC, 'favicon.svg'), 'w').write(favicon_svg())


if __name__ == '__main__':
    main()
