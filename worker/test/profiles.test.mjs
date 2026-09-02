// The two printers, and the places where treating them as one loses tickets.
//
// Written alongside the switch to the AURES TRP 100 III on 31 August. Most of
// these are geometry and would fail loudly; three of them are the quiet kind,
// and they are the reason this file exists:
//
//   "the strip is transmitted in RENDER order when it is not rotated" - the
//   MXW01 strip is rotated once at the end, so it goes out back to front. The
//   TRP 100 III is not. Inheriting the MXW01 arithmetic would, on every
//   partial failure, requeue exactly the tickets that printed and give up on
//   exactly the ones that did not.
//
//   "a batch never mixes widths" - a 384-wide ticket appended to a 512-wide
//   strip would print as noise at the wrong scale, silently.
//
//   "the small printer still renders exactly as it shipped" - the MXW01 work
//   is going out as open source. It has to still work the day it is released,
//   and a refactor done for another machine is exactly how it would stop.

import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

import { Canvas } from "../src/bitmap.js";
import { PROFILES, profileFor, DEFAULT_PROFILE, linesToMm, mmToLines } from "../src/profiles.js";
import { renderTicket, renderBatch, composeTicket, charsPerLine, LAYOUT } from "../src/render.js";
import { buildPayload, buildBatchPayload, feedLinesKey } from "../src/jobs.js";
import { ADVANCE } from "../src/font.js";
import ATLAS from "../src/font-atlas.js";
import { loadSettings } from "../src/settings.js";
// The default lives in settings.js DEFAULTS, which is not exported; read it
// the way the module does, through a database that has no settings at all.
const DEFAULTS_ONLY_SUPPORTERS = (
  await loadSettings({ prepare: () => ({ all: async () => ({ results: [] }) }) })
).only_supporters;

const MXW01 = PROFILES.mxw01;
const TRP100 = PROFILES.trp100;

const SETTINGS = { intensity: "93", feed_lines: "", max_batch_lines: "900" };

const job = (id, text = "Bonjour") => ({
  id,
  text,
  created_at: 0,
  handle: null,
});

// --- geometry ---------------------------------------------------------------

test("the two printers have the geometry their manuals state", () => {
  assert.equal(MXW01.widthPixels, 384);
  assert.equal(MXW01.widthBytes, 48);
  assert.equal(MXW01.dotsPerMm, 8);

  // 180 dpi, 512 dots, 72 mm. From the AURES manual section 7-1, and NOT the
  // 576 dots that almost every other 80 mm printer does.
  assert.equal(TRP100.widthPixels, 512);
  assert.equal(TRP100.widthBytes, 64);
  assert.ok(Math.abs(TRP100.dotsPerMm - 7.0866) < 0.001);
  assert.ok(Math.abs(TRP100.widthPixels / TRP100.dotsPerMm - 72.2) < 0.1);
});

test("width and bytes agree, on both, forever", () => {
  for (const profile of Object.values(PROFILES)) {
    assert.equal(profile.widthBytes, profile.widthPixels / 8);
  }
});

test("a canvas takes its width, and rows follow it", () => {
  const wide = new Canvas(512);
  wide.feed(3);
  assert.equal(wide.widthBytes, 64);
  assert.equal(wide.rows[0].length, 64);
  assert.equal(wide.toBytes().length, 3 * 64);
});

test("a width that is not a whole number of bytes is refused", () => {
  assert.throws(() => new Canvas(500), /multiple of 8/);
  assert.throws(() => new Canvas(0), /multiple of 8/);
});

test("a pixel past the right edge is dropped, at either width", () => {
  const narrow = new Canvas(384);
  narrow.setPixel(384, 0);
  narrow.setPixel(400, 0);
  assert.equal(narrow.height, 0, "nothing should have been created");

  const wide = new Canvas(512);
  wide.setPixel(400, 0); // inside on the wide one, outside on the narrow
  assert.equal(wide.height, 1);
});

test("millimetres and lines convert both ways", () => {
  assert.equal(linesToMm(80, MXW01), 10);
  assert.equal(mmToLines(10, MXW01), 80);
  // The same 80 lines is longer on the coarser printer, which is the whole
  // reason every length in this project had to be re-derived.
  assert.ok(linesToMm(80, TRP100) > 11.2);
});

// --- choosing one -----------------------------------------------------------

test("no profile means the MXW01, because its firmware cannot ask", () => {
  assert.equal(DEFAULT_PROFILE, "mxw01");
  assert.equal(profileFor(undefined).id, "mxw01");
  assert.equal(profileFor(null).id, "mxw01");
  assert.equal(profileFor("").id, "mxw01");
});

test("junk falls back rather than throwing", () => {
  assert.equal(profileFor("nonsense").id, "mxw01");
  assert.equal(profileFor(42).id, "mxw01");
  assert.equal(profileFor("TRP100").id, "trp100");
});

// --- the two layouts --------------------------------------------------------

test("the framed ticket has the title and rules back", () => {
  const canvas = composeTicket("Bonjour", { id: 7, createdAt: 0, profile: TRP100 });
  const art = canvas.toAscii("#", ".");
  const rows = art.split("\n");

  // A rule is a run of ink spanning the full inner width. There are two on a
  // framed ticket: two rows under the title, one over the reference line.
  const solid = rows.filter(
    (row) => row.slice(TRP100.margin, TRP100.widthPixels - TRP100.margin).indexOf(".") === -1
  );
  assert.ok(solid.length >= 3, `expected 3 full-width rule rows, found ${solid.length}`);
});

test("the bare ticket has neither, exactly as it shipped", () => {
  const canvas = composeTicket("Bonjour", { id: 7, createdAt: 0, profile: MXW01 });
  const rows = canvas.toAscii("#", ".").split("\n");
  const solid = rows.filter(
    (row) => row.slice(MXW01.margin, MXW01.widthPixels - MXW01.margin).indexOf(".") === -1
  );
  assert.equal(solid.length, 0, "the small printer's ticket has no rules");
});

test("the framed ticket carries the date, the bare one does not", () => {
  const framed = composeTicket("x", { id: 7, createdAt: 0, profile: TRP100 }).height;
  const bare = composeTicket("x", { id: 7, createdAt: 0, profile: MXW01 }).height;
  // Title, two rules and a date line: about 13 mm of furniture.
  assert.ok(framed > bare + 40, `framed ${framed}, bare ${bare}`);
});

test("a handle gets its own line on the framed ticket", () => {
  const without = composeTicket("x", { id: 1, createdAt: 0, profile: TRP100 }).height;
  const with_ = composeTicket("x", {
    id: 1,
    createdAt: 0,
    handle: "someone",
    profile: TRP100,
  }).height;
  assert.ok(with_ > without, "the signature must cost a line");
});

test("a handle costs no LINE on the bare ticket, only its descender", () => {
  const without = composeTicket("x", { id: 1, createdAt: 0, profile: MXW01 }).height;
  const with_ = composeTicket("x", {
    id: 1,
    createdAt: 0,
    handle: "someone",
    profile: MXW01,
  }).height;
  // Three rows, not a line: '#1  @someone' shares one line with '#1', and '@'
  // simply reaches lower than '#'. Measured at 58 and 61 on the code as it
  // shipped, which is where these numbers come from.
  assert.ok(
    with_ - without < LAYOUT.lineHeight,
    `the signature cost ${with_ - without} rows, which is a whole line`
  );
});

test("the wider paper fits more characters, and the margin is a real margin", () => {
  // Derived from the pitch rather than written down. The two claims in this
  // test's name - wider paper fits more, and the margin is real - are true of
  // any font; the exact counts are true only of the one currently built, and
  // hardcoding them made this test fail on `build_font.py --preset terminal`,
  // which is a supported thing to do rather than a mistake.
  const fits = (p) => Math.floor((p.widthPixels - 2 * p.margin) / ADVANCE);
  assert.equal(charsPerLine(MXW01), fits(MXW01));
  assert.equal(charsPerLine(TRP100), fits(TRP100));
  assert.ok(charsPerLine(TRP100) > charsPerLine(MXW01),
    "the wider printer must fit more characters per line");
  // 2.8 mm rather than 0.75. The old margin read as "the renderer ran out of
  // paper" on a printer that had none to spare.
  assert.ok(TRP100.margin / TRP100.dotsPerMm > 2.5);
});

// --- rotation ---------------------------------------------------------------

test("only the MXW01 is pre-rotated", () => {
  assert.equal(MXW01.flip180, true);
  assert.equal(TRP100.flip180, false);
});

test("the TRP ticket comes out of the renderer the right way up", () => {
  // The framed ticket has two rules of different thickness: two rows under the
  // title at the TOP, one row over the reference line at the BOTTOM. Their
  // order in the buffer is therefore thick-then-thin, and rotating the ticket
  // swaps them - which is how every ticket would print upside down and
  // backwards while still looking, row by row, perfectly plausible.
  const thicknesses = (canvas) => {
    const rows = canvas.toAscii("#", ".").split("\n");
    const inner = (row) => row.slice(TRP100.margin, TRP100.widthPixels - TRP100.margin);
    const runs = [];
    let run = 0;
    for (const row of rows) {
      if (inner(row).indexOf(".") === -1) run++;
      else if (run) {
        runs.push(run);
        run = 0;
      }
    }
    if (run) runs.push(run);
    return runs;
  };

  assert.deepEqual(
    thicknesses(renderTicket("Bonjour", { id: 1, createdAt: 0, profile: TRP100 })),
    [2, 1],
    "the title's rule must come first, and it is the thick one"
  );

  // The same ticket through a rotated profile, to prove this assertion can
  // actually fail rather than being true of any ticket at all.
  assert.deepEqual(
    thicknesses(
      renderTicket("Bonjour", {
        id: 1,
        createdAt: 0,
        profile: { ...TRP100, flip180: true },
      })
    ),
    [1, 2]
  );
});

// --- batches ----------------------------------------------------------------

test("a batch never mixes widths", () => {
  const strip = new Canvas(512);
  const other = new Canvas(384);
  other.feed(1);
  assert.throws(() => strip.append(other), /cannot append/);
});

test("the strip is transmitted in RENDER order when it is not rotated", () => {
  const jobs = [job(1), job(2), job(3)];
  const built = buildBatchPayload(jobs, SETTINGS, TRP100);
  const spans = built.payload.spans;

  assert.deepEqual(
    spans.map((s) => s.id),
    [1, 2, 3]
  );
  // First ticket first: its bytes leave before anyone else's.
  assert.equal(spans[0].start, 0);
  assert.ok(spans[0].start < spans[1].start);
  assert.ok(spans[1].start < spans[2].start);
});

test("and in REVERSE order when it is", () => {
  const jobs = [job(1), job(2), job(3)];
  const built = buildBatchPayload(jobs, SETTINGS, MXW01);
  const spans = built.payload.spans;

  assert.deepEqual(
    spans.map((s) => s.id),
    [1, 2, 3]
  );
  // The ticket rendered first is transmitted LAST, because rotate180 reverses
  // the rows of the whole strip.
  assert.ok(spans[0].start > spans[1].start);
  assert.ok(spans[1].start > spans[2].start);
  assert.equal(spans[2].start, 0);
});

test("a device that stops early reached the right tickets, on both", () => {
  // The rescue rule in completeBatch is `start >= sent` means never reached.
  // It has to be true under both orderings, or a partial failure requeues the
  // tickets that printed and writes off the ones that did not.
  for (const profile of [MXW01, TRP100]) {
    const built = buildBatchPayload([job(1), job(2), job(3)], SETTINGS, profile);
    const { spans, lines } = built.payload;
    // Stop one line into the strip: everything but the first-transmitted
    // ticket must be rescuable.
    const rescued = spans.filter((s) => s.start >= 1).map((s) => s.id);
    assert.equal(rescued.length, 2, `${profile.id}: expected 2 rescued, got ${rescued.length}`);
    // And a transfer that completed rescues nobody.
    assert.equal(spans.filter((s) => s.start >= lines).length, 0);
  }
});

test("every ticket carries its own height, whichever way the strip runs", () => {
  for (const profile of [MXW01, TRP100]) {
    const built = buildBatchPayload([job(1), job(2), job(3)], SETTINGS, profile);
    const spans = built.payload.spans;
    for (const span of spans) {
      assert.ok(span.lines > 0, `${profile.id}: ticket ${span.id} has no height`);
    }
    // The heights account for the whole strip, separators included: a ticket
    // after the first carries the separator above it. That is deliberate -
    // the paper gauge wants the paper a ticket cost, and the separator is
    // paper - and it is what the gauge assumed before spans carried heights.
    assert.equal(
      spans.reduce((sum, s) => sum + s.lines, 0),
      built.payload.lines,
      `${profile.id}: heights do not add up to the strip`
    );
    // The first ticket pays for no separator; the others do.
    const separator = 2 * LAYOUT.batchGap + 1;
    assert.ok(spans[1].lines - spans[0].lines >= separator - 1);
  }
});

// --- payloads ---------------------------------------------------------------

test("a payload says which printer it was rendered for", () => {
  const payload = buildPayload({ id: 1, text: "Bonjour", created_at: 0 }, SETTINGS, TRP100);
  assert.equal(payload.profile, "trp100");
  assert.equal(payload.width_bytes, 64);
  assert.equal(payload.width_pixels, 512);
  assert.equal(payload.data.length % 4, 0);
});

test("and the default payload is still the Pico's, byte for byte", () => {
  const payload = buildPayload({ id: 1, text: "Bonjour", created_at: 0 }, SETTINGS);
  assert.equal(payload.profile, "mxw01");
  assert.equal(payload.width_bytes, 48);
});

test("feed_lines falls back to the profile when the setting is blank", () => {
  assert.equal(
    buildPayload({ id: 1, text: "x", created_at: 0 }, SETTINGS, TRP100).feed_lines,
    TRP100.feedLines
  );
  assert.equal(
    buildPayload({ id: 1, text: "x", created_at: 0 }, SETTINGS, MXW01).feed_lines,
    MXW01.feedLines
  );
});

test("a set feed_lines wins over the profile", () => {
  const settings = { ...SETTINGS, [feedLinesKey(TRP100)]: "42" };
  assert.equal(
    buildPayload({ id: 1, text: "x", created_at: 0 }, settings, TRP100).feed_lines,
    42
  );
});

test("one printer's tear-off feed is never applied to the other", () => {
  // The trap this key was split to defuse. `feed_lines` held 7 - the MXW01's
  // head-to-bar distance, right for that machine - and a settings row beats
  // any default in the code. Seven dots on the TRP 100 III is one millimetre,
  // so every ticket would have come out still under the print head, with
  // nothing in any log to say why.
  const settings = { ...SETTINGS, feed_lines: "7", [feedLinesKey(MXW01)]: "7" };
  const onTheBigOne = buildPayload({ id: 1, text: "x", created_at: 0 }, settings, TRP100);
  assert.equal(onTheBigOne.feed_lines, TRP100.feedLines);
  assert.ok(
    onTheBigOne.feed_lines / TRP100.dotsPerMm > 5,
    "the ticket has to clear the tear bar"
  );

  const onTheSmallOne = buildPayload({ id: 1, text: "x", created_at: 0 }, settings, MXW01);
  assert.equal(onTheSmallOne.feed_lines, 7);
});

test("feed_lines is never zero, whatever the settings row says", () => {
  // A ticket still under the print head cannot be torn off (ETAT 2.10). A
  // hand-edited settings row must not be able to produce one.
  for (const bad of ["0", "-5", "nonsense", ""]) {
    const settings = { ...SETTINGS, [feedLinesKey(TRP100)]: bad };
    const payload = buildPayload({ id: 1, text: "x", created_at: 0 }, settings, TRP100);
    assert.ok(payload.feed_lines > 0, `feed_lines was ${payload.feed_lines} for ${bad}`);
  }
});

test("the line ceiling is the host's, not a global one", () => {
  // 1024 is the Pico's RAM. Telling the Raspberry Pi the same thing would cap
  // a strip at an eighth of what the machine can print.
  assert.equal(MXW01.maxLines, 1024);
  assert.ok(TRP100.maxLines > 4000);
});

// --- the paused printer must still work -------------------------------------

/**
 * Rendered output, pinned per font.
 *
 * These are fixed points for the renderer, and the renderer alone: the bytes
 * depend on which atlas is built, so the table is keyed by it. Changing the
 * ticket font is a supported thing to do - `build_font.py --preset terminal` -
 * and it must be a DELIBERATE act with a row added here, not a test that
 * quietly goes green because somebody re-pinned it to its own output.
 *
 * Where each row came from, because provenance is the whole value:
 *
 *   GoogleSansCode-Regular  Not this file's own output. Taken by checking out
 *                           worker/src/{bitmap,render,font,font-atlas}.js at
 *                           072c8fe - the last commit before the switch - and
 *                           rendering the same two tickets against it.
 *   JetBrainsMono-Regular   This file's own output, at the commit that added
 *                           the row, because this font had never shipped and
 *                           so there is no earlier state to appeal to. It
 *                           guards every refactor from that commit onward,
 *                           which is what a golden test does; it cannot also
 *                           guard the switch that introduced it.
 */
const SHIPPED = {
  "GoogleSansCode-Regular": [["Bonjour", 58, 0x74], ["Le petit chat", 58, 0x9c]],
  "JetBrainsMono-Regular": [["Bonjour", 57, 0xcf], ["Le petit chat", 57, 0x43]],
};

test("the small printer still renders exactly as it shipped", () => {
  // The MXW01 work is what is going out as open source. A refactor done for
  // another machine is exactly how it would quietly stop working.
  const expected = SHIPPED[ATLAS.name];
  assert.ok(expected,
    `no pinned rendering for the atlas in worker/src/font-atlas.js (${ATLAS.name}).\n` +
    `Add a row to SHIPPED above with the height and crc8 this build produces, ` +
    `and say in the comment where the numbers came from. Do not delete this test.`);
  for (const [text, lines, crc] of expected) {
    const canvas = renderTicket(text, { id: 1, createdAt: 0, profile: MXW01 });
    assert.equal(canvas.height, lines, `${text}: height`);
    assert.equal(canvas.crc8(), crc, `${text}: crc`);
    assert.equal(canvas.widthBytes, 48);
  }
});

test("the pinned renderings cover the atlas that is actually built", () => {
  // The guard on the guard. Without it, a font change that nobody adds a row
  // for turns the test above into a single assert.ok that passes on any
  // rendering at all - which is the failure mode this project has already paid
  // for twice: an assertion whose subject drifted away from its own subject.
  assert.ok(ATLAS.name in SHIPPED,
    `worker/src/font-atlas.js ships ${ATLAS.name}, which SHIPPED does not pin`);
});

// --- the thank-yous-only mode -----------------------------------------------

test("supporters jump the queue, whatever the mode", () => {
  // Not a nicety. A priority ticket that arrives behind four thousand queued
  // messages is not a thank-you, and the person who paid is most likely
  // watching the queue counter while it does not move.
  const sql = readFileSync(new URL("../src/jobs.js", import.meta.url), "utf8");
  assert.match(sql, /ORDER BY \(s\.job_id IS NOT NULL\) DESC/);
});

test("only_supporters is off by default, and is a flag", () => {
  // Off, because a mode that silences four thousand messages should never be
  // something a fresh database arrives in.
  assert.equal(DEFAULTS_ONLY_SUPPORTERS, "0");
});

test("the long poll asks the same question the claim will answer", () => {
  // The bug this guards: if the waiting loop ignores only_supporters, it
  // returns the instant ANY job is approved, the claim then finds nothing it
  // may hand out, the device gets a 204 and comes straight back. That is a hot
  // loop against D1 for as long as the mode is on - and with a full queue,
  // that is forever. It would look like "the agent is very busy doing nothing".
  const index = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
  assert.match(index, /anythingApproved\(env\.DB, onlySupporters\)/);
  assert.match(index, /JOIN supporters s ON s\.job_id = j\.id/);
});
