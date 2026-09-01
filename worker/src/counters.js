// Two numbers nobody may count.
//
// D1 bills rows READ, and a COUNT over a table is a read of every row it
// touches. Two counts in this system have no bound at all:
//
//   * "how many tickets has this printer printed", on the public status page,
//     which is answered on every poll from every open tab;
//   * "how many messages are ahead of yours", on the submit path, which
//     decides which of four phrases the page shows.
//
// On 1 September the free tier's five million rows a day were exhausted. The
// expiry sweep (moderation.js) was the largest single cause, but these two
// were next, and neither gets cheaper as the project succeeds: a wave that
// brings five thousand messages also brings the tabs that ask how many there
// are. A cache only divides the problem by its TTL; the queue length still has
// to be recounted, and the count still grows with the queue.
//
// So the numbers are kept rather than recounted. Every transition that changes
// one writes its delta, and reading either costs a single row.
//
// A counter maintained by hand drifts - one missed call site and it is wrong
// forever - so nothing here is trusted indefinitely: `reseedCounters` recounts
// both from the jobs table once a day, from the cron, and that recount is the
// only unbounded query left in the system. Once a day, over a table this size,
// is affordable; once per submission was not.

/** How long a counter may go without being checked against reality. */
export const RESEED_AFTER_MS = 24 * 60 * 60 * 1000;

export const PRINTED = "printed";
export const QUEUED = "queued";
/**
 * How many messages are waiting for a human, which is not the same question.
 *
 * The desk shows it, and the desk redraws itself every minute for as long as
 * the tab is open. `SELECT COUNT(*) FROM jobs WHERE status = 'pending'` over a
 * queue of five thousand, sixty times an hour, is three hundred thousand rows
 * for one number on a phone in somebody's pocket.
 *
 * Cheaper to keep than `queued` and for a pleasant reason: a message can only
 * leave `pending` by being decided - at the desk, or by expiring - and those
 * are four functions in two files.
 */
export const PENDING = "pending";

/**
 * What `queued` means, and why it is not "waiting to print".
 *
 * It counts every job that has not reached a final state - pending, approved
 * AND printing - rather than the pending-plus-approved that the wait estimate
 * used to count. Including `printing` is what makes the counter cheap to
 * maintain: a claim and a requeue are then invisible to it, and only the
 * events that genuinely end a message's life have to remember to write.
 *
 * At any moment `printing` holds at most one strip, so the two definitions
 * differ by a handful of tickets out of thousands. The wait estimate they feed
 * is four fixed phrases with its nearest boundary at a hundred.
 */
export const LIVE_STATUSES = ["pending", "approved", "printing"];

/**
 * Reads one counter. A single row, whatever the table holds.
 *
 * Returns null when the row is missing, which is not the same as zero: a
 * database that has never been seeded should fall back to counting rather than
 * announce that nothing has ever been printed.
 */
export async function readCounter(db, key) {
  const row = await db
    .prepare("SELECT value FROM counters WHERE key = ?")
    .bind(key)
    .first();
  return row ? Number(row.value) : null;
}

/**
 * Adds `delta` to a counter, creating it at zero-plus-delta if need be.
 *
 * Never lets a counter go negative. A negative queue length is always a bug in
 * the bookkeeping rather than a fact about the world, and clamping it here
 * keeps that bug from reaching a page and confusing somebody.
 */
export async function bumpCounter(db, key, delta) {
  if (!delta) return;
  await db
    .prepare(
      `INSERT INTO counters (key, value, seeded_at) VALUES (?, MAX(?, 0), 0)
       ON CONFLICT(key) DO UPDATE SET value = MAX(value + ?, 0)`
    )
    .bind(key, delta, delta)
    .run();
}

/**
 * Recounts both counters from the jobs table.
 *
 * The one unbounded pair of queries in the system, and it runs from the cron,
 * at most once a day - `force` is for tests and for a first install.
 *
 * Returns what it wrote, or null when it decided the counters were fresh
 * enough to leave alone.
 */
export async function reseedCounters(db, now = Date.now(), force = false) {
  if (!force) {
    const row = await db
      .prepare("SELECT MIN(seeded_at) AS oldest FROM counters")
      .first();
    // MIN over an empty table is NULL, which is the never-seeded case and
    // must reseed rather than be read as "seeded at the epoch".
    const oldest = row?.oldest ?? null;
    if (oldest !== null && now - Number(oldest) < RESEED_AFTER_MS) return null;
  }

  const holes = LIVE_STATUSES.map(() => "?").join(",");
  const printed = await db
    .prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'printed'")
    .first();
  const queued = await db
    .prepare(`SELECT COUNT(*) AS n FROM jobs WHERE status IN (${holes})`)
    .bind(...LIVE_STATUSES)
    .first();

  const pending = await db
    .prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'pending'")
    .first();

  const values = {
    [PRINTED]: printed?.n ?? 0,
    [QUEUED]: queued?.n ?? 0,
    [PENDING]: pending?.n ?? 0,
  };
  for (const [key, value] of Object.entries(values)) {
    await db
      .prepare(
        `INSERT INTO counters (key, value, seeded_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                                        seeded_at = excluded.seeded_at`
      )
      .bind(key, value, now)
      .run();
  }
  return values;
}

/**
 * Reads a counter, and counts it the once if it has never been written.
 *
 * The fallback exists so that deploying this code against a database that
 * predates it shows the right number immediately rather than zero until the
 * first cron fires. It costs a full count exactly once, and the reseed it
 * triggers means the next reader pays a single row.
 */
export async function counterOrCount(db, key, now = Date.now()) {
  const value = await readCounter(db, key);
  if (value !== null) return value;
  const seeded = await reseedCounters(db, now, true);
  return seeded?.[key] ?? 0;
}
