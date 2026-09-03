// The operational memory.
//
// Every incident of 30 August - a printer that vanished for 26 minutes, a
// batch that killed eighteen tickets on a BLE write race, a head that burned
// three attempts in 45 seconds - was diagnosed through a USB cable plugged
// into a laptop, watching a serial port in real time. The firmware produces
// exactly the right numbers and then throws them away.
//
// This module keeps the few that explain things, so the next incident can be
// read after the fact, from /admin, by somebody who was not there.

/** Rows kept. Older ones are swept, oldest first. */
export const MAX_EVENTS = 2000;

/**
 * Records one event. Never throws.
 *
 * Deliberately swallowing: this is instrumentation, and instrumentation that
 * can fail a print is worse than no instrumentation. Every caller is on a path
 * that matters more than the record of it.
 */
export async function record(db, kind, fields = {}, now = Date.now()) {
  try {
    await db
      .prepare(
        `INSERT INTO events (at, kind, detail, temperature, pace_ms, stalls, sent_lines, job_ids)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        now,
        kind,
        fields.detail ?? null,
        fields.temperature ?? null,
        fields.paceMs ?? null,
        fields.stalls ?? null,
        fields.sentLines ?? null,
        fields.jobIds ? fields.jobIds.join(",") : null
      )
      .run();
  } catch (err) {
    console.log(JSON.stringify({ event: "event_record_failed", error: String(err) }));
  }
}

/** The last `limit` events, newest first. */
export async function recent(db, limit = 100, kind = "") {
  const where = kind ? "WHERE kind = ?" : "";
  const binds = kind ? [kind, Math.min(limit, 500)] : [Math.min(limit, 500)];
  const { results } = await db
    .prepare(`SELECT * FROM events ${where} ORDER BY at DESC, id DESC LIMIT ?`)
    .bind(...binds)
    .all();
  return results ?? [];
}

/**
 * Keeps the table bounded.
 *
 * Runs on the cron rather than on every insert: a DELETE on the hot path would
 * make the cheapest write in the system into the most expensive one.
 *
 * IT USED TO COST THE WHOLE TABLE TO DELETE NOTHING. The statement was
 * `DELETE FROM events WHERE id NOT IN (SELECT id ... ORDER BY at DESC
 * LIMIT ?)`, which reads correctly: SQLite materialises the two thousand ids
 * worth keeping, then walks every row asking whether it is one of them.
 * Measured in production on 3 September: 2,556 rows read per run, 144 runs a
 * day from the cron, 368,000 rows - to remove nothing at all, because the
 * table held 1,119 rows against a cap of 2,000. Seven per cent of the day's
 * allowance, spent trimming a log that did not need trimming.
 *
 * That is the disease of the expiry sweep in a second place:
 * "matches nothing" is not "reads nothing", and a sweep that runs on a timer
 * forever has to be cheap in the case where it finds nothing, because that is
 * every case but one.
 *
 * So the cutoff is arithmetic rather than a sort. `id` is INTEGER PRIMARY KEY
 * AUTOINCREMENT - never reused, never going backwards - and this only ever
 * deletes from the bottom, so the rows above `MAX(id) - keep` are exactly the
 * newest `keep` of them, with no gaps to make the subtraction lie. `MAX` over
 * a rowid is one seek, and the DELETE reaches the rows by primary key and
 * reads only the ones it removes. Under the cap it reads a single row and
 * stops without preparing the DELETE at all.
 *
 * What changes: the rows kept are the newest by INSERTION rather than by `at`.
 * `record` stamps `at` at the moment of the insert, so for everything this
 * table receives the two orders are the same. A row written by hand with a
 * back-dated `at` would outlive its timestamp - which, for a log bounded by
 * count rather than by age, is not worth a table scan every ten minutes.
 */
export async function sweepEvents(db, keep = MAX_EVENTS) {
  const row = await db.prepare("SELECT MAX(id) AS newest FROM events").first();
  // MAX over an empty table is NULL, which reads here as "nothing to sweep"
  // rather than as an id.
  const cutoff = Number(row?.newest ?? 0) - keep;
  // The ordinary case, and the one the rewrite is for: fewer rows than the cap,
  // nothing to delete, and one row read to establish it.
  if (cutoff <= 0) return 0;
  const { meta } = await db
    .prepare("DELETE FROM events WHERE id <= ?")
    .bind(cutoff)
    .run();
  return meta?.changes ?? 0;
}

/**
 * How many print failures in the recent past.
 *
 * The alert that was missing on 30 August: eighteen tickets died over an
 * afternoon and the way it was noticed was the owner refreshing the page. A single
 * failure is normal - a hot head, a stall - and a run of them is a fault.
 */
export async function failureBurst(db, windowMs, now = Date.now()) {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM events WHERE kind = 'print_failed' AND at >= ?`)
    .bind(now - windowMs)
    .first();
  return row?.n ?? 0;
}
