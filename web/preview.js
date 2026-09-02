// The live preview: your words, drawn with the printer's own atlas.
//
// WHY THIS FILE EXISTS AT ALL
//
// The page could have shown what you type in a web font and rendered the real
// ticket only after you pressed the button. That is one more typeface to pick,
// and it is a typeface that LIES: it wraps at a different column, it has
// characters the print head does not, and the first time somebody's careful
// layout comes out mangled they have no way of knowing why.
//
// So there is no second typeface. The textarea on top of this canvas is
// transparent, and the only rendering of anybody's words on this page is the
// one the print head would lay down: same atlas, same blitter, same 384 dots
// across, same one bit deep. What you see is the ticket.
//
// It follows that changing the ticket font changes the page, which is the
// point. `python tools/build_font.py --preset typewriter` then
// `node tools/sync_web.mjs`, and this file needs no edit: it never names a
// font, a size or a column count, it asks the atlas.
//
// app.js owns the form, the submit and the printing animation. This file only
// draws, and the two never touch the same element.

import { renderTicket, charsPerLine } from "./lib/render.js";
import { CURRENT_PROFILE, profileFor } from "./lib/profiles.js";

const canvas = document.getElementById("preview");
const input = document.getElementById("text");
const cols = document.getElementById("gauge-cols");
const mm = document.getElementById("gauge-mm");
if (canvas && input) {
  const ctx = canvas.getContext("2d");
  // CURRENT_PROFILE is the KEY ("trp100"), not the profile. Passing the
  // string straight through gives a profile with no dotsPerMm and every
  // measurement on the page reads NaN.
  const profile = profileFor(CURRENT_PROFILE);
  const COLUMNS = charsPerLine(profile);

  // Shown on an empty sheet. Not a label sitting over the paper in some other
  // font - it is drawn in the dots too, faintly, so that the first thing
  // anybody sees is already the truth about what this machine does.
  const EMPTY = "Type here. These are the printer's own dots, not a font that looks like them.";

  /** Paints a rendered canvas at `ink` on `stock`, one bit deep. */
  function paint(rendered, ink, stock) {
    const width = rendered.widthPixels;
    const height = Math.max(rendered.height, 1);
    canvas.width = width;
    canvas.height = height;
    // The sheet keeps the paper's own proportions whatever the font's line
    // height turns out to be; CSS gives it the width.
    canvas.style.aspectRatio = `${width} / ${height}`;
    const image = ctx.createImageData(width, height);
    const data = image.data;
    for (let y = 0; y < height; y++) {
      const row = rendered.rows[y];
      for (let x = 0; x < width; x++) {
        const on = row && row[x >> 3] & (1 << (x & 7));
        const [r, g, b] = on ? ink : stock;
        const i = (y * width + x) * 4;
        data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
      }
    }
    ctx.putImageData(image, 0, 0);
  }

  const STOCK = [244, 243, 238];   // --stock
  const INK = [20, 20, 15];        // --stock-ink
  const FAINT = [201, 199, 190];   // the empty sheet's prompt

  function draw() {
    const text = input.value;
    const empty = !text.trim();
    // renderTicket is the Worker's own, so the preview carries the header, the
    // rule and the spacing the real ticket has. A preview of only the body
    // would be a preview of something nobody receives.
    const rendered = renderTicket(empty ? EMPTY : text, {
      id: 0,
      createdAt: Date.now(),
      profile,
    });
    paint(rendered, empty ? FAINT : INK, STOCK);

    if (cols) {
      const longest = empty ? 0 : Math.max(...text.split("\n").map((l) => l.length));
      cols.textContent = `${Math.min(longest, COLUMNS)} / ${COLUMNS} columns`;
      cols.classList.toggle("over", longest > COLUMNS);
    }
    if (mm) {
      // 203 dpi is eight dots to the millimetre. This number is not decorative:
      // it is what the message costs off somebody's roll.
      const dots = empty ? 0 : rendered.height;
      mm.textContent = `${(dots / profile.dotsPerMm).toFixed(1)} mm of paper`;
    }
  }

  input.addEventListener("input", draw);
  draw();
}
