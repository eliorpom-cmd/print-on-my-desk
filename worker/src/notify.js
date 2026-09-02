// Push to the owner's phone.
//
// Everything that is not rejected outright now waits for a tap, so every held
// message notifies - which makes the CHANNEL's reliability the thing that
// decides whether the service works at all. A message nobody hears about is a
// message that never prints.
//
// Discord is the primary channel and ntfy is kept as a documented fallback;
// the comment on each says why. Both credentials are secrets: a webhook URL is
// a capability, and an ntfy topic is readable by anyone who knows its name.

const encoder = new TextEncoder();

/**
 * A one-tap token for exactly one job and one action.
 *
 * The notification carries approve and reject buttons, so it has to carry
 * something that authorises them. It deliberately is NOT the admin token: this
 * signs the job id and the verb, so the worst a leaked notification can do is
 * approve or reject the one message it was already showing in full.
 */
export async function actionToken(secret, jobId, action) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(`${jobId}:${action}`));
  return [...new Uint8Array(signature)]
    .slice(0, 12)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function verifyActionToken(secret, jobId, action, token) {
  const expected = await actionToken(secret, jobId, action);
  if (typeof token !== "string" || token.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0;
}

/**
 * Sends the review notification on whatever channels are configured.
 *
 * Never throws: a message that cannot be pushed is still a message sitting in
 * /admin, and a failed notification must not take the submission down with it.
 *
 * Two flavours everywhere, and keeping them apart is what stops the phone
 * becoming noise now that every message asks for a tap. A clean note arrives
 * quietly; something the filters were unsure about arrives louder and says
 * why. If both looked the same, the ones that actually need reading would be
 * buried among the ones that just need a thumb.
 */
export async function notifyReview(env, origin, job, decision, { held = false } = {}) {
  const sent = [];
  if (env.DISCORD_WEBHOOK) sent.push(notifyDiscord(env, origin, job, decision, held));
  if (env.NTFY_TOPIC) sent.push(notifyNtfy(env, origin, job, decision, held));

  if (!sent.length) {
    // Logged rather than returned quietly. No channel and a broken channel
    // looked identical from the outside, and that cost an hour once: messages
    // piling up correctly in /admin while the phone stayed silent, with
    // nothing anywhere saying why.
    console.log(JSON.stringify({ event: "notify_skipped", reason: "no channel configured" }));
    return false;
  }
  return (await Promise.all(sent)).some(Boolean);
}

/**
 * Discord, via an incoming webhook on a private channel.
 *
 * Chosen over ntfy after ntfy turned out to be unusable from a Worker: its
 * free quota is counted per source IP, and a Worker's source IP is a
 * Cloudflare address shared with everyone else on it, so the quota is spent by
 * strangers. Discord's webhook limits are per webhook, which is ours alone.
 *
 * No buttons. Interactive components need a registered bot application rather
 * than a webhook, so the embed title links to /admin and the decision is two
 * taps instead of one. Worth it to avoid running a bot.
 */
async function notifyDiscord(env, origin, job, decision, held) {
  const why = decision.reason ? `${decision.source} : ${decision.reason}` : decision.source;

  // A bare link. The admin token used to ride in the fragment so that tapping
  // a notification landed on an already-unlocked desk, and that is no longer
  // worth what it cost.
  //
  // What it cost: hold_all is on, so every message notifies, so every message
  // put a copy of the full admin token into Discord. Hundreds of copies, kept
  // on Discord's servers, in every export and every backup, readable by any
  // bot ever added to the channel - and untouched by rotating the secret,
  // because rotation cannot reach into a scrollback.
  //
  // What it bought: not having to retype the token on a new tab. That problem
  // was solved separately and better when the desk moved to a session cookie
  // (see session.js), which survives new tabs by itself. So the fragment was
  // paying a permanent price for a convenience that already exists.
  const desk = `${origin}/admin`;
  try {
    const response = await fetch(env.DISCORD_WEBHOOK, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "Print on my desk",
        // Nothing is ever @-mentioned: the channel's own notification setting
        // decides whether the phone buzzes, which is where that belongs.
        allowed_mentions: { parse: [] },
        embeds: [
          {
            title: held ? `#${job.id} — a valider` : `#${job.id} — a regarder`,
            url: desk,
            description: job.text.slice(0, 1800),
            color: held ? 0x2f6b3a : 0x8a6314,
            footer: { text: held ? "rien a signaler" : why },
            timestamp: new Date().toISOString(),
          },
        ],
      }),
    });
    if (!response.ok) {
      console.log(
        JSON.stringify({
          event: "discord_refused",
          status: response.status,
          body: (await response.text()).slice(0, 200),
        })
      );
    }
    return response.ok;
  } catch (err) {
    console.log(JSON.stringify({ event: "discord_error", error: String(err).slice(0, 200) }));
    return false;
  }
}

/**
 * ntfy.sh. Kept, and kept documented, but it is not the primary channel.
 *
 * Its free quota is enforced per source IP even for an authenticated account
 * (`limits.basis` is "ip" in /v1/account), and a Worker egresses from shared
 * Cloudflare addresses. Verified in both directions with the same token: 200
 * from a home IP, 429 from the Worker. It therefore works by luck.
 */
async function notifyNtfy(env, origin, job, decision, held) {
  const topic = env.NTFY_TOPIC;
  const secret = env.ADMIN_TOKEN ?? env.IP_SALT ?? "";

  const approve = await actionToken(secret, job.id, "approve");
  const reject = await actionToken(secret, job.id, "reject");
  const act = (action, token) =>
    `${origin}/api/admin/act?id=${job.id}&a=${action}&t=${token}`;

  const why = decision.reason ? ` : ${decision.reason}` : "";

  // Anonymous publishing is quota'd by ntfy PER SOURCE IP, and a Worker's
  // source IP is a Cloudflare address shared with everybody else on it. So the
  // quota can be exhausted by strangers, and the first symptom is a phone that
  // stops ringing while everything else looks fine. Observed on 29 August: a
  // 429 from ntfy on the very first real message.
  //
  // An access token from a free ntfy account moves the quota onto the account
  // instead, which is the only version of this that works from a Worker.
  const headers = { "content-type": "application/json" };
  if (env.NTFY_TOKEN) headers.authorization = `Bearer ${env.NTFY_TOKEN}`;

  try {
    const response = await fetch("https://ntfy.sh/", {
      method: "POST",
      headers,
      body: JSON.stringify({
        topic,
        title: held
          ? `Print on my desk #${job.id}`
          : `Print on my desk #${job.id} — a regarder`,
        message: held ? job.text : `${job.text}\n\n— ${decision.source}${why}`,
        tags: held ? ["printer"] : ["warning"],
        priority: held ? 3 : 4,
        click: `${origin}/admin`,
        actions: [
          { action: "http", label: "Imprimer", url: act("approve", approve), method: "POST", clear: true },
          { action: "http", label: "Jeter", url: act("reject", reject), method: "POST", clear: true },
        ],
      }),
    });
    if (!response.ok) {
      // ntfy refusing the payload is not an exception, so without this the
      // failure is invisible: no throw, no log, and a phone that never rings.
      console.log(
        JSON.stringify({
          event: "ntfy_refused",
          status: response.status,
          body: (await response.text()).slice(0, 200),
        })
      );
    }
    return response.ok;
  } catch (err) {
    console.log(JSON.stringify({ event: "ntfy_error", error: String(err).slice(0, 200) }));
    return false;
  }
}

/**
 * An operational alert, addressed to the owner rather than about a message.
 *
 * Deliberately plain and without buttons: there is nothing to decide, only
 * something to go and look at. Failures here never carry the ticket's text -
 * a print that failed is still a stranger's message, and the fault is the
 * machine's.
 */
async function alert(env, text, hook = env.DISCORD_WEBHOOK) {
  if (!hook) {
    console.log(JSON.stringify({ event: "alert_skipped", reason: "no webhook", text }));
    return false;
  }
  try {
    const res = await fetch(hook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: text }),
    });
    return res.ok;
  } catch (err) {
    console.log(JSON.stringify({ event: "alert_failed", error: String(err) }));
    return false;
  }
}


/**
 * Where the machine's own bad news goes.
 *
 * Three webhooks, and the split is about attention rather than tidiness. The
 * moderation channel fires on every held message and is read in batches; the
 * a tip jar one fires when somebody gives money and can stay loud forever; this
 * one fires when the machine needs a person, which is rare and always worth
 * interrupting for. Sharing one channel means the rare urgent thing scrolls
 * past under the routine noisy thing, and then the channel gets muted.
 *
 * Falls back to DISCORD_WEBHOOK, so nothing goes silent if only one is set.
 */
const statusHook = (env) => env.STATUS_DISCORD_WEBHOOK || env.DISCORD_WEBHOOK;

/** A job that has run out of attempts. Nobody else will ever notice it. */
export function notifyPrintFailed(env, id, reason, attempts) {
  return alert(
    env,
    `**Ticket #${id} will not print.** ${attempts} attempts, last error: \`${reason ?? "unknown"}\`. ` +
      `It is \`failed\` and waiting for nothing: the Reprint button on the desk puts it back in the queue.`,
    statusHook(env)
  );
}

/**
 * The roll is empty.
 *
 * Worth its own alert because it is the one fault the queue hides: the Pico
 * refuses to claim anything while the roll is out, so messages pile up
 * silently and correctly, and the only symptom is that nothing comes out.
 */
export function notifyNoPaper(env, waiting) {
  return alert(
    env,
    `**Out of paper.** ${waiting} message${waiting > 1 ? "s are waiting" : " is waiting"} for the roll to be changed. ` +
      `Nothing is lost: the machine refuses to claim work it cannot print.`,
    statusHook(env)
  );
}
