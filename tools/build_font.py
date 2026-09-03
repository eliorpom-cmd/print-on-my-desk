#!/usr/bin/env python3
"""Turns a TTF into a fixed-pitch bitmap atlas the Worker can blit.

Run on the Mac, never on the Pico and never in the Worker. The output is a JS
module committed to the repo, so a Worker cold start pays for parsing it once
per isolate rather than rasterising anything per request. Constraint: stay
inside the free tier's CPU budget, which rules out rendering outlines at
request time.

Why an atlas and not a font file: the printer takes 384 one-bit pixels per
line. Somebody has to decide, for every glyph, which pixels are on. Doing that
once here, offline, with a real rasteriser and a threshold we can inspect,
beats approximating it in a Worker.

    python tools/build_font.py                       # defaults, 22 px
    python tools/build_font.py --size 20 --preview   # try another size
    python tools/build_font.py --font path/to.ttf

Output:
    worker/src/font-atlas.js    imported by the Worker
    web/font-atlas.json         same data, for the browser preview
"""

import argparse
import json
import subprocess
import sys
import unicodedata
from pathlib import Path

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    sys.exit("Pillow required:  uv pip install --python .venv/bin/python Pillow")

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_FONT = ROOT / "tools" / "fonts" / "GoogleSansCode-Regular.ttf"
DEFAULT_BOLD = ROOT / "tools" / "fonts" / "GoogleSansCode-Bold.ttf"

# Three faces to choose between, and why only three.
#
# The atlas is FIXED PITCH: every glyph gets the same advance, and the line
# length is 384 pixels divided by that advance. A proportional font can be
# forced through this and comes out looking like a ransom note, so the choice
# is between monospaced faces or nothing.
#
# All three are under the SIL Open Font License, which is what makes it honest
# to fetch and rasterise them. They are fetched rather than committed: shipping
# a font means shipping its licence text alongside, and a repository that
# quietly carries four fonts is a repository nobody has checked the paperwork
# on.
#
#   code        Google Sans Code. The default. Round, even, modern.
#   terminal    JetBrains Mono. Taller x-height, reads well small and dense.
#   typewriter  Courier Prime. What a receipt printer looks like in anybody's
#               head, and the only one of the three that looks like paper.
PRESETS = {
    "code": {
        "file": "GoogleSansCode-Regular.ttf",
        "url": "https://github.com/google/fonts/raw/main/ofl/googlesanscode/GoogleSansCode%5Bwght%5D.ttf",
        # 20, not 22, and the difference is a whole column of text.
        #
        # The atlas actually committed in worker/src/font-atlas.js was built at
        # 20 px, but this preset said 22 - so `--preset code`, the command the
        # documentation gives, did not reproduce what was shipped. It rebuilt
        # the font one pitch wider (12 px to 13), which is 30 characters per
        # line on the 58 mm printer instead of 32, and dropped the pinned
        # renderings in worker/test/profiles.test.mjs on the floor. Running the
        # documented command should never be how you find that out.
        "size": 20,
    },
    "terminal": {
        "file": "JetBrainsMono-Regular.ttf",
        "url": "https://github.com/JetBrains/JetBrainsMono/raw/master/fonts/ttf/JetBrainsMono-Regular.ttf",
        # 28 since 3 September, for the same reason the `code` note above
        # exists: this is the size the open-source edition actually ships, so
        # it has to be the size the documented command produces. At 22 its
        # letters were 3.4 mm tall on the 58 mm printer, which is legible and
        # reads as an afterthought - the first person to print with it said so.
        # 28 is 4.4 mm and 21 characters a line, which is where the wrap stops
        # cutting ordinary words.
        "size": 28,
    },
    "typewriter": {
        "file": "CourierPrime-Regular.ttf",
        "url": "https://github.com/quoteunquoteapps/CourierPrime/raw/master/fonts/ttf/CourierPrime-Regular.ttf",
        "size": 24,
    },
}


def font_for(preset):
    """The file for a preset, downloaded the first time it is asked for."""
    spec = PRESETS[preset]
    path = ROOT / "tools" / "fonts" / spec["file"]
    if path.exists():
        return path, spec["size"]

    path.parent.mkdir(parents=True, exist_ok=True)
    print("fetching %s ..." % spec["file"])

    # Two ways, because the first one fails on a lot of Macs.
    #
    # A Homebrew or python.org interpreter often has no certificate bundle
    # wired up, and urllib then dies on CERTIFICATE_VERIFY_FAILED for a URL
    # that any browser opens. curl uses the system trust store and is on every
    # machine this runs on, so it is the fallback rather than the instruction.
    problems = []
    try:
        import urllib.request

        urllib.request.urlretrieve(spec["url"], path)
        return path, spec["size"]
    except Exception as err:  # noqa: BLE001 - the message is the whole point
        problems.append("python: %s" % err)

    try:
        import subprocess

        subprocess.run(
            ["curl", "-fsSL", "-o", str(path), spec["url"]], check=True
        )
        return path, spec["size"]
    except Exception as err:  # noqa: BLE001
        problems.append("curl: %s" % err)

    if path.exists():
        path.unlink()
    sys.exit(
        "could not download %s.\n  %s\n\n"
        "Download it yourself from\n  %s\nand save it as\n  %s\n"
        "then run this again."
        % (spec["file"], "\n  ".join(problems), spec["url"], path)
    )

WIDTH_PIXELS = 384

# Latin-1 printable. The brief calls full coverage mandatory, French accents
# above all, so this is not a "common characters" shortlist.
CODEPOINTS = list(range(0x20, 0x7F)) + list(range(0xA0, 0x100))
# Typography people actually paste from a phone keyboard. Without these, a
# message written with smart quotes comes out as a row of question marks.
EXTRAS = [
    0x152, 0x153,   # OE oe
    0x2018, 0x2019, # ' '
    0x201C, 0x201D, # " "
    0x2013, 0x2014, # en dash, em dash
    0x2026,         # ellipsis
    0x20AC,         # euro
]
# Invisible, and a bitmap of it would be a lie.
SKIP = {0xAD}


def render_glyph(font, ch, cell_width, height, baseline, threshold):
    """Rasterises one character into a list of row bitmasks, bit 0 = leftmost.

    cell_width can exceed the advance: a few glyphs (%, oe, ae) are drawn
    slightly wider than the pitch they occupy, which is ordinary typography.
    Since the blitter ORs pixels and steps by the advance, letting the bitmap
    be wider makes neighbours overlap by a pixel instead of losing one.
    """
    pad = cell_width
    img = Image.new("L", (cell_width + 2 * pad, height + 2 * pad), 255)
    draw = ImageDraw.Draw(img)
    draw.text((pad, pad + baseline), ch, font=font, fill=0, anchor="ls")
    pixels = img.load()

    rows = []
    for y in range(height):
        mask = 0
        for x in range(cell_width):
            if pixels[pad + x, pad + y] < threshold:
                mask |= 1 << x
        rows.append(mask)

    # Anything still inked outside the cell would be clipped at blit time.
    overhang = False
    for y in range(img.height):
        for x in range(img.width):
            if pixels[x, y] < threshold:
                if not (pad <= x < pad + cell_width and pad <= y < pad + height):
                    overhang = True
                    break
        if overhang:
            break
    return rows, overhang


def measure(font, codepoints, threshold):
    """Finds the real ink bounds of every glyph, relative to the baseline.

    The font's nominal ascent does NOT cover accented capitals: rendering into
    an ascent-tall cell clips the accent off O-circumflex, U-grave and friends,
    which in French is not a rare edge case. So the cell is sized from what the
    rasteriser actually draws, not from what the font metrics claim.
    """
    ascent, descent = font.getmetrics()
    pad = 3 * max(ascent, 1)
    top, bottom, right = 0, 0, 0
    for code in codepoints:
        ch = chr(code)
        if not ch.strip():
            continue
        img = Image.new("L", (pad * 2, pad * 2), 255)
        ImageDraw.Draw(img).text((pad, pad), ch, font=font, fill=0, anchor="ls")
        box = img.point(lambda v: 255 if v < threshold else 0, mode="1").getbbox()
        if box is None:
            continue
        x0, y0, x1, y1 = box
        top = max(top, pad - y0)        # above the baseline
        bottom = max(bottom, y1 - pad)  # below it
        right = max(right, x1 - pad)    # past the pen start
    return top, bottom, right


def build(font_path, size, threshold):
    font = ImageFont.truetype(str(font_path), size)

    advances = {round(font.getlength(chr(c))) for c in CODEPOINTS if chr(c).strip()}
    if len(advances) != 1:
        sys.exit(
            "font is not fixed pitch: advances %s. The brief asks for fixed "
            "pitch to keep the blitter simple." % sorted(advances)
        )
    advance = advances.pop()

    wanted = [c for c in CODEPOINTS + EXTRAS if c not in SKIP]
    top, bottom, overshoot = measure(font, wanted, threshold)
    baseline = top
    height = top + bottom
    # The cell holds the widest ink; the pen still steps by the advance.
    cell_width = max(advance, overshoot)

    glyphs = {}
    overhangs = []
    for code in CODEPOINTS + EXTRAS:
        if code in SKIP:
            continue
        ch = chr(code)
        rows, overhang = render_glyph(font, ch, cell_width, height, baseline, threshold)
        # Trim trailing all-zero rows: descenders are rare and the blank rows
        # cost bytes in every glyph that lacks them.
        while rows and rows[-1] == 0:
            rows.pop()
        glyphs[code] = rows
        if overhang:
            overhangs.append((code, ch))

    return {
        "name": font_path.stem,
        "size": size,
        "advance": advance,
        "cellWidth": cell_width,
        "height": height,
        "baseline": baseline,
        "threshold": threshold,
        "columns": WIDTH_PIXELS // advance,
        "glyphs": glyphs,
    }, overhangs


def fold_table():
    """Characters we cannot draw, mapped to ones we can.

    Much smaller than the 5x7 font's table, because this atlas actually has the
    accents. What is left is the long tail: anything outside Latin-1 that a
    phone keyboard might produce.
    """
    table = {}
    for code in list(range(0x100, 0x180)) + [0x2122, 0xFB01, 0xFB02]:
        ch = chr(code)
        # NFKD, not NFD: it decomposes ligatures and compatibility forms too,
        # which is what a phone keyboard occasionally emits.
        decomposed = unicodedata.normalize("NFKD", ch)
        stripped = "".join(c for c in decomposed if not unicodedata.combining(c))
        if stripped and stripped != ch and all(ord(c) < 0x100 for c in stripped):
            table[ch] = stripped
    table["™"] = "(TM)"
    return table


def preview(atlas, text):
    """ASCII rendering, so a glyph can be proofread before it costs paper."""
    lines = []
    rows = [0] * atlas["height"]
    for ch in text:
        glyph = atlas["glyphs"].get(ord(ch))
        if glyph is None:
            continue
        for y in range(atlas["height"]):
            bits = glyph[y] if y < len(glyph) else 0
            rows[y] |= bits << (len(lines) * 0)
    out = []
    x_offset = 0
    canvas = [[" "] * (atlas["advance"] * len(text) + atlas["cellWidth"])
              for _ in range(atlas["height"])]
    for ch in text:
        glyph = atlas["glyphs"].get(ord(ch), [])
        for y in range(atlas["height"]):
            bits = glyph[y] if y < len(glyph) else 0
            for x in range(atlas["cellWidth"]):
                if bits & (1 << x):
                    canvas[y][x_offset + x] = "#"
        x_offset += atlas["advance"]
    return "\n".join("".join(row).rstrip() for row in canvas)


def main():
    parser = argparse.ArgumentParser(
        description="Build the bitmap font atlas the printer draws with.",
        epilog="Presets: " + ", ".join(PRESETS),
    )
    parser.add_argument("--preset", choices=sorted(PRESETS),
                        help="one of the three bundled faces; downloads it if missing")
    parser.add_argument("--font", type=Path, default=None,
                        help="any monospaced TTF of your own")
    parser.add_argument("--size", type=int, default=None)
    parser.add_argument("--threshold", type=int, default=128,
                        help="grey level below which a pixel is inked")
    parser.add_argument("--preview", action="store_true")
    args = parser.parse_args()

    # --preset picks a face AND the size it was tuned at; --font and --size
    # override either of those. Neither given is the default face.
    size = args.size
    if args.preset:
        font, preset_size = font_for(args.preset)
        size = size or preset_size
    else:
        font = args.font or DEFAULT_FONT
    size = size or 22

    if not font.exists():
        sys.exit(
            "font not found: %s\n"
            "Try --preset code, --preset terminal or --preset typewriter, "
            "which fetch one for you." % font
        )

    atlas, overhangs = build(font, size, args.threshold)
    atlas["fold"] = fold_table()

    print("%s %dpx" % (atlas["name"], atlas["size"]))
    print("  advance  : %d px  ->  %d characters per line"
          % (atlas["advance"], atlas["columns"]))
    if atlas["cellWidth"] != atlas["advance"]:
        print("  cell     : %d px, so %d px of deliberate overhang past the advance"
              % (atlas["cellWidth"], atlas["cellWidth"] - atlas["advance"]))
    print("  height   : %d px (baseline %d)" % (atlas["height"], atlas["baseline"]))
    print("  glyphs   : %d" % len(atlas["glyphs"]))
    if overhangs:
        print("  WARNING: %d glyph(s) overflow the cell and will be clipped:"
              % len(overhangs))
        print("    " + " ".join("%r" % ch for _, ch in overhangs[:20]))
    else:
        print("  no glyph overflows its cell")

    empty = [c for c, rows in atlas["glyphs"].items()
             if c != 0x20 and c != 0xA0 and not any(rows)]
    if empty:
        print("  WARNING: empty glyphs: "
              + " ".join("U+%04X %r" % (c, chr(c)) for c in empty))

    # Serialise glyph rows as compact strings rather than JSON arrays of ints:
    # roughly half the bytes, and the Worker splits them once per isolate.
    compact = {str(c): ",".join(str(v) for v in rows)
               for c, rows in sorted(atlas["glyphs"].items())}
    payload = dict(atlas)
    payload["glyphs"] = compact

    js_path = ROOT / "worker" / "src" / "font-atlas.js"
    js_path.write_text(
        "// GENERATED by tools/build_font.py - do not edit by hand.\n"
        "//\n"
        "// %s at %d px, threshold %d. Fixed pitch %d px, %d columns on 384.\n"
        "// Latin-1 plus the punctuation a phone keyboard produces.\n"
        "// Font: %s, SIL Open Font License.\n"
        "export default %s;\n"
        % (atlas["name"], atlas["size"], atlas["threshold"], atlas["advance"],
           atlas["columns"], atlas["name"], json.dumps(payload, ensure_ascii=False)),
        encoding="utf-8",
    )
    json_path = ROOT / "web" / "font-atlas.json"
    json_path.parent.mkdir(exist_ok=True)
    json_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")

    print("  wrote    : %s (%.1f kB)" % (js_path.relative_to(ROOT), js_path.stat().st_size / 1024))
    print("             %s (%.1f kB)" % (json_path.relative_to(ROOT), json_path.stat().st_size / 1024))

    # And then the copy the BROWSER reads, which is neither of the two above.
    #
    # This step used to be the reader's job and nothing said so. The page
    # imports web/lib/font-atlas.js, made by tools/sync_web.mjs from the
    # worker/src copy - so rebuilding the font and deploying, which is exactly
    # what docs/05 told you to do, left the site previewing the OLD font while
    # the Worker printed the new one. The test suite catches it, but only if
    # you run the tests, and nothing told you to.
    #
    # The two must agree or the preview is a lie, so the script that breaks
    # them is the script that puts them back.
    sync = ROOT / "tools" / "sync_web.mjs"
    if sync.exists():
        try:
            subprocess.run(["node", str(sync)], cwd=ROOT, check=True,
                           stdout=subprocess.DEVNULL)
            print("             web/lib/font-atlas.js (via tools/sync_web.mjs)")
        except (OSError, subprocess.CalledProcessError) as err:
            print()
            print("  WARNING: the browser copy was not regenerated (%s)." % err)
            print("             The preview would still show the old font.")
            print("             Lance :  node tools/sync_web.mjs")

    if args.preview:
        print()
        print(preview(atlas, "Ca marche ! éàçÔ"))


if __name__ == "__main__":
    main()
