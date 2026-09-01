// Rate limiting, on the salted IP hash and nothing else.
//
// No account, no cookie, no fingerprint: the brief wants a form anyone can use
// without signing up, so the only handle we have on "a person" is where the
// request came from - and even that is stored as a salted hash, never as an
// address (see hashIp in index.js).
//
// Four limits, and each exists for a failure the others do not cover:
//
//   cooldown  five minutes between two messages. Stops the excited-friend
//             burst, which is the common case and is not malicious.
//   daily     three a day. The actual quota.
//   hourly    a tighter burst guard, so the three cannot all land in a minute
//             while the owner is out.
//   queue     a global cap, OFF by default (queue_max = 0). It existed when a
//             queued message meant paper waiting to come out; since everything
//             waits for a tap, a long queue is just a long list of text.
//
// The one design decision worth stating: REJECTED MESSAGES COUNT. A message
// killed by moderation still occupies one of the three, because the author is
// told nothing either way. If rejections were free, the silent-rejection
// policy would turn into an oracle - post, see whether you can post again,
// learn exactly which word was the problem, and iterate.

import { startOfDayIn, num } from "./settings.js";

const HOUR_MS = 60 * 60 * 1000;

/**
 * @returns {{ok: true} | {ok: false, reason: string, retryAfterS: number}}
 */
export async function checkRateLimit(db, ipHash, settings, now = Date.now()) {
  const perDay = num(settings, "rate_per_day", 3);
  const perHour = num(settings, "rate_per_hour", 3);
  const cooldownMs = num(settings, "rate_cooldown_s", 300) * 1000;
  const queueMax = num(settings, "queue_max", 0);

  const dayStart = startOfDayIn(settings.timezone ?? "Europe/Paris", now);
  const hourStart = now - HOUR_MS;
  const since = Math.min(dayStart, hourStart, now - cooldownMs);

  // One round trip. D1 is a network hop per statement, and this runs on every
  // submission, so the conditional sums are worth the slightly opaque SQL.
  const counts = await db
    .prepare(
      `SELECT MAX(created_at) AS last_at,
              SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS today,
              SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS this_hour
         FROM jobs
        WHERE ip_hash = ? AND created_at >= ?`
    )
    .bind(dayStart, hourStart, ipHash, since)
    .first();

  const lastAt = counts?.last_at ?? 0;
  const today = counts?.today ?? 0;
  const thisHour = counts?.this_hour ?? 0;

  if (today >= perDay) {
    return {
      ok: false,
      reason: "daily",
      retryAfterS: Math.ceil((dayStart + 24 * HOUR_MS - now) / 1000),
    };
  }
  if (thisHour >= perHour) {
    return { ok: false, reason: "hourly", retryAfterS: Math.ceil((lastAt + HOUR_MS - now) / 1000) };
  }
  if (lastAt && now - lastAt < cooldownMs) {
    return {
      ok: false,
      reason: "cooldown",
      retryAfterS: Math.ceil((lastAt + cooldownMs - now) / 1000),
    };
  }

  // 0 means no cap, and that is the default. The cap existed to stop a backlog
  // nobody could work through; now that nothing prints without a tap, a long
  // queue is a long list of text and costs nothing. Skipping the check also
  // skips a database read on every single submission.
  //
  // What is left holding the line is the per-person quota above, the word list
  // and the echo rule - and the kill switch, if a day ever goes wrong.
  if (queueMax > 0) {
    const queued = await db
      .prepare("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('approved','pending','printing')")
      .first();
    if ((queued?.n ?? 0) >= queueMax) {
      return { ok: false, reason: "queue", retryAfterS: 600 };
    }
  }

  return { ok: true };
}

/**
 * Has this person already sent this exact text recently?
 *
 * A double-tap on a flaky mobile connection looks identical to a deliberate
 * repeat, and printing the same ticket twice is the more annoying of the two
 * mistakes. Matched on the stored text after normalisation, so it catches the
 * retry and not much else.
 */
export async function isDuplicate(db, ipHash, text, settings, now = Date.now()) {
  const windowMs = num(settings, "dedupe_window_h", 24) * HOUR_MS;
  const row = await db
    .prepare(
      `SELECT id FROM jobs
        WHERE ip_hash = ? AND text = ? AND created_at >= ?
        LIMIT 1`
    )
    .bind(ipHash, text, now - windowMs)
    .first();
  return Boolean(row);
}

/** Below this length, two people writing the same thing is a coincidence. */
export const ECHO_MIN_LENGTH = 20;

/**
 * Has this exact text just arrived from somebody else?
 *
 * Every limit above counts one address at a time, which is precisely what a
 * botnet is built to defeat: a thousand machines each posting once are a
 * thousand people as far as the quota can tell. What they share is the
 * payload, because whoever is driving them wrote it once.
 *
 * Short texts are exempt. Two strangers both writing "hello from Paris" within
 * an hour is a coincidence and a nice one; two hundred addresses posting the
 * same forty-character sentence is not.
 *
 * Deliberately not merged with isDuplicate above: that one is a courtesy to
 * somebody whose thumb slipped, and it says so. This one is a spam rule, and
 * it is silent for the same reason every other spam rule is.
 */
export async function isEcho(db, text, now = Date.now(), windowMs = HOUR_MS) {
  if ([...text].length < ECHO_MIN_LENGTH) return false;
  const row = await db
    .prepare("SELECT id FROM jobs WHERE text = ? AND created_at >= ? LIMIT 1")
    .bind(text, now - windowMs)
    .first();
  return Boolean(row);
}
