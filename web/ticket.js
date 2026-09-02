// A ticket, as a PERSON should see it. One place, because it was three.
//
// WHY THIS FILE EXISTS
//
// `renderTicket` in web/lib renders for the print head, not for eyes, and on
// the MXW01 those are not the same picture: its head is mounted upside down,
// so the profile carries `flip180` and the bitmap comes out pre-rotated. The
// bytes are correct. Looked at on a screen, they are mirrored gibberish.
//
// Undoing that is one line, and one line copied into every place that draws a
// ticket is one line that will be forgotten by the next place. It was: this
// page previewed upside down, and so did the social card, because both were
// written against the TRP 100 III profile - which has no rotation - and
// neither author ever saw the bug. web/app.js had the line. The two new
// callers did not.
//
// So the un-rotation is not a step you remember any more, it is the only door.
// `renderForScreen` is what the browser side calls, and nothing here exposes a
// version that skips it.
//
// web/app.js still carries its own copy of the line and that is deliberate:
// app.js is shared with the upstream this project is exported from, so it
// cannot import a file that only exists over here. It is already correct;
// worker/test/screen-render.test.mjs is what keeps it that way.

import { renderTicket } from "./lib/render.js";
import { CURRENT_PROFILE, profileFor } from "./lib/profiles.js";

/**
 * The printer this deployment has.
 *
 * CURRENT_PROFILE is the KEY ("mxw01"), not the profile - passing the string
 * straight through gives an object with no dotsPerMm and every measurement on
 * the page reads NaN. It must also agree with the profile web/bridge/bridge.js
 * asks the Worker for, or the preview is of a different machine than the one
 * printing; screen-render.test.mjs asserts exactly that.
 */
export const PROFILE = profileFor(CURRENT_PROFILE);

/** Paper, ink, and the barely-inked grey an empty sheet is prompted with. */
export const STOCK = [244, 243, 238];   // --stock
export const INK = [20, 20, 15];        // --stock-ink
export const FAINT = [201, 199, 190];

/**
 * Renders a ticket the right way up.
 *
 * Same renderer, same atlas, same geometry as the paper - and then turned back
 * over for whoever is looking at it. Profiles with no rotation, like the
 * TRP 100 III, have nothing to undo and are returned as they came.
 */
export function renderForScreen(text, { id = 0, createdAt = Date.now(), profile = PROFILE } = {}) {
  const rendered = renderTicket(text, { id, createdAt, profile });
  if (profile.flip180) rendered.rotate180();
  return rendered;
}

/**
 * Paints a rendered ticket onto a canvas, one bit deep, at its own dot size.
 *
 * Opaque on purpose: the sheet is a real object on a dark page, not ink
 * floating on whatever is behind it. CSS gives the element its width; this
 * sets the aspect ratio so the dots stay square whatever the font's line
 * height turns out to be.
 */
export function paint(canvas, rendered, { ink = INK, stock = STOCK } = {}) {
  const width = rendered.widthPixels;
  const height = Math.max(rendered.height, 1);
  canvas.width = width;
  canvas.height = height;
  canvas.style.aspectRatio = `${width} / ${height}`;
  const ctx = canvas.getContext("2d");
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
  return { width, height };
}
