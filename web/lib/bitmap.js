// COPIED from worker/src/bitmap.js by tools/sync_web.mjs - do not edit here.
// The preview and the ticket must come from one implementation, not two.
// Monochrome 384-pixel-wide canvas, in exactly the line format the MXW01 eats.
//
// The pixel packing is not a choice, it is what the capture showed
// (docs/09-protocol.md 5.1): 48 bytes per line, bit set = black, and bit 0 of a
// byte is the LEFTMOST pixel. That last part is the one everybody gets wrong.
//
// The CRC8 here is the same Dallas/Maxim variant as the control frames, and it
// matters more than it looks: the printer echoes the CRC of the image buffer it
// actually received in its AA notification, and ae03 is written without
// response. Computing it server-side means the Pico can prove, end to end, that
// the bytes that came out of D1 are the bytes that reached the print head.

// The default geometry, which is the MXW01's. The numbers themselves now live
// in profiles.js, one entry per printer; these two exist so that every caller
// written when there was only one printer keeps meaning what it meant.
//
// A Canvas takes its width at construction. Nothing below reads these
// constants except the default argument, so a canvas of another width is not a
// special case anywhere in this file.
export const WIDTH_PIXELS = 384;
export const WIDTH_BYTES = 48;

const CRC8_TABLE = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let bit = 0; bit < 8; bit++) {
    c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
  }
  CRC8_TABLE[i] = c;
}

/** CRC-8 Dallas/Maxim, poly 0x07, init 0x00, no reflection, no final xor. */
export function crc8(bytes, crc = 0) {
  for (const byte of bytes) crc = CRC8_TABLE[crc ^ byte];
  return crc;
}

export class Canvas {
  /**
   * @param {number} widthPixels printable dots across; must be a multiple of 8,
   *   since a line is a whole number of bytes and half a byte is not a thing
   *   either printer accepts.
   */
  constructor(widthPixels = WIDTH_PIXELS) {
    if (!Number.isInteger(widthPixels) || widthPixels <= 0 || widthPixels % 8 !== 0) {
      throw new Error(`canvas width must be a positive multiple of 8, got ${widthPixels}`);
    }
    this.widthPixels = widthPixels;
    this.widthBytes = widthPixels / 8;
    /** @type {Uint8Array[]} one widthBytes-long line each */
    this.rows = [];
  }

  get height() {
    return this.rows.length;
  }

  /** Grows the canvas so that row index y exists. */
  ensure(y) {
    while (this.rows.length <= y) this.rows.push(new Uint8Array(this.widthBytes));
    return this.rows[y];
  }

  /** Adds n blank lines and returns the new height. */
  feed(n) {
    for (let i = 0; i < n; i++) this.rows.push(new Uint8Array(this.widthBytes));
    return this.height;
  }

  setPixel(x, y) {
    if (x < 0 || x >= this.widthPixels || y < 0) return;
    this.ensure(y)[x >> 3] |= 1 << (x & 7);
  }

  /** Horizontal rule, `thickness` rows tall, inset by `margin` on each side. */
  rule(y, thickness = 1, margin = 0) {
    for (let dy = 0; dy < thickness; dy++) {
      for (let x = margin; x < this.widthPixels - margin; x++) this.setPixel(x, y + dy);
    }
    return y + thickness;
  }

  /**
   * Blits one glyph, scaled by an integer factor.
   * `rows` is the bitmask-per-row array from font.glyph(); `width` is the
   * glyph cell, which can be wider than the pen advance for glyphs the font
   * draws past their own pitch.
   */
  drawGlyph(rows, x0, y0, scale = 1, width = 8) {
    for (let gy = 0; gy < rows.length; gy++) {
      const mask = rows[gy];
      if (mask === 0) continue;
      for (let gx = 0; gx < width; gx++) {
        if ((mask & (1 << gx)) === 0) continue;
        for (let sy = 0; sy < scale; sy++) {
          for (let sx = 0; sx < scale; sx++) {
            this.setPixel(x0 + gx * scale + sx, y0 + gy * scale + sy);
          }
        }
      }
    }
  }

  /** Flips the whole canvas 180 degrees, in place. */
  rotate180() {
    this.rows.reverse();
    for (const row of this.rows) {
      const flipped = new Uint8Array(this.widthBytes);
      for (let x = 0; x < this.widthPixels; x++) {
        if (row[x >> 3] & (1 << (x & 7))) {
          const nx = this.widthPixels - 1 - x;
          flipped[nx >> 3] |= 1 << (nx & 7);
        }
      }
      row.set(flipped);
    }
    return this;
  }

  /**
   * Drops the blank lines at the end of the canvas - the ones sent last.
   *
   * This was believed in M4 to be the cause of the "mystery margin", on three
   * prints that looked conclusive and were not: the test moved blank lines
   * from the tail to the head, so both ends changed. Job 18 ended on a printed
   * line and produced the margin anyway. See docs/09-protocol.md 6.2.
   *
   * Kept because it is right on its own terms - about 1.25 mm a ticket of
   * paper nobody asked for - and not because it fixes anything.
   *
   * Must be called after any rotation, since that decides which end is sent
   * last. Never trims to nothing: A9 announces a line count, and zero is not
   * a count the printer was ever asked for.
   */
  trimTail() {
    const blank = (row) => row.every((byte) => byte === 0);
    while (this.rows.length > 1 && blank(this.rows[this.rows.length - 1])) {
      this.rows.pop();
    }
    return this;
  }

  /**
   * A dashed horizontal rule, for separating tickets on a continuous strip.
   *
   * Dashed rather than solid on purpose: it reads as a tear line, which is
   * what it is, and it costs a third of the ink of a solid one across 372
   * pixels - small per rule, real over a thousand tickets.
   */
  dashedRule(y, dash = 6, gap = 5, margin = 0) {
    for (let x = margin; x < this.widthPixels - margin; x++) {
      if (x % (dash + gap) < dash) this.setPixel(x, y);
    }
    return y + 1;
  }

  /**
   * Appends another canvas's lines to this one.
   *
   * Rows are copied, not shared: a batch that aliased its tickets' buffers
   * would have `rotate180` flip the same memory twice.
   */
  append(other) {
    // Refused rather than padded or cropped. Two widths in one strip is a
    // profile mix-up upstream, and silently coercing it would put half a
    // batch out at the wrong scale with nothing to show for it afterwards.
    if (other.widthPixels !== this.widthPixels) {
      throw new Error(
        `cannot append a ${other.widthPixels}px canvas to a ${this.widthPixels}px one`
      );
    }
    for (const row of other.rows) this.rows.push(Uint8Array.from(row));
    return this;
  }

  /** The whole image as one flat buffer, in transmission order. */
  toBytes() {
    const out = new Uint8Array(this.rows.length * this.widthBytes);
    this.rows.forEach((row, i) => out.set(row, i * this.widthBytes));
    return out;
  }

  crc8() {
    return crc8(this.toBytes());
  }

  /** Debug rendering, used by the tests to proofread glyphs by eye. */
  toAscii(on = "#", off = ".") {
    return this.rows
      .map((row) => {
        let line = "";
        for (let x = 0; x < this.widthPixels; x++) {
          line += row[x >> 3] & (1 << (x & 7)) ? on : off;
        }
        return line;
      })
      .join("\n");
  }
}

/** Standard base64 of a byte array. Workers gives us btoa, but not for bytes. */
export function toBase64(bytes) {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
