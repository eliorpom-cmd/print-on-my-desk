// Host-side tests. No network, no hardware, no wrangler.
//
// The CRC assertions are not made up: they are the values this printer
// reported over BLE during M0 and M1, recorded in docs/09-protocol.md. If the
// Worker computes the same numbers for the same patterns, then its bit
// packing, its byte order and its checksum all agree with the physical device.
// That is a much stronger test than comparing against ourselves.

import { test } from "node:test";
import assert from "node:assert/strict";

import { Canvas, crc8, toBase64, WIDTH_BYTES, WIDTH_PIXELS } from "../src/bitmap.js";
import { wrap, renderTicket, renderProbe, charsPerLine, shortDate, LAYOUT } from "../src/render.js";
import { PROFILES, profileFor } from "../src/profiles.js";
import { fold, glyph, has, ADVANCE, HEIGHT, COLUMNS, CELL_WIDTH } from "../src/font.js";
import { isOpen, acceptingMessages, startOfDayIn } from "../src/settings.js";
import { tidyHandle } from "../src/limits.js";
import { screen } from "../src/blocklist.js";

// --- patterns whose CRC the hardware confirmed -----------------------------

function solidBlack(height, total) {
  const canvas = new Canvas();
  for (let y = 0; y < total; y++) {
    const row = canvas.ensure(y);
    if (y < height) row.fill(0xff);
  }
  return canvas;
}

function checkerboard(height, total, cell = 8) {
  const canvas = new Canvas();
  for (let y = 0; y < total; y++) {
    canvas.ensure(y);
    if (y >= height) continue;
    const band = Math.floor(y / cell) % 2;
    for (let x = 0; x < WIDTH_PIXELS; x++) {
      if ((Math.floor(x / cell) + band) % 2 === 0) canvas.setPixel(x, y);
    }
  }
  return canvas;
}

test("CRC8 matches what the printer reported for solid black", () => {
  // trace c and d, padded to 90 lines
  assert.equal(solidBlack(32, 90).crc8(), 0x7d);
  // same pattern unpadded, echoed back by the printer during M1
  assert.equal(solidBlack(32, 32).crc8(), 0x71);
});

test("CRC8 matches what the printer reported for the checkerboard", () => {
  assert.equal(checkerboard(32, 90).crc8(), 0x9a); // trace e
  assert.equal(checkerboard(32, 32).crc8(), 0x87); // M1, unpadded
});

test("CRC8 of an all-zero buffer is zero, which is why probes are numbered", () => {
  assert.equal(new Canvas().feed(64) && new Canvas().crc8(), 0);
  const blank = new Canvas();
  blank.feed(64);
  assert.equal(blank.crc8(), 0);
  // Losing half of it changes nothing: a blank image cannot test a transfer.
  const half = new Canvas();
  half.feed(32);
  assert.equal(half.crc8(), blank.crc8());
});

test("the probe pattern is sensitive to dropped and reordered lines", () => {
  const full = renderProbe(32);
  const short = renderProbe(31);
  assert.notEqual(full.crc8(), short.crc8());

  const swapped = renderProbe(32);
  [swapped.rows[3], swapped.rows[9]] = [swapped.rows[9], swapped.rows[3]];
  assert.notEqual(full.crc8(), swapped.crc8());
});

// --- bit order -------------------------------------------------------------

test("bit 0 of a byte is the leftmost pixel", () => {
  const canvas = new Canvas();
  canvas.setPixel(0, 0);
  assert.equal(canvas.rows[0][0], 0x01);
  canvas.setPixel(7, 0);
  assert.equal(canvas.rows[0][0], 0x81);
  canvas.setPixel(8, 0);
  assert.equal(canvas.rows[0][1], 0x01);
  assert.equal(canvas.rows[0].length, WIDTH_BYTES);
});

test("a pixel outside the paper is dropped, not wrapped onto the next line", () => {
  const canvas = new Canvas();
  canvas.ensure(0);
  canvas.setPixel(WIDTH_PIXELS, 0);
  canvas.setPixel(-1, 0);
  assert.equal(canvas.crc8(), 0);
});

test("trimTail drops the blank lines at the end and nothing else", () => {
  const canvas = new Canvas();
  canvas.rule(0, 2);
  canvas.feed(10);
  assert.equal(canvas.height, 12);
  canvas.trimTail();
  assert.equal(canvas.height, 2);
});

test("trimTail leaves one line rather than nothing", () => {
  // A9 announces a line count. Zero is not a count the printer was ever
  // asked for, so a canvas that is blank all the way through keeps a line.
  const canvas = new Canvas();
  canvas.feed(5);
  canvas.trimTail();
  assert.equal(canvas.height, 1);
});

test("a ticket ends on its stated margin and not a row more", () => {
  // Not a fix for the mystery margin. That claim was made in M4 and then
  // disproved by job 18, which ended on a printed line and produced the margin
  // anyway - see docs/09-protocol.md 6.2. Trailing blank lines are simply paper
  // nobody asked for.
  //
  // This used to demand zero blank rows, enforced by trimTail. That stopped
  // being right when the title came off the ticket: the end of the
  // transmission is the TOP of the message, and trimming it took the margin
  // away and made the height depend on whether the first line happened to
  // carry an accent. The property worth keeping is that the waste is stated
  // rather than accidental.
  // #public-allow-french the fixtures ARE the subject: accented and French
  // text is what this asserts survives folding and wrapping.
  for (const text of ["Bonjour", "Le petit chat", "Ete a Paris, deja", "!"]) {
    const canvas = renderTicket(text, { id: 1, createdAt: 0 });
    const blank = (row) => row.every((byte) => byte === 0);
    let trailing = 0;
    for (let i = canvas.rows.length - 1; i >= 0 && blank(canvas.rows[i]); i--) {
      trailing++;
    }
    // topPad, plus whatever the glyph cell leaves empty above the tallest
    // character on that line. The second part is not waste anyone can remove
    // without cropping the font: a line of lowercase simply has more air above
    // it than a line of accented capitals. What matters is that it stays
    // inside one line, so it can never grow with the message.
    // topPad moved to the profile on 31 August, when there were two printers
    // to state it for. The property is unchanged.
    const allowed = PROFILES.mxw01.topPad + HEIGHT;
    assert.ok(
      trailing <= allowed,
      `"${text}" ends on ${trailing} blank rows, more than the ${allowed} a margin plus one cell allows`
    );
  }
});

test("the same message is always the same height", () => {
  // What trimming broke: a line of lowercase has blank rows above its
  // x-height and a line of accented capitals has none, so the trimmed height
  // moved with the first character of the message.
  const a = renderTicket("eeeee eeeee", { id: 1, createdAt: 0 });
  const b = renderTicket("ÉÉÉÉÉ ÀÀÀÀÀ", { id: 1, createdAt: 0 });
  assert.equal(a.height, b.height);
});

test("rotate180 is its own inverse", () => {
  const original = renderTicket("Le petit chat", { id: 7, createdAt: 0 });
  const before = original.crc8();
  original.rotate180().rotate180();
  assert.equal(original.crc8(), before);
});

// --- font ------------------------------------------------------------------

test("the font covers printable ASCII", () => {
  for (let code = 32; code <= 126; code++) {
    assert.ok(has(String.fromCharCode(code)), `missing U+${code.toString(16)}`);
  }
});

test("the font covers Latin-1, which the brief calls mandatory", () => {
  // 0xAD is the soft hyphen: invisible, deliberately absent.
  for (let code = 0xa0; code <= 0xff; code++) {
    if (code === 0xad) continue;
    assert.ok(has(String.fromCharCode(code)), `missing U+${code.toString(16)}`);
  }
});

test("every French accent is a real glyph, not a transliteration", () => {
  for (const ch of "àâäéèêëîïôöùûüçÀÂÄÉÈÊËÎÏÔÖÙÛÜÇœŒæÆ") {
    assert.ok(has(ch), `${ch} is not in the atlas`);
    assert.notEqual(glyph(ch).reduce((a, b) => a | b, 0), 0, `${ch} is blank`);
  }
  // This is the regression that matters: M3 turned Café into Cafe.
  assert.equal(fold("Café à Noël, un cœur, 3€ « oui »"), "Café à Noël, un cœur, 3€ « oui »");
});

test("an accented capital is taller than its unaccented form", () => {
  const inkTop = (ch) => glyph(ch).findIndex((row) => row !== 0);
  // If the cell were sized from the font's nominal ascent, the circumflex
  // would have been clipped off and these would be equal.
  assert.ok(inkTop("Ô") < inkTop("O"), "the accent on O-circumflex is clipped");
  assert.ok(inkTop("É") < inkTop("E"), "the accent on E-acute is clipped");
});

test("space is blank and every other printable glyph has ink", () => {
  assert.equal(glyph(" ").reduce((a, b) => a | b, 0), 0);
  for (let code = 33; code <= 126; code++) {
    const ink = glyph(String.fromCharCode(code)).reduce((a, b) => a | b, 0);
    assert.notEqual(ink, 0, `glyph ${code} (${String.fromCharCode(code)}) is empty`);
  }
});

test("characters outside the atlas degrade instead of vanishing", () => {
  assert.equal(fold("Ĳsland"), "IJsland");   // stripped of its combining marks
  assert.equal(fold("naïve"), "naïve");      // already covered
  assert.ok(fold("日本").includes("?"));      // nothing sensible to draw
});

test("no glyph is wider than its cell", () => {
  const limit = (1 << CELL_WIDTH) - 1;
  for (let code = 32; code <= 126; code++) {
    for (const row of glyph(String.fromCharCode(code))) {
      assert.ok(row <= limit, `U+${code.toString(16)} overflows the cell`);
    }
  }
});

// --- word wrap -------------------------------------------------------------

test("wrap breaks on spaces", () => {
  assert.deepEqual(wrap("le chat dort", 8), ["le chat", "dort"]);
});

test("wrap hard-splits a word longer than the line", () => {
  assert.deepEqual(wrap("aaaaaaaaaaaa", 5), ["aaaaa", "aaaaa", "aa"]);
});

test("wrap keeps paragraph breaks", () => {
  assert.deepEqual(wrap("one\ntwo", 10), ["one", "two"]);
});

test("wrap drops trailing blank lines so they do not cost paper", () => {
  assert.deepEqual(wrap("bonjour\n\n\n", 20), ["bonjour"]);
});

test("a 200-character ticket stays well inside the line budget", () => {
  const canvas = renderTicket("a".repeat(200), { id: 1, createdAt: 0 });
  assert.ok(canvas.height < 400, `ticket is ${canvas.height} lines`);
  assert.ok(charsPerLine() >= 26, `only ${charsPerLine()} characters per line`);
});

test("a ticket of accented text is no taller than the same text plain", () => {
  // Accents must not push the line height around, or wrapping becomes
  // unpredictable and the preview stops matching the ticket.
  const plain = renderTicket("eeeee eeeee eeeee", { id: 1, createdAt: 0 });
  const accented = renderTicket("ééééé ààààà ôôôôô", { id: 1, createdAt: 0 });
  assert.equal(plain.height, accented.height);
});

// --- rendering -------------------------------------------------------------

test("rendering is deterministic", () => {
  const a = renderTicket("bonjour", { id: 3, createdAt: 1000 });
  const b = renderTicket("bonjour", { id: 3, createdAt: 1000 });
  assert.equal(a.crc8(), b.crc8());
  assert.equal(a.height, b.height);
});

test("different text gives a different ticket", () => {
  const a = renderTicket("bonjour", { id: 3, createdAt: 1000 });
  const b = renderTicket("bonsoir", { id: 3, createdAt: 1000 });
  assert.notEqual(a.crc8(), b.crc8());
});

test("every line is exactly 48 bytes", () => {
  const canvas = renderTicket("test", { id: 1, createdAt: 0 });
  for (const row of canvas.rows) assert.equal(row.length, WIDTH_BYTES);
  assert.equal(canvas.toBytes().length, canvas.height * WIDTH_BYTES);
});

test("dates are rendered in Paris time, not the Worker's", () => {
  // 2026-01-15T23:30:00Z is 00:30 on the 16th in Paris.
  assert.equal(shortDate(Date.parse("2026-01-15T23:30:00Z")), "16/01 00:30");
  // And in summer, +2.
  assert.equal(shortDate(Date.parse("2026-07-15T12:00:00Z")), "15/07 14:00");
});

// --- base64 ----------------------------------------------------------------

test("base64 round-trips a full ticket", () => {
  const canvas = renderTicket("The wind is picking up", { id: 12, createdAt: 0 });
  const bytes = canvas.toBytes();
  const decoded = Buffer.from(toBase64(bytes), "base64");
  assert.equal(decoded.length, bytes.length);
  assert.equal(crc8(decoded), canvas.crc8());
});

// --- the kill switch -------------------------------------------------------

// Opening hours are gone: since everything queues for a tap, the hour a
// message is written no longer decides the hour it is printed. One deliberate
// switch is the only thing that closes the service now.

test("the service is open unless the kill switch is on", () => {
  const settings = { kill_switch: "0", timezone: "Europe/Paris" };
  assert.equal(isOpen(settings).open, true);
  assert.equal(isOpen(settings).reason, "open");
});

test("the kill switch closes the service, whatever the hour", () => {
  const paused = { kill_switch: "1", timezone: "Europe/Paris" };
  assert.equal(isOpen(paused).open, false);
  assert.equal(isOpen(paused).reason, "paused");
});

// --- the end of a season ---------------------------------------------------

// Season 1 stops taking messages at a stated instant. What it must NOT do is
// stop the printer: the whole reason for closing is that thousands of already
// approved messages go on coming out for weeks afterwards. These two live in
// separate functions for that reason, and this is the test that keeps them
// apart if anyone is ever tempted to fold one into the other.

const OPEN = { kill_switch: "0", timezone: "Europe/Paris" };
const CLOSES = Date.parse("2026-09-02T10:30:00+02:00");

test("no closing date means the season never ends on its own", () => {
  assert.equal(acceptingMessages({ ...OPEN, closes_at: "0" }).accepting, true);
  assert.equal(acceptingMessages({ ...OPEN }).accepting, true);
  assert.equal(acceptingMessages({ ...OPEN, closes_at: "nonsense" }).accepting, true);
});

test("messages are taken up to the closing instant and not after", () => {
  const settings = { ...OPEN, closes_at: String(CLOSES) };
  assert.equal(acceptingMessages(settings, CLOSES - 1).accepting, true);
  assert.equal(acceptingMessages(settings, CLOSES).accepting, false);
  assert.equal(acceptingMessages(settings, CLOSES).seasonOver, true);
});

test("closing the season does not close the service", () => {
  // The one that matters. isOpen() is what handleNext() reads before handing a
  // job to the printer; if a past closes_at ever reached it, the queue would
  // freeze on the morning the form shut and nobody would notice for hours.
  const closed = { ...OPEN, closes_at: String(CLOSES) };
  assert.equal(isOpen(closed).open, true);
  assert.equal(isOpen(closed).reason, "open");
});

test("the kill switch still works while the season is over", () => {
  const both = { kill_switch: "1", timezone: "Europe/Paris", closes_at: String(CLOSES) };
  assert.equal(isOpen(both).open, false);
  assert.equal(acceptingMessages(both, CLOSES + 1).accepting, false);
});

// The quota still resets on the owner's calendar rather than on UTC's, so the
// timezone still has to be handled properly even without opening hours.
test("the day starts at local midnight, not at UTC midnight", () => {
  const midnightParis = Date.parse("2026-07-15T22:00:00Z"); // 00:00 on the 16th
  const justAfter = startOfDayIn("Europe/Paris", midnightParis + 60_000);
  assert.equal(justAfter, midnightParis);
});

// --- the optional handle ----------------------------------------------------

test("a handle is cleaned down to a name, or refused", () => {
  assert.equal(tidyHandle("@mavie.log"), "mavie.log");
  assert.equal(tidyHandle("  @Mavie_P  "), "mavie_p");
  assert.equal(tidyHandle("xj9_kk"), "xj9_kk");
  // Blank is a legitimate answer: the field is optional.
  assert.equal(tidyHandle(""), null);
  assert.equal(tidyHandle(null), null);
  assert.equal(tidyHandle("   "), null);
  // Refused, and distinguishable from blank.
  assert.equal(tidyHandle("has space"), undefined);
  assert.equal(tidyHandle("emoji\u{1F600}"), undefined);
  assert.equal(tidyHandle("..."), undefined);
  assert.equal(tidyHandle("a".repeat(31)), undefined);
});

// The whole point of screening a handle with the word list rather than the AI:
// a name has no grammar, and half of them look like keyboard noise. These must
// all survive, or people get turned away for having an ordinary handle.
test("the word list does not eat ordinary handles", () => {
  for (const handle of [
    "mavie.log", "xj9_kk", "assange", "scunthorpe", "classic_al",
    "analysis", "sexton", "japan.trip", "matt_hancock", "cockburn",
  ]) {
    assert.equal(screen(handle).severity, null, handle);
  }
});

test("the word list still catches a handle that is an insult", () => {
  assert.ok(screen("fuckyou").severity);
});

test("a handle costs one line of paper and no more", () => {
  const plain = renderTicket("i got the job", { id: 412 });
  const signed = renderTicket("i got the job", { id: 412, handle: "mavie.log" });
  const cost = signed.height - plain.height;
  assert.ok(cost > 0, "the signature must appear on the paper");
  // One text line, give or take the descender room the last line always gets.
  assert.ok(cost <= HEIGHT + 4, `a signature cost ${cost} lines, expected ~${HEIGHT}`);
});

test("a handle that was refused leaves the ticket untouched", () => {
  const plain = renderTicket("i got the job", { id: 412 });
  for (const bad of [null, undefined, ""]) {
    assert.equal(renderTicket("i got the job", { id: 412, handle: bad }).height, plain.height);
  }
});
