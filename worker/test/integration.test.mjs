// Integration tests: real SQL, real engine, no hand-written fake database.
//
// Every test in here corresponds to something that actually broke on
// 30 August and was found in production rather than by the suite.

import { test } from "node:test";
import assert from "node:assert/strict";

import { makeDb } from "./helpers/d1.mjs";
import {
  claimBatch,
  releaseJobs,
  completeBatch,
  completeJob,
  sweepStaleLeases,
  buildBatchPayload,
} from "../src/jobs.js";
import {
  requeueFailed,
  searchJobs,
  reprint,
  paperUsed,
  decideMany,
  decideAllPending,
} from "../src/admin.js";
import { record, recent, sweepEvents, failureBurst } from "../src/events.js";

const DEV = "pico-1";
const SETTINGS = { intensity: 93, feed_lines: 12, max_batch_lines: 900 };

// --- the refusal that consumed attempts ------------------------------------

test("a refused batch goes back with its attempt refunded", async () => {
  // The bug that killed tickets 173 and 174: the head stayed above 38 C, the
  // same strip was refused three times in 45 seconds, and attempts hit 3.
  const db = makeDb();
  db.seed([{ id: 1, status: "printing", claimed_by: DEV, attempts: 1 }]);

  const out = await completeBatch(db, {
    ids: [1],
    deviceId: DEV,
    ok: false,
    error: "printer too hot",
    retry: true,
  });

  assert.equal(out.retrying, true);
  const job = db.job(1);
  assert.equal(job.status, "approved", "it must go back in the queue");
  assert.equal(job.attempts, 0, "a refusal is not an attempt at the paper");
});

test("three refusals in a row still leave the ticket printable", async () => {
  const db = makeDb();
  db.seed([{ id: 1, status: "printing", claimed_by: DEV, attempts: 1 }]);
  for (let i = 0; i < 5; i++) {
    await completeBatch(db, {
      ids: [1], deviceId: DEV, ok: false, error: "printer too hot", retry: true,
    });
    db.raw.prepare("UPDATE jobs SET status='printing', claimed_by=?, attempts=attempts+1 WHERE id=1").run(DEV);
  }
  assert.notEqual(db.job(1).status, "failed", "a hot head must never be terminal");
});

// --- the strip that took everyone down -------------------------------------

test("only the tickets that were reached are given up on", async () => {
  // A strip is transmitted in reverse render order, so a transfer that stops
  // after N lines reached the END of the array, not the start.
  const db = makeDb();
  db.seed([
    { id: 1, status: "printing", claimed_by: DEV, attempts: 1 },
    { id: 2, status: "printing", claimed_by: DEV, attempts: 1 },
    { id: 3, status: "printing", claimed_by: DEV, attempts: 1 },
  ]);

  // id 3 goes out first (start 0), then id 2, then id 1.
  const spans = [
    { id: 1, start: 264 },
    { id: 2, start: 132 },
    { id: 3, start: 0 },
  ];

  const out = await completeBatch(db, {
    ids: [1, 2, 3],
    deviceId: DEV,
    ok: false,
    error: "EALREADY",
    retry: false,
    sentLines: 140,
    spans,
  });

  assert.deepEqual(out.rescued, [1], "only #1 never started going out");
  assert.equal(db.job(1).status, "approved");
  assert.equal(db.job(2).status, "failed", "#2 was half printed");
  assert.equal(db.job(3).status, "failed", "#3 printed");
});

test("a transfer that sent nothing rescues the whole strip", async () => {
  const db = makeDb();
  db.seed([
    { id: 1, status: "printing", claimed_by: DEV },
    { id: 2, status: "printing", claimed_by: DEV },
  ]);
  const out = await completeBatch(db, {
    ids: [1, 2],
    deviceId: DEV,
    ok: false,
    error: "boom",
    retry: false,
    sentLines: 0,
    spans: [{ id: 1, start: 132 }, { id: 2, start: 0 }],
  });
  assert.deepEqual(out.rescued.sort(), [1, 2]);
});

test("without spans it still fails closed rather than duplicating", async () => {
  // Old firmware, or an unknown error: no evidence means no rescue, because a
  // wrong guess here prints somebody's message twice.
  const db = makeDb();
  db.seed([{ id: 1, status: "printing", claimed_by: DEV }]);
  await completeBatch(db, {
    ids: [1], deviceId: DEV, ok: false, error: "boom", retry: false,
  });
  assert.equal(db.job(1).status, "failed");
});

// --- claiming ---------------------------------------------------------------

test("claimBatch takes the oldest, in order, and only the approved", async () => {
  const db = makeDb();
  db.seed([
    { id: 3, created_at: 300 },
    { id: 1, created_at: 100 },
    { id: 2, created_at: 200 },
    { id: 9, created_at: 50, status: "rejected" },
  ]);
  const rows = await claimBatch(db, DEV, 2);
  assert.deepEqual(rows.map((r) => r.id), [1, 2]);
  assert.equal(db.job(3).status, "approved", "the rest stays queued");
  assert.equal(db.job(9).status, "rejected", "a rejected job is never claimed");
});

test("released jobs come back with their attempt refunded", async () => {
  const db = makeDb();
  db.seed([{ id: 1 }, { id: 2 }]);
  await claimBatch(db, DEV, 2);
  assert.equal(db.job(2).attempts, 1);
  await releaseJobs(db, [2], DEV);
  assert.equal(db.job(2).status, "approved");
  assert.equal(db.job(2).attempts, 0, "it was never sent anywhere");
});

test("a device cannot complete a job it does not hold", async () => {
  const db = makeDb();
  db.seed([{ id: 1, status: "printing", claimed_by: "someone-else" }]);
  const out = await completeBatch(db, { ids: [1], deviceId: DEV, ok: true });
  assert.equal(out.changed, 0);
  assert.equal(db.job(1).status, "printing");
});

test("a stale lease is swept, and a fresh one is not", async () => {
  const db = makeDb();
  const now = 1756000000000;
  db.seed([
    { id: 1, status: "printing", claimed_by: DEV, claimed_at: now - 5 * 60 * 1000 },
    { id: 2, status: "printing", claimed_by: DEV, claimed_at: now - 1000 },
  ]);
  await sweepStaleLeases(db, now);
  assert.equal(db.job(1).status, "failed");
  assert.equal(db.job(2).status, "printing");
});

// --- recovery ---------------------------------------------------------------

test("requeueFailed puts everything back and only what failed", async () => {
  const db = makeDb();
  db.seed([
    { id: 1, status: "failed", attempts: 3 },
    { id: 2, status: "failed", attempts: 3 },
    { id: 3, status: "printed" },
    { id: 4, status: "rejected" },
  ]);
  const n = await requeueFailed(db);
  assert.equal(n, 2);
  assert.equal(db.job(1).status, "approved");
  assert.equal(db.job(1).attempts, 0);
  assert.equal(db.job(3).status, "printed", "a printed ticket is left alone");
  assert.equal(db.job(4).status, "rejected", "so is a rejected one");
});

test("a rejected message can be forced to print, and the reason survives", async () => {
  const db = makeDb();
  db.seed([{ id: 1, status: "rejected" }]);
  db.moderation([{ job_id: 1, verdict: "rejected", source: "spam", reason: "link" }]);

  assert.equal(await reprint(db, 1, 999), true);
  assert.equal(db.job(1).status, "approved");

  const m = db.raw.prepare("SELECT * FROM moderation WHERE job_id = 1").get();
  assert.equal(m.verdict, "approved");
  assert.equal(m.reviewed_by, "admin");
  assert.equal(m.source, "spam", "what flagged it must survive the override");
  assert.equal(m.reason, "link");
});

// --- the archive ------------------------------------------------------------

test("search finds by substring and never returns pending", async () => {
  const db = makeDb();
  db.seed([
    { id: 1, text: "bonjour le monde", status: "printed" },
    { id: 2, text: "au revoir", status: "rejected" },
    { id: 3, text: "bonjour encore", status: "pending" },
  ]);
  const found = await searchJobs(db, { q: "bonjour" });
  assert.deepEqual(found.rows.map((r) => r.id), [1]);
  assert.equal(found.total, 1);
});

test("a percent sign in the query does not match everything", async () => {
  const db = makeDb();
  db.seed([
    { id: 1, text: "100% sur", status: "printed" },
    { id: 2, text: "rien a voir", status: "printed" },
  ]);
  const found = await searchJobs(db, { q: "100%" });
  assert.deepEqual(found.rows.map((r) => r.id), [1]);
});

test("the spam filter reads moderation, not status", async () => {
  const db = makeDb();
  db.seed([
    { id: 1, status: "rejected" },
    { id: 2, status: "rejected" },
    { id: 3, status: "printed" },
  ]);
  db.moderation([
    { job_id: 1, source: "spam" },
    { job_id: 2, source: "ai" },
    { job_id: 3, source: "ai", verdict: "approved" },
  ]);
  const found = await searchJobs(db, { status: "spam" });
  assert.deepEqual(found.rows.map((r) => r.id), [1]);
});

// --- paper ------------------------------------------------------------------

test("the paper gauge counts only what printed since the roll changed", async () => {
  const db = makeDb();
  db.seed([
    { id: 1, status: "printed", lines: 800, printed_at: 500 },
    { id: 2, status: "printed", lines: 800, printed_at: 1500 },
    { id: 3, status: "approved", lines: 800 },
  ]);
  const paper = await paperUsed(db, { roll_changed_at: "1000", roll_length_m: "10" });
  assert.equal(paper.tickets, 1, "the one before the roll change does not count");
  // 800 lines at 8/mm is 100 mm, plus one eject margin.
  assert.equal(paper.usedMm, 130);
  assert.equal(paper.leftMm, 10000 - 130);
});

test("a roll length of zero turns the estimate off rather than guessing", async () => {
  const db = makeDb();
  const paper = await paperUsed(db, { roll_changed_at: "0", roll_length_m: "0" });
  assert.equal(paper.leftMm, null);
});

// --- events -----------------------------------------------------------------

test("events are recorded, read back newest first, and bounded", async () => {
  const db = makeDb();
  for (let i = 0; i < 12; i++) {
    await record(db, "print_failed", { detail: "n" + i }, 1000 + i);
  }
  const rows = await recent(db, 5);
  assert.equal(rows.length, 5);
  assert.equal(rows[0].detail, "n11", "newest first");

  const removed = await sweepEvents(db, 4);
  assert.equal(removed, 8);
  assert.equal((await recent(db, 50)).length, 4);
});

test("recording an event never throws, whatever the database does", async () => {
  const broken = { prepare() { throw new Error("D1 is down"); } };
  await record(broken, "note", { detail: "x" });
});

test("the failure burst counts only failures, only inside the window", async () => {
  const db = makeDb();
  const now = 1756000000000;
  await record(db, "print_failed", {}, now - 60 * 1000);
  await record(db, "print_failed", {}, now - 120 * 1000);
  await record(db, "print_ok", {}, now - 60 * 1000);
  await record(db, "print_failed", {}, now - 60 * 60 * 1000);
  assert.equal(await failureBurst(db, 15 * 60 * 1000, now), 2);
});

// --- the strip itself -------------------------------------------------------

test("spans really describe the transmission order", async () => {
  // The one that would print a batch back to front if it were wrong.
  const jobs = [1, 2, 3].map((id) => ({
    id, text: "ticket " + id, created_at: 1756000000000, handle: null,
  }));
  const built = buildBatchPayload(jobs, SETTINGS);
  const spans = built.payload.spans;
  assert.equal(spans[spans.length - 1].start, 0, "the last drawn goes out first");
  for (let i = 1; i < spans.length; i++) {
    assert.ok(spans[i - 1].start > spans[i].start, "starts descend with render order");
  }
  assert.ok(spans[0].start < built.payload.lines);
});

// --- bulk review ------------------------------------------------------------

test("a bulk approval moves every pending message and nothing else", async () => {
  const db = makeDb();
  db.seed([
    { id: 1, status: "pending" },
    { id: 2, status: "pending" },
    { id: 3, status: "printed" },
    { id: 4, status: "rejected" },
  ]);
  db.moderation([
    { job_id: 1, verdict: "pending", source: "ai" },
    { job_id: 2, verdict: "pending", source: "ai" },
  ]);

  const n = await decideMany(db, [1, 2, 3, 4], "approve", "admin", 999);
  assert.equal(n, 2, "only the pending ones count");
  assert.equal(db.job(1).status, "approved");
  assert.equal(db.job(2).status, "approved");
  assert.equal(db.job(3).status, "printed", "a printed ticket is untouched");
  assert.equal(db.job(4).status, "rejected", "so is a rejected one");

  const m = db.raw.prepare("SELECT * FROM moderation WHERE job_id = 1").get();
  assert.equal(m.verdict, "approved");
  assert.equal(m.reviewed_by, "admin");
  assert.equal(m.reviewed_at, 999);
});

test("a bulk decision cannot overwrite one already made", async () => {
  // The double tap, or the notification opened on a phone and a laptop.
  const db = makeDb();
  db.seed([{ id: 1, status: "approved" }]);
  db.moderation([{ job_id: 1, verdict: "approved", source: "admin" }]);
  const n = await decideMany(db, [1], "reject");
  assert.equal(n, 0);
  assert.equal(db.job(1).status, "approved", "the earlier decision stands");
});

test("a bulk rejection clears the expiry like the single form does", async () => {
  const db = makeDb();
  db.seed([{ id: 1, status: "pending" }]);
  db.raw.prepare("UPDATE jobs SET expires_at = 12345 WHERE id = 1").run();
  await decideMany(db, [1], "reject");
  assert.equal(db.job(1).status, "rejected");
  assert.equal(db.job(1).expires_at, null);
});

test("an empty selection does nothing at all", async () => {
  const db = makeDb();
  db.seed([{ id: 1, status: "pending" }]);
  assert.equal(await decideMany(db, [], "approve"), 0);
  assert.equal(db.job(1).status, "pending");
});

test("a hundred and fifty at once is one decision, not a hundred and fifty", async () => {
  const db = makeDb();
  const jobs = [];
  for (let i = 1; i <= 150; i++) jobs.push({ id: i, status: "pending" });
  db.seed(jobs);
  const n = await decideMany(db, jobs.map((j) => j.id), "approve");
  assert.equal(n, 150);
  assert.equal(
    db.all("SELECT id FROM jobs WHERE status = 'approved'").length,
    150
  );
});

test("the whole queue can be decided without listing it", async () => {
  // 377 waiting and a page that shows 500 is fine; 3000 is not, and sending
  // three thousand ids from a phone to say "all of them" is silly.
  const db = makeDb();
  const jobs = [];
  for (let i = 1; i <= 300; i++) jobs.push({ id: i, status: "pending" });
  jobs.push({ id: 900, status: "printed" }, { id: 901, status: "rejected" });
  db.seed(jobs);

  const n = await decideAllPending(db, "approve");
  assert.equal(n, 300);
  assert.equal(db.job(900).status, "printed", "a printed ticket is untouched");
  assert.equal(db.job(901).status, "rejected", "so is a rejected one");
  assert.equal(
    db.all("SELECT id FROM jobs WHERE status = 'pending'").length,
    0
  );
});

test("the wait estimate stays quiet on a short queue and coarse on a long one", async () => {
  // Not a queue position - that is deliberately never shown - but a promise of
  // paper "on its way" is a small lie when the paper is four days out.
  const { phraseFor } = await import("../src/wait.js");

  assert.equal(phraseFor(0), null, "an empty queue says nothing");
  assert.equal(phraseFor(60), null, "sixty waiting is not worth a warning");

  // A thousand used to be days. It is not any more, and the test said so
  // before the estimate did: the MXW01 managed about 76 tickets an hour, the
  // TRP 100 III printed four thousand in well under one. Asserting the old
  // rate would have kept the page promising "about a week" for a backlog that
  // clears in an evening.
  assert.match(phraseFor(1400), /today|tomorrow/, "a thousand is one evening");
  assert.match(phraseFor(14000), /days|week/, "tens of thousands is still days");
});

test("the wait estimate reads the queue's own length, and never counts it", async () => {
  // This is the D1 bill of 1 September, as a test. The estimate used to run a
  // COUNT over the queue per submitted message; now the queue keeps its length
  // and this reads one row. The assertion is on the SQL because that is what
  // the free tier is billed for.
  const { waitEstimate } = await import("../src/wait.js");
  const { reseedCounters } = await import("../src/counters.js");

  const db = makeDb();
  const rows = [];
  for (let i = 1; i <= 1400; i++) rows.push({ id: i, status: "pending" });
  db.seed(rows);

  // The first call finds no counter and pays for one count, which is what
  // makes this safe to deploy against a database that predates the table.
  assert.match(await waitEstimate(db), /today|tomorrow/);

  const seen = [];
  const spy = { prepare: (sql) => (seen.push(sql), db.prepare(sql)) };
  assert.match(await waitEstimate(spy), /today|tomorrow/);
  assert.equal(seen.length, 1, "one statement");
  assert.match(seen[0], /FROM counters/, "and it reads the counter, not the queue");
  assert.ok(!/FROM jobs/.test(seen[0]), "nothing may scan the queue here");

  // And the counter follows the queue, because the cron reconciles it.
  const many = [];
  for (let i = 2000; i < 14000; i++) many.push({ id: i, status: "pending" });
  db.seed(many);
  await reseedCounters(db, Date.now(), true);
  assert.match(await waitEstimate(db), /days|week/);
});

test("printed and rejected messages are not counted as waiting", async () => {
  const db = makeDb();
  const rows = [];
  for (let i = 1; i <= 500; i++) rows.push({ id: i, status: "printed" });
  for (let i = 501; i <= 900; i++) rows.push({ id: i, status: "rejected" });
  db.seed(rows);
  const { waitEstimate } = await import("../src/wait.js");
  assert.equal(await waitEstimate(db), null, "nothing is actually waiting");
});

test("a thermal refusal is not counted as a failure", async () => {
  // Eleven alerts went out on the first evening for these. They send nothing,
  // lose nothing, requeue themselves, and happen several times an hour: they
  // are the machine working, not a fault.
  const db = makeDb();
  const now = 1756000000000;
  await record(db, "print_refused", { detail: "printer too hot" }, now - 60000);
  await record(db, "print_refused", { detail: "printer too hot" }, now - 120000);
  await record(db, "print_refused", { detail: "printer too hot" }, now - 180000);
  await record(db, "print_refused", { detail: "printer too hot" }, now - 240000);
  assert.equal(await failureBurst(db, 15 * 60 * 1000, now), 0);

  await record(db, "print_failed", { detail: "EALREADY" }, now - 60000);
  assert.equal(await failureBurst(db, 15 * 60 * 1000, now), 1, "a real loss counts");
});
