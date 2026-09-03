// Print on my desk Worker.
//
// Three audiences, and they must not be confused:
//
//   /api/machine/*   the Pico. Shared-token auth. Hands out bitmaps, takes
//                    confirmations and heartbeats.
//   /admin, /api/admin/*  the owner. A second, separate token.
//   everything else  the public. No auth, and everything it can reach is
//                    rate-limited, proof-of-worked and moderated.
//
// Constraint 2 of the brief: the Pico always dials out, nothing ever dials in.
// So there is no endpoint here that pushes to the printer, only endpoints the
// printer pulls from.

import { checkToken, safeEqual } from "./auth.js";
import { adminAuth, mintSession, setCookie, clearCookie } from "./session.js";
import { harden, htmlCsp, nonce, JSON_CSP } from "./headers.js";
import {
  loadSettings,
  isOpen,
  submissionGate,
  num,
} from "./settings.js";
import {
  claimJob,
  claimBatch,
  buildBatchPayload,
  completeBatch,
  releaseJobs,
  buildPayload,
  completeJob,
  recordHeartbeat,
  sweepStaleLeases,
  MAX_LINES,
} from "./jobs.js";
import { renderProbe, renderTicket } from "./render.js";
import { toBase64 } from "./bitmap.js";
import { profileFor, PROFILES } from "./profiles.js";
import { supportersFor } from "./supporters.js";
import ATLAS from "./font-atlas.js";
// Not exported from this module: a Worker entrypoint may only export handlers,
// and a stray named export makes the whole script fail to load.
import { MAX_TEXT_LENGTH, MAX_PUBLIC_LINES, tidy, tidyHandle } from "./limits.js";
import { undrawable, looksLikeEmoji } from "./font.js";
import { ipKey } from "./ipkey.js";
import { waitEstimate } from "./wait.js";
import {
  record as recordEvent,
  recent as recentEvents,
  sweepEvents,
  failureBurst,
} from "./events.js";
import { createChallenge, verifySolution, spendChallenge, gcChallenges } from "./altcha.js";
import { checkRateLimit, isDuplicate, isEcho } from "./ratelimit.js";
import { screen } from "./blocklist.js";
import { moderate, recordDecision, expirePending } from "./moderation.js";
import {
  notifyReview,
  notifyPrintFailed,
  notifyNoPaper,
  verifyActionToken,
} from "./notify.js";
import {
  loadDesk,
  decide,
  reprint,
  validateSetting,
  resolveSetting,
  saveSetting,
  exportJobs,
  searchJobs,
  requeueFailed,
  paperUsed,
  decideMany,
  decideAllPending,
  budgetedBatch,
  spendBudget,
  readBudget,
} from "./admin.js";
import { ADMIN_PAGE } from "./admin-page.js";
import { NOT_FOUND_PAGE } from "./not-found.js";
import { proxyScript, proxySend } from "./analytics.js";
import {
  bumpCounter,
  counterOrCount,
  reseedCounters,
  PENDING,
  PRINTED,
  QUEUED,
} from "./counters.js";
import { respectEmptyFloor, markEmpty } from "./pollfloor.js";
import { hasPrivateAccess, ACCESS_HEADER } from "./access.js";

// How long the Pico should wait before asking again. Short polling rather than
// the long polling the brief sketched: holding a TLS socket open for a minute
// on MicroPython is fragile and memory-hungry, and the request budget is not
// the constraint here. 5 s over a 10 h day is ~7 200 requests against the
// 100 000 the free tier gives.
const POLL_OPEN_S = 5;
const POLL_CLOSED_S = 300;

const CORS = {
  "access-control-allow-origin": "*",
  // x-access-key rides along so that a key holder opening the site from
  // anywhere is not stopped by a preflight. It is not a credential the browser
  // sends on its own - the page reads it out of the URL fragment and attaches
  // it deliberately - so widening this by one header name widens nothing else.
  "access-control-allow-headers": "content-type, x-access-key",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });

const noContent = (pollAfter) =>
  new Response(null, { status: 204, headers: { "x-poll-after": String(pollAfter) } });

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/**
 * The key the proof-of-work challenges are signed with.
 *
 * Falls back to IP_SALT so that a deployment which has not been given a
 * dedicated secret still signs its challenges with something an attacker does
 * not have. Both are secrets; neither is ever sent to the browser.
 */
const powKey = (env) => env.ALTCHA_HMAC_KEY || env.IP_SALT || env.PRINTER_TOKEN || "";

// --- machine endpoints -----------------------------------------------------

// How long /api/machine/next may hold a connection open waiting for work, and
// how often it looks while it waits.
//
// Only for devices that ask, with ?wait=<seconds>. The Pico never will: its
// cycle is ruled by a nine-minute BLE deadline it cannot talk its way out of
// (firmware/main.py), so a handler that sits on the connection for half a
// minute would be spending the one budget that keeps the printer awake. The
// Raspberry Pi has no radio to protect and nothing better to do, which is what
// turns "up to five seconds after the tap" into "about one".
//
// 25 s rather than 30: Cloudflare will eventually give up on a response that
// produces nothing, and the agent reconnects immediately anyway, so there is
// no reason to find the edge of that.
const LONG_POLL_MAX_S = 25;
// One look a second. The queue is checked with a SELECT and not with the
// claiming UPDATE, so an idle minute costs sixty single-row reads rather than
// sixty writes - the difference between free-tier arithmetic that works and
// arithmetic that does not.
const LONG_POLL_TICK_MS = 1000;
// Twelve and a half seconds, in thank-yous-only mode, and the number is a
// budget rather than a preference.
//
// The probe is not one row in that mode. It cannot be: proving that none of
// the payments is still waiting means looking at each of them, and twelve
// payments cost twenty-four rows however the statement is written. That is the
// floor for this data model, and the CROSS JOIN of 2 September already reached
// it - the fix was real, and it left a multiplier behind.
//
// The multiplier is this tick. Twenty-five looks per poll, a poll every
// twenty-five seconds, forever, is 86,400 probes a day: at one row each that
// is the 86,000 in the budget table, and at twenty-four it is
// 2.07 million, forty-one per cent of the day's allowance, with the printer
// idle and the queue not moving. The arithmetic of that table only ever held
// for the LIVE probe.
//
// So the tick is paid for by what a look costs. In LIVE it stays at one
// second: there the probe IS one row, and a second is what stands between
// somebody tapping approve and paper moving. In thank-yous-only the only thing
// that can end the wait is a payment landing on this same Worker's own webhook,
// nobody is standing at the printer waiting for their own donation, and twelve
// seconds of latency on a thank-you is invisible. Three looks a poll instead of
// twenty-five: 249,000 rows a day rather than 2.07 million.
//
// Slowing it further is not the answer, and neither is short-polling instead:
// a 204 sends the Pico straight back, its firmware is frozen, and the long
// poll is what stops that being a hot loop (pollfloor.js). This tick buys the
// factor of eight that was there to buy. What it does not buy is room to grow
// - see IDLE_PROBE_MAX_SUPPORTERS.
const LONG_POLL_TICK_PAID_MS = 12500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A 204 that also remembers when this device was last turned away. */
const nothingFor = (deviceId, pollAfter) => {
  markEmpty(deviceId);
  return noContent(pollAfter);
};

/**
 * Is there anything for a device to take right now?
 *
 * MUST ask the same question the claim will ask, `only_supporters` included.
 *
 * If it did not, the long poll would return the instant any job was approved,
 * the claim would find nothing it was allowed to hand out, the device would
 * get a 204 and come straight back - a hot loop against D1 for as long as the
 * mode stayed on, which with four thousand queued messages is indefinitely.
 * The bug would look like "the agent is very busy doing nothing".
 */
export async function anythingApproved(db, onlySupporters = false) {
  // CROSS JOIN for the same reason the claim uses one, and it matters more
  // here: this runs once a second for the whole length of a long poll, so the
  // join order SQLite guesses is multiplied by twenty-five before the device
  // has even been answered. See PICK_SUPPORTER in jobs.js.
  const sql = onlySupporters
    ? `SELECT 1 AS ok FROM supporters s CROSS JOIN jobs j ON j.id = s.job_id
        WHERE j.status = 'approved' LIMIT 1`
    : "SELECT 1 AS ok FROM jobs WHERE status = 'approved' LIMIT 1";
  return Boolean(await db.prepare(sql).first());
}

// --- what the idle probe costs, and the day it stops being affordable ------

/** D1's daily allowance on the free plan, which is what all of this is about. */
const DAILY_ROWS_READ = 5_000_000;
/** The share of it the thank-yous-only probe is allowed to have. */
const IDLE_PROBE_SHARE = 0.1;

/**
 * Rows a day the thank-yous-only probe reads with nothing happening at all.
 *
 * Two rows per payment, and that figure is the plan's promise rather than a
 * guess: `supporters` is the outer loop and `jobs` is entered by rowid once
 * per row (PICK_SUPPORTER in jobs.js, and the rule in d1-cost.test.mjs that
 * holds it there). Twelve payments, twenty-four rows, measured in production
 * on 3 September at exactly that.
 *
 * Derived from the constants rather than written down, so that changing the
 * tick moves the budget with it instead of leaving a stale number in a comment.
 */
export function idleProbeRowsPerDay(supporters, tickMs = LONG_POLL_TICK_PAID_MS) {
  // A look on entry, then one per tick until the deadline.
  const looksPerPoll = Math.floor((LONG_POLL_MAX_S * 1000) / tickMs) + 1;
  const pollsPerDay = 86400 / LONG_POLL_MAX_S;
  return Math.round(looksPerPoll * pollsPerDay * 2 * supporters);
}

/**
 * How many payments that budget stretches to. Twenty-four, at the tick above.
 *
 * This is the honest limit of the 2 September fix, and it deserves saying
 * plainly rather than being discovered a third time. `CROSS JOIN` moved the
 * probe's cost from the queue to the supporters table - five thousand rows to
 * twelve - and a table five hundred times smaller is not a table that does not
 * grow. It grows by two rows a day's probing per donation, forever, because a
 * payment is never undone.
 *
 * Past this line the answer is not a slower tick. It is to stop asking
 * `supporters` the question: a marker on `jobs` written when a priority ticket is
 * created, with a partial index over it, makes the probe one row whatever the
 * table holds. That costs a column, a migration and a write path, which is why
 * it is not here yet - and why the cron says so before the bill does.
 */
export const IDLE_PROBE_MAX_SUPPORTERS = Math.floor(
  (DAILY_ROWS_READ * IDLE_PROBE_SHARE) / idleProbeRowsPerDay(1)
);

/**
 * Writes it down, from the cron, when the supporters table outgrows the probe.
 *
 * Both days this project lost to D1 were a query whose cost grew on its own
 * while every test stayed green, and both were noticed by an email from
 * Cloudflare. This is the same shape of problem caught one donation at a time
 * instead: a COUNT over twelve rows, once a day, that lands in the operational
 * memory and shows up at /admin.
 *
 * Returns null while there is nothing to say, which is the ordinary case.
 */
export async function checkIdleProbeBudget(db, now = Date.now()) {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM supporters").first();
  const supporters = Number(row?.n ?? 0);
  if (supporters <= IDLE_PROBE_MAX_SUPPORTERS) return null;
  const rows = idleProbeRowsPerDay(supporters);
  await recordEvent(
    db,
    "note",
    {
      detail:
        `${supporters} payments: the idle poll's probe now reads about ` +
        `${rows.toLocaleString("en")} rows a day, past the ` +
        `${IDLE_PROBE_MAX_SUPPORTERS} it was budgeted for. It needs a marker ` +
        `on jobs and a partial index now, not a slower poll.`,
    },
    now
  );
  return { supporters, rows };
}

async function handleNext(request, env, url) {
  const deviceId = url.searchParams.get("device") || "pico-1";
  // The device names the printer it is plugged into. Absent means the MXW01,
  // because the Pico's firmware predates this parameter and is frozen for the
  // open-source release - see profiles.js.
  const profile = profileFor(url.searchParams.get("profile"));
  // Before anything is read, not after: the point is to cost nothing.
  await respectEmptyFloor(deviceId);

  const settings = await loadSettings(env.DB);
  const { open } = isOpen(settings);
  const pollWhenEmpty = open ? num(settings, "poll_interval_s", POLL_OPEN_S) : POLL_CLOSED_S;

  if (!open) {
    // Nothing is handed out while closed. There is no backlog to flush at
    // 10:00 because nothing was accepted while closed either.
    return nothingFor(deviceId, pollWhenEmpty);
  }

  await sweepStaleLeases(env.DB);
  // Only when an expiry is actually configured, and that condition is the
  // whole point rather than a micro-optimisation.
  //
  // This used to be called unconditionally, with a comment calling it "a no-op
  // while the expiries are 0". It was not a no-op. Both TTLs have been 0 since
  // 29 August, so no job carries an expires_at and the sweep matched nothing -
  // but its SELECT still had to READ every pending row to discover that, and
  // this handler runs every 25 seconds forever. Five thousand queued messages
  // times 3,460 polls a day is seventeen million rows read for an answer that
  // was always the empty set, and on 1 September it exhausted D1's free tier.
  //
  // The partial index added the same day (schema.sql) makes the sweep cheap
  // even when it does run; this check makes it free when it cannot match.
  // Turning a TTL back on from /admin still takes effect on the next poll, so
  // nothing here depends on the cron trigger, exactly as before.
  if (num(settings, "hold_ttl_h", 0) > 0 || num(settings, "pending_ttl_h", 0) > 0) {
    await expirePending(env.DB);
  }

  // A Pico that asks for a batch gets one strip carrying several tickets, so
  // the printer's end-of-print eject is paid once instead of once per message.
  // Firmware that does not ask keeps the old one-job-per-poll contract, which
  // is what makes this safe to deploy before the board is reflashed.
  const batchSize = Math.min(Math.max(Number(url.searchParams.get("batch")) || 1, 1), MAX_BATCH);

  // Hold the connection open rather than answer 204, if the caller asked.
  // Nothing here claims anything: it only waits for something to be there, so
  // a device that gives up mid-wait leaves no job marked as handed out.
  const onlySupporters = settings.only_supporters === "1";

  // "Print a thousand of them and stop." Zero while idle as well as when no
  // budget is set: idle already prints nothing but thank-yous, and a thank-you
  // must not spend a budget that has been paused or has already run out.
  let budget = onlySupporters ? 0 : Math.max(num(settings, "print_budget", 0), 0);

  const waitS = Math.min(Math.max(Number(url.searchParams.get("wait")) || 0, 0), LONG_POLL_MAX_S);
  if (waitS > 0) {
    const until = Date.now() + waitS * 1000;
    // What one look costs decides how often it is taken - see the constants.
    const tick = onlySupporters ? LONG_POLL_TICK_PAID_MS : LONG_POLL_TICK_MS;
    while (!(await anythingApproved(env.DB, onlySupporters))) {
      const left = until - Date.now();
      if (left <= 0) return nothingFor(deviceId, pollWhenEmpty);
      // Clamped to what is left of the wait, so a five-second tick cannot hold
      // the connection open past the deadline the device sized its own read
      // timeout against.
      await sleep(Math.min(tick, left));
    }
    // The wait was up to 25 seconds long, and settings were read before it.
    // With two devices on the wire the other one can have finished the run in
    // the meantime, and claiming on the stale figure would hand out one strip
    // past the end. One row, and only while a run is actually going.
    if (budget > 0) {
      budget = await readBudget(env.DB);
      // Zero here is "the run ended while we waited", never "no budget": this
      // branch is only reached when there was one. The mode is already back to
      // idle and this request is the only thing that has not heard. Answering
      // 204 rather than falling through matters - falling through would read
      // the 0 as "no limit" and hand out the rest of the queue.
      if (!budget) return nothingFor(deviceId, pollWhenEmpty);
    }
  }

  // The last strip is short by exactly as much as the budget is, so the run
  // ends on the number asked for rather than on a batch boundary.
  const tickets = budgetedBatch(batchSize, budget);

  if (tickets > 1) {
    return await handleNextBatch(
      env, deviceId, settings, tickets, pollWhenEmpty, profile, onlySupporters, budget
    );
  }

  const job = await claimJob(env.DB, deviceId, Date.now(), onlySupporters);
  if (!job) return nothingFor(deviceId, pollWhenEmpty);

  // a tip jar jobs are drawn differently and jump the queue, so the claim may well
  // have handed us one. One extra query, only on the single-job path.
  const supporter = (await supportersFor(env.DB, [job.id])).get(job.id) ?? null;

  let payload;
  try {
    payload = buildPayload(job, settings, profile, supporter);
  } catch (err) {
    // A job we cannot render is a job that will never print. Fail it now
    // rather than hand the Pico something it cannot use, forever.
    await completeJob(env.DB, {
      id: job.id,
      deviceId,
      ok: false,
      error: `render failed: ${err.message}`,
    });
    console.log(JSON.stringify({ event: "render_failed", id: job.id, error: err.message }));
    return nothingFor(deviceId, pollWhenEmpty);
  }

  // After the render, so a ticket that could never have printed does not cost
  // one. Awaited rather than deferred: the next poll is a second away and must
  // see the new figure, or a budget of one hands out two.
  if (budget > 0) await spendBudget(env.DB, 1);

  console.log(
    JSON.stringify({ event: "claimed", id: job.id, device: deviceId, lines: payload.lines })
  );
  return json(payload, 200, { "x-poll-after": "0" });
}

/**
 * How many tickets one strip may carry.
 *
 * Not a paper limit but a sanity one: the real ceiling is MAX_LINES, enforced
 * while rendering. This only stops a malformed query claiming the whole table
 * and then releasing most of it.
 */
const MAX_BATCH = 12;

/**
 * Ceiling on one bulk decision.
 *
 * Not a policy about how many messages may be approved - it is a bound on one
 * SQL statement's parameter list, so a malformed or hostile body cannot build
 * a query with fifty thousand placeholders in it. The page pages through
 * anything larger.
 */
const MAX_BULK = 500;

async function handleNextBatch(
  env, deviceId, settings, batchSize, pollWhenEmpty, profile, onlySupporters = false, budget = 0
) {
  const jobs = await claimBatch(env.DB, deviceId, batchSize, Date.now(), onlySupporters);
  if (!jobs.length) return nothingFor(deviceId, pollWhenEmpty);

  let built;
  try {
    built = buildBatchPayload(jobs, settings, profile);
  } catch (err) {
    // Only the first ticket can trigger this, and only by being unrenderable
    // on its own. Fail it and hand the rest back, rather than letting one bad
    // row block the queue behind it forever.
    await completeBatch(env.DB, {
      ids: [jobs[0].id],
      deviceId,
      ok: false,
      error: `render failed: ${err.message}`,
    });
    await releaseJobs(env.DB, jobs.slice(1).map((job) => job.id), deviceId);
    console.log(JSON.stringify({ event: "render_failed", id: jobs[0].id, error: err.message }));
    return nothingFor(deviceId, pollWhenEmpty);
  }

  if (built.leftOver.length) {
    await releaseJobs(env.DB, built.leftOver.map((job) => job.id), deviceId);
  }

  // The paper gauge: the printer says "empty" and nothing else, and it says it
  // the moment the roll runs out. Recording how tall each ticket was is the
  // only way to know how much is left before that happens - it ran out twice
  // on 30 August, the second time with nobody in the flat.
  await rememberHeights(env.DB, built);

  // The tickets on the strip, not the tickets claimed: buildBatchPayload hands
  // back whatever did not fit under max_batch_lines, and released paper was
  // never going to be printed.
  if (budget > 0) await spendBudget(env.DB, built.payload.ids.length);

  console.log(
    JSON.stringify({
      event: "claimed_batch",
      ids: built.payload.ids,
      device: deviceId,
      lines: built.payload.lines,
      released: built.leftOver.length,
    })
  );
  return json(built.payload, 200, { "x-poll-after": "0" });
}

// How many failures inside how long counts as a fault worth waking somebody
// for, and how long to stay quiet afterwards so one bad hour is one message
// and not forty.
const BURST_WINDOW_MS = 15 * 60 * 1000;
const BURST_THRESHOLD = 4;
const BURST_QUIET_MS = 60 * 60 * 1000;

/**
 * Wakes somebody when prints start failing in a run.
 *
 * Two things this got wrong on its first evening, and both mattered because
 * the cost of an alerting bug is paid in trust:
 *
 * 1. It counted thermal refusals. Those send nothing, lose nothing and requeue
 *    themselves - they are the machine working, several times an hour, and
 *    eleven alerts went out for them. Only a failure that actually lost a
 *    ticket counts now, which is what `print_failed` means since the refusals
 *    were given their own kind.
 *
 * 2. The quiet period lived in a module variable. Worker isolates come and go
 *    constantly, so it reset to zero over and over and the hour of silence
 *    never happened. It belongs in the database, which is the only thing here
 *    that remembers anything.
 */
async function alertOnBurst(env, ctx) {
  const now = Date.now();
  const settings = await loadSettings(env.DB);
  const last = Number(settings.last_burst_alert) || 0;
  if (now - last < BURST_QUIET_MS) return;
  const n = await failureBurst(env.DB, BURST_WINDOW_MS, now);
  if (n < BURST_THRESHOLD) return;
  await saveSetting(env.DB, "last_burst_alert", String(now));
  await recordEvent(env.DB, "note", {
    detail: `${n} print failures in ${BURST_WINDOW_MS / 60000} minutes`,
  });
  await notifyPrintFailed(
    env,
    0,
    `${n} print failures in ${BURST_WINDOW_MS / 60000} minutes - something is wrong`,
    n
  );
}

/**
 * Stores the rendered height of each ticket on a strip.
 *
 * Approximate by construction - a strip is a little taller than its tickets
 * apart, because of the separators - and that is fine: the gauge answers "is
 * there about a metre left", not "how many millimetres".
 */
async function rememberHeights(db, built) {
  const spans = built.payload.spans ?? [];
  await Promise.all(
    spans.map((span) =>
      db
        .prepare("UPDATE jobs SET lines = ? WHERE id = ?")
        .bind(Math.max(Number(span.lines) || 0, 0), span.id)
        .run()
    )
  );
}

async function handleDone(request, env, ctx) {
  const body = await readJson(request);
  const batchIds = Array.isArray(body?.ids)
    ? body.ids.filter((id) => typeof id === "number")
    : null;
  if (!body || (!batchIds?.length && typeof body.id !== "number")) {
    return json({ error: "expected {id, ok, crc} or {ids, ok, crc}" }, 400);
  }
  const deviceId = body.device || "pico-1";
  const ok = body.ok === true;
  const reason = ok ? null : String(body.error ?? "print failed").slice(0, 200);

  if (batchIds?.length) {
    const { changed, retrying, rescued } = await completeBatch(env.DB, {
      ids: batchIds,
      deviceId,
      ok,
      crc: typeof body.crc === "number" ? body.crc : null,
      error: reason,
      // The Pico says whether a single byte reached the printer. Nothing sent
      // means nothing on the floor, so the strip can safely go round again.
      retry: body.retry === true,
      // And when something did go out, how far it got, so only the tickets
      // that were actually reached are given up on.
      sentLines: Number.isInteger(body.sent) ? body.sent : null,
      spans: Array.isArray(body.spans) ? body.spans : null,
    });
    console.log(
      JSON.stringify({ event: "done_batch", ids: batchIds, ok, updated: changed, retrying })
    );

    ctx.waitUntil(
      recordEvent(env.DB, ok ? "print_ok" : retrying ? "print_refused" : "print_failed", {
        detail: ok
          ? `${batchIds.length} ticket(s) printed`
          : retrying
            ? `${reason} - requeued, nothing was sent`
            : rescued?.length
              ? `${reason} - ${rescued.length} of ${batchIds.length} rescued`
              : reason,
        paceMs: Number.isInteger(body.pace) ? body.pace : null,
        stalls: Number.isInteger(body.stalls) ? body.stalls : null,
        sentLines: Number.isInteger(body.sent) ? body.sent : null,
        jobIds: batchIds,
      })
    );

    // One notification for the strip, not one per ticket. Only when the batch
    // is really finished: a strip going back in the queue is not news.
    if (changed && !ok && !retrying) {
      const lost = batchIds.length - (rescued?.length ?? 0);
      if (lost > 0) {
        ctx.waitUntil(notifyPrintFailed(env, batchIds[0], `lot: ${lost} perdu(s) - ${reason}`, 1));
      }
    }
    return json({ ok: true, updated: changed, retrying, rescued });
  }

  const outcome = await completeJob(env.DB, {
    id: body.id,
    deviceId,
    ok,
    crc: typeof body.crc === "number" ? body.crc : null,
    error: reason,
  });
  console.log(
    JSON.stringify({
      event: "done",
      id: body.id,
      ok,
      updated: outcome.changed,
      retrying: outcome.retrying,
      attempts: outcome.attempts,
    })
  );

  // A print that has run out of attempts is the one case nobody would ever
  // find out about on their own: the author is told nothing by design, and the
  // desk does not poll. Two of these sat dead in the table for days.
  if (outcome.changed && !ok && !outcome.retrying) {
    ctx.waitUntil(notifyPrintFailed(env, body.id, reason, outcome.attempts));
  }

  if (!outcome.changed) {
    // Either the lease expired and the sweep already failed it, or this device
    // never held it. Not an error the Pico can act on, so tell it plainly and
    // let it move on.
    return json({ ok: false, reason: "not claimed by this device" }, 409);
  }
  return json({ ok: true });
}

async function handleHeartbeat(request, env, ctx) {
  const body = (await readJson(request)) ?? {};
  const deviceId = body.device || "pico-1";
  const profile = profileFor(body.profile);

  // Read the state we had before overwriting it: the alert below has to fire
  // on the transition, not on every heartbeat, and heartbeats arrive every few
  // seconds.
  const previous = await env.DB.prepare(
    "SELECT printer_state FROM devices WHERE id = ?"
  )
    .bind(deviceId)
    .first();

  await recordHeartbeat(env.DB, deviceId, body);

  // Every change of the printer's state, and only the changes.
  //
  // This is what answers the question left open on 30 August: the printer went
  // silent for 26 minutes and came back, and nobody could say whether a human
  // had pressed its button. docs/09-protocol.md insists only the button wakes it. If
  // an asleep -> awake transition ever lands here with nobody in the flat, the
  // documentation is wrong about the one thing the status page repeats.
  //
  // On the transition only: heartbeats arrive every few seconds, and a row per
  // heartbeat would bury the six that matter under a hundred thousand.
  if (body.printer_state && body.printer_state !== previous?.printer_state) {
    ctx.waitUntil(
      recordEvent(env.DB, "printer_state", {
        detail: `${previous?.printer_state ?? "unknown"} -> ${body.printer_state}`,
        temperature: body.temperature ?? null,
      })
    );

    // Going from an empty roll to a working one means somebody loaded paper.
    // Nothing else can produce that transition, so the gauge stamps itself
    // rather than waiting for a button nobody remembers to press - it had been
    // counting from the beginning of time because that button never was.
    if (previous?.printer_state === "no_paper" && body.printer_state !== "no_paper") {
      ctx.waitUntil(
        (async () => {
          await saveSetting(env.DB, "roll_changed_at", String(Date.now()));
          await recordEvent(env.DB, "paper", { detail: "new roll detected, gauge reset" });
        })()
      );
    }
  }

  // A run of failures is a fault; one is a bad afternoon. Eighteen tickets
  // died on 30 August and the way it was noticed was the owner refreshing a page.
  if (body.printer_state === "error" || body.prints_failed > (previous?.prints_failed ?? 0)) {
    ctx.waitUntil(alertOnBurst(env, ctx));
  }

  if (body.printer_state === "no_paper" && previous?.printer_state !== "no_paper") {
    const waiting = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM jobs WHERE status IN ('approved', 'pending')"
    ).first();
    ctx.waitUntil(notifyNoPaper(env, waiting?.n ?? 0));
  }

  const settings = await loadSettings(env.DB);
  const { open, reason } = isOpen(settings);
  // The heartbeat is also how the Pico learns what to do next: it is the one
  // call that always happens, open or closed.
  return json({
    ok: true,
    open,
    reason,
    server_time: Date.now(),
    poll_interval_s: open ? num(settings, "poll_interval_s", POLL_OPEN_S) : POLL_CLOSED_S,
    kill_switch: settings.kill_switch === "1",
    // The device's own ceiling, not a global one. 1024 lines is the Pico's
    // RAM; the Raspberry Pi has no such wall and being told it did would cap
    // a strip at an eighth of what the machine can print.
    max_lines: profile.maxLines,
    profile: profile.id,
    // The thermostat travels with the heartbeat so it can be retuned from
    // /admin without touching the board. Clamped here as well as in /admin:
    // a hand-edited settings row must not be able to cook the print head.
    //
    // MXW01 numbers. That printer reports its head temperature in every A1
    // status frame and has no thermal protection of its own worth the name,
    // so the thermostat had to live in the firmware. The TRP 100 III reports
    // no temperature over ESC/POS and looks after its own head; the agent
    // reads these two fields and ignores them, which is why they are still
    // sent rather than made conditional - one shape of heartbeat reply.
    head_max_c: clamp(num(settings, "head_max_c", 38), 30, 45),
    cool_to_c: clamp(num(settings, "cool_to_c", 34), 25, 43),
  });
}

/**
 * A ticket that exercises the whole transport without touching the queue.
 * Its CRC is computable on both ends, and its lines are individually numbered,
 * so a truncated or reordered transfer cannot pass unnoticed.
 */
function handleProbe(url) {
  const profile = profileFor(url.searchParams.get("profile"));
  const lines = Math.min(Number(url.searchParams.get("lines")) || 32, profile.maxLines);
  const canvas = renderProbe(lines, profile);
  return json({
    id: 0,
    profile: profile.id,
    lines: canvas.height,
    width_bytes: profile.widthBytes,
    width_pixels: profile.widthPixels,
    crc: canvas.crc8(),
    intensity: 0x5d,
    feed_lines: 0,
    data: toBase64(canvas.toBytes()),
  });
}

// --- public endpoints ------------------------------------------------------

/**
 * Salted hash of the caller's IP. The raw address is never stored.
 *
 * The salt is a secret, which is what makes this more than decoration: a
 * plain SHA-256 of an IPv4 address is trivially reversible by enumerating the
 * four billion of them.
 *
 * `cf-connecting-ip` cannot be forged: Cloudflare's edge refuses, with a 403
 * of its own, any request that arrives already carrying that header. Verified
 * against the deployed Worker rather than assumed - the whole rate limit rests
 * on it.
 *
 * ipKey() decides what counts as one person before the hash. See ipkey.js:
 * IPv6 is truncated to its /64, or the quota would count nothing.
 */
async function hashIp(request, env) {
  const ip = ipKey(request.headers.get("cf-connecting-ip") ?? "unknown");
  const salt = env.IP_SALT ?? "";
  const data = new TextEncoder().encode(salt + ip);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .slice(0, 16)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Mints a proof-of-work challenge for the form.
 *
 * The difficulty is cached, and that is not a micro-optimisation. This
 * endpoint is unauthenticated and precedes the rate limit by construction - a
 * bot cannot be told to go away until it has solved something - so a database
 * read here is a database read anyone can trigger at will. At a hundred
 * requests a second, reading the settings table would spend the free tier's
 * daily row budget before lunch. The cost of the cache is that a difficulty
 * changed from /admin takes up to a minute to bite.
 */
let difficultyCache = { value: null, until: 0 };
const DIFFICULTY_TTL_MS = 60 * 1000;

async function handleChallenge(request, env) {
  const now = Date.now();
  // Minted only for a door that is actually open.
  //
  // Not security - the submit path refuses on its own, and has to - but a shut
  // service that hands out proof-of-work challenges is a shut service doing
  // arithmetic on demand for anybody who asks. Refusing here also means the
  // page finds out the season is over before somebody types two hundred
  // characters into a box that will say no.
  const settings = await loadSettings(env.DB);
  const gate = submissionGate(settings, {
    now,
    privateAccess: await hasPrivateAccess(request, env),
  });
  if (!gate.open) {
    return json({ error: "closed", reason: gate.reason }, 403, {
      ...CORS,
      "cache-control": "no-store",
    });
  }
  if (difficultyCache.value === null || now > difficultyCache.until) {
    difficultyCache = {
      value: num(settings, "pow_difficulty", 150000),
      until: now + DIFFICULTY_TTL_MS,
    };
  }
  const challenge = await createChallenge(powKey(env), { maxnumber: difficultyCache.value });
  return json(challenge, 200, { ...CORS, "cache-control": "no-store" });
}

const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);

const RATE_MESSAGES = {
  // Singular matters here: the quota went to one on 30 August and the refusal
  // would otherwise have read "that is your 1 messages for today".
  daily: (n) =>
    n === 1
      ? "That is your message for today. The counter resets at midnight, Paris time."
      : `That is your ${n} messages for today. The counter resets at midnight, Paris time.`,
  hourly: () => "That is a lot at once. Give it an hour.",
  cooldown: (_n, s) =>
    `One message at a time — try again in ${Math.max(1, Math.ceil(s / 60))} minutes.`,
  queue: () => "The queue is full. Come back in a few minutes.",
};

/**
 * Refuses a submission driven from somebody else's page.
 *
 * /api/status and /api/font are open to anyone - they are public facts. The
 * form is not: with `allow-origin: *` and nothing else, any site could make
 * each of its visitors spend their daily quota, from their own IP,
 * without them noticing. The rate limit cannot see that, because as far as it
 * is concerned those are three ordinary people.
 *
 * A same-origin fetch sends its own Origin, and a request with no Origin at
 * all - curl, the integration tests - is not a browser being used against its
 * owner, so it passes.
 */
function foreignOrigin(request, url) {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).host !== url.host;
  } catch {
    return true;
  }
}

async function handleSubmit(request, env, ctx, url) {
  if (foreignOrigin(request, url)) {
    return json({ ok: false, error: "Post it from the site itself." }, 403, CORS);
  }

  const settings = await loadSettings(env.DB);
  // One gate, server-side, and not merely hidden in the page: the form is not
  // the only way to reach this endpoint. Note what is NOT gated - handleNext()
  // is untouched, so the queue goes on being handed to the printer long after
  // the last message is taken in. See submissionGate in settings.js.
  const gate = submissionGate(settings, {
    privateAccess: await hasPrivateAccess(request, env),
  });
  if (!gate.open) {
    return json(
      gate.reason === "season_over"
        ? {
            ok: false,
            reason: "season_over",
            error: "Season 1 is over. Thank you for taking part.",
          }
        : { ok: false, reason: gate.reason },
      403,
      CORS
    );
  }

  const body = await readJson(request);
  const raw = typeof body?.text === "string" ? body.text : null;
  if (raw === null) return json({ ok: false, error: "expected {text}" }, 400, CORS);

  // Normalise before measuring: an accented character typed as letter plus
  // combining mark would otherwise count twice against the limit. tidy() then
  // collapses the blank space, which the character budget does not constrain -
  // 199 newlines fit inside 200 characters.
  const text = tidy(raw.normalize("NFC"));
  if (!text) return json({ ok: false, error: "The message is empty." }, 400, CORS);
  if ([...text].length > MAX_TEXT_LENGTH) {
    return json({ ok: false, error: `${MAX_TEXT_LENGTH} characters maximum.` }, 400, CORS);
  }

  // Refused here, while the author is still on the page and can fix it.
  //
  // The font has no emoji, so fold() turns one into a question mark. Every
  // other check waves it through - it is one character, it is not blank space,
  // it is not a slur - and the message prints as "Bonjour ? le monde". The
  // author never learns that, and neither does anyone reading the ticket.
  //
  // The rule is "the font cannot draw this", not "this looks like an emoji":
  // a Cyrillic or Greek message prints as a row of question marks for exactly
  // the same reason and deserves the same answer. Only the wording splits the
  // two, because "remove the emoji" is actionable and "remove these
  // characters" is what is left to say otherwise.
  const cannotDraw = undrawable(text);
  if (cannotDraw.length) {
    const emoji = cannotDraw.filter(looksLikeEmoji);
    const error = emoji.length
      ? `The printer cannot print emoji. Please remove ${emoji.slice(0, 5).join(" ")} and try again.`
      : `The printer cannot print ${cannotDraw.slice(0, 5).join(" ")}. Please rewrite without it.`;
    return json({ ok: false, error }, 400, CORS);
  }

  // The handle is optional and, unlike the message, it is never sent to the AI
  // moderator. A handle is a name: it is short, it has no grammar, and half of
  // them look like keyboard noise, so a classifier reading `xj9_kk` has
  // nothing to go on and everything to get wrong. The word list is enough, and
  // it is built to avoid exactly this kind of false positive.
  //
  // A handle that does not survive is dropped, never fatal. Losing a signature
  // is a smaller harm than losing the message it was attached to.
  let handle = tidyHandle(body.handle);
  if (handle === undefined) handle = null;
  if (handle && screen(handle).severity) handle = null;

  // Proof of work, before anything that costs a database round trip. A script
  // that has not solved a challenge never reaches D1 at all.
  const solution = await verifySolution(powKey(env), body?.altcha, Date.now());
  if (!solution.ok) {
    return json(
      { ok: false, error: "Verification failed, please try again.", retry_challenge: true },
      400,
      CORS
    );
  }

  const ipHash = await hashIp(request, env);

  // The quota is checked BEFORE the challenge is spent, and the order matters
  // under attack. Spending is a database write; someone already over quota
  // would otherwise get to make us write a row for every solution they grind
  // out, which is the one way a bot that cannot post can still cost us
  // something.
  const limit = await checkRateLimit(env.DB, ipHash, settings, Date.now());
  if (!limit.ok) {
    const message = RATE_MESSAGES[limit.reason](
      num(settings, "rate_per_day", 3),
      limit.retryAfterS
    );
    return json({ ok: false, error: message, retry_after: limit.retryAfterS }, 429, {
      ...CORS,
      "retry-after": String(limit.retryAfterS),
    });
  }

  if (!(await spendChallenge(env.DB, solution.challenge, solution.expires))) {
    // Same solution twice. One challenge, one message.
    return json(
      { ok: false, error: "Verification failed, please try again.", retry_challenge: true },
      400,
      CORS
    );
  }

  if (await isDuplicate(env.DB, ipHash, text, settings)) {
    // A double tap on a flaky connection looks exactly like this, and printing
    // it twice is the worse of the two mistakes.
    return json({ ok: false, error: "You already sent that one." }, 409, CORS);
  }

  // Render it now rather than at print time: a message that cannot be laid out
  // should be refused while its author is still there to be told, not
  // discovered by a Pico at three in the morning.
  //
  // MAX_PUBLIC_LINES, not MAX_LINES: the first is how much paper a stranger
  // may spend, the second is how much RAM the Pico has. Treating them as the
  // same number was worth twelve centimetres a ticket. See limits.js.
  let lines;
  try {
    lines = renderTicket(text, { id: 0, handle }).height;
    if (lines > MAX_PUBLIC_LINES) {
      return json({ ok: false, error: "That message would use too much paper." }, 400, CORS);
    }
  } catch {
    return json({ ok: false, error: "That message cannot be printed." }, 400, CORS);
  }

  // The same sentence, from a different address, minutes ago. Every limit
  // above counts one address at a time, which is what a botnet exists to
  // defeat; what its machines share is the text somebody wrote once for all of
  // them. Silent, and it costs one of the three, like every other rejection.
  const echo = await isEcho(env.DB, text);

  const decision = echo
    ? { verdict: "rejected", source: "spam", reason: "echo", score: 1, aiLabel: null }
    : await moderate(text, { ai: env.AI, settings });

  // With hold_all on, the filters only ever throw something away; they never
  // decide to print. A clean message becomes a job waiting for a tap, exactly
  // like a grey one, and the ticket comes out when the owner says so. The
  // moderation row still records what the filters thought, which is what lets
  // the desk show "clean" next to one card and a reason next to another.
  const holdAll = settings.hold_all !== "0";
  const held = holdAll && decision.verdict === "approved";
  const status =
    decision.verdict === "rejected" ? "rejected" : held ? "pending" : decision.verdict;
  const waiting = status === "pending";

  const now = Date.now();
  // Both expiries default to 0, which means never, and that is the owner's call
  // rather than the brief's: the brief asked for an unreviewed message to be
  // dropped after two hours. A queued message is a few hundred bytes of text
  // that costs nothing to keep, and "I did not look for five days" is a normal
  // week, not a failure. Throwing somebody's message away because nobody
  // picked up a phone is the one behaviour here with no upside.
  //
  // The mechanism stays, because turning it back on is one number in /admin.
  const ttlHours = held ? num(settings, "hold_ttl_h", 0) : num(settings, "pending_ttl_h", 0);
  const expiresAt = waiting && ttlHours > 0 ? now + ttlHours * 60 * 60 * 1000 : null;

  const row = await env.DB.prepare(
    `INSERT INTO jobs (text, status, created_at, ip_hash, moderation_score, expires_at, handle)
     VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`
  )
    .bind(text, status, now, ipHash, decision.score, expiresAt, handle)
    .first();

  if (row?.id) {
    // A message that was refused never entered the queue, so only the other
    // two are counted. See counters.js for why the queue length is written
    // rather than counted: a COUNT on the submit path is a scan of everything
    // already queued, paid for by every new message.
    if (status !== "rejected") await bumpCounter(env.DB, QUEUED, 1);
    // And a second counter for the one the desk shows, which asks a different
    // question: not "how many are in the queue" but "how many are waiting for
    // me". See counters.js.
    if (status === "pending") await bumpCounter(env.DB, PENDING, 1);
    await recordDecision(env.DB, row.id, decision, now);
    if (waiting) {
      ctx.waitUntil(
        notifyReview(env, url.origin, { id: row.id, text }, decision, { held })
      );
    }
  }

  console.log(
    JSON.stringify({
      event: "submitted",
      id: row?.id,
      lines,
      verdict: decision.verdict,
      status,
      source: decision.source,
      reason: decision.reason,
    })
  );

  // Deliberately identical for approved, pending and rejected. No photo, no
  // tracking link, no queue position, and above all no hint that a filter ran.
  //
  // `online` is the one thing it does say, and it says nothing about THIS
  // message: it is the state of the machine, true for everyone, and the page
  // needs it to avoid promising paper from a printer that is asleep.
  //
  // `wait` is the second, added the evening the queue passed a thousand. Still
  // not a queue position - that stays out on purpose - but a promise of paper
  // "on its way" is a small lie when the paper is four days out, and someone
  // who knows that is not disappointed by it.
  const device = await env.DB.prepare(
    "SELECT last_seen FROM devices ORDER BY last_seen DESC LIMIT 1"
  ).first();
  return json(
    { ok: true, id: row?.id, online: isAwake(device), wait: await waitEstimate(env.DB) },
    200,
    CORS
  );
}

/**
 * Has the printer reported in recently enough to be called awake?
 *
 * A sleeping printer is a normal state of this system, not a fault: only its
 * button wakes it. Both the status page and the submission answer need the
 * same definition, and having it twice is how the two drift apart.
 */
function isAwake(device) {
  return device ? Date.now() - device.last_seen < 15 * 60 * 1000 : false;
}

/**
 * How long the status pill may be stale, and why that is free.
 *
 * /api/status is answered on every poll from every open tab, and app.js calls
 * it once every three minutes per VISIBLE tab. On the day the link went round
 * Threads it was one of the largest sources of D1 reads in the system.
 *
 * Thirty seconds loses nothing anybody can see. The freshest field here is the
 * printer's state, and that only changes when a heartbeat lands - once a
 * minute, by HEARTBEAT_EVERY_S in the agent. The pill was already showing a
 * number up to sixty seconds old before any of this existed.
 *
 * TWO caches, because they protect against different things.
 *
 * The per-isolate one below needs no invalidation and cannot go stale across a
 * deploy, but it only helps a tab that lands on an isolate which has answered
 * recently - and a wave of visitors arrives on many isolates in many colos at
 * once, which is exactly when the cache is needed and exactly when it misses.
 *
 * So the response is also put in the colo's own cache, which every isolate in
 * that colo shares. Ten thousand people opening the page in the same city then
 * cost one read between them rather than one each. The same header lets the
 * browser hold it for thirty seconds too, which is free.
 */
const STATUS_TTL_MS = 30_000;
const STATUS_CACHE_S = 30;
let statusCache = { at: 0, payload: null };

/** Where the shared cache stores it. A URL, so it must be a stable one. */
const statusCacheKey = (url) => new Request(new URL("/api/status", url).toString());

async function handleStatus(env, ctx, url, request) {
  // A key holder gets a page that has not been cached for everybody else.
  //
  // Both caches below are keyed on nothing but the URL, so one private answer
  // put in either of them would tell every visitor in the colo that the form
  // is open. The door is rare and the caches are for the common case, so a
  // request carrying a key simply pays for its own reads.
  const privateAccess = request ? await hasPrivateAccess(request, env) : false;
  const cacheable = !privateAccess;

  const fresh = cacheable && statusCache.payload && Date.now() - statusCache.at < STATUS_TTL_MS;
  if (fresh) return statusResponse(statusCache.payload);

  const shared = cacheable && typeof caches !== "undefined" ? caches.default : null;
  if (shared && url) {
    const hit = await shared.match(statusCacheKey(url));
    // Trusted enough to serve, not trusted enough to keep: the colo cache is
    // shared by every isolate here, so a hit says another isolate paid for
    // this recently. It is not put back in the per-isolate cache, which would
    // let one stale body outlive its own max-age by another thirty seconds.
    if (hit) return hit;
  }

  const settings = await loadSettings(env.DB);
  const { open, reason } = isOpen(settings);
  const device = await env.DB.prepare(
    "SELECT id, last_seen, printer_state, temperature, battery FROM devices ORDER BY last_seen DESC LIMIT 1"
  ).first();
  // Read, not counted. This was `SELECT COUNT(*) FROM jobs WHERE status =
  // 'printed'` - every printed row, on every poll from every tab, for a number
  // that only ever goes up by one. See counters.js.
  const printed = await counterOrCount(env.DB, PRINTED);

  // A printer that is asleep is a normal state of this system, not a fault.
  // M6's status page needs to be able to say so.
  const online = isAwake(device);

  const gate = submissionGate(settings, { privateAccess });

  const payload = {
    open,
    reason,
    // The season, separate from the kill switch and from the printer. The
    // page needs all three: paused, out of paper, and over are different
    // things to tell somebody standing in front of an empty text box.
    //
    // Both come from the same gate the submit path uses, so the page can never
    // show a form the server would refuse, nor hide one it would accept. That
    // was two separate readings of the settings before the door existed, and
    // two readings is how they drift.
    accepting: gate.open,
    season_over: !gate.open && gate.reason === "season_over",
    // Says the door was used, so the page can show that it is in private mode
    // rather than quietly behaving differently from everybody else's.
    private_access: gate.privately,
    online,
    per_day: num(settings, "rate_per_day", 3),
    printed,
    printer: device
      ? {
          state: device.printer_state,
          temperature: device.temperature,
          battery: device.battery,
          last_seen: device.last_seen,
        }
      : null,
  };

  if (cacheable) statusCache = { at: Date.now(), payload };
  const response = privateAccess ? privateStatusResponse(payload) : statusResponse(payload);
  if (shared && url && ctx) {
    ctx.waitUntil(shared.put(statusCacheKey(url), response.clone()));
  }
  return response;
}

const statusResponse = (payload) =>
  json(payload, 200, {
    ...CORS,
    "cache-control": `public, max-age=${STATUS_CACHE_S}`,
    // Without this a key holder's own browser would answer their status poll
    // from the public copy it cached thirty seconds earlier, and the form
    // would flicker shut on the one person allowed to use it.
    vary: ACCESS_HEADER,
  });

/** The same answer, marked so that nothing between here and the tab keeps it. */
const privateStatusResponse = (payload) =>
  json(payload, 200, { ...CORS, "cache-control": "no-store" });

// --- admin -----------------------------------------------------------------

/** The one screen a signed link lands on. One button, and it POSTs. */
function confirmPage(id, action, csp) {
  const verb = action === "approve" ? "Print it" : "Discard it";
  return `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Print on my desk #${id}</title>
<style nonce="${csp}">
 body{margin:0;display:grid;place-items:center;min-height:100vh;background:#f4f2ed;color:#16150f;
      font:16px/1.5 ui-monospace,Menlo,monospace}
 @media (prefers-color-scheme:dark){body{background:#14140f;color:#eceadf}}
 form{text-align:center;padding:2rem}
 button{font:inherit;font-weight:700;padding:1rem 2rem;border:1px solid currentColor;
        background:currentColor;color:#f4f2ed;cursor:pointer}
 @media (prefers-color-scheme:dark){button{color:#14140f}}
 p{color:#8c887c;font-size:.875rem}
</style>
<form method="post">
  <p>Message #${id}</p>
  <button type="submit">${verb}</button>
  <p>One tap, and this cannot be undone.</p>
</form>`;
}

async function handleAdmin(request, env, url, path) {
  // One-tap approve/reject from the ntfy notification. Not behind the admin
  // token, because a notification cannot carry it safely: instead the URL
  // holds a signature over this job id and this verb alone, so a leaked link
  // decides one message and nothing else.
  if (path === "/api/admin/act") {
    const id = Number(url.searchParams.get("id"));
    const action = url.searchParams.get("a");
    const token = url.searchParams.get("t");
    const secret = env.ADMIN_TOKEN ?? env.IP_SALT ?? "";
    if (
      !Number.isInteger(id) ||
      !["approve", "reject"].includes(action) ||
      !(await verifyActionToken(secret, id, action, token))
    ) {
      return new Response("Nope.", { status: 403, headers: { "content-type": "text/plain" } });
    }
    // A GET never changes anything. Chat clients, mail scanners and link
    // previewers fetch every URL they are shown, and a signed approve link
    // that acted on GET would mean a message approving itself the moment the
    // notification was rendered. So GET asks, POST acts.
    if (request.method !== "POST") {
      const csp = nonce();
      return new Response(confirmPage(id, action, csp), {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "x-robots-tag": "noindex, nofollow",
          "content-security-policy": htmlCsp(csp),
        },
      });
    }

    const changed = await decide(env.DB, id, action, "notification");
    return new Response(
      changed
        ? `#${id} ${action === "approve" ? "will print" : "discarded"}.`
        : `#${id} was already handled.`,
      { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } }
    );
  }

  // Trading the token for a session cookie. The only route here that accepts
  // the raw ADMIN_TOKEN in a body, and the only one that needs to: after this
  // the desk holds nothing, and its credential is a cookie its own JavaScript
  // cannot read back (see session.js for why that matters on this origin).
  if (path === "/api/admin/session" && request.method === "POST") {
    const body = await readJson(request);
    const offered = typeof body?.token === "string" ? body.token : "";
    if (!env.ADMIN_TOKEN || !safeEqual(offered, env.ADMIN_TOKEN)) {
      console.log(
        JSON.stringify({ event: "admin_auth_failed", path, ipHash: await hashIp(request, env) })
      );
      return json({ ok: false, error: "unauthorized" }, 401);
    }
    const session = await mintSession(env.ADMIN_TOKEN);
    return json({ ok: true }, 200, { "set-cookie": setCookie(session), "cache-control": "no-store" });
  }

  if (path === "/api/admin/logout" && request.method === "POST") {
    return json({ ok: true }, 200, { "set-cookie": clearCookie(), "cache-control": "no-store" });
  }

  const auth = await adminAuth(request, env);
  if (!auth.ok) {
    // ADMIN_TOKEN is 24 random bytes, so guessing it is not a threat anyone
    // can act on. What IS worth knowing is that somebody is trying: a run of
    // these in the logs means the route has been found, and the answer to that
    // is to rotate the token, not to add a lock nobody can pick anyway.
    //
    // The salted hash rather than the address. The rest of this Worker is
    // careful never to let an IP past hashIp(), and an auth failure is not a
    // good enough reason to put one in Cloudflare's logs: the hash still
    // groups a run of attempts, which is the only thing this log is read for.
    console.log(
      JSON.stringify({ event: "admin_auth_failed", path, ipHash: await hashIp(request, env) })
    );
    return json({ error: "unauthorized" }, 401);
  }

  // A cookie is ambient authority: the browser attaches it to whatever a page
  // asks for, including a page the owner did not write. SameSite=Strict already
  // refuses cross-site sends, and this is the second lock on the same door,
  // because one of these being wrong should not be enough.
  //
  // Only for cookies, and only for writes. A header is put there deliberately
  // by whoever composed the request - curl, the export script - and no browser
  // adds one on its own, so header auth has nothing to forge against it.
  if (auth.via === "cookie" && request.method !== "GET" && foreignOrigin(request, url)) {
    return json({ error: "cross-site request refused" }, 403);
  }

  if (path === "/api/admin/queue" && request.method === "GET") {
    const settings = await loadSettings(env.DB);
    await expirePending(env.DB);
    const [desk, paper, events] = await Promise.all([
      loadDesk(env.DB, settings),
      paperUsed(env.DB, settings),
      recentEvents(env.DB, 40),
    ]);
    return json({ ...desk, paper, events, ...isOpen(settings) });
  }

  // Two recoveries a person should not need a terminal for.
  if (path === "/api/admin/recover" && request.method === "POST") {
    const body = await readJson(request);
    if (body?.what === "failed") {
      const n = await requeueFailed(env.DB);
      await recordEvent(env.DB, "note", { detail: `${n} failed job(s) requeued by hand` });
      return json({ ok: true, requeued: n });
    }
    if (body?.what === "roll") {
      // Stamped rather than computed: only a human knows a new roll went in.
      await saveSetting(env.DB, "roll_changed_at", String(Date.now()));
      await recordEvent(env.DB, "paper", { detail: "roll changed" });
      return json({ ok: true });
    }
    return json({ ok: false, error: "expected {what: 'failed'|'roll'}" }, 400);
  }

  // The archive, searched. Separate from /queue because the desk reloads that
  // one every few seconds and a search is a deliberate act: paging three
  // hundred rows through the polling loop would be silly.
  if (path === "/api/admin/search" && request.method === "GET") {
    const found = await searchJobs(env.DB, {
      q: (url.searchParams.get("q") ?? "").trim().slice(0, 200),
      status: url.searchParams.get("status") ?? "",
      limit: Number(url.searchParams.get("limit")) || 100,
      offset: Number(url.searchParams.get("offset")) || 0,
    });
    return json(found);
  }

  // The same decision over many messages. Separate from /job because it is a
  // different shape of mistake to make: one tap here moves a hundred and fifty
  // rows, so the count that comes back is what the page reports rather than a
  // silent "ok".
  if (path === "/api/admin/bulk" && request.method === "POST") {
    const body = await readJson(request);
    const ids = Array.isArray(body?.ids)
      ? body.ids.filter((id) => Number.isInteger(id)).slice(0, MAX_BULK)
      : [];
    const action = body?.action;
    // `scope: "all"` means every waiting message, whether or not the page is
    // showing it. Spelled out by the caller rather than inferred from an empty
    // id list, because "I selected nothing" and "I meant all of them" must
    // never be the same request.
    const all = body?.scope === "all";
    if (!["approve", "reject"].includes(action) || (!all && !ids.length)) {
      return json({ ok: false, error: "expected {ids, action} or {scope:'all', action}" }, 400);
    }
    const changed = all
      ? await decideAllPending(env.DB, action)
      : await decideMany(env.DB, ids, action);
    console.log(
      JSON.stringify({ event: "admin_bulk", action, asked: ids.length, changed })
    );
    await recordEvent(env.DB, "note", {
      detail: `${changed} message(s) ${action}d in one go`,
      jobIds: ids.slice(0, 20),
    });
    return json({ ok: true, changed, asked: ids.length });
  }

  if (path === "/api/admin/job" && request.method === "POST") {
    const body = await readJson(request);
    const id = Number(body?.id);
    const action = body?.action;
    if (!Number.isInteger(id) || !["approve", "reject", "reprint"].includes(action)) {
      return json({ ok: false, error: "expected {id, action}" }, 400);
    }
    // Reprint is not a verdict: it touches a job that was already judged, so
    // it leaves the moderation row exactly as it was.
    const changed =
      action === "reprint"
        ? await reprint(env.DB, id)
        : await decide(env.DB, id, action);
    console.log(JSON.stringify({ event: "admin_decision", id, action, changed }));
    return json({ ok: changed });
  }

  // The archive, as newline-delimited JSON: one ticket per line, appendable,
  // and readable by anything without a parser that has to hold the whole file.
  //   curl -H "x-admin-token: ..." ".../api/admin/export?after=0" > tickets.ndjson
  if (path === "/api/admin/export" && request.method === "GET") {
    const rows = await exportJobs(env.DB, {
      after: Number(url.searchParams.get("after")) || 0,
      limit: Number(url.searchParams.get("limit")) || 500,
    });
    const body = rows.map((row) => JSON.stringify(row)).join("\n");
    return new Response(rows.length ? body + "\n" : "", {
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        // The last id of this page, so a caller knows where to resume without
        // parsing the body it just streamed to disk.
        "x-last-id": String(rows.length ? rows[rows.length - 1].id : 0),
        "x-count": String(rows.length),
      },
    });
  }

  if (path === "/api/admin/settings" && request.method === "POST") {
    const body = await readJson(request);
    const check = validateSetting(body?.key, body?.value);
    if (!check.ok) return json({ ok: false, error: check.error }, 400);
    const [key, value] = resolveSetting(body.key, check.value);
    await saveSetting(env.DB, key, value);
    console.log(JSON.stringify({ event: "admin_setting", key: body.key, value: check.value }));
    return json({ ok: true, key: body.key, value: check.value });
  }

  return json({ error: "not found" }, 404);
}

// --- router ----------------------------------------------------------------

/**
 * Everything this Worker answers.
 *
 * Separate from fetch() below so that every response, on every branch, goes
 * back through one place that sets the security headers. Forty returns and a
 * header list repeated on each of them is a header list that ends up applying
 * to most of a site.
 */
async function route(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  if (path.startsWith("/api/machine/")) {
    if (!checkToken(request, env)) {
      return json({ error: "unauthorized" }, 401);
    }
    try {
      if (path === "/api/machine/next" && request.method === "GET") {
        return await handleNext(request, env, url);
      }
      if (path === "/api/machine/done" && request.method === "POST") {
        return await handleDone(request, env, ctx);
      }
      if (path === "/api/machine/heartbeat" && request.method === "POST") {
        return await handleHeartbeat(request, env, ctx);
      }
      if (path === "/api/machine/probe" && request.method === "GET") {
        return handleProbe(url);
      }
    } catch (err) {
      console.log(JSON.stringify({ event: "error", path, error: String(err) }));
      return json({ error: "internal error" }, 500);
    }
    return json({ error: "not found" }, 404);
  }

  if (path.startsWith("/api/admin/")) {
    try {
      return await handleAdmin(request, env, url, path);
    } catch (err) {
      console.log(JSON.stringify({ event: "admin_error", path, error: String(err) }));
      return json({ error: "internal error" }, 500);
    }
  }

  // The desk itself. Served from the Worker so it is not a file anyone can
  // find by listing the assets.
  //
  // Still served to anyone, and it still holds no secret: what comes back is
  // a password prompt. Everything behind it needs the session cookie, and
  // the cookie is only issued against ADMIN_TOKEN.
  if (path === "/admin") {
    const csp = nonce();
    return new Response(ADMIN_PAGE.replaceAll("__CSP_NONCE__", csp), {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-robots-tag": "noindex, nofollow",
        "content-security-policy": htmlCsp(csp),
      },
    });
  }


  if (path === "/api/status") return await handleStatus(env, ctx, url, request);

  if (path === "/api/challenge") return await handleChallenge(request, env);

  if (path === "/api/submit" && request.method === "POST") {
    try {
      return await handleSubmit(request, env, ctx, url);
    } catch (err) {
      console.log(JSON.stringify({ event: "submit_error", error: String(err) }));
      return json({ ok: false, error: "Something broke on our side." }, 500, CORS);
    }
  }

  // Analytics, relayed through this origin so that the tracker and its
  // events are both same-origin. See analytics.js for why that matters.
  if (path === "/m/c.js" && request.method === "GET") {
    return proxyScript();
  }
  if (path === "/m/api/send" && request.method === "POST") {
    return proxySend(request, !foreignOrigin(request, url));
  }

  // The same atlas the ticket is rendered from, so the browser preview is
  // the ticket rather than an approximation of it. Immutable: a new font is
  // a new deployment.
  if (path === "/api/font") {
    return json(ATLAS, 200, {
      ...CORS,
      "cache-control": "public, max-age=31536000, immutable",
    });
  }

  // A person who mistyped a URL gets a page; a mistyped API route still gets
  // JSON, because whatever called it cannot read HTML.
  if (path.startsWith("/api/")) {
    return json({ error: "not found" }, 404);
  }
  const csp = nonce();
  return new Response(NOT_FOUND_PAGE.replaceAll("__CSP_NONCE__", csp), {
    status: 404,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": htmlCsp(csp),
    },
  });
}

export default {
  /**
   * The front door, and the only place the security headers are set.
   *
   * A handler that already set its own Content-Security-Policy keeps it: the
   * HTML pages each carry a nonce only they know. Everything else gets the
   * JSON policy, which permits nothing at all.
   */
  async fetch(request, env, ctx) {
    return harden(await route(request, env, ctx));
  },

  /**
   * The cron. Two jobs that must happen even when nobody is polling:
   * pending messages expiring, and spent challenges being swept up.
   *
   * expirePending also runs on GET /next, so the two-hour rule holds with or
   * without this trigger. Belt and braces on purpose: a pending job that never
   * expires is a message sitting in a queue forever, which is the one outcome
   * worse than either printing it or dropping it.
   */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        const expired = await expirePending(env.DB);
        const swept = await sweepStaleLeases(env.DB);
        const collected = await gcChallenges(env.DB);
        // Off the hot path on purpose: a DELETE on every insert would make the
        // cheapest write in the system the most expensive one.
        const trimmed = await sweepEvents(env.DB);
        // The counters are the only numbers here nobody recomputes, so this is
        // where they are checked against the table they describe. It counts
        // the whole of `jobs` and does it at most once a day - which is the
        // deal counters.js makes: one unbounded query a day instead of one per
        // submission and one per status poll. Returns null the other 143 times
        // the cron fires.
        const counters = await reseedCounters(env.DB);
        // Only on the day's reconciliation pass, which is what a non-null
        // `counters` means. The cron fires every ten minutes; a budget warning
        // written 144 times a day would bury the operational memory it is
        // meant to appear in, and would give sweepEvents real work to do for
        // the first time in its life.
        const probe = counters ? await checkIdleProbeBudget(env.DB) : null;
        console.log(
          JSON.stringify({ event: "cron", expired, swept, collected, trimmed, counters, probe })
        );
      })()
    );
  },
};
