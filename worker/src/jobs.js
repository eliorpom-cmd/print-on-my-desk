// The queue itself.

import { renderBatch, renderTicket } from "./render.js";
import { toBase64 } from "./bitmap.js";
import { PROFILES, DEFAULT_PROFILE, profileFor } from "./profiles.js";
import { bumpCounter, PRINTED, QUEUED } from "./counters.js";

// How long a claimed job may stay claimed before we give up on it. A full
// print cycle measured 3.1 to 4.4 s in M2, plus the WiFi/BLE radio switch, so
// two minutes is enormous - which is the point. It should only ever fire when
// the Pico has genuinely died mid-ticket.
export const LEASE_MS = 2 * 60 * 1000;

// Ceiling on one ticket, in printer lines, for the Pico.
//
// A memory bound, not a style rule: the Pico has to buffer the whole bitmap in
// RAM before it cuts WiFi (constraint 6 forbids streaming a socket into the
// BLE stack). 1024 lines is 48 KB against 441 KB free, and the 200-character
// limit of M4 puts a real ticket around 130.
//
// Per-printer since 31 August - profile.maxLines - because the Raspberry Pi
// driving the TRP 100 III has no such bound and capping it at the Pico's RAM
// would be superstition. This export stays because it is still the honest
// answer for the profile it was measured on, and index.js sends it in the
// heartbeat that the Pico's firmware reads.
export const MAX_LINES = PROFILES[DEFAULT_PROFILE].maxLines;

/**
 * Fails any job whose lease has expired.
 *
 * Deliberately 'failed' and not back to 'approved'. If the Pico printed the
 * ticket and then died before it could confirm, re-queueing would print it
 * twice. On a public service run for fun, a duplicate is more confusing than a
 * miss, and a miss is recoverable by asking again.
 */
export async function sweepStaleLeases(db, now = Date.now()) {
  const { meta } = await db
    .prepare(
      `UPDATE jobs SET status = 'failed', error = 'lease expired'
       WHERE status = 'printing' AND claimed_at < ?`
    )
    .bind(now - LEASE_MS)
    .run();
  const changed = meta?.changes ?? 0;
  // A lease that expires is a message reaching a final state, so the queue is
  // one shorter. Nothing else here writes it: `printing` is counted as live
  // precisely so that claiming and requeueing stay invisible to the counter.
  await bumpCounter(db, QUEUED, -changed);
  return changed;
}

/**
 * Atomically hands one job to one device, without reading the queue.
 *
 * THE SHAPE OF THIS IS THE WHOLE POINT, so it is worth stating plainly.
 *
 * It used to be one statement: a LEFT JOIN onto `supporters` and
 * `ORDER BY (s.job_id IS NOT NULL) DESC, j.created_at ASC`. That reads
 * correctly and costs everything. No index can satisfy an ORDER BY over a
 * computed expression, so SQLite walked EVERY approved job, joined each one,
 * and sorted the lot into a temporary B-tree - to hand back a single row.
 * Measured on 1 September against a queue of twenty thousand: the old form
 * takes 2.8 ms per claim and the two below take 0.1 ms, and the gap is not a
 * constant. It is the length of the queue.
 *
 * Four thousand tickets printed out of a five thousand deep queue is four
 * thousand claims, each reading the whole queue: twenty million rows, on a
 * free tier that allows five. That is the other half of what the expiry sweep
 * started, and it is the half that gets worse every time somebody posts.
 *
 * So the priority is expressed as two statements instead of one sort:
 *
 *   1. anything a supporter paid for - bounded by the supporters table, which
 *      holds one row per a tip jar payment and will not reach four figures;
 *   2. otherwise the oldest approved job, which idx_jobs_queue answers
 *      directly, one row read, whatever the queue is doing.
 *
 * Each statement is still a single atomic UPDATE ... WHERE id = (SELECT ...),
 * so two devices polling at once cannot be handed the same row. They are not
 * atomic WITH EACH OTHER, and they do not need to be: the worst interleaving
 * hands one device a thank-you and the other an ordinary message, which is the
 * outcome either order would have produced anyway.
 */

// The oldest job somebody paid for. Bounded by `supporters`, not by the queue.
//
// CROSS JOIN, and it is not decoration. SQLite reorders a plain JOIN freely,
// and with no ANALYZE statistics - which is every D1 database, including this
// one - it guessed the other way round: drive off `idx_jobs_queue`, walk every
// approved row, probe `supporters` for each. That reads the queue to prove
// twelve payments are not in it, which is the exact cost this rewrite was for.
// CROSS JOIN is SQLite's one promise about join order: the left table is the
// outer loop. Twelve rows, each a rowid seek into jobs.
const PICK_SUPPORTER = `SELECT j.id FROM supporters s
                          CROSS JOIN jobs j ON j.id = s.job_id
                         WHERE j.status = 'approved'
                         ORDER BY j.created_at ASC, j.id ASC`;

// The oldest approved job. idx_jobs_queue (status, created_at) answers this
// without a sort and without reading anything it does not return.
const PICK_OLDEST = `SELECT id FROM jobs
                      WHERE status = 'approved'
                      ORDER BY created_at ASC, id ASC`;

const CLAIM_RETURNING = "id, text, created_at, attempts, handle";

export async function claimJob(db, deviceId, now = Date.now(), onlySupporters = false) {
  const paid = await claimOne(db, PICK_SUPPORTER, deviceId, now);
  if (paid) return paid;
  // "Thank-yous only": the queue goes on filling and being moderated, and the
  // printer stays quiet for everything else. See settings.js.
  if (onlySupporters) return null;
  return await claimOne(db, PICK_OLDEST, deviceId, now);
}

async function claimOne(db, pick, deviceId, now) {
  const row = await db
    .prepare(
      `UPDATE jobs
          SET status = 'printing', claimed_at = ?, claimed_by = ?,
              attempts = attempts + 1
        WHERE id = (${pick} LIMIT 1)
       RETURNING ${CLAIM_RETURNING}`
    )
    .bind(now, deviceId)
    .first();
  return row ?? null;
}

/**
 * How many times a job may be handed out before its failure is final.
 *
 * The failures that actually happen here are transient: the two jobs lost on
 * 27 August both died on `OSError: [Errno 114] EALREADY`, a BLE connection
 * race, and would have printed on a second pass. The Pico already refuses to
 * claim anything while the roll is empty or the printer asleep, precisely so a
 * message is never burned by a condition its author had nothing to do with, so
 * what reaches this counter is genuinely worth trying again.
 *
 * Three, because a fault that survives three attempts is a fault a person has
 * to look at, and quietly retrying it forever would only hide it.
 */
export const MAX_PRINT_ATTEMPTS = 3;

/**
 * Blank lines to feed after a print, so the last line clears the tear bar.
 *
 * PER PROFILE, and that is not tidiness - it is a trap that was already set.
 *
 * There used to be one `feed_lines` row, holding the MXW01's value: 7, which
 * is the ~10 mm from its head to its tear bar, measured on paper in M4. A
 * settings row wins over any default in the code, so on the day the TRP 100
 * III was plugged in that row would have fed it 7 dots - one millimetre - and
 * every ticket would have come out still under the print head, undetachable,
 * with nothing in any log to say why. The number was right. It just belonged
 * to another machine.
 *
 * So the key carries the profile, the old flat `feed_lines` row is ignored,
 * and an unset key means "whatever the profile says". Never zero: a ticket
 * still under the head is a ticket nobody can tear off (ETAT 2.10).
 */
export function feedLinesKey(profile) {
  return `feed_lines_${profile.id}`;
}

function feedLines(settings, profile) {
  const n = Number(settings[feedLinesKey(profile)]);
  return Number.isFinite(n) && n > 0 ? n : profile.feedLines;
}

/** Turns a claimed row into the payload the machine consumes. */
export function buildPayload(job, settings, profile = DEFAULT_PROFILE, supporter = null) {
  const p = typeof profile === "string" ? profileFor(profile) : profile;
  const canvas = renderTicket(job.text, {
    id: job.id,
    createdAt: job.created_at,
    handle: job.handle ?? null,
    profile: p,
    supporter,
  });
  if (canvas.height > p.maxLines) {
    throw new Error(`ticket is ${canvas.height} lines, cap is ${p.maxLines}`);
  }
  const bytes = canvas.toBytes();
  return {
    id: job.id,
    profile: p.id,
    lines: canvas.height,
    width_bytes: p.widthBytes,
    width_pixels: p.widthPixels,
    // CRC8 of the exact buffer that has to reach the print head.
    //
    // On the MXW01 this was checkable end to end: ae03 is written without
    // response, and the printer echoes the CRC of what it received in its AA
    // notification, so the Pico could prove the bytes that left D1 are the
    // bytes that arrived. On the TRP 100 III there is no echo - ESC/POS has
    // nothing of the kind - so it proves less: D1 to the agent's buffer, over
    // HTTP and base64, and no further. Kept because that half is still worth
    // proving and costs nothing, and because pretending otherwise is how a
    // guarantee quietly becomes a habit. docs/10-escpos.md says so too.
    crc: canvas.crc8(),
    intensity: Number(settings.intensity),
    feed_lines: feedLines(settings, p),
    // Make a noise for this one. A thank-you nobody notices coming out is a
    // thank-you that sits on the floor with five thousand others.
    beep: Boolean(supporter),
    data: toBase64(bytes),
  };
}

/**
 * Hands jobs to one device, up to `limit` of them.
 *
 * The batch form of claimJob, and it splits for the same reason: paid tickets
 * come from the supporters table, the rest come off the front of the queue by
 * index. Neither statement reads a row it is not going to hand out.
 *
 * RETURNING says nothing about row order, and the two statements say nothing
 * about each other, so the caller sorts. On a strip that is not cosmetic - it
 * is the order the messages come out in.
 */
export async function claimBatch(db, deviceId, limit, now = Date.now(), onlySupporters = false) {
  const rows = await claimSome(db, PICK_SUPPORTER, deviceId, limit, now);
  const room = limit - rows.length;
  if (room > 0 && !onlySupporters) {
    // Whatever the first statement took is already 'printing', so this one
    // cannot pick it up again.
    rows.push(...(await claimSome(db, PICK_OLDEST, deviceId, room, now)));
  }
  rows.sort((a, b) => a.created_at - b.created_at || a.id - b.id);
  return rows;
}

async function claimSome(db, pick, deviceId, limit, now) {
  if (limit <= 0) return [];
  const { results } = await db
    .prepare(
      `UPDATE jobs
          SET status = 'printing', claimed_at = ?, claimed_by = ?,
              attempts = attempts + 1
        WHERE id IN (${pick} LIMIT ?)
       RETURNING ${CLAIM_RETURNING}`
    )
    .bind(now, deviceId, limit)
    .all();
  return results ?? [];
}

/**
 * Puts claimed jobs back in the queue, untouched.
 *
 * For the tickets that were claimed but did not fit in the line budget. They
 * were never sent to anything, so the attempt they were charged on the way out
 * is given back: a job must not burn its three tries by being at the wrong end
 * of a full strip.
 */
export async function releaseJobs(db, ids, deviceId) {
  if (!ids.length) return 0;
  const holes = ids.map(() => "?").join(",");
  const { meta } = await db
    .prepare(
      `UPDATE jobs
          SET status = 'approved', claimed_at = NULL, claimed_by = NULL,
              attempts = MAX(attempts - 1, 0)
        WHERE id IN (${holes}) AND status = 'printing' AND claimed_by = ?`
    )
    .bind(...ids, deviceId)
    .run();
  return meta?.changes ?? 0;
}

/**
 * Renders as many of `jobs` as fit on one strip.
 *
 * Greedy and quadratic, over at most a handful of tickets: re-rendering the
 * strip for each candidate is a few milliseconds and removes any need to
 * predict a ticket's height before drawing it.
 *
 * @returns {{payload: object, included: object[], leftOver: object[]}}
 * @throws if not even the first ticket fits, which is a job that can never
 *         print and has to be failed rather than retried forever.
 */
export function buildBatchPayload(jobs, settings, profile = DEFAULT_PROFILE) {
  const p = typeof profile === "string" ? profileFor(profile) : profile;
  // Two ceilings, and they mean different things. profile.maxLines is what the
  // host can hold and is not negotiable; max_batch_lines is how much we dare
  // put in one transfer, and is a setting because the honest answer was still
  // being measured on BLE. A ticket over the host bound on its own can never
  // print; one that merely exceeds the strip budget travels alone.
  const budget = Math.min(
    Number(settings.max_batch_lines) || p.maxLines,
    p.maxLines
  );
  const included = [];
  let strip = null;
  for (const job of jobs) {
    const candidate = renderBatch([...included, job], { profile: p });
    if (candidate.height > budget && included.length) break;
    if (candidate.height > p.maxLines) break;
    included.push(job);
    strip = candidate;
  }
  if (!strip) {
    throw new Error(
      `ticket ${jobs[0].id} is over the ${p.maxLines}-line cap on its own`
    );
  }
  // Where each ticket sits on the strip, in transmission order.
  //
  // ORDER DEPENDS ON THE PROFILE, and this is the trap of the whole switch.
  //
  // On the MXW01 the strip is rendered upright and rotated once at the end, so
  // the ticket drawn FIRST is transmitted LAST: a device that stops after N
  // lines reached the tickets at the END of the array. The TRP 100 III is not
  // rotated (profiles.js explains why), so transmission order IS render order
  // and the device that stops after N lines reached the tickets at the START.
  //
  // Inheriting the MXW01 arithmetic here would requeue exactly the tickets
  // that printed and give up on exactly the ones that did not, on every
  // partial failure, silently. It is the reason spans is computed from
  // flip180 rather than from a constant.
  const heights = [];
  for (let i = 0; i < included.length; i++) {
    heights.push(renderBatch(included.slice(0, i + 1), { profile: p }).height);
  }
  const total = strip.height;
  // start = the line index at which this ticket's first byte goes out.
  // lines = how tall it is, separator included, which the paper gauge wants.
  //
  // `lines` is carried rather than derived from neighbouring starts. It used
  // to be reconstructed by the gauge as "the gap to the previous span", which
  // was correct only while every strip was transmitted in reverse; stating it
  // here means the gauge never has to know which way round a profile prints.
  const spans = included.map((job, i) => {
    const height = heights[i] - (i === 0 ? 0 : heights[i - 1]);
    return {
      id: job.id,
      start: p.flip180 ? total - heights[i] : i === 0 ? 0 : heights[i - 1],
      lines: height,
    };
  });

  return {
    payload: {
      // The first id, so every log line and every error message still names
      // something a human can look up. `ids` is what the Pico confirms.
      id: included[0].id,
      ids: included.map((job) => job.id),
      // Consumed only when a transfer dies half way, to work out which
      // tickets never left. Harmless for the Pico to ignore.
      spans,
      profile: p.id,
      lines: strip.height,
      width_bytes: p.widthBytes,
      width_pixels: p.widthPixels,
      crc: strip.crc8(),
      intensity: Number(settings.intensity),
      feed_lines: feedLines(settings, p),
      data: toBase64(strip.toBytes()),
    },
    included,
    leftOver: jobs.slice(included.length),
  };
}

/**
 * Confirms or fails a whole batch.
 *
 * The `retry` flag is the whole subtlety, and it cost a strip of tickets to
 * learn. A batch that died mid-transmission has already put some of its
 * tickets on the floor, and re-sending it would print those twice - that one
 * is final, per the project's standing choice of a miss over a duplicate.
 *
 * But most failures never send a byte: the Pico refuses to start when the roll
 * is empty, when the head is too hot, or when the printer is asleep. Nothing
 * was printed and nothing was lost, so those go back in the queue like any
 * single ticket would. Treating them as final failed five perfectly good
 * messages on 30 August because the head had reached 40 C.
 */
export async function completeBatch(
  db,
  { ids, deviceId, ok, crc, error, retry = false, sentLines = null, spans = null },
  now = Date.now()
) {
  if (!ids.length) return { changed: 0, retrying: false, rescued: [] };

  // A transfer that died half way: some of the strip is on the floor, and the
  // rest never left the Pico. Only the ones that were reached are lost.
  //
  // The strip is transmitted in reverse render order, so `start` is the line
  // index at which a ticket's first byte goes out. A ticket whose start is at
  // or past the last line sent never reached the paper and can go straight
  // back in the queue. Before this, one stall took its whole strip down with
  // it - three or four messages for one bad write.
  if (!ok && !retry && Number.isInteger(sentLines) && Array.isArray(spans)) {
    const rescued = spans
      .filter((s) => Number.isInteger(s.start) && s.start >= sentLines)
      .map((s) => s.id)
      .filter((id) => ids.includes(id));
    const lost = ids.filter((id) => !rescued.includes(id));
    if (rescued.length) {
      await requeue(db, rescued, deviceId);
    }
    if (lost.length) {
      await settle(db, lost, deviceId, "'failed'", "attempts", null, crc, error);
    }
    return { changed: rescued.length + lost.length, retrying: false, rescued };
  }

  const holes = ids.map(() => "?").join(",");
  // A refusal that never sent a byte gives its attempt back.
  //
  // `attempts` is meant to count real tries at the paper, and counting
  // refusals instead is what killed tickets 173 and 174: the head stayed above
  // 38 C through a backlog, the same strip was refused three times in
  // 45 seconds, and a message died of a condition it had nothing to do with.
  // The Pico now waits for the head to cool, so this cannot spin - and a job
  // that genuinely cannot print is stopped by the machine state, not by a
  // counter that a hot afternoon can exhaust.
  const status = ok ? "'printed'" : retry ? "'approved'" : "'failed'";
  const attempts = retry && !ok ? "MAX(attempts - 1, 0)" : "attempts";
  const changed = await settle(
    db, ids, deviceId, status, attempts, ok ? now : null, crc, error
  );
  return { changed, retrying: !ok && retry, rescued: [] };
}

/** One status write over a set of claimed jobs. */
async function settle(db, ids, deviceId, status, attempts, printedAt, crc, error) {
  const holes = ids.map(() => "?").join(",");
  const { meta } = await db
    .prepare(
      `UPDATE jobs
          SET status = ${status}, attempts = ${attempts}, printed_at = ?,
              claimed_at = NULL, claimed_by = NULL, crc = ?, error = ?
        WHERE id IN (${holes}) AND status = 'printing' AND claimed_by = ?`
    )
    .bind(printedAt ?? null, crc ?? null, error ?? null, ...ids, deviceId)
    .run();
  const changed = meta?.changes ?? 0;
  await countSettled(db, status, changed);
  return changed;
}

/**
 * Keeps the two counters in step with a status write.
 *
 * `status` arrives as the SQL literal it was interpolated with, quotes and
 * all, which is ugly to match on and is the reason it is matched on HERE, once,
 * rather than at each of settle's callers. See counters.js for why these
 * numbers are kept rather than counted.
 *
 * 'approved' is the requeue path and moves nothing: a job going back in the
 * queue never left it, because `printing` counts as live.
 */
async function countSettled(db, status, changed) {
  if (!changed) return;
  if (status === "'printed'") {
    await bumpCounter(db, PRINTED, changed);
    await bumpCounter(db, QUEUED, -changed);
  } else if (status === "'failed'") {
    await bumpCounter(db, QUEUED, -changed);
  }
}

/** Puts untouched tickets back, with their attempt refunded. */
async function requeue(db, ids, deviceId) {
  return settle(db, ids, deviceId, "'approved'", "MAX(attempts - 1, 0)", null, null, null);
}

/** Confirms or fails a claimed job. Only the device holding the lease may. */
/**
 * Records the outcome, and gives a failure another chance.
 *
 * A failed print used to be terminal on the first try, which is how two
 * messages sat dead in the table for days with nobody told. Now a failure goes
 * back to 'approved' until the attempts run out, and the lease is cleared so
 * the next poll can pick it straight up.
 *
 * @returns {Promise<{changed: boolean, retrying: boolean, attempts: number}>}
 */
export async function completeJob(db, { id, deviceId, ok, crc, error }, now = Date.now()) {
  const row = await db
    .prepare(
      `UPDATE jobs
          SET status = CASE
                WHEN ?1 THEN 'printed'
                WHEN attempts < ?2 THEN 'approved'
                ELSE 'failed'
              END,
              printed_at = CASE WHEN ?1 THEN ?3 ELSE NULL END,
              claimed_at = NULL,
              claimed_by = NULL,
              crc = ?4,
              error = ?5
        WHERE id = ?6 AND status = 'printing' AND claimed_by = ?7
       RETURNING status, attempts`
    )
    .bind(ok ? 1 : 0, MAX_PRINT_ATTEMPTS, now, crc ?? null, error ?? null, id, deviceId)
    .first();

  // The statement chose between three outcomes, so the counters are told what
  // it landed on rather than what was asked for.
  if (row?.status === "printed") {
    await bumpCounter(db, PRINTED, 1);
    await bumpCounter(db, QUEUED, -1);
  } else if (row?.status === "failed") {
    await bumpCounter(db, QUEUED, -1);
  }

  return {
    changed: Boolean(row),
    retrying: row?.status === "approved",
    attempts: row?.attempts ?? 0,
  };
}

/** Upserts the device row. One row per Pico, always the latest state. */
export async function recordHeartbeat(db, deviceId, body, now = Date.now()) {
  await db
    .prepare(
      `INSERT INTO devices (id, last_seen, printer_state, temperature, battery,
                            uptime_ms, firmware, last_error, prints_ok, prints_failed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         last_seen     = excluded.last_seen,
         printer_state = excluded.printer_state,
         temperature   = excluded.temperature,
         battery       = excluded.battery,
         uptime_ms     = excluded.uptime_ms,
         firmware      = excluded.firmware,
         last_error    = excluded.last_error,
         prints_ok     = excluded.prints_ok,
         prints_failed = excluded.prints_failed`
    )
    .bind(
      deviceId,
      now,
      body.printer_state ?? "unknown",
      body.temperature ?? null,
      body.battery ?? null,
      body.uptime_ms ?? null,
      body.firmware ?? null,
      body.last_error ?? null,
      body.prints_ok ?? 0,
      body.prints_failed ?? 0
    )
    .run();
}
