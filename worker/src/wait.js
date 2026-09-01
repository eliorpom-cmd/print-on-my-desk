// How long a message written now waits for paper.
//
// Its own module because it is a policy, not plumbing: the number it divides
// by is a judgement about how many tickets a real day produces, and that
// deserves to be somewhere a person can find it.

import { counterOrCount, QUEUED } from "./counters.js";

/**
 * Roughly how long a message written now waits for paper.
 *
 * Coarse on purpose, and rounded down into words rather than numbers. The
 * printer only runs while somebody is home to feed it, so a realistic day is a
 * few hundred to a few thousand tickets. Anything more precise than "a few
 * days" would be a number this system cannot honour.
 *
 * Returns null when the queue is short, and the page then says nothing at all.
 */
// Recalibrated on 31 August, when the printer changed.
//
// It was 500, which was honest for the MXW01: a thermal limit of about 76
// tickets an hour, and only while somebody was home to feed it. The
// TRP 100 III printed four thousand tickets in well under an hour, so 500 was
// telling people "about a week" for a backlog that clears in an evening.
//
// 3000 rather than the machine's real rate, because the limit was never the
// printer - it is how often the owner starts it and how much paper is in the flat.
// A number that promises what the hardware can do rather than what actually
// happens is the same lie in the other direction.
const TICKETS_PER_DAY = 3000;

/**
 * The queue length is read, not counted, and that is the whole story here.
 *
 * This function used to run `SELECT COUNT(*) FROM jobs WHERE status IN
 * ('pending','approved')` on the submit path: one scan of everything already
 * queued, paid for by every new message. On 1 September it was reading five
 * thousand rows per submission and helping exhaust D1's free tier.
 *
 * Bounding the count with a subquery and caching the answer for a minute both
 * helped and neither was enough: a bounded count still reads up to twelve
 * thousand rows, and a per-isolate cache only divides that by however many
 * submissions land in one isolate in sixty seconds.
 *
 * So the queue keeps its own length (counters.js) and this reads one row. No
 * cache, because there is nothing left to cache: the answer is as cheap as the
 * cache lookup would have been, and it is never stale.
 */
export async function waitEstimate(db, now = Date.now()) {
  const ahead = await counterOrCount(db, QUEUED, now);
  return phraseFor(ahead);
}

/**
 * Four phrases, and the thresholds between them are hundreds of messages
 * apart. That distance is what makes the counter's small drift - it is
 * reconciled against the jobs table once a day - invisible here.
 */
export function phraseFor(ahead) {
  if (ahead < 100) return null;
  const days = Math.ceil(ahead / TICKETS_PER_DAY);
  if (days <= 1) return "later today or tomorrow";
  if (days === 2) return "a day or two";
  if (days <= 4) return "a few days";
  return "about a week";
}
