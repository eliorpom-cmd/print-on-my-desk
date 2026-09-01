// A real SQLite database behind D1's interface.
//
// The Worker's unit tests use hand-written fake databases, and on 30 August
// two of the worst bugs of the day walked straight through 145 green tests and
// were found in production, by the owner, on his own paper:
//
//   * a batch whose print was refused had its attempts counted, so three
//     refusals in 45 seconds killed messages that had never been sent;
//   * a strip that failed took every ticket on it down, including the ones
//     that had never left the Pico.
//
// Neither is visible to a fake `db` object, because a fake cannot disagree
// with the SQL - it returns whatever the test author expected. These run the
// real statements against a real engine, where a wrong CASE or a missing
// clause shows up as a wrong row.

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SCHEMA = fileURLToPath(new URL("../../schema.sql", import.meta.url));

/** A D1-shaped wrapper: prepare().bind().all()/first()/run(). */
export function makeDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(SCHEMA, "utf8"));

  const wrap = (sql) => {
    let params = [];
    const api = {
      bind(...args) {
        params = args;
        return api;
      },
      async all() {
        return { results: db.prepare(sql).all(...params) };
      },
      async first() {
        return db.prepare(sql).get(...params) ?? null;
      },
      async run() {
        const out = db.prepare(sql).run(...params);
        return { meta: { changes: Number(out.changes ?? 0) } };
      },
    };
    return api;
  };

  return {
    prepare: wrap,
    raw: db,
    seed(jobs) {
      const insert = db.prepare(
        `INSERT INTO jobs (id, text, status, created_at, attempts, claimed_by, claimed_at, lines, printed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const j of jobs) {
        insert.run(
          j.id,
          j.text ?? "hello",
          j.status ?? "approved",
          j.created_at ?? 1756000000000 + j.id,
          j.attempts ?? 0,
          j.claimed_by ?? null,
          j.claimed_at ?? null,
          j.lines ?? null,
          j.printed_at ?? null
        );
      }
    },
    moderation(rows) {
      const insert = db.prepare(
        `INSERT INTO moderation (job_id, verdict, source, reason, decided_at)
         VALUES (?, ?, ?, ?, ?)`
      );
      for (const r of rows) {
        insert.run(
          r.job_id,
          r.verdict ?? "rejected",
          r.source ?? "ai",
          r.reason ?? null,
          1756000000000
        );
      }
    },
    job(id) {
      return db.prepare("SELECT * FROM jobs WHERE id = ?").get(id);
    },
    all(sql) {
      return db.prepare(sql).all();
    },
  };
}
