// What the free tier is billed for.
//
// On 1 September this project exhausted D1's daily allowance of five million
// rows read. Nothing was down for long and nothing was lost, but the cause was
// not a spike in traffic: it was three queries whose cost grew with the length
// of the queue, run on paths that fire every few seconds forever.
//
//   * the expiry sweep, reading every pending row to find the none that had
//     expired - about seventeen million rows a day on its own;
//   * the claim, sorting the entire queue to pick one job, once per ticket;
//   * the wait estimate and the printed tally, counting rows to answer a
//     question whose answer only ever moves by one.
//
// Correctness tests would not have caught any of them. Every one of those
// queries returned exactly the right answer, which is why they survived a
// suite of 241 tests and a fortnight of review. So these tests assert cost:
// they read the query plans SQLite actually chooses, and fail on the shapes
// that read rows nobody asked for.
//
// A plan test is a strange thing to write and it earns its place here. The
// difference between the old claim and the new one is invisible in a result
// set and visible in a plan, and it is the difference between a system that
// works at five thousand queued messages and one that does not.

import { test } from "node:test";
import assert from "node:assert/strict";

import { makeDb } from "./helpers/d1.mjs";
import { claimJob, claimBatch, completeJob, completeBatch, sweepStaleLeases } from "../src/jobs.js";
import { decideMany, reprint, requeueFailed } from "../src/admin.js";
import { expirePending } from "../src/moderation.js";
import {
  bumpCounter,
  reseedCounters,
  readCounter,
  LIVE_STATUSES,
  PENDING,
  PRINTED,
  QUEUED,
} from "../src/counters.js";

const DEV = "pico-1";

/** Records every statement a piece of code prepares, and runs it for real. */
function spyOn(db) {
  const seen = [];
  return {
    seen,
    db: { ...db, prepare: (sql) => (seen.push(sql), db.prepare(sql)) },
  };
}

/**
 * The plan SQLite chooses for one statement, as one string.
 *
 * Parameters are left unbound: the planner does not need their values, and
 * binding them here would mean teaching this helper each statement's shape.
 */
function planOf(raw, sql) {
  return raw
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all()
    .map((row) => row.detail)
    .join("\n");
}

/**
 * Fails on any plan that walks the queue.
 *
 * Two shapes, and both were in the code on 1 September. `SCAN jobs` is a read
 * of every row rather than a seek to the ones wanted. `USE TEMP B-TREE FOR
 * ORDER BY` is a sort, which SQLite can only do by first reading everything
 * there is to sort - it is what an ORDER BY over a computed expression costs,
 * and no index can remove it.
 */
function assertCheap(plan, what) {
  // A bare table scan, with or without an alias. "SCAN jobs USING INDEX ..."
  // is a different animal and allowed: walking an index in the order a LIMIT
  // wants stops after the rows it asked for, and the plan cannot show that.
  assert.ok(
    !/SCAN (jobs|j)\b(?! USING)/.test(plan),
    `${what} must not scan the queue:\n${plan}`
  );
  // A sort is allowed only when nothing drives it off the queue.
  //
  // This rule is worth stating carefully, because the obvious version of it is
  // useless. The query of 1 September sorted, and its plan named
  // idx_supporters_job too - so "a sort is fine if supporters are involved"
  // would have waved the very statement this file exists to forbid.
  //
  // What actually separates them is what feeds the sort. The old one drove off
  // a jobs index range - every approved row, by status - and sorted the lot.
  // The paid pick drives off `supporters`, which holds a row per payment and
  // will not reach four figures, and reaches jobs one rowid at a time. So: if
  // there is a sort, no index on `jobs` may be feeding it.
  if (/TEMP B-TREE/.test(plan)) {
    assert.ok(
      !/idx_jobs_/.test(plan),
      `${what} may sort only what is bounded, and a jobs index is not:\n${plan}`
    );
  }
}

/** A queue long enough that a scan and a seek cannot be confused. */
function longQueue(db, n = 5000, supporters = 3) {
  const rows = [];
  for (let i = 1; i <= n; i++) rows.push({ id: i, status: "approved" });
  db.seed(rows);
  // Supporters rows on purpose, even in the tests that do not care about
  // priority: an empty table lets SQLite plan the paid pick away entirely, and
  // then the plan under test is not the plan production runs.
  //
  // They point past the end of the queue, at ids no job has, so the table is
  // populated for the planner and empty for the join. A test about cost must
  // not also change which ticket comes out.
  const insert = db.raw.prepare(
    `INSERT INTO supporters (source_id, job_id, kind, received_at)
     VALUES (?, ?, 'Donation', 0)`
  );
  for (let i = 0; i < supporters; i++) insert.run(`seed-${i}`, n + 1 + i);
  db.raw.exec("ANALYZE");
  return db;
}

test("claiming one job reads the queue's front, not the queue", async () => {
  const db = longQueue(makeDb());
  const spy = spyOn(db);

  const job = await claimJob(spy.db, DEV);
  assert.equal(job.id, 1, "still the oldest message");

  assert.ok(spy.seen.length > 0, "the claim must actually query");
  for (const sql of spy.seen) assertCheap(planOf(db.raw, sql), "a claim");
});

test("claiming a batch reads the queue's front, not the queue", async () => {
  const db = longQueue(makeDb());
  const spy = spyOn(db);

  const rows = await claimBatch(spy.db, DEV, 8);
  assert.deepEqual(
    rows.map((r) => r.id),
    [1, 2, 3, 4, 5, 6, 7, 8],
    "the eight oldest, in order"
  );

  for (const sql of spy.seen) assertCheap(planOf(db.raw, sql), "a batch claim");
});

test("a supporter still jumps the queue, and pays the supporters table for it", async () => {
  // The priority is the reason the old claim sorted, and it is the thing that
  // must survive the rewrite. Ordering by an expression over a LEFT JOIN is
  // the only shape that expresses it in one statement, and it is the shape
  // that cost twenty million rows a day.
  const db = longQueue(makeDb());
  db.raw
    .prepare(
      `INSERT INTO supporters (source_id, job_id, kind, received_at)
       VALUES ('k1', 4999, 'Donation', 0)`
    )
    .run();

  const job = await claimJob(db, DEV);
  assert.equal(job.id, 4999, "the paid ticket comes first, wherever it sits");

  const next = await claimJob(db, DEV);
  assert.equal(next.id, 1, "and then the queue resumes where it was");
});

test("the guard would have caught the query that caused all this", async () => {
  // A cost test that passes for the wrong reason is worse than no cost test,
  // and this one nearly did: the statement of 1 September sorts the whole
  // queue AND names idx_supporters_job, so a check for "supporters were
  // involved" waves it straight through.
  //
  // The exact query, kept here and nowhere else, so the rule above can be held
  // against the thing it was written for.
  const BEFORE = `SELECT j.id FROM jobs j
                    LEFT JOIN supporters s ON s.job_id = j.id
                   WHERE j.status = 'approved'
                   ORDER BY (s.job_id IS NOT NULL) DESC, j.created_at ASC, j.id ASC
                   LIMIT 1`;

  const db = longQueue(makeDb());
  const plan = planOf(db.raw, BEFORE);
  assert.match(plan, /TEMP B-TREE/, "it sorted, and that was the whole cost");
  assert.throws(
    () => assertCheap(plan, "the old claim"),
    /may sort only what is bounded/,
    "the guard has to refuse it, or it guards nothing"
  );
});

test("thank-yous-only hands out nothing else, and does not spin", async () => {
  // The failure this guards is a hot loop rather than a wrong ticket: if the
  // mode could not find a paid job but the poll said work was available, the
  // agent would ask again immediately, forever, against D1.
  const db = longQueue(makeDb(), 50);
  assert.equal(await claimJob(db, DEV, Date.now(), true), null);
  assert.equal((await claimBatch(db, DEV, 8, Date.now(), true)).length, 0);
});

test("the lease sweep looks only at what is printing", async () => {
  const db = longQueue(makeDb());
  const spy = spyOn(db);
  await sweepStaleLeases(spy.db);
  for (const sql of spy.seen) {
    if (/counters/.test(sql)) continue;
    assertCheap(planOf(db.raw, sql), "the lease sweep");
  }
});

test("the expiry sweep reads nothing while expiry is switched off", async () => {
  // The exact query of 1 September. Both TTLs have been 0 since 29 August, so
  // no job carries an expires_at and this matches nothing - but "matches
  // nothing" was not "reads nothing" until the partial index existed.
  const db = longQueue(makeDb());
  db.raw.prepare("UPDATE jobs SET status = 'pending'").run();
  db.raw.exec("ANALYZE");

  const spy = spyOn(db);
  assert.equal(await expirePending(spy.db), 0);

  const select = spy.seen.find((sql) => /^SELECT/.test(sql.trim()));
  const plan = planOf(db.raw, select);
  assert.match(plan, /idx_jobs_expiring/, "the partial index must be the one used");
  assertCheap(plan, "the expiry sweep");
});

// --- the counters ----------------------------------------------------------

/** What the counters claim, against what the jobs table actually holds. */
function truth(db) {
  const pending = db.raw
    .prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'pending'")
    .get().n;
  const printed = db.raw
    .prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'printed'")
    .get().n;
  const queued = db.raw
    .prepare(
      `SELECT COUNT(*) AS n FROM jobs WHERE status IN (${LIVE_STATUSES.map(
        (s) => `'${s}'`
      ).join(",")})`
    )
    .get().n;
  return { printed, queued, pending };
}

async function claimed(db) {
  return {
    printed: await readCounter(db, PRINTED),
    queued: await readCounter(db, QUEUED),
    pending: await readCounter(db, PENDING),
  };
}

test("the counters survive a whole message life cycle without drifting", async () => {
  // The one real risk of keeping a number instead of counting it: a transition
  // somewhere that forgets to write. This walks every path a message can take
  // and compares the books with the table at the end.
  const db = makeDb();
  await reseedCounters(db, 0, true);

  // Arriving. index.js does exactly this after its INSERT.
  const rows = [];
  for (let i = 1; i <= 10; i++) rows.push({ id: i, status: "pending" });
  db.seed(rows);
  await bumpCounter(db, QUEUED, 10);
  await bumpCounter(db, PENDING, 10);

  // Two rejected at the desk, three approved.
  await decideMany(db, [1, 2], "reject");
  await decideMany(db, [3, 4, 5], "approve");

  // One printed, one failed for good, one refused and requeued.
  db.raw.prepare("UPDATE jobs SET status='printing', claimed_by=? WHERE id=3").run(DEV);
  await completeJob(db, { id: 3, deviceId: DEV, ok: true, crc: 1 });

  db.raw
    .prepare("UPDATE jobs SET status='printing', claimed_by=?, attempts=9 WHERE id=4")
    .run(DEV);
  await completeJob(db, { id: 4, deviceId: DEV, ok: false, error: "dead" });

  db.raw.prepare("UPDATE jobs SET status='printing', claimed_by=? WHERE id=5").run(DEV);
  await completeBatch(db, { ids: [5], deviceId: DEV, ok: false, error: "too hot", retry: true });

  // A lease that expired while nobody was watching. Approved at the desk
  // first, because that is the only way a message reaches a printer - going
  // straight from 'pending' to 'printing' by hand would be the test inventing
  // a transition the system does not have, and then asserting on it.
  await decideMany(db, [6], "approve");
  db.raw
    .prepare("UPDATE jobs SET status='printing', claimed_by=?, claimed_at=1 WHERE id=6")
    .run(DEV);
  await sweepStaleLeases(db, 10 * 60 * 1000);

  // The desk putting things back: a reprint of a printed ticket, and a sweep
  // of everything that failed.
  await reprint(db, 3);
  await requeueFailed(db);

  assert.deepEqual(await claimed(db), truth(db), "the books must match the table");
});

test("a reprint does not invent a ticket that was never printed twice", async () => {
  // Reviving a printed job takes it off the printed tally as well as putting
  // it back in the queue. Without that, pressing reprint grows the number on
  // the public page by one every time.
  const db = makeDb();
  db.seed([{ id: 1, status: "printed" }]);
  await reseedCounters(db, 0, true);
  assert.equal(await readCounter(db, PRINTED), 1);

  await reprint(db, 1);
  assert.deepEqual(await claimed(db), truth(db));
  assert.equal(await readCounter(db, PRINTED), 0, "it is waiting again, not printed");
});

test("a counter is never negative, however confused the bookkeeping gets", async () => {
  const db = makeDb();
  await bumpCounter(db, QUEUED, -5);
  assert.equal(await readCounter(db, QUEUED), 0);
  await bumpCounter(db, QUEUED, 2);
  await bumpCounter(db, QUEUED, -7);
  assert.equal(await readCounter(db, QUEUED), 0, "a negative queue is a bug, not a fact");
});

test("the reseed is the only unbounded query, and it runs once a day", async () => {
  const db = makeDb();
  db.seed([{ id: 1, status: "printed" }]);

  const first = await reseedCounters(db, 1_000_000, false);
  assert.deepEqual(
    first,
    { printed: 1, queued: 0, pending: 0 },
    "an unseeded table is counted"
  );

  db.seed([{ id: 2, status: "printed" }]);
  assert.equal(
    await reseedCounters(db, 1_000_000 + 60_000, false),
    null,
    "a minute later it declines to count anything"
  );
  assert.equal(await readCounter(db, PRINTED), 1, "and leaves the counter alone");

  const later = await reseedCounters(db, 1_000_000 + 25 * 60 * 60 * 1000, false);
  assert.deepEqual(
    later,
    { printed: 2, queued: 0, pending: 0 },
    "a day later it reconciles"
  );
});

test("a database that predates the counters shows the right number at once", async () => {
  // The deploy case. Four thousand tickets are already printed and the table
  // is empty; the page must not say zero until the first cron fires.
  const db = makeDb();
  const rows = [];
  for (let i = 1; i <= 40; i++) rows.push({ id: i, status: "printed" });
  db.seed(rows);

  const { counterOrCount } = await import("../src/counters.js");
  assert.equal(await counterOrCount(db, PRINTED, 1), 40);
  // And having counted once, it wrote what it found.
  assert.equal(await readCounter(db, PRINTED), 40);
});

// --- the floor under the polling -------------------------------------------

test("a device that comes straight back is made to wait, not served", async () => {
  const {
    respectEmptyFloor,
    markEmpty,
    resetPollFloor,
    trackedDevices,
    EMPTY_FLOOR_MS,
  } = await import("../src/pollfloor.js");
  resetPollFloor();

  const waits = [];
  const spySleep = async (ms) => waits.push(ms);

  // A device nobody has seen goes straight through.
  assert.equal(await respectEmptyFloor("pi-1", 1000, spySleep), 0);

  markEmpty("pi-1", 1000);
  assert.equal(
    await respectEmptyFloor("pi-1", 1100, spySleep),
    EMPTY_FLOOR_MS - 100,
    "a hundred milliseconds later, it owes the other nine hundred"
  );
  assert.deepEqual(waits, [EMPTY_FLOOR_MS - 100], "and it is made to wait them");

  // A long poll that took its twenty-five seconds owes nothing.
  assert.equal(await respectEmptyFloor("pi-1", 26_000, spySleep), 0);

  // One device's spin does not slow another down.
  assert.equal(await respectEmptyFloor("pico-1", 1100, spySleep), 0);

  resetPollFloor();
  assert.equal(trackedDevices(), 0);
});

test("the floor cannot be made to remember every name it is given", async () => {
  // The machine endpoints are behind a token, so this is not an attack so much
  // as a typo in a loop - but a Map keyed by a caller-supplied string is a leak
  // waiting for one, and an isolate that runs for hours would hold it.
  const { markEmpty, resetPollFloor, trackedDevices } = await import("../src/pollfloor.js");
  resetPollFloor();
  for (let i = 0; i < 5000; i++) markEmpty(`device-${i}`, i);
  assert.ok(trackedDevices() <= 64, `bounded, got ${trackedDevices()}`);
  resetPollFloor();
});

// --- the desk --------------------------------------------------------------

test("the desk's archive stops after forty rows instead of sorting the table", async () => {
  // "Everything that is not waiting, newest first" had no index for its order,
  // so SQLite read every job and sorted the lot to show forty - once a minute,
  // for as long as somebody had the tab open on their phone.
  const { loadDesk } = await import("../src/admin.js");
  const db = longQueue(makeDb());
  const spy = spyOn(db);

  await loadDesk(spy.db, { roll_changed_at: "0", roll_length_m: "0" }, Date.now());

  const archive = spy.seen.find((sql) => /status != 'pending'/.test(sql));
  assert.ok(archive, "the desk must still show an archive");
  const plan = planOf(db.raw, archive);
  assert.match(plan, /idx_jobs_created/, "and it must ride the created_at index");
  assertCheap(plan, "the desk archive");
});

test("the desk does not count what is waiting", async () => {
  const { loadDesk } = await import("../src/admin.js");
  const db = longQueue(makeDb());
  db.raw.prepare("UPDATE jobs SET status = 'pending'").run();
  await reseedCounters(db, Date.now(), true);

  const spy = spyOn(db);
  const desk = await loadDesk(spy.db, { roll_changed_at: "0", roll_length_m: "0" }, Date.now());

  assert.equal(desk.pending_total, 5000, "the number still has to be true");
  assert.ok(
    !spy.seen.some((sql) => /COUNT\(\*\)[\s\S]*status = 'pending'/.test(sql)),
    "and nothing may count it:\n" + spy.seen.join("\n---\n")
  );
});

test("the paper gauge seeks to the roll change rather than reading every print", async () => {
  const { paperUsed } = await import("../src/admin.js");
  // A third printed, the rest still queued. The mix matters: with every row
  // printed, `status = 'printed'` narrows nothing and SQLite is right to sweep
  // the table instead - a fixture where the index cannot win is not a test of
  // whether the index is used.
  const db = longQueue(makeDb());
  db.raw
    .prepare(
      "UPDATE jobs SET status='printed', printed_at=created_at, lines=140 WHERE id % 3 = 0"
    )
    .run();
  db.raw.exec("ANALYZE");

  const spy = spyOn(db);
  await paperUsed(spy.db, { roll_changed_at: "1756000002000", roll_length_m: "80" });

  const sum = spy.seen.find((sql) => /SUM\(lines\)/.test(sql));
  assert.ok(sum, "the gauge must still sum something");
  const plan = planOf(db.raw, sum);
  assert.match(plan, /idx_jobs_printed/, "it must seek, not sweep");
  assertCheap(plan, "the paper gauge");
});
