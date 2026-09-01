// The moderation desk.
//
// Designed for one hand on a phone, because that is where it will actually be
// used: the ntfy notification arrives, the owner taps it, and the queue is one
// screen with two buttons per message. Anything that needs a second screen is
// something that will not get done, and an unreviewed pending expires to
// rejected after two hours.

import { num } from "./settings.js";
import { profileFor, PROFILES } from "./profiles.js";
import { bumpCounter, counterOrCount, PENDING, PRINTED, QUEUED } from "./counters.js";

// Settings the page may change. An allowlist rather than "any key", because
// this endpoint writes straight into the table the Pico reads its operating
// parameters from.
const EDITABLE = {
  kill_switch:     { type: "flag" },
  moderation:      { type: "flag" },
  // Off means the filters may approve on their own again, and clean messages
  // print without a tap. On is the deliberate default.
  hold_all:        { type: "flag" },
  hold_ttl_h:      { type: "int", min: 0, max: 720 },
  // Constraint 8 of the brief, enforced where it can be changed rather than
  // only where it is used: never above 0xC0, or the head cooks.
  intensity:       { type: "int", min: 1, max: 0xc0 },
  // 0 means "use the profile's own value". The ceiling is 400 rather than 100
  // because a dot is 0.141 mm on the TRP 100 III, so 100 is only 14 mm and the
  // real head-to-bar distance has not been measured yet.
  feed_lines_mxw01:  { type: "int", min: 0, max: 400 },
  feed_lines_trp100: { type: "int", min: 0, max: 400 },
  // Lower bound of 1 line means "one ticket per print", which turns batching
  // off without a deploy. The upper bound is MAX_LINES, the Pico's RAM.
  max_batch_lines: { type: "int", min: 1, max: 1024 },
  // 0 turns the paper gauge off rather than showing a figure nobody trusts.
  // Which machine is in service. Only the paper gauge and the desk read it -
  // a device is served the profile it asks for, because it is the one thing
  // that knows what it is plugged into.
  printer_profile: { type: "enum", values: Object.keys(PROFILES) },
  // Print priority tickets and nothing else.
  only_supporters: { type: "flag" },
  // Metres. 100 was the ceiling when a roll was 4 m; an 80 mm roll is sold by
  // the tens of metres, and the number has to be measurable rather than
  // plausible - see settings.js.
  roll_length_m:   { type: "int", min: 0, max: 500 },
  // Bounded well under the 52 C the machine has been seen to survive, and
  // never below room temperature, where it would never resume at all.
  head_max_c:      { type: "int", min: 30, max: 45 },
  cool_to_c:       { type: "int", min: 25, max: 43 },
  poll_interval_s: { type: "int", min: 2, max: 600 },
  rate_per_day:    { type: "int", min: 1, max: 100 },
  rate_per_hour:   { type: "int", min: 1, max: 100 },
  rate_cooldown_s: { type: "int", min: 0, max: 86400 },
  // 0 means no cap, and that is the default.
  queue_max:       { type: "int", min: 0, max: 5000 },
  // 0 means never. A queue that does not expire is the default.
  pending_ttl_h:   { type: "int", min: 0, max: 168 },
  pow_difficulty:  { type: "int", min: 1000, max: 5000000 },
  dedupe_window_h: { type: "int", min: 0, max: 168 },
  moderation_model:{ type: "text", max: 80 },
  /**
   * Closing and reopening the season, as a switch rather than a date.
   *
   * A VIRTUAL key: nothing named `season_closed` is ever stored. It is written
   * through to `closes_at`, which stays the single source of truth and keeps
   * being an instant, so "the season ended at 22:14 on 31 August" survives a
   * reopening and is still true afterwards.
   *
   * It exists because closing the season was, until today, an UPDATE typed
   * against the production database. The one operation the service most needs
   * a person to be able to do - stop taking messages - was the one that
   * required a terminal, and the result was a season that looked closed in the
   * page and was open at every other door. A switch on the desk is the whole
   * point of the desk.
   */
  season_closed:   { type: "flag" },
};

/** The virtual key, resolved. Returns [realKey, realValue]. */
export function resolveSetting(key, value, now = Date.now()) {
  if (key !== "season_closed") return [key, value];
  // Closed at this instant, or never closed at all. Not a future date: the
  // desk is for deciding now, and a schedule nobody can see is a schedule
  // somebody forgets.
  return ["closes_at", value === "1" ? String(now) : "0"];
}

export function validateSetting(key, value) {
  const rule = EDITABLE[key];
  if (!rule) return { ok: false, error: "unknown setting" };
  if (rule.type === "flag") {
    const v = value === true || value === "1" || value === 1 ? "1" : "0";
    return { ok: true, value: v };
  }
  if (rule.type === "int") {
    const n = Number(value);
    if (!Number.isInteger(n) || n < rule.min || n > rule.max) {
      return { ok: false, error: `expected an integer ${rule.min}-${rule.max}` };
    }
    return { ok: true, value: String(n) };
  }
  if (rule.type === "enum") {
    const v = String(value).trim().toLowerCase();
    if (!rule.values.includes(v)) {
      return { ok: false, error: `expected one of ${rule.values.join(", ")}` };
    }
    return { ok: true, value: v };
  }
  const text = String(value).trim();
  if (!text || text.length > rule.max) return { ok: false, error: "invalid value" };
  return { ok: true, value: text };
}

export async function saveSetting(db, key, value, now = Date.now()) {
  await db
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .bind(key, value, now)
    .run();
}

/** Everything the page shows, in one round trip's worth of queries. */
export async function loadDesk(db, settings, now = Date.now()) {
  // Counted separately from the rows fetched. The page used to show the length
  // of the list it had been handed, so a queue of 377 read "200" - the one
  // number on the desk that has to be true, because it is what tells the owner
  // whether there is an evening's work waiting.
  //
  // The page itself is deliberately small - 150, down from 500. The queue is
  // in the thousands now and rendering five hundred cards on a phone, every
  // refresh, served nobody: reviewing happens a screenful at a time, and
  // "Print everything waiting" already covers the whole queue in one go.
  const [pending, recent, counts, device, pendingTotal] = await Promise.all([
    db
      .prepare(
        `SELECT j.id, j.text, j.created_at, j.expires_at, j.moderation_score, j.handle,
                m.verdict, m.source, m.reason, m.ai_label
           FROM jobs j LEFT JOIN moderation m ON m.job_id = j.id
          WHERE j.status = 'pending'
          ORDER BY j.created_at ASC
          LIMIT 150`
      )
      .all(),
    db
      .prepare(
        `SELECT j.id, j.text, j.status, j.created_at, j.printed_at, j.error,
                m.source, m.reason
           FROM jobs j LEFT JOIN moderation m ON m.job_id = j.id
          WHERE j.status != 'pending'
          ORDER BY j.created_at DESC
          LIMIT 40`
      )
      .all(),
    db
      .prepare(
        `SELECT status, COUNT(*) AS n FROM jobs
          WHERE created_at >= ? GROUP BY status`
      )
      .bind(now - 24 * 60 * 60 * 1000)
      .all(),
    db
      .prepare(
        "SELECT id, last_seen, printer_state, temperature, battery, prints_ok, prints_failed FROM devices ORDER BY last_seen DESC LIMIT 1"
      )
      .first(),
    // Read, not counted: this is the number the desk shows, and the desk
    // redraws itself every minute for as long as the tab is open. See
    // counters.js.
    counterOrCount(db, PENDING, now),
  ]);

  const today = {};
  for (const row of counts.results ?? []) today[row.status] = row.n;

  // The desk reads the switch it writes, so the checkbox reflects the state
  // rather than the raw epoch nobody can read on a phone.
  const closesAt = Number(settings.closes_at);
  const seasonClosed = Number.isFinite(closesAt) && closesAt > 0 && now >= closesAt;

  return {
    now,
    pending: pending.results ?? [],
    pending_total: pendingTotal,
    recent: recent.results ?? [],
    today,
    device: device ?? null,
    settings: { ...settings, season_closed: seasonClosed ? "1" : "0" },
    pending_ttl_h: num(settings, "pending_ttl_h", 2),
  };
}

/**
 * Every ticket ever submitted, oldest first, for taking somewhere else.
 *
 * The archive is the point, not a by-product: nothing in this codebase ever
 * deletes a row from `jobs`, and the two sweeps that look destructive
 * (expirePending, sweepStaleLeases) only ever change a status. A message that
 * was refused is kept too - the refusals are as much a record of what a public
 * printer receives as the ones that came out.
 *
 * Paged rather than streamed, because D1 answers a statement at a time and a
 * single unbounded SELECT is how an export starts timing out two years from
 * now. `after` is the last id of the previous page.
 *
 * ip_hash is included, and it is worth knowing what it is: a salted hash of an
 * address, truncated to a /64 on IPv6. It is not an address and cannot be
 * turned back into one without the salt, but it does group a person's messages
 * together, which is exactly what a later project would want.
 */
export async function exportJobs(db, { after = 0, limit = 500 } = {}) {
  const { results } = await db
    .prepare(
      `SELECT j.id, j.text, j.status, j.created_at, j.printed_at, j.ip_hash, j.handle,
              j.moderation_score, j.attempts, j.crc, j.error,
              m.verdict, m.source, m.reason, m.ai_label, m.reviewed_by, m.reviewed_at
         FROM jobs j LEFT JOIN moderation m ON m.job_id = j.id
        WHERE j.id > ?
        ORDER BY j.id ASC
        LIMIT ?`
    )
    .bind(after, Math.min(Math.max(limit, 1), 1000))
    .all();
  return results ?? [];
}

/**
 * Approve or reject one pending job.
 *
 * Guarded on `status = 'pending'`, so the notification that arrives twice, or
 * the tap that lands after the two-hour expiry, changes nothing rather than
 * resurrecting a job the system has already given up on.
 */
/**
 * Puts a ticket back in the queue.
 *
 * For the two cases the desk could not act on before: a print that ran out of
 * attempts, and one that came out badly. Deliberately allowed on 'printed' too
 * - paper jams, and a ticket that technically printed is not always a ticket
 * that exists.
 *
 * Attempts go back to zero, or a job that already spent three would fail on
 * its first retry and the button would do nothing.
 */
export async function reprint(db, id, now = Date.now()) {
  // Read before writing, for the counters and for nothing else.
  //
  // The UPDATE below cannot say what the job WAS, and the two counters need to
  // know: reviving a printed ticket has to take one off the printed tally as
  // well as putting one back in the queue, or the public page grows a ticket
  // every time somebody presses reprint. One extra row read, on a button a
  // person presses by hand. See counters.js.
  const before = await db
    .prepare("SELECT status FROM jobs WHERE id = ?")
    .bind(id)
    .first();

  const { meta } = await db
    .prepare(
      `UPDATE jobs
          SET status = 'approved', attempts = 0, claimed_at = NULL,
              claimed_by = NULL, printed_at = NULL, error = NULL,
              expires_at = NULL
        WHERE id = ? AND status IN ('failed', 'printed', 'rejected')`
    )
    .bind(id)
    .run();
  const changed = (meta?.changes ?? 0) > 0;

  if (changed) {
    await bumpCounter(db, QUEUED, 1);
    if (before?.status === "printed") await bumpCounter(db, PRINTED, -1);
  }

  // 'rejected' is in that list on purpose: a filter's decision has to be
  // overridable by the person whose paper it is. The blocklist and the model
  // are both wrong sometimes, and a message refused by a machine with nobody
  // able to say otherwise is the one failure mode with no appeal.
  //
  // The moderation row keeps its source and reason - what flagged it, and why -
  // and only the verdict moves, with the reviewer stamped. So the desk can
  // still say "spam: link, approved by admin" rather than losing the fact that
  // a filter objected.
  if (changed) {
    await db
      .prepare(
        `UPDATE moderation
            SET verdict = 'approved', reviewed_by = 'admin', reviewed_at = ?
          WHERE job_id = ? AND verdict != 'approved'`
      )
      .bind(now, id)
      .run();
  }
  return changed;
}

/**
 * Approves or rejects a whole set of waiting messages at once.
 *
 * Coming home to a hundred and fifty of them and tapping each card twice is
 * not review, it is data entry, and it is how a queue stops being read at all.
 *
 * Two statements rather than one per id: a hundred and fifty round trips to D1
 * would take longer than the drive home. Guarded on `status = 'pending'` like
 * the single-message form, so a decision that arrives twice - a double tap, a
 * notification opened on two devices - cannot overwrite one already made.
 */
/**
 * The same decision over every waiting message, without listing them.
 *
 * For the case the list cannot hold: 377 messages waiting and a page that
 * shows 500 at most is fine, 3000 is not, and either way sending three
 * thousand ids over a phone connection to say "all of them" is silly.
 */
export async function decideAllPending(db, action, who = "admin", now = Date.now()) {
  const status = action === "approve" ? "approved" : "rejected";
  const { meta } = await db
    .prepare(`UPDATE jobs SET status = ?, expires_at = NULL WHERE status = 'pending'`)
    .bind(status)
    .run();
  const changed = meta?.changes ?? 0;
  if (changed) {
    await db
      .prepare(
        `UPDATE moderation
            SET verdict = ?, reviewed_by = ?, reviewed_at = ?
          WHERE job_id IN (SELECT id FROM jobs WHERE status = ?)
            AND verdict NOT IN ('approved', 'rejected')`
      )
      .bind(status, who, now, status)
      .run();
  }
  // Approving leaves a message in the queue; rejecting takes it out of it.
  // Either way it stops waiting for a human, which is the other counter.
  if (status === "rejected") await bumpCounter(db, QUEUED, -changed);
  await bumpCounter(db, PENDING, -changed);
  return changed;
}

export async function decideMany(db, ids, action, who = "admin", now = Date.now()) {
  if (!ids.length) return 0;
  const status = action === "approve" ? "approved" : "rejected";
  const verdict = status;
  const holes = ids.map(() => "?").join(",");

  const { meta } = await db
    .prepare(
      `UPDATE jobs SET status = ?, expires_at = NULL
        WHERE id IN (${holes}) AND status = 'pending'`
    )
    .bind(status, ...ids)
    .run();
  const changed = meta?.changes ?? 0;
  if (!changed) return 0;

  // Only the rows this call actually moved. A message somebody else decided a
  // second earlier keeps the verdict it was given, and the reviewer who gave
  // it - stamping every id here would rewrite that history.
  await db
    .prepare(
      `UPDATE moderation
          SET verdict = ?, reviewed_by = ?, reviewed_at = ?
        WHERE job_id IN (
          SELECT id FROM jobs WHERE id IN (${holes}) AND status = ?
        )`
    )
    .bind(verdict, who, now, ...ids, status)
    .run();

  if (status === "rejected") await bumpCounter(db, QUEUED, -changed);
  await bumpCounter(db, PENDING, -changed);
  return changed;
}

/**
 * Puts every failed job back in the queue.
 *
 * Five times on 30 August a batch of tickets ended up stuck, and five times
 * the fix was an UPDATE typed by hand against the production database. That
 * should not need someone with a terminal: the recovery is always the same,
 * and a Sunday morning is exactly when nobody has one open.
 */
export async function requeueFailed(db) {
  const { meta } = await db
    .prepare(
      `UPDATE jobs
          SET status = 'approved', attempts = 0, claimed_at = NULL,
              claimed_by = NULL, printed_at = NULL, error = NULL,
              expires_at = NULL
        WHERE status = 'failed'`
    )
    .run();
  const changed = meta?.changes ?? 0;
  await bumpCounter(db, QUEUED, changed);
  return changed;
}

/**
 * Roughly how much paper has gone through since the roll was last changed.
 *
 * The printer has one paper signal and it is binary: empty, or not. It arrives
 * the moment the roll runs out, which on 30 August happened twice - the second
 * time with nobody in the flat and sixteen messages waiting. Counting the
 * lines we sent is the only way to see it coming.
 *
 * Approximate on purpose. It cannot know the eject margins, and it counts the
 * rendered height rather than the paper actually pulled through, so it reads a
 * little low. It is a fuel gauge, not a measurement.
 */
export async function paperUsed(db, settings) {
  const since = Number(settings.roll_changed_at) || 0;
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(lines), 0) AS lines, COUNT(*) AS tickets
         FROM jobs
        WHERE status = 'printed' AND printed_at >= ?`
    )
    .bind(since)
    .first();
  const lines = row?.lines ?? 0;
  const tickets = row?.tickets ?? 0;
  const profile = profileFor(settings.printer_profile);
  // Vertical dots per millimetre, plus whatever leaves the slot per print that
  // is not the ticket.
  //
  // On the MXW01 that second term was 30 mm: the printer's own end-of-print
  // eject, never explained (PROTOCOL.md 6.2) and the single biggest waste in
  // the system. The TRP 100 III does not do it. What it costs instead is the
  // feed to the tear bar, which is ours and is therefore known exactly.
  const perPrintMm =
    profile.id === "mxw01" ? 30 : profile.feedLines / profile.dotsPerMm;
  const mm = lines / profile.dotsPerMm + tickets * perPrintMm;
  const rollMm = (Number(settings.roll_length_m) || 0) * 1000;
  return {
    since,
    tickets,
    usedMm: Math.round(mm),
    rollMm,
    leftMm: rollMm ? Math.max(Math.round(rollMm - mm), 0) : null,
  };
}

/**
 * The archive, searched and filtered.
 *
 * The desk used to show the last forty rows and nothing else, which is fine
 * until you want to find one message among three hundred - or see what the
 * filters have been throwing away, which is invisible precisely when it
 * matters most.
 *
 * `q` is a substring of the text. `status` is one of the job statuses, or
 * 'spam' - which is not a status but a moderation source, and is what someone
 * means when they ask to see the spam.
 */
export async function searchJobs(db, { q = "", status = "", limit = 100, offset = 0 } = {}) {
  const where = ["j.status != 'pending'"];
  const binds = [];

  if (q) {
    // LIKE with escaped wildcards: a search for "100%" must not match
    // everything. ESCAPE is standard SQLite and D1 passes it through.
    where.push("j.text LIKE ? ESCAPE '\\'");
    binds.push("%" + q.replace(/[\\%_]/g, "\\$&") + "%");
  }

  if (status === "spam") {
    where.push("m.source IN ('spam', 'blocklist')");
  } else if (status) {
    where.push("j.status = ?");
    binds.push(status);
  }

  const rows = await db
    .prepare(
      `SELECT j.id, j.text, j.status, j.created_at, j.printed_at, j.error, j.handle,
              m.source, m.reason, m.verdict, m.ai_label, m.reviewed_by
         FROM jobs j LEFT JOIN moderation m ON m.job_id = j.id
        WHERE ${where.join(" AND ")}
        ORDER BY j.created_at DESC
        LIMIT ? OFFSET ?`
    )
    .bind(...binds, Math.min(Math.max(limit, 1), 500), Math.max(offset, 0))
    .all();

  const total = await db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM jobs j LEFT JOIN moderation m ON m.job_id = j.id
        WHERE ${where.join(" AND ")}`
    )
    .bind(...binds)
    .first();

  return { rows: rows.results ?? [], total: total?.n ?? 0 };
}

export async function decide(db, id, action, who = "admin", now = Date.now()) {
  const status = action === "approve" ? "approved" : "rejected";
  const { meta } = await db
    .prepare(
      `UPDATE jobs SET status = ?, expires_at = NULL
        WHERE id = ? AND status = 'pending'`
    )
    .bind(status, id)
    .run();
  const changed = (meta?.changes ?? 0) > 0;
  if (changed && status === "rejected") await bumpCounter(db, QUEUED, -1);
  if (changed) await bumpCounter(db, PENDING, -1);
  if (changed) {
    await db
      .prepare(
        `INSERT INTO moderation (job_id, verdict, source, decided_at, reviewed_by, reviewed_at)
         VALUES (?, ?, 'admin', ?, ?, ?)
         ON CONFLICT(job_id) DO UPDATE SET
           verdict = excluded.verdict, reviewed_by = excluded.reviewed_by,
           reviewed_at = excluded.reviewed_at`
      )
      .bind(id, status, now, who, now)
      .run();
  }
  return changed;
}
