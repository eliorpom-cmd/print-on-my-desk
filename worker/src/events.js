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
 */
export async function sweepEvents(db, keep = MAX_EVENTS) {
  const { meta } = await db
    .prepare(
      `DELETE FROM events WHERE id NOT IN (
         SELECT id FROM events ORDER BY at DESC, id DESC LIMIT ?
       )`
    )
    .bind(keep)
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
