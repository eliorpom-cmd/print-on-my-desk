// The moderation decision.
//
// Three outcomes, and they come straight from the brief:
//
//   approved   prints. The author sees a confirmation.
//   rejected   never prints. The author sees THE SAME confirmation. Not to be
//              coy - because telling someone their message was filtered is an
//              invitation to find out what got filtered, and a public form
//              with a feedback channel is a public form being probed.
//   pending    a human looks. ntfy pushes it to the owner's phone, and if nobody
//              taps within two hours it expires to rejected.
//
// Two layers, cheapest first. The word list is free and instant and catches
// the deliberate cases; the model catches what a word list structurally
// cannot - "I hope your whole family gets hurt" contains no listed term.
//
// The model is asked only when the list has not already decided, which also
// keeps us inside the free Workers AI allowance on the days somebody decides
// to hammer the form.

import { screen } from "./blocklist.js";
import { spamCheck } from "./spam.js";
import { bumpCounter, PENDING, QUEUED } from "./counters.js";

// Llama Guard answers with a safety verdict and, when unsafe, a category code.
// Some of those categories are things the owner would want to see before they are
// thrown away, and some are not things a printer in a flat should ever emit.
const HARD_CATEGORIES = new Set([
  "S1", // violent crimes
  "S2", // non-violent crimes
  "S3", // sex-related crimes
  "S4", // child sexual exploitation
  "S9", // indiscriminate weapons
  "S10", // hate
  "S11", // suicide and self-harm
  "S12", // sexual content
]);

/** What the Worker writes to jobs.status for each verdict. */
export const VERDICT_STATUS = {
  approved: "approved",
  pending: "pending",
  rejected: "rejected",
};

/**
 * Asks Workers AI whether the text is safe.
 *
 * Returns null - not "safe" - when anything at all goes wrong. A moderation
 * layer that fails open is worse than no moderation layer, because it fails
 * open exactly when it is under load.
 */
export async function classify(ai, model, text) {
  if (!ai) return null;
  try {
    const result = await ai.run(model, {
      messages: [{ role: "user", content: text }],
    });
    const raw = String(result?.response ?? result?.result?.response ?? "").trim();
    if (!raw) return null;
    const unsafe = /unsafe/i.test(raw);
    const categories = (raw.match(/\bS\d{1,2}\b/g) ?? []).map((c) => c.toUpperCase());
    return { unsafe, categories, raw: raw.slice(0, 120) };
  } catch (err) {
    console.log(JSON.stringify({ event: "ai_error", error: String(err).slice(0, 200) }));
    return null;
  }
}

/**
 * The whole decision, for one message.
 *
 * @returns {{verdict: string, source: string, reason: string|null,
 *            score: number|null, aiLabel: string|null}}
 * score is 0 (fine) to 1 (certainly out), stored on the job so the admin page
 * can sort by it.
 */
export async function moderate(text, { ai, settings }) {
  const spam = spamCheck(text);
  if (spam.spam) {
    return { verdict: "rejected", source: "spam", reason: spam.reason, score: 1, aiLabel: null };
  }

  const { severity, terms } = screen(text);
  const reasonTerms = terms.length ? terms.join(",") : null;

  if (severity === "high") {
    return { verdict: "rejected", source: "blocklist", reason: reasonTerms, score: 1, aiLabel: null };
  }
  if (severity === "medium") {
    return { verdict: "pending", source: "blocklist", reason: reasonTerms, score: 0.6, aiLabel: null };
  }

  // severity === "low" or null: still worth a model pass, and the low terms
  // are carried through so the admin page can show why a ticket looked odd.
  if (settings.moderation !== "1") {
    return {
      verdict: "approved",
      source: "blocklist",
      reason: reasonTerms,
      score: severity === "low" ? 0.2 : 0,
      aiLabel: null,
    };
  }

  const verdictAI = await classify(ai, settings.moderation_model, text);
  if (!verdictAI) {
    // The model is unreachable, or answered something we cannot read. Fail to
    // review rather than to print: an unmoderated ticket cannot be unprinted.
    return {
      verdict: "pending",
      source: "ai-unavailable",
      reason: reasonTerms,
      score: null,
      aiLabel: null,
    };
  }

  if (verdictAI.unsafe) {
    const hard = verdictAI.categories.some((c) => HARD_CATEGORIES.has(c));
    const reason = [reasonTerms, verdictAI.categories.join(",") || "unsafe"]
      .filter(Boolean)
      .join(" | ");
    return {
      verdict: hard ? "rejected" : "pending",
      source: "ai",
      reason,
      score: hard ? 0.95 : 0.6,
      aiLabel: verdictAI.raw,
    };
  }

  return {
    verdict: "approved",
    source: "ai",
    reason: reasonTerms,
    score: severity === "low" ? 0.2 : 0.05,
    aiLabel: verdictAI.raw,
  };
}

/** Records why a job ended up where it did. One row per job, upserted. */
export async function recordDecision(db, jobId, decision, now = Date.now()) {
  await db
    .prepare(
      `INSERT INTO moderation (job_id, verdict, source, reason, ai_label, decided_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(job_id) DO UPDATE SET
         verdict = excluded.verdict, source = excluded.source,
         reason = excluded.reason, ai_label = excluded.ai_label,
         decided_at = excluded.decided_at`
    )
    .bind(
      jobId,
      decision.verdict,
      decision.source,
      decision.reason ?? null,
      decision.aiLabel ?? null,
      now
    )
    .run();
}

/**
 * Expires pending jobs nobody reviewed.
 *
 * Off by default since 29 August: both TTLs are 0, so nothing is ever given an
 * expires_at and this sweep matches no rows. A queued message is a few hundred
 * bytes of text, and dropping somebody's note because nobody picked up a phone
 * for a day has no upside.
 *
 * The code stays because the policy is a number in /admin, not a deployment.
 * When it is on, the rule is: rejected, never approved. If nobody looked,
 * nobody approved, and a timeout is not a human.
 */
export async function expirePending(db, now = Date.now()) {
  const { results } = await db
    // INDEXED BY, and it is load-bearing rather than a hint.
    //
    // idx_jobs_expiring is partial - it holds only rows with an expires_at -
    // so while the TTLs are 0 it is empty and this query reads nothing. But
    // SQLite only picks it once it has statistics: with no sqlite_stat1 it
    // prefers idx_jobs_lease on the status equality instead, and then reads
    // every pending row to check a column that is NULL in all of them. That is
    // the plan that read seventeen million rows a day and exhausted D1's free
    // tier on 1 September, and "run ANALYZE and hope" is not a fix. Naming the
    // index takes the planner out of the decision entirely.
    //
    // If the index is ever missing this throws instead of quietly going
    // quadratic again, which is the failure mode worth having.
    .prepare(
      `SELECT id FROM jobs INDEXED BY idx_jobs_expiring
        WHERE expires_at IS NOT NULL AND expires_at < ? AND status = 'pending'`
    )
    .bind(now)
    .all();
  if (!results?.length) return 0;

  // The two statements below only ever run when the sweep found something, so
  // they are off the hot path - but they carry the IS NOT NULL anyway, because
  // a partial index cannot be used by a query that does not imply its
  // condition, and a bare `expires_at < ?` does not.
  await db
    .prepare(
      `UPDATE jobs SET status = 'rejected'
        WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at < ?`
    )
    .bind(now)
    .run();
  await db
    .prepare(
      `UPDATE moderation SET verdict = 'rejected', source = 'expired', reviewed_at = ?
        WHERE job_id IN (
                SELECT id FROM jobs
                 WHERE status = 'rejected' AND expires_at IS NOT NULL AND expires_at < ?
              )
          AND verdict = 'pending'`
    )
    .bind(now, now)
    .run();
  // Expiring is a message reaching a final state, so the queue is that much
  // shorter. See counters.js for why that is written rather than counted.
  await bumpCounter(db, QUEUED, -results.length);
  await bumpCounter(db, PENDING, -results.length);
  return results.length;
}
