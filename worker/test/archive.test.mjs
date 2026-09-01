// The archive: searching it, filtering it, and overriding a filter's verdict.
//
// The desk used to show the last forty rows, full stop. That is fine until a
// message has to be found among three hundred, or until you want to see what
// the filters have been refusing - which is invisible exactly when it matters,
// because a refused message is the one nobody is told about.
//
// These tests drive searchJobs against a fake D1 that records the SQL it was
// handed, because what matters here is which rows the query asks for.

import { test } from "node:test";
import assert from "node:assert/strict";

import { searchJobs, reprint } from "../src/admin.js";

/** Captures the statements and returns canned rows. */
function spyDb(rows = [], total = 0) {
  const seen = [];
  return {
    seen,
    prepare(sql) {
      const entry = { sql, binds: [] };
      seen.push(entry);
      return {
        bind(...args) {
          entry.binds = args;
          return this;
        },
        async all() {
          return { results: rows };
        },
        async first() {
          return { n: total };
        },
        async run() {
          return { meta: { changes: 1 } };
        },
      };
    },
  };
}

test("an empty search still excludes what is waiting for a decision", async () => {
  // Pending messages have their own list on the desk. Mixing them into the
  // archive would show the same card twice and invite deciding it twice.
  const db = spyDb();
  await searchJobs(db, {});
  assert.match(db.seen[0].sql, /j\.status != 'pending'/);
});

test("a query becomes a LIKE, and its wildcards are escaped", async () => {
  const db = spyDb();
  await searchJobs(db, { q: "100%" });
  assert.match(db.seen[0].sql, /LIKE \? ESCAPE/);
  // Without escaping, "100%" would match every row in the table.
  assert.equal(db.seen[0].binds[0], "%100\\%%");
});

test("an underscore is escaped too", async () => {
  const db = spyDb();
  await searchJobs(db, { q: "a_b" });
  assert.equal(db.seen[0].binds[0], "%a\\_b%");
});

test("filtering by a status filters by that status", async () => {
  const db = spyDb();
  await searchJobs(db, { status: "rejected" });
  assert.match(db.seen[0].sql, /j\.status = \?/);
  assert.equal(db.seen[0].binds[0], "rejected");
});

test("'spam' is not a status, and is not treated as one", async () => {
  // It is a moderation source. Asking for j.status = 'spam' would silently
  // return nothing at all, which looks exactly like "no spam today".
  const db = spyDb();
  await searchJobs(db, { status: "spam" });
  assert.match(db.seen[0].sql, /m\.source IN \('spam', 'blocklist'\)/);
  assert.ok(
    !db.seen[0].binds.includes("spam"),
    "spam must not be bound as a job status"
  );
});

test("the page size is bounded whatever is asked for", async () => {
  const db = spyDb();
  await searchJobs(db, { limit: 100000, offset: -5 });
  const binds = db.seen[0].binds;
  assert.equal(binds[binds.length - 2], 500, "limit is capped");
  assert.equal(binds[binds.length - 1], 0, "offset cannot go negative");
});

test("a rejected message can be put back to print", async () => {
  // The whole point: a filter's verdict has to be overridable by the person
  // whose paper it is. Both filters are wrong sometimes.
  const db = spyDb();
  const ok = await reprint(db, 7);
  assert.equal(ok, true);
  // Found rather than indexed: reprint reads the job's current status first,
  // because the counters need to know whether it was a printed ticket being
  // revived (counters.js), and that read is not the statement under test.
  const update = db.seen.find((s) => s.sql.includes("UPDATE jobs"));
  assert.ok(update, "reprint must move the job itself");
  assert.match(update.sql, /status IN \('failed', 'printed', 'rejected'\)/);
});

test("an override is stamped, and the reason it was flagged survives", async () => {
  const db = spyDb();
  await reprint(db, 7, 1234);
  const update = db.seen.find((s) => s.sql.includes("UPDATE moderation"));
  assert.ok(update, "the moderation row must record the override");
  assert.match(update.sql, /verdict = 'approved'/);
  assert.match(update.sql, /reviewed_by = 'admin'/);
  // source and reason are deliberately untouched: "spam: link, approved by
  // admin" is the reading we want, not a row that forgets a filter objected.
  assert.ok(!/source =/.test(update.sql), "the flagging source must survive");
  assert.ok(!/reason =/.test(update.sql), "the reason must survive");
});
