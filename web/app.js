// The page.
//
// There is no preview. Nothing shows the ticket until the button is pressed,
// and then the page gets out of the way: it goes white, a slot opens, and the
// paper comes out of it.
//
// The pixels in that animation are not a drawing of a ticket. The renderer is
// the Worker's own, copied verbatim into web/lib by tools/sync_web.mjs, so the
// bitmap on screen is the bitmap the print head will lay down.

import { renderTicket } from "./lib/render.js";
import { tidyHandle } from "./lib/limits.js";
import { profileFor, CURRENT_PROFILE } from "./lib/profiles.js";
import { ProofOfWork } from "./pow.js";

// The printer actually standing in the flat. The preview has to be THE ticket,
// not a ticket: a visitor shown three lines who gets five has been misled by
// the only part of this site that promises anything.
const PROFILE = profileFor(CURRENT_PROFILE);

/* --- the private door ---
 *
 * A link with `#k=<key>` on the end opens the form when the season is shut.
 * For testing out of season, and for letting a handful of people into a
 * Season 2 before it is announced.
 *
 * In the FRAGMENT rather than the query string, and that is the whole design.
 * A fragment is never sent to a server, never appears in an access log, and is
 * not passed on in a referrer - so the key exists in the link, in this tab's
 * memory, and nowhere else. From here it travels as a header, deliberately
 * attached, on the three calls that need it.
 *
 * Stripped from the address bar as soon as it is read, so a screenshot or a
 * shoulder does not carry it, and kept in sessionStorage so a refresh does not
 * lose it. sessionStorage rather than localStorage: closing the tab should end
 * the session, because the next person to open this browser is not necessarily
 * the person who was given the key.
 */
const ACCESS_HEADER = "x-access-key";
const ACCESS_KEY_STORE = "print-on-my-desk.key";

const accessKey = (() => {
  let key = "";
  try {
    const hash = location.hash || "";
    const found = /^#k=(.+)$/.exec(hash);
    if (found) {
      key = decodeURIComponent(found[1]);
      sessionStorage.setItem(ACCESS_KEY_STORE, key);
      // Out of the address bar, without adding a history entry to go back to.
      history.replaceState(null, "", location.pathname + location.search);
    } else {
      key = sessionStorage.getItem(ACCESS_KEY_STORE) || "";
    }
  } catch (err) {
    // A browser refusing storage is not a reason to fail to load the page. The
    // key then lasts as long as this document, which is enough to send.
  }
  return key;
})();

/** The headers for a call that should carry the key, if there is one. */
function withKey(headers) {
  const out = { ...(headers || {}) };
  if (accessKey) out[ACCESS_HEADER] = accessKey;
  return out;
}

const MAX = 200;
// Printed dots per millimetre. 8 on the MXW01, 7.09 on the TRP 100 III, and
// read from the profile rather than written down here - the millimetre count
// under the preview was wrong by 13% for as long as it was a constant.
const DOTS_PER_MM = PROFILE.dotsPerMm;
// One text line is 24 dots tall, so a ticket's rows are its visible steps.
const DOTS_PER_LINE = 24;

const WHITE_MS = 450;
const SLOT_MS = 320;
const FEED_MS = 1600;
const NOTE_MS = 400;
const SHEET_MS = 900;

// The invitation is worth one appearance a day, not one per message. Asking
// again on every message someone sends is asking too often.
const SHEET_KEY = "print-on-my-desk.invited";
const SHEET_EVERY_MS = 24 * 60 * 60 * 1000;

/**
 * One event, if anyone is listening.
 *
 * Umami loads deferred and through a proxy, so it may not be there yet, may be
 * blocked, or may never have been configured. None of that is allowed to be a
 * problem: the page works identically with no analytics at all.
 */
function track(name, data) {
  try {
    window.umami?.track?.(name, data);
  } catch {
    // Counting is never worth breaking the thing being counted.
  }
}

const $ = (id) => document.getElementById(id);
const form = $("form");
const input = $("text");
const handle = $("handle");
const count = $("count");
const paper = $("paper");
const canvas = $("canvas");
const button = $("send");
const state = $("state");
const stateText = $("state-text");
const info = $("info");
const tally = $("tally");
const tallyN = $("tally-n");
const notes = $("notes");
const printEl = $("print");
const strip = $("strip");
const printNote = $("print-note");
const printClose = $("print-close");
const sheet = $("sheet");
const sheetCta = $("sheet-cta");
const sheetClose = $("sheet-close");
const over = $("over");
const overThreads = $("over-threads");
const overSite = $("over-site");
const lede = document.querySelector(".lede");

const ctx = canvas.getContext("2d", { willReadFrequently: false });
const still = matchMedia("(prefers-reduced-motion: reduce)");
const wait = (ms) => new Promise((done) => setTimeout(done, still.matches ? 0 : ms));

// Starts hashing immediately, in the background, while the visitor reads the
// page. See pow.js: by the time anyone has typed a sentence it is long done.
const pow = new ProofOfWork(withKey);

let ready = false;
let busy = false;
let timers = [];

const later = (fn, ms) => timers.push(setTimeout(fn, still.matches ? 0 : ms));
const cancel = () => { timers.forEach(clearTimeout); timers = []; };

/** Paints a rendered canvas onto the 2D context, at the canvas's own width. */
function paint(rendered) {
  const height = Math.max(rendered.height, 1);
  const width = rendered.widthPixels;
  canvas.width = width;
  canvas.height = height;
  const image = ctx.createImageData(width, height);
  const data = image.data;

  for (let y = 0; y < height; y++) {
    const row = rendered.rows[y];
    for (let x = 0; x < width; x++) {
      const inked = row && row[x >> 3] & (1 << (x & 7));
      const i = (y * width + x) * 4;
      const v = inked ? 0 : 255;
      data[i] = data[i + 1] = data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
}

function render(text) {
  const rendered = renderTicket(text.trim() || " ", {
    id: 0,
    createdAt: Date.now(),
    // Cleaned the same way the Worker cleans it, so the paper on screen is the
    // paper that comes out rather than an optimistic version of it.
    handle: tidyHandle(handle.value),
    profile: PROFILE,
  });
  // The MXW01 buffer is pre-rotated for the print head. Undo that for a human;
  // the TRP 100 III is not rotated and there is nothing to undo.
  if (PROFILE.flip180) rendered.rotate180();
  paint(rendered);
  return rendered;
}

/** The meter runs off the real render, even though nobody sees the pixels yet. */
function update() {
  // While the print is on screen, that canvas is the ticket that was just
  // sent. Repainting it from an emptied field would wipe the message off the
  // paper the person is looking at.
  if (!printEl.hidden) return;

  const length = [...input.value].length;
  count.textContent = `${length}/${MAX}`;
  count.classList.toggle("count--full", length >= MAX);

  const rendered = render(input.value);
  const mm = length === 0 ? 0 : rendered.height / DOTS_PER_MM;
  paper.textContent = `${mm.toFixed(1)} mm of paper`;

  button.disabled = !ready || length === 0 || busy;
}

/* --- the rules, behind an i --- */

function toggleNotes(open = notes.hidden) {
  notes.hidden = !open;
  info.setAttribute("aria-expanded", String(open));
}

info.addEventListener("click", () => {
  toggleNotes();
  if (!notes.hidden) track("rules-opened");
});
document.addEventListener("click", (event) => {
  if (!notes.hidden && !notes.contains(event.target) && event.target !== info) {
    toggleNotes(false);
  }
});

/* --- the print --- */

/** White first, then the slot. The message is still in flight at this point. */
function openPrint() {
  cancel();
  printEl.hidden = false;
  printNote.textContent = "";
  printNote.className = "print__note";
  printClose.textContent = "Write another";
  printEl.classList.remove("is-refused");
  canvas.style.animation = "";
  if (still.matches) {
    printEl.classList.add("is-white", "is-slot");
    return;
  }
  requestAnimationFrame(() => printEl.classList.add("is-white"));
  later(() => printEl.classList.add("is-slot"), SLOT_MS);
}

/** The paper, printed one band of rows at a time out of the slot. */
async function feed(text) {
  const rendered = render(text);
  // Wait for the white and the slot before any paper moves.
  await wait(WHITE_MS + SLOT_MS);

  // The strip's window opens to the ticket's own height in one go; what is
  // animated is the paper inside it, never the box around it.
  strip.style.setProperty("--strip-h", `${canvas.offsetHeight}px`);
  printEl.classList.add("is-feeding");

  if (!still.matches) {
    const steps = Math.max(6, Math.min(30, Math.round(rendered.height / DOTS_PER_LINE)));
    canvas.style.animation = `feed ${FEED_MS}ms steps(${steps}, end) both`;
  }

  await wait(FEED_MS);
  await wait(NOTE_MS);
  printEl.classList.add("is-out");
}

/**
 * A refusal is a stop, not a print.
 *
 * It does not wait out the slot animation, because the ceremony exists to
 * cover the wait for a ticket and there is no ticket. The slot never opens and
 * the message sits on its own, so nothing about the screen suggests paper.
 */
function refuse(message) {
  cancel();
  printEl.classList.remove("is-slot", "is-feeding");
  printEl.classList.add("is-refused", "is-out");
  printNote.textContent = message;
  printNote.className = "print__note print__note--error";
  printClose.textContent = "Back";
}

function closePrint() {
  cancel();
  closeSheet();
  printEl.classList.remove("is-white", "is-slot", "is-feeding", "is-out", "is-refused");
  canvas.style.animation = "";
  strip.style.removeProperty("--strip-h");
  const hide = () => {
    printEl.hidden = true;
    update();
  };
  if (still.matches) hide();
  else later(hide, WHITE_MS);
  input.focus();
}

printClose.addEventListener("click", closePrint);

/* --- the invitation --- */

/**
 * Is there anywhere to invite anybody TO?
 *
 * The invitation is optional and most copies of this page will never fill it
 * in - so the page itself is the configuration, and the destination is the
 * thing that decides. An `href` of "#" is what the unconfigured page ships
 * with, and it is not a place.
 *
 * Without this check a fresh install thanks somebody for their message and
 * then, nine hundred milliseconds later, slides up a dialog titled "One more
 * thing" with an empty paragraph and a button that goes nowhere. That happened
 * to the first person who followed the quick start on a machine that was not
 * this one, which is how it was found.
 */
function inviteConfigured() {
  const to = sheetCta?.getAttribute("href") ?? "";
  return to !== "" && !to.startsWith("#");
}

function invitePending() {
  if (!inviteConfigured()) return false;
  try {
    const seen = Number(localStorage.getItem(SHEET_KEY));
    return !seen || Date.now() - seen > SHEET_EVERY_MS;
  } catch {
    // Private windows and blocked storage both land here. Ask once this visit.
    return true;
  }
}

function openSheet() {
  sheet.hidden = false;
  requestAnimationFrame(() => sheet.classList.add("is-open"));
  try {
    localStorage.setItem(SHEET_KEY, String(Date.now()));
  } catch {
    // Nothing to remember it with. The next message asks again, which is fine.
  }
}

function closeSheet() {
  if (sheet.hidden) return;
  sheet.classList.remove("is-open");
  const hide = () => { sheet.hidden = true; };
  if (still.matches) hide();
  else setTimeout(hide, 420);
}

sheetClose.addEventListener("click", () => {
  track("threads-dismissed");
  closeSheet();
});
sheetCta.addEventListener("click", () => {
  track("threads-followed");
  closeSheet();
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!sheet.hidden) closeSheet();
  else if (!printEl.hidden) closePrint();
  else if (!notes.hidden) toggleNotes(false);
});

/* --- service state --- */

/* The end of Season 1.
 *
 * Driven only by /api/status, never by a clock in the browser: a phone set to
 * next week must not close the season on its own, and one set to last month
 * must not keep the form alive after it is over. The Worker refuses either way
 * - this is the courtesy of not showing a box that would only say no.
 *
 * Idempotent, because refreshState() runs every three minutes and on every
 * return to the tab, and the analytics event is worth exactly once. */
let seasonShown = null;

function showSeasonOver(isOver) {
  if (seasonShown === isOver) return;
  seasonShown = isOver;
  over.hidden = !isOver;
  form.hidden = isOver;
  info.hidden = isOver;
  if (lede) lede.hidden = isOver;
  if (isOver) {
    // The rules describe writing a message, and there is nothing left to
    // write. Closed rather than merely unreachable, so the panel is what is
    // on screen.
    toggleNotes(false);
    track("season-over");
  }
}

overThreads?.addEventListener("click", () => track("season-over-threads"));
overSite?.addEventListener("click", () => track("season-over-site"));


async function refreshState() {
  try {
    const res = await fetch("/api/status", { headers: withKey() });
    const body = await res.json();
    ready = body.open === true;
    // The printer sleeping is a normal state of this system, not a fault: only
    // its button wakes it. Saying so in the same ink as "everything is fine"
    // would be a small lie told on every ticket that then waits.
    const online = body.online === true;
    // An empty roll is a wait, not a stop, and the page used to say the
    // opposite. It showed "out of paper" in the alert colour, which reads as
    // "do not bother" - while in fact the message is accepted, moderated and
    // queued exactly as usual, and comes out whole when the roll is reloaded.
    // Nothing is lost and nothing expires: an approved job has no deadline.
    //
    // So it moves to the same neutral bucket as a sleeping printer, which is
    // the other "this will happen, just not this second" state. The wording
    // says what the visitor actually gets rather than naming the machine's
    // problem, which is the owner's business and shows in /admin.
    const noPaper = body.printer?.state === "no_paper";
    // A season that has ended is not a fault and not a pause: nothing is
    // broken, nobody is going to switch it back on this evening, and the
    // paper carries on coming out for weeks. It gets the neutral mark, not
    // the red one, and it outranks every other state on the chip.
    const seasonOver = body.season_over === true;
    showSeasonOver(seasonOver);
    if (seasonOver) ready = false;
    // The door being used says so, and outranks everything else on the chip.
    // A form that is open only for you should look different from a form that
    // is open for everybody, or the first test after a season closes is
    // somebody quietly reopening the shop and not noticing.
    const privately = body.private_access === true;
    const kind = privately
      ? "warn"
      : seasonOver
        ? "warn"
        : !ready
          ? "paused"
          : noPaper || !online
            ? "warn"
            : "ready";
    state.className = `state state--${kind}`;
    // "printer asleep" is gone, 31 August. It was true of the MXW01, which
    // stopped advertising after ten minutes and could only be woken by its own
    // button - a state a visitor genuinely needed warning about, because a
    // ticket could sit for hours. The TRP 100 III does not sleep. What "not
    // online" means now is that the agent is not running, which is a few
    // minutes at most and is nobody's business but the owner's.
    //
    // Same neutral wording as an empty roll, for the same reason: it says what
    // the visitor gets rather than naming the machine's problem.
    stateText.textContent = privately
      ? "private access"
      : seasonOver
        ? "season 1 over"
        : !ready
          ? "paused"
          : noPaper || !online
            ? "prints later"
            : "ready";

    // The stated limit comes from the server, never from the markup. The page
    // told people "three messages a day" for an afternoon after the quota had
    // been cut to one, which is the kind of small lie that turns into a
    // support conversation.
    const perDay = Number(body.per_day) || 0;
    const quotaNote = document.getElementById("note-quota");
    if (quotaNote && perDay > 0) {
      quotaNote.textContent =
        perDay === 1
          ? "One message a day per person."
          : perDay + " messages a day per person.";
    }

    // Only ever shown once it has something to say.
    const printed = Number(body.printed) || 0;
    tally.hidden = printed < 1;
    tallyN.textContent = printed.toLocaleString("en");
  } catch {
    ready = false;
    state.className = "state state--paused";
    stateText.textContent = "no service";
  }
  if (!busy) update();
}

/* --- sending --- */

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text || busy) return;

  busy = true;
  button.disabled = true;
  // The white goes up before the request, so the wait happens behind it rather
  // than in front of a spinner.
  openPrint();

  try {
    const altcha = await pow.ready;
    const res = await fetch("/api/submit", {
      method: "POST",
      headers: withKey({ "content-type": "application/json" }),
      body: JSON.stringify({ text, handle: handle.value.trim() || null, altcha }),
    });
    const body = await res.json();

    if (body.ok) {
      await feed(text);
      // Deliberately plain, and deliberately the same sentence whatever the
      // moderator decided: no queue position, no tracking, no photo.
      //
      // The one thing worth splitting on is the machine. A printer that is
      // asleep is normal and only its button wakes it, so a ticket sent to one
      // can sit for hours. Saying "on its way" over an animation of paper
      // coming out would be the page's one real lie.
      // The wait, when there is one worth mentioning. Not a queue position -
      // that stays out by design - but "on its way" is a small lie when the
      // paper is four days out, and somebody who knows is not disappointed.
      const wait = typeof body.wait === "string" ? body.wait : null;
      printNote.textContent = body.online === false
        ? "It is queued. It comes out next time the printer runs."
        : wait
          ? "It is on its way to the printer. There is a queue right now, so it prints " + wait + "."
          : "It is on its way to the printer.";
      track("printed", { awake: body.online !== false, chars: [...text].length });
      input.value = "";
      handle.value = "";
      if (invitePending()) later(openSheet, SHEET_MS);
    } else {
      track("refused", { status: res.status });
      refuse(body.error ?? "That message could not be sent.");
    }
  } catch {
    track("refused", { status: 0 });
    refuse("Network unavailable, try again.");
  }

  busy = false;
  // No update() here: the overlay owns the canvas until it closes.
  // A challenge is spent once, whether or not the message got through, so the
  // next one starts solving now rather than when the visitor is waiting on it.
  pow.refresh();
});

input.addEventListener("input", update);
handle.addEventListener("input", update);

update();
refreshState();

/* --- keeping the status fresh without hammering the Worker ---
 *
 * This was setInterval(refreshState, 60000), which is one API call a minute
 * for every tab anyone has ever left open - including phones face down in a
 * pocket. On a day when the link went round Threads, that was the largest
 * source of traffic on the whole service, ahead of the messages themselves and
 * the printer's own polling, and Workers AI had already hit its daily ceiling
 * by teatime.
 *
 * Two changes. Three minutes instead of one, because the pill says "ready" or
 * "paused" or "prints later" and nobody watches it change. And nothing at all
 * while the tab is hidden, which is most tabs most of the time - with an
 * immediate refresh when it comes back, so returning to the page never shows a
 * stale answer.
 */
const STATE_INTERVAL_MS = 3 * 60 * 1000;
let stateTimer = null;

function startPolling() {
  if (stateTimer !== null) return;
  stateTimer = setInterval(refreshState, STATE_INTERVAL_MS);
}

function stopPolling() {
  if (stateTimer === null) return;
  clearInterval(stateTimer);
  stateTimer = null;
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    stopPolling();
  } else {
    // The answer on screen is up to three minutes old, and the person is
    // looking at it again. Ask once, then resume the slow rhythm.
    refreshState();
    startPolling();
  }
});

if (!document.hidden) startPolling();
