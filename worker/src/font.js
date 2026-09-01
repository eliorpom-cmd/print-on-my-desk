// The ticket font: a fixed-pitch bitmap atlas generated from a real TTF by
// tools/build_font.py. This replaces the provisional 5x7 font of M3, and with
// it the transliteration that turned "Café" into "Cafe".
//
// Why an atlas rather than rasterising here: the free tier gives a Worker
// about 10 ms of CPU per request, and turning outlines into pixels does not
// fit in that. Doing it offline also means the threshold that decides which
// pixels are inked is a decision we can look at, not a side effect.
//
// Rows are decoded lazily. A ticket touches maybe forty distinct characters,
// so parsing all two hundred on every cold start would be work for nothing.

import ATLAS from "./font-atlas.js";

export const ADVANCE = ATLAS.advance;      // pen step, the fixed pitch
export const CELL_WIDTH = ATLAS.cellWidth; // ink box, may exceed the pitch
export const HEIGHT = ATLAS.height;
export const BASELINE = ATLAS.baseline;
export const COLUMNS = ATLAS.columns;
export const FONT_NAME = ATLAS.name;
export const FONT_SIZE = ATLAS.size;

const decoded = new Map();
const EMPTY = [];

function rowsFor(code) {
  if (decoded.has(code)) return decoded.get(code);
  const raw = ATLAS.glyphs[code];
  const rows = raw === undefined ? null : raw === "" ? EMPTY : raw.split(",").map(Number);
  decoded.set(code, rows);
  return rows;
}

const FALLBACK = "?".codePointAt(0);

/** Row bitmasks for one character, or the '?' glyph. bit 0 = leftmost pixel. */
export function glyph(ch) {
  return rowsFor(ch.codePointAt(0)) ?? rowsFor(FALLBACK) ?? EMPTY;
}

// The pair that decides how tight lines may sit: a descender hanging off one
// line, an accented capital reaching up from the next. Everything else clears
// by more. Naming them is the whole policy - measuring the entire atlas
// instead would include glyphs that fill their cell edge to edge and cost
// three millimetres a line to protect against a pairing French does not make.
const DESCENDERS = "gjpqy,;()[]{}";
const RISERS = "ÀÂÄÉÈÊËÎÏÔÖÙÛÜÇÑ";

/**
 * The tightest baseline-to-baseline spacing at which two lines cannot touch.
 *
 * Was the constant HEIGHT - 2, picked when the atlas was 22 px. It was exactly
 * right there and silently wrong the moment the font was rebuilt smaller: at
 * 20 px it put a descender one row inside the accent below it.
 *
 * Derived now. Line n's ink ends at `lowest`; line n+1's begins at
 * `spacing + highest`; they clear when spacing > lowest - highest. Computed
 * once per isolate, so rebuilding the font at any size stays safe without
 * anyone remembering this file exists.
 */
export function minimumLeading() {
  let lowest = 0;
  let highest = HEIGHT;
  const scan = (text, fn) => {
    for (const ch of text) {
      // Through rowsFor, not the raw table: the atlas stores a glyph as a
      // comma-separated string of row bitmasks, and treating that string as an
      // array counts its characters instead of its rows.
      const rows = rowsFor(ch.codePointAt(0));
      if (!rows) continue;
      for (let y = 0; y < rows.length; y++) if (rows[y]) fn(y);
    }
  };
  scan(DESCENDERS, (y) => { if (y > lowest) lowest = y; });
  scan(RISERS, (y) => { if (y < highest) highest = y; });
  return lowest - highest + 1;
}

export function has(ch) {
  return rowsFor(ch.codePointAt(0)) !== null;
}

/**
 * Maps what we cannot draw onto what we can.
 *
 * Much shorter than the 5x7 font's table, because this atlas has the accents.
 * What is left is the tail: characters outside Latin-1 that a phone keyboard
 * still produces, and which would otherwise all come out as '?'.
 */
/**
 * What one character becomes on paper, or null if nothing does.
 *
 * The single definition of "we cannot draw this". fold() and undrawable()
 * both go through it, so the submission form can never refuse a character the
 * renderer would have coped with, nor accept one it would have turned into a
 * question mark.
 */
function foldChar(ch) {
  if (ch === "\n" || has(ch)) return ch;
  const replacement = ATLAS.fold[ch];
  if (replacement !== undefined) return replacement;
  // NFKD rather than NFD: it also breaks up compatibility forms, which is what
  // turns the ligatures a phone keyboard can emit - IJ, fi - into letters we
  // can actually draw. NFD leaves them whole and they would come out as
  // question marks.
  const stripped = ch.normalize("NFKD").replace(/\p{M}/gu, "");
  return stripped && stripped !== ch && [...stripped].every(has) ? stripped : null;
}

export function fold(text) {
  let out = "";
  for (const ch of text) out += foldChar(ch) ?? "?";
  return out;
}

/**
 * The characters this font cannot draw, in order, without repeats.
 *
 * Exists so a message can be refused while its author is still on the page.
 * An emoji survives every other check - it is one character, it is not blank
 * space, it is not a slur - and then prints as a question mark, which the
 * author never sees and cannot fix.
 */
export function undrawable(text) {
  const bad = [];
  for (const ch of text) {
    if (foldChar(ch) === null && !bad.includes(ch)) bad.push(ch);
  }
  return bad;
}

/**
 * True when a character is emoji-ish, for the wording of the refusal only.
 *
 * Never for deciding what is allowed: that is foldChar's job, and the two must
 * not drift apart. A message is refused because it cannot be drawn, not
 * because a regex thinks it looks like an emoji.
 */
export function looksLikeEmoji(ch) {
  return /\p{Extended_Pictographic}/u.test(ch);
}

/**
 * Synthetic bold: the glyph ORed with itself shifted one pixel right.
 *
 * Cheaper than shipping a second atlas for the handful of characters in the
 * ticket header, and at this size it reads as bold rather than as a smear.
 */
export function embolden(rows) {
  return rows.map((mask) => mask | (mask << 1));
}
