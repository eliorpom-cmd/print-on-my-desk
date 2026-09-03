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
// one the print head would lay down: same atlas, same blitter, same dots
// across, same one bit deep. What you see is the ticket.
//
// It follows that changing the ticket font changes the page, which is the
// point. `python tools/build_font.py --preset typewriter` and this file needs
// no edit: it never names a font, a size or a column count, it asks the atlas.
//
// The rendering itself lives in web/ticket.js, with the social card's, because
// drawing a ticket for a person has a rule that must not be forgotten and this
// file forgot it once. app.js owns the form, the submit and the printing
// animation; this file only draws, and the two never touch the same element.

import { charsPerLine } from "./lib/render.js";
import { PROFILE, renderForScreen, paint, FIELD, FIELD_INK, FIELD_FAINT } from "./ticket.js";

const canvas = document.getElementById("preview");
const input = document.getElementById("text");
const cols = document.getElementById("gauge-cols");
const mm = document.getElementById("gauge-mm");
if (canvas && input) {
  const COLUMNS = charsPerLine(PROFILE);

  // Shown on an empty field. Not a placeholder in some other font - it is
  // drawn in the dots too, faintly, so that the first thing anybody sees is
  // already the truth about what this machine does.
  const EMPTY = "Type here. These are the printer's own dots, not a font that looks like them.";

  function draw() {
    const text = input.value;
    const empty = !text.trim();
    // renderForScreen is the Worker's own renderer, so the preview carries the
    // header, the rule and the spacing the real ticket has. A preview of only
    // the body would be a preview of something nobody receives.
    const rendered = renderForScreen(empty ? EMPTY : text);
    // Light on dark, because this is a form control on a dark page rather than
    // a sheet of paper. The paper is what the printing animation shows.
    paint(canvas, rendered, {
      ink: empty ? FIELD_FAINT : FIELD_INK,
      stock: FIELD,
    });

    if (cols) {
      const longest = empty ? 0 : Math.max(...text.split("\n").map((l) => l.length));
      cols.textContent = `${Math.min(longest, COLUMNS)} / ${COLUMNS} columns`;
      cols.classList.toggle("over", longest > COLUMNS);
    }
    if (mm) {
      // 203 dpi is eight dots to the millimetre. This number is not decorative:
      // it is what the message costs off somebody's roll.
      const dots = empty ? 0 : rendered.height;
      mm.textContent = `${(dots / PROFILE.dotsPerMm).toFixed(1)} mm of paper`;
    }
  }

  input.addEventListener("input", draw);
  draw();
}
