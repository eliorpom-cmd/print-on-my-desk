// A batch is several tickets on one strip, printed in one go so the printer's
// end-of-print eject is paid once instead of once per message.
//
// The whole feature turns on one thing being right: the order the tickets come
// out in. renderTicket rotates every ticket 180 degrees, and rotate180
// reverses row order, so concatenating already-rotated tickets prints them
// back to front. These tests exist because that failure is silent - the strip
// looks perfectly well formed, it is just in the wrong order.

import { test } from "node:test";
import assert from "node:assert/strict";

import { renderTicket, renderBatch, composeTicket, LAYOUT } from "../src/render.js";
import { buildBatchPayload, MAX_LINES } from "../src/jobs.js";

const SETTINGS = { intensity: 93, feed_lines: 12 };

function job(id, text, handle = null) {
  // A fixed date: shortDate goes on the ticket, and a moving one would make
  // the byte comparisons below depend on the clock.
  return { id, text, created_at: Date.UTC(2026, 7, 30, 12, 0, 0), handle };
}

function rowsOf(canvas) {
  return canvas.rows.map((row) => Buffer.from(row).toString("hex"));
}

test("a batch of one is byte for byte the ticket on its own", () => {
  const one = job(7, "Un seul message.");
  const batch = renderBatch([one]);
  const single = renderTicket(one.text, {
    id: one.id,
    createdAt: one.created_at,
    handle: one.handle,
  });
  assert.deepEqual(rowsOf(batch), rowsOf(single));
});

test("the first ticket of a batch is printed last", () => {
  // The printer pushes the first line it receives furthest out, so the tail of
  // the transmission is what ends up nearest the head - and after the 180
  // degree rotation that tail is the TOP of the first ticket. Concatenating
  // rotated tickets instead would put the last ticket's top there.
  const first = job(1, "PREMIER");
  const last = job(2, "DERNIER");
  const strip = renderBatch([first, last]);

  const firstAlone = renderTicket(first.text, {
    id: first.id,
    createdAt: first.created_at,
  });
  const tail = rowsOf(strip).slice(-firstAlone.height);
  assert.deepEqual(
    tail,
    rowsOf(firstAlone),
    "the end of the strip must be the whole of the first ticket"
  );
});

// The printer ejects roughly 3 cm of its own accord at the end of every print
// (docs/09-protocol.md §7.3). At 8 dots/mm that is about 240 lines of paper
// per print, which dwarfs anything the layout does - and it is the entire
// reason batches exist. Approximate on purpose: the eject has never been
// measured precisely, only observed.
const EJECT_LINES = 240;

test("a batch saves an eject margin per ticket", () => {
  const jobs = [job(1, "Alpha"), job(2, "Beta"), job(3, "Gamma")];
  const strip = renderBatch(jobs);
  const apart = jobs.reduce(
    (total, j) =>
      total + renderTicket(j.text, { id: j.id, createdAt: j.created_at }).height,
    0
  );

  // The strip is a little taller in ink - it keeps each ticket's padding and
  // adds a separator per join - and that is fine. What matters is the total
  // paper, ejects included.
  const paperApart = apart + jobs.length * EJECT_LINES;
  const paperStrip = strip.height + EJECT_LINES;
  // Three short tickets: 609 lines against 1035, a 41% saving, and the ratio
  // only improves with the size of the batch because the eject is paid once
  // however many tickets ride along.
  assert.ok(
    paperStrip < paperApart * 0.7,
    `strip costs ${paperStrip} lines of paper, three prints cost ${paperApart}`
  );
});

test("tickets stay separated by a dashed tear line", () => {
  // Since the titles and reference lines went, this is the only thing marking
  // where one message ends and the next begins.
  const one = renderBatch([job(1, "Alpha")]);
  const two = renderBatch([job(1, "Alpha"), job(2, "Beta")]);

  const dashed = (canvas) =>
    canvas.rows.filter((row) => {
      const ink = row.reduce(
        (n, byte) => n + byte.toString(2).split("1").length - 1,
        0
      );
      // A dashed rule inks roughly half the width; a line of text far less,
      // and a solid rule far more.
      return ink > 120 && ink < 260;
    }).length;

  assert.equal(dashed(one), 0, "a lone ticket needs no separator");
  assert.equal(dashed(two), 1, "two tickets are parted by exactly one");
});

test("the line budget is enforced, and the overflow is handed back", () => {
  // ~395 lines each: two share a strip, four cannot.
  const fat = "x ".repeat(150);
  const jobs = [job(1, fat), job(2, fat), job(3, fat), job(4, fat)];
  const built = buildBatchPayload(jobs, SETTINGS);
  assert.ok(built.payload.lines <= MAX_LINES, "strip must fit the Pico's RAM");
  assert.ok(built.included.length >= 1, "at least one ticket must go");
  assert.equal(
    built.included.length + built.leftOver.length,
    jobs.length,
    "every claimed job is either sent or handed back"
  );
  assert.deepEqual(
    built.payload.ids,
    built.included.map((j) => j.id),
    "the payload names exactly the tickets on the strip"
  );
});

test("a single ticket over the cap throws rather than looping forever", () => {
  const enormous = job(1, "y ".repeat(6000));
  assert.throws(() => buildBatchPayload([enormous], SETTINGS), /line cap/);
});

test("the payload keeps a single id for the logs", () => {
  const jobs = [job(11, "un"), job(12, "deux")];
  const built = buildBatchPayload(jobs, SETTINGS);
  assert.equal(built.payload.id, 11);
  assert.deepEqual(built.payload.ids, [11, 12]);
});

test("renderTicket is composeTicket rotated, and the rotation is real", () => {
  const when = Date.UTC(2026, 7, 30, 12, 0, 0);
  const upright = composeTicket("Alpha", { id: 1, createdAt: when });
  const sent = renderTicket("Alpha", { id: 1, createdAt: when });

  // Not a tautology: comparing the first rows would compare two runs of blank
  // padding and pass whatever the rotation did.
  assert.notDeepEqual(rowsOf(upright), rowsOf(sent), "the rotation must do something");

  // The title band sits at the top of the upright canvas, and must end up at
  // the bottom of the transmitted one. Ink per row is enough to locate it and
  // survives the horizontal mirroring.
  const ink = (canvas) =>
    canvas.rows.map((row) => row.reduce((n, byte) => n + byte.toString(2).replace(/0/g, "").length, 0));
  // rotate180 reverses the rows, then trimTail eats what is now the tail -
  // the topPad that used to be at the very top of the upright canvas.
  assert.deepEqual(ink(sent), ink(upright).reverse().slice(0, sent.height));
});

test("max_batch_lines caps the strip without blocking a lone long ticket", () => {
  const jobs = [job(1, "Alpha"), job(2, "Beta"), job(3, "Gamma")];
  // Tighter than before: a stripped ticket is a third of its old height, so a
  // 200-line budget no longer splits three short messages.
  const tight = buildBatchPayload(jobs, { ...SETTINGS, max_batch_lines: 60 });
  assert.ok(
    tight.payload.ids.length < jobs.length,
    "a tight budget must split the batch"
  );
  assert.ok(tight.leftOver.length > 0, "the rest is handed back");

  // A budget of 1 turns batching off rather than deadlocking the queue: one
  // ticket still goes, because a ticket that fits no budget would never print.
  const off = buildBatchPayload(jobs, { ...SETTINGS, max_batch_lines: 1 });
  assert.equal(off.payload.ids.length, 1);
  assert.equal(off.leftOver.length, 2);
});

test("the RAM bound still wins over a generous setting", () => {
  const jobs = [job(1, "x ".repeat(150)), job(2, "x ".repeat(150)),
                job(3, "x ".repeat(150)), job(4, "x ".repeat(150))];
  const built = buildBatchPayload(jobs, { ...SETTINGS, max_batch_lines: 99999 });
  assert.ok(built.payload.lines <= MAX_LINES);
});
