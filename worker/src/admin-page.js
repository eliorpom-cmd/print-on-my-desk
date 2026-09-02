// The admin page, served by the Worker rather than sitting in /web.
//
// The brief asks for "a secret route": a file in the assets directory would be
// fetchable by anyone who guessed its name, and would show up in any crawl of
// the deployment. Served from here, /admin exists only because the router says
// so, and the shell it returns holds no secret of its own.
//
// The token is typed in ONCE, POSTed to /api/admin/session, and never touched
// by this page again: what comes back is an HttpOnly cookie the browser
// attaches on its own and no script here can read. It used to live in
// localStorage, and the reason that had to change is not this page but the
// origin it sits on - localStorage is shared by every script on an origin, and
// this origin also serves /m/c.js, which relays Umami's tracker onto the
// public page. Same origin, same storage: a compromise upstream at Umami was a
// compromise of the desk. See worker/src/session.js.
//
// The cookie also survives a new tab, which is what localStorage was chosen
// for when the notifications became the way in.

export const ADMIN_PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Print on my desk · desk</title>
<!-- The desk borrows the front page's stylesheet rather than keeping a second
     palette in sync by hand: same origin, same tokens, same two typefaces.
     Everything below is only the parts the public page does not have. -->
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/style.css">
<style nonce="__CSP_NONCE__">
  main { max-width: 44rem; padding: 2.5rem 1.25rem 5rem; }
  .sub { color: var(--mute); font-size: 13px; margin: 0.6rem 0 2rem; }
  h2 {
    margin: 2.5rem 0 0.75rem;
    font-family: var(--mono); font-weight: 500; font-size: 10px;
    letter-spacing: 0.14em; text-transform: uppercase; color: var(--mute);
  }
  input, select, button { font: inherit; }
  input, select {
    width: 100%; padding: 0.65rem 0.75rem;
    border: 1px solid var(--rule); background: var(--paper); color: var(--ink);
  }
  input:focus-visible, select:focus-visible { border-color: var(--ink); outline: none; }
  button {
    padding: 0.7rem 0.9rem;
    border: 1px solid var(--ink); background: var(--ink); color: var(--paper);
    font-family: var(--display); font-weight: 900; font-size: 15px;
    letter-spacing: 0.1em; cursor: pointer;
  }
  button:hover:not(:disabled) { background: var(--paper); color: var(--ink); }
  button.ghost {
    background: var(--paper); color: var(--ink); border-color: var(--rule);
    font-family: var(--mono); font-weight: 500; font-size: 11px;
    letter-spacing: 0.1em; text-transform: uppercase;
  }
  button.ghost:hover { border-color: var(--ink); background: var(--paper); }
  button:disabled {
    border-color: var(--rule); background: var(--rule);
    color: var(--mute); cursor: not-allowed;
  }

  /* A message waiting for a verdict is a ticket waiting to be torn off. */
  .card {
    padding: 1rem; margin-bottom: 0.75rem;
    border: 1px solid var(--rule); border-top: 1px dashed var(--ink);
  }
  .card.flagged { border-top-color: var(--alert); }
  .card p.text { margin: 0 0 0.85rem; white-space: pre-wrap; word-break: break-word; }
  .meta {
    display: flex; flex-wrap: wrap; gap: 0.4rem 0.9rem; margin-bottom: 0.85rem;
    font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase;
    color: var(--mute); font-variant-numeric: tabular-nums;
  }
  .tag { border: 1px solid var(--rule); padding: 0 0.35rem; }
  .tag.ok { color: var(--ink); border-color: var(--ink); }
  .tag.flag { color: var(--alert); border-color: var(--alert); }
  .row { display: flex; gap: 0.5rem; }
  .row button { flex: 1; }

  /* Same square as the public page: lit, unlit, or red. */
  .bar {
    display: flex; align-items: center; gap: 0.6rem;
    padding: 0.75rem 0.85rem; margin-bottom: 0.6rem;
    border: 1px solid var(--rule);
    font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase;
    color: var(--mute);
  }
  .dot { width: 8px; height: 8px; flex: none; border: 1px solid var(--mute); background: var(--mute); }
  .on { color: var(--ink); }
  .on .dot { border-color: var(--ink); background: var(--ink); }
  .warnstate .dot { border-color: var(--ink); background: transparent; }
  .off { color: var(--alert); }
  .off .dot { border-color: var(--alert); background: var(--alert); }

  table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  td { padding: 0.5rem 0; border-bottom: 1px dashed var(--dot); vertical-align: top; }
  td.st {
    width: 6rem; color: var(--mute);
    font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase;
  }
  td.id { width: 3rem; color: var(--mute); font-variant-numeric: tabular-nums; }
  td.act { width: 5.5rem; text-align: right; }
  button.small { padding: 0.3rem 0.5rem; font-size: 10px; }
  .find { display: flex; flex-wrap: wrap; gap: 0.4rem; margin: 0.6rem 0; }
  .find input {
    flex: 1 1 12rem; min-width: 0; padding: 0.35rem 0.5rem;
    font: inherit; font-size: 12px; color: var(--ink);
    background: var(--paper); border: 1px solid var(--rule);
  }
  .find input:focus { outline: none; border-color: var(--ink); }
  /* The filter you are on, so the table never lies about what it is showing. */
  button.on { border-color: var(--ink); background: var(--ink); color: var(--paper); }
  .why { color: var(--mute); font-size: 10px; }
  .bulkbar {
    position: sticky; top: 0; z-index: 5;
    display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;
    padding: 0.6rem; margin: 0.6rem 0;
    background: var(--paper); border: 1px solid var(--ink);
  }
  .bulkbar span { font-size: 12px; margin-right: auto; }
  /* Grid rather than flex, and two named tracks rather than one flexible one.
     The flex version made the paragraph an item whose automatic minimum size
     is its longest unbreakable run - and .text sets word-break: break-word, so
     that minimum is a single character. The message came out as a vertical
     column of letters. A grid track of 1fr has no such rule attached to the
     item, and the width is stated rather than negotiated. */
  .card > label.pick {
    display: grid;
    grid-template-columns: 1.1rem 1fr;
    gap: 0.5rem;
    align-items: start;
    cursor: pointer;
  }
  .card > label.pick input { margin: 0.25rem 0 0; width: 1.1rem; height: 1.1rem; }
  .card > label.pick p.text {
    /* Belt and braces: the track already bounds it, and these make the
       paragraph fill that track whatever the user agent decides about
       intrinsic sizing. */
    width: 100%; min-width: 0; max-width: 100%; margin-bottom: 0;
  }
  .card.picked { border-color: var(--ink); }

  .settings {
    display: grid; grid-template-columns: 1fr auto;
    gap: 0.6rem; align-items: center; font-size: 13px;
  }
  .settings input { width: 7rem; text-align: right; font-variant-numeric: tabular-nums; }
  .empty { color: var(--mute); font-size: 12px; }
  .err { color: var(--alert); font-size: 13px; }
  .hide { display: none; }
  #gate input { margin-bottom: 0.75rem; }
</style>
</head>
<body>
<main>
  <h1>PRINT ON MY DESK</h1>
  <p class="sub">Moderation desk. Nothing prints until you say so.</p>

  <form id="gate">
    <label for="token" class="sub">Admin token</label>
    <input id="token" type="password" autocomplete="current-password" placeholder="token">
    <p></p>
    <button type="submit">Unlock</button>
    <p id="gate-error" class="err"></p>
  </form>

  <div id="desk" class="hide">
    <div id="service" class="bar"><span class="dot"></span><span id="service-text">…</span></div>
    <div id="printer" class="bar"><span class="dot"></span><span id="printer-text">…</span></div>

    <div class="row">
      <button id="kill" class="ghost" type="button">Pause the service</button>
      <button id="refresh" class="ghost" type="button">Refresh</button>
      <button id="export" class="ghost" type="button">Export all</button>
    </div>
    <p id="export-note" class="empty"></p>

    <h2>Waiting for you (<span id="pending-count">0</span>)</h2>
    <!-- Sticky on purpose: with a hundred and fifty cards the buttons would
         otherwise be a hundred and fifty cards away from the last box ticked. -->
    <div id="bulkbar" class="bulkbar" hidden>
      <span id="bulk-count">0 selected</span>
      <button id="bulk-approve" type="button">Print these</button>
      <button id="bulk-reject" class="ghost" type="button">Discard these</button>
      <button id="bulk-none" class="ghost small" type="button">Clear</button>
    </div>
    <div class="find">
      <button id="all-approve" class="ghost small" type="button">Print everything waiting</button>
    </div>
    <div class="find">
      <button id="pick-all" class="ghost small" type="button">Select all</button>
      <button id="pick-clean" class="ghost small" type="button">Select the clean ones</button>
      <button id="pick-flagged" class="ghost small" type="button">Select the flagged ones</button>
      <button id="pick-short" class="ghost small" type="button">Select the very short ones</button>
    </div>
    <p id="pending-note" class="empty"></p>
    <div id="pending"></div>

    <h2>Last 24 hours</h2>
    <p id="today" class="empty"></p>

    <h2>Paper</h2>
    <p id="paper" class="empty"></p>
    <div class="find">
      <button id="roll" class="ghost small" type="button">I put a new roll in</button>
      <button id="unstick" class="ghost small" type="button">Requeue everything failed</button>
    </div>
    <p id="recover-note" class="empty"></p>

    <h2>What the machine did</h2>
    <table><tbody id="events"></tbody></table>

    <h2>Recent</h2>
    <p id="stuck" class="err"></p>
    <div class="find">
      <input id="q" type="search" placeholder="Search the archive" autocomplete="off">
      <button class="ghost small" data-filter="" type="button">All</button>
      <button class="ghost small" data-filter="printed" type="button">Printed</button>
      <button class="ghost small" data-filter="approved" type="button">Queued</button>
      <button class="ghost small" data-filter="rejected" type="button">Rejected</button>
      <button class="ghost small" data-filter="spam" type="button">Spam</button>
      <button class="ghost small" data-filter="failed" type="button">Failed</button>
    </div>
    <p id="found" class="empty"></p>
    <table><tbody id="recent"></tbody></table>
    <p><button id="more" class="ghost" type="button" hidden>Show more</button></p>

    <h2>Settings</h2>
    <div id="settings" class="settings"></div>
    <p id="settings-note" class="empty"></p>
  </div>
</main>

<script nonce="__CSP_NONCE__">
(function () {
  var $ = function (id) { return document.getElementById(id); };

  // Clears the token this page used to keep here. Every browser that has ever
  // opened the desk still holds one, and it stays there until something
  // removes it - a stale secret sitting in the exact storage this change
  // exists to get out of. Rotating ADMIN_TOKEN makes it worthless; this makes
  // it absent, which is the part rotation cannot do.
  try { localStorage.removeItem("print-on-my-desk-admin-token"); } catch (e) {}

  // No token variable, and nothing to put one in. The credential is a cookie
  // this script cannot read, which is the whole point: whatever else ends up
  // running on this origin cannot read it either.
  function api(path, options) {
    options = options || {};
    options.credentials = "same-origin";
    return fetch("/api/admin" + path, options);
  }

  /** Trades the typed token for the session cookie. Done once. */
  function unlock(typed) {
    return fetch("/api/admin/session", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: typed })
    }).then(function (response) {
      if (!response.ok) throw new Error("Wrong token.");
    });
  }

  function ago(ms) {
    var s = Math.round((Date.now() - ms) / 1000);
    if (s < 60) return s + "s ago";
    if (s < 3600) return Math.round(s / 60) + "m ago";
    if (s < 86400) return Math.round(s / 3600) + "h ago";
    return Math.round(s / 86400) + "d ago";
  }

  function left(ms) {
    var s = Math.round((ms - Date.now()) / 1000);
    if (s <= 0) return "expired";
    if (s < 3600) return Math.round(s / 60) + " min left";
    return (s / 3600).toFixed(1) + " h left";
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  var SETTING_LABELS = {
    hold_all: "Hold every message for approval",
    hold_ttl_h: "Hours a clean message waits (0 = forever)",
    rate_per_day: "Messages per person per day",
    rate_per_hour: "Messages per person per hour",
    rate_cooldown_s: "Seconds between two messages",
    queue_max: "Queue cap (0 = no limit)",
    pending_ttl_h: "Hours a flagged message waits (0 = forever)",
    pow_difficulty: "Proof-of-work difficulty",
    dedupe_window_h: "Duplicate window, hours",
    intensity: "Print intensity (max 192)",
    only_supporters: "priority tickets ONLY (nothing else prints)",
    print_budget: "Tickets left to print, then idle (0 = no limit)",
    feed_lines_mxw01: "Tear-off feed (58 mm, paused)",
    feed_lines_trp100: "Tear-off feed (80 mm)",
    printer_profile: "Printer in service",
    moderation: "AI moderation",
    // Last, and on its own, because it is the only one here that ends the
    // season rather than tuning it.
    season_closed: "SEASON CLOSED (no new messages; the queue still prints)"
  };

  // Settings that are yes/no rather than a number.
  //
  // They used to render as number boxes like everything else, which is how
  // "only_supporters" shipped and was then impossible to find: a switch that
  // looks like a quantity reads as a quantity, and nobody scans a column of
  // number fields looking for one. hold_all and moderation had the same
  // problem and nobody had said so.
  var FLAGS = { hold_all: 1, moderation: 1, only_supporters: 1, season_closed: 1 };

  // Settings that are one of a fixed set rather than a number or a switch.
  //
  // Only printer_profile so far, and it needed this because it had no control
  // at all: it was in the API's schema, absent from this page, and named in no
  // document. Which machine is in service decides what the paper gauge divides
  // by - 8 dots per millimetre against 7.0866 - so a deployment whose printer
  // is not the shipped default read its roll 13% out with no way to say so
  // short of hand-rolling an API call.
  //
  // The options are not listed here. They arrive with the queue, from
  // profiles.js, so adding a printer stays a one-file change.
  var ENUMS = { printer_profile: 1 };
  var enumOptions = {};

  function renderSettings(settings) {
    var box = $("settings");
    box.textContent = "";
    Object.keys(SETTING_LABELS).forEach(function (key) {
      box.appendChild(el("label", null, SETTING_LABELS[key]));
      var input;
      if (ENUMS[key]) {
        input = el("select");
        (enumOptions[key] || []).forEach(function (id) {
          var option = el("option", null, id);
          option.value = id;
          if (settings[key] === id) option.selected = true;
          input.appendChild(option);
        });
      } else {
        input = el("input");
        if (FLAGS[key]) {
          input.type = "checkbox";
          input.checked = settings[key] === "1";
        } else {
          input.type = "number";
          input.value = settings[key];
        }
      }
      input.dataset.key = key;
      input.addEventListener("change", function () {
        api("/settings", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            key: key,
            value: FLAGS[key] ? (input.checked ? "1" : "0") : input.value
          })
        })
          .then(function (r) { return r.json(); })
          .then(function (body) {
            $("settings-note").textContent = body.ok
              ? key + " saved"
              : key + ": " + (body.error || "refused");
            $("settings-note").className = body.ok ? "empty" : "err";
          });
      });
      box.appendChild(input);
    });
  }

  // Ids ticked right now. Survives a refresh of the list: the desk reloads
  // every few seconds, and losing a selection halfway through reading a
  // hundred and fifty messages would be maddening.
  // Where "very short" stops. Three words catches hello / merci beaucoup / trop
  // cool without touching anything that says something.
  var SHORT_WORDS = 3;

  var picked = new Set();
  // The pending ids currently on screen, so "select all" means what is shown.
  var onScreen = [];
  // How many are waiting in total, which is not the same thing.
  var pendingTotal = 0;
  // Set when the reader asks for everything rather than a selection.
  var wholeQueue = false;

  function renderBulkBar() {
    // Anything ticked and then decided elsewhere drops out on its own.
    picked.forEach(function (id) {
      if (onScreen.indexOf(id) === -1) picked.delete(id);
    });
    var n = picked.size;
    $("bulkbar").hidden = n === 0;
    $("bulk-count").textContent =
      n + (n === 1 ? " message selected" : " messages selected");
  }

  function renderPending(jobs, ttl) {
    var box = $("pending");
    box.textContent = "";
    onScreen = jobs.map(function (j) { return j.id; });
    // The real number, not the length of the page. A queue of 377 reading
    // "200" is the one lie on this desk that changes what the owner does next.
    $("pending-count").textContent = pendingTotal;
    $("pending-note").textContent =
      pendingTotal > jobs.length
        ? "Showing the oldest " + jobs.length + " of " + pendingTotal +
          ". The bulk buttons can still act on all of them."
        : "";
    if (!jobs.length) {
      box.appendChild(el("p", "empty", "Nothing waiting. The queue is clear."));
      renderBulkBar();
      return;
    }
    jobs.forEach(function (job) {
      var card = el("div", "card");

      // The box and the text are one label, so the whole message is a hit
      // target. Ticking a hundred and fifty 13-pixel squares would be its own
      // small hell.
      var pick = el("label", "pick");
      // Deliberately not called "box": that name already holds the container
      // this card is appended to, a few lines down. Shadowing it made
      // appendChild put the card inside the checkbox, which is a void element,
      // and the browser refused the whole desk with "the operation would yield
      // an incorrect node tree".
      //
      // No backticks in this file, ever: the page is one template literal, and
      // a backtick in a comment ends it.
      var tick = el("input");
      tick.type = "checkbox";
      tick.checked = picked.has(job.id);
      tick.addEventListener("change", function () {
        if (tick.checked) picked.add(job.id);
        else picked.delete(job.id);
        card.classList.toggle("picked", tick.checked);
        renderBulkBar();
      });
      pick.appendChild(tick);
      pick.appendChild(el("p", "text", job.text));
      card.appendChild(pick);
      card.classList.toggle("picked", tick.checked);

      var meta = el("div", "meta");
      meta.appendChild(el("span", "tag", "#" + job.id));
      // The signature is context worth having before deciding: it is the one
      // thing on the ticket the author chose to attach their name to.
      if (job.handle) meta.appendChild(el("span", "tag", "@" + job.handle));
      meta.appendChild(el("span", null, ago(job.created_at)));
      meta.appendChild(el("span", null, job.expires_at ? left(job.expires_at) : "waits"));

      // Everything waits for a tap now, so the card has to say which kind of
      // waiting this is: a note the filters found nothing wrong with, or one
      // they want a second opinion on. Without that distinction the queue is
      // uniform and the ones worth reading get skimmed past.
      var wordCount = String(job.text || "").trim().split(/\s+/).filter(Boolean).length;
      if (wordCount <= SHORT_WORDS) {
        meta.appendChild(el("span", "tag", wordCount === 1 ? "1 word" : wordCount + " words"));
      }
      if (job.verdict === "approved") {
        card.classList.add("clean");
        meta.appendChild(el("span", "tag ok", "clean"));
      } else {
        card.classList.add("flagged");
        meta.appendChild(el("span", "tag flag", job.source || "flagged"));
        if (job.reason) meta.appendChild(el("span", null, job.reason));
      }
      card.appendChild(meta);

      var row = el("div", "row");
      ["approve", "reject"].forEach(function (action) {
        var button = el("button", action === "reject" ? "ghost" : null,
          action === "approve" ? "Print it" : "Discard");
        button.addEventListener("click", function () {
          button.disabled = true;
          api("/job", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ id: job.id, action: action })
          }).then(load);
        });
        row.appendChild(button);
      });
      card.appendChild(row);
      box.appendChild(card);
    });
    renderBulkBar();
  }

  // What the archive table is currently showing. The polling /queue reload must
  // not stamp on a search the moment it fires, so once a filter or a query is
  // set, the table belongs to the search and /queue stops touching it.
  var find = { q: "", status: "", offset: 0, owned: false };
  var PAGE = 100;

  function renderPaper(paper) {
    var note = $("paper");
    if (!paper) { note.textContent = ""; return; }
    var used = (paper.usedMm / 1000).toFixed(2);
    if (paper.leftMm === null) {
      note.textContent = used + " m printed since the last roll change.";
      return;
    }
    var left = (paper.leftMm / 1000).toFixed(2);
    note.textContent =
      used + " m printed, about " + left + " m left of the roll (" +
      paper.tickets + " tickets). Estimate, not a measurement.";
    note.className = paper.leftMm < 700 ? "err" : "empty";
  }

  function renderEvents(events) {
    var body = $("events");
    body.textContent = "";
    (events || []).forEach(function (e) {
      var tr = el("tr");
      tr.appendChild(el("td", "st", ago(e.at)));
      tr.appendChild(el("td", "st", e.kind));
      var bits = [e.detail || ""];
      // Only the numbers that are actually there: a row full of nulls reads
      // as noise and hides the one line that explains an incident.
      if (e.temperature != null) bits.push(e.temperature + " C");
      if (e.pace_ms != null && e.pace_ms > 8) bits.push("pace " + e.pace_ms + " ms");
      if (e.stalls) bits.push(e.stalls + " stalls");
      if (e.sent_lines != null) bits.push(e.sent_lines + " lines sent");
      tr.appendChild(el("td", null, bits.filter(Boolean).join(" - ")));
      body.appendChild(tr);
    });
  }

  function renderRecent(jobs, append) {
    var body = $("recent");
    if (!append) body.textContent = "";
    jobs.forEach(function (job) {
      var tr = el("tr");
      tr.appendChild(el("td", "id", "#" + job.id));
      tr.appendChild(el("td", "st", job.status));
      var td = el("td", null, job.text);
      if (job.reason) td.title = job.source + ": " + job.reason;
      // Spelt out rather than left in a tooltip: deciding to print something a
      // filter refused means knowing what it objected to.
      if (job.status === "rejected" && job.source) {
        var why = el("span", "why", " " + job.source + (job.reason ? ": " + job.reason : ""));
        td.appendChild(why);
      }
      if (job.reviewed_by === "admin" && job.verdict === "approved") {
        td.appendChild(el("span", "why", " overridden by you"));
      }
      tr.appendChild(td);
      tr.appendChild(el("td", "st", ago(job.created_at)));

      // Anything already judged can be put back: a print that gave up, one
      // that came out badly, and - deliberately - one a filter refused. The
      // blocklist and the model are both wrong sometimes, and until now their
      // verdict was final with no way to say otherwise.
      var last = el("td", "act");
      if (
        job.status === "failed" ||
        job.status === "printed" ||
        job.status === "rejected"
      ) {
        var override = job.status === "rejected";
        var again = el("button", "ghost small", override ? "Print anyway" : "Reprint");
        again.addEventListener("click", function () {
          again.disabled = true;
          again.textContent = "Queued";
          api("/job", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ id: job.id, action: "reprint" }),
          }).then(reload);
        });
        last.appendChild(again);
      }
      tr.appendChild(last);
      body.appendChild(tr);
    });
  }

  function runSearch(append) {
    if (!append) find.offset = 0;
    var query =
      "/search?limit=" + PAGE +
      "&offset=" + find.offset +
      "&q=" + encodeURIComponent(find.q) +
      "&status=" + encodeURIComponent(find.status);
    return api(query)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        renderRecent(data.rows, append);
        find.offset += data.rows.length;
        var shown = find.offset;
        $("found").textContent = data.total
          ? shown + " of " + data.total
          : "Nothing matches.";
        $("more").hidden = shown >= data.total;
      })
      .catch(function () {
        $("found").textContent = "Search failed.";
      });
  }

  // Reloads whichever view the table currently belongs to, so an action taken
  // from a filtered list does not throw the reader back to the unfiltered one.
  function reload() {
    return find.owned ? runSearch(false).then(load) : load();
  }

  function markFilter() {
    Array.prototype.forEach.call(
      document.querySelectorAll("[data-filter]"),
      function (b) {
        b.className = "ghost small" + (b.dataset.filter === find.status ? " on" : "");
      }
    );
  }

  function load() {
    return api("/queue")
      .then(function (response) {
        // Flagged rather than worded, because this is now the ordinary way the
        // page starts: no cookie yet, or one that has lapsed. The gate says
        // what it wants by existing, and "Wrong token." before anyone has
        // typed one would be an accusation rather than a prompt. Only unlock()
        // reports a token that was actually refused.
        if (response.status === 401) {
          var locked = new Error("");
          locked.locked = true;
          throw locked;
        }
        return response.json();
      })
      .then(function (data) {
        $("gate").classList.add("hide");
        $("desk").classList.remove("hide");

        var paused = data.settings.kill_switch === "1";
        var service = $("service");
        service.className = "bar " + (paused ? "off" : "on");
        $("service-text").textContent = paused
          ? "Paused, nothing is accepted"
          : "Accepting messages";
        $("kill").textContent = paused ? "Resume the service" : "Pause the service";

        var device = data.device;
        var alive = device && Date.now() - device.last_seen < 15 * 60 * 1000;
        var printerBar = $("printer");
        printerBar.className = "bar " + (alive && device.printer_state === "awake" ? "on" : alive ? "warnstate" : "off");
        $("printer-text").textContent = device
          ? "Printer " + device.printer_state + " · " + device.temperature + "°C · seen " + ago(device.last_seen) +
            " · " + device.prints_ok + " ok / " + device.prints_failed + " failed"
          : "No device has ever reported in.";

        var today = data.today;
        $("today").textContent = Object.keys(today).length
          ? Object.keys(today).map(function (k) { return today[k] + " " + k; }).join(" · ")
          : "Nothing yet today.";

        // Kept so the selection helpers can re-render without another fetch.
        lastPending = data.pending;
        lastTtl = data.pending_ttl_h;
        pendingTotal = data.pending_total || data.pending.length;
        renderPending(data.pending, data.pending_ttl_h);
        renderPaper(data.paper);
        renderEvents(data.events);
        // Only while nobody is searching. Otherwise the poll would wipe a
        // filtered view every few seconds, under the reader's hands.
        if (!find.owned) renderRecent(data.recent);
        var stuck = data.recent.filter(function (j) { return j.status === "failed"; }).length;
        $("stuck").textContent = stuck
          ? stuck + " ticket" + (stuck > 1 ? "s" : "") + " will not print. Reprint puts it back in the queue."
          : "";
        enumOptions.printer_profile = data.profiles || [];
        renderSettings(data.settings);
      })
      .catch(function (err) {
        $("gate-error").textContent = err.locked ? "" : err.message;
        $("desk").classList.add("hide");
        $("gate").classList.remove("hide");
      });
  }

  $("gate").addEventListener("submit", function (event) {
    event.preventDefault();
    $("gate-error").textContent = "";
    var field = $("token");
    unlock(field.value.trim())
      .then(function () {
        // Cleared as soon as it has been spent. It is in the cookie jar now,
        // and leaving it sitting in an input is one autofill or one screenshot
        // away from being somewhere else too.
        field.value = "";
        return load();
      })
      .catch(function (err) {
        $("gate-error").textContent = err.message;
      });
  });

  $("refresh").addEventListener("click", reload);

  // --- archive search ---
  var typing = null;
  $("q").addEventListener("input", function (e) {
    find.q = e.target.value.trim();
    find.owned = Boolean(find.q || find.status);
    clearTimeout(typing);
    // Debounced: every keystroke is a D1 query otherwise, and the archive is
    // the one table here that is allowed to grow without limit.
    typing = setTimeout(function () {
      find.owned ? runSearch(false) : load();
    }, 250);
  });

  Array.prototype.forEach.call(
    document.querySelectorAll("[data-filter]"),
    function (button) {
      button.addEventListener("click", function () {
        find.status = button.dataset.filter;
        find.owned = Boolean(find.q || find.status);
        markFilter();
        find.owned ? runSearch(false) : load();
      });
    }
  );

  $("more").addEventListener("click", function () {
    runSearch(true);
  });

  // --- recovery, so neither of these needs a terminal ---
  function recover(what, button, working, done) {
    button.disabled = true;
    var was = button.textContent;
    button.textContent = working;
    api("/recover", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ what: what }),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        $("recover-note").textContent = done(data);
        button.textContent = was;
        button.disabled = false;
        return reload();
      })
      .catch(function () {
        $("recover-note").textContent = "That did not work.";
        button.textContent = was;
        button.disabled = false;
      });
  }

  // --- bulk review ---
  var lastPending = [];
  var lastTtl = 0;

  function pickWhere(test) {
    lastPending.forEach(function (job) {
      if (test(job)) picked.add(job.id);
    });
    renderPending(lastPending, lastTtl);
  }

  $("pick-all").addEventListener("click", function () {
    pickWhere(function () { return true; });
  });
  $("pick-clean").addEventListener("click", function () {
    // The ones the filters had nothing against. On a queue of a hundred and
    // fifty this is the reason the feature exists: read the flagged ones, wave
    // the rest through.
    pickWhere(function (job) { return job.verdict === "approved"; });
  });
  $("pick-flagged").addEventListener("click", function () {
    pickWhere(function (job) { return job.verdict !== "approved"; });
  });
  // "hello", "yo", "salut" - three words or fewer. They were 17% of a queue of
  // 662 and 1.7 m of the paper, and each one still costs a full ticket: title,
  // rule, reference line and the printer's own eject margin. Selecting them is
  // not deciding for you, it just puts them in one place.
  $("pick-short").addEventListener("click", function () {
    pickWhere(function (job) {
      return String(job.text || "").trim().split(/\s+/).filter(Boolean).length <= SHORT_WORDS;
    });
  });
  $("bulk-none").addEventListener("click", function () {
    picked.clear();
    renderPending(lastPending, lastTtl);
  });

  function bulk(action, button) {
    var ids = Array.from(picked);
    if (!ids.length) return;
    // No confirm on approve: the whole point is speed, and a wrongly approved
    // message is a ticket, not a disaster. Discarding is asked about, because
    // there is nothing to undo it with.
    if (action === "reject" &&
        !confirm("Discard " + ids.length + " message(s)? This cannot be undone.")) {
      return;
    }
    var was = button.textContent;
    button.disabled = true;
    button.textContent = "Working...";
    api("/bulk", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: ids, action: action }),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        picked.clear();
        button.textContent = was;
        button.disabled = false;
        $("recover-note").textContent =
          data.changed + " message(s) " + (action === "approve" ? "queued to print" : "discarded") + ".";
        return reload();
      })
      .catch(function () {
        button.textContent = was;
        button.disabled = false;
        $("recover-note").textContent = "That did not work. Nothing was changed.";
      });
  }

  // Everything waiting, including what the page is not showing. Confirmed
  // because it is the one button here that acts on messages the reader has not
  // seen - a queue of 377 with 200 on screen means 177 unread decisions.
  $("all-approve").addEventListener("click", function () {
    var button = this;
    if (!confirm("Print all " + pendingTotal + " waiting messages, including the ones not shown?")) return;
    var was = button.textContent;
    button.disabled = true;
    button.textContent = "Working...";
    api("/bulk", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "all", action: "approve" }),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        picked.clear();
        button.textContent = was;
        button.disabled = false;
        $("recover-note").textContent = data.changed + " message(s) queued to print.";
        return reload();
      })
      .catch(function () {
        button.textContent = was;
        button.disabled = false;
        $("recover-note").textContent = "That did not work. Nothing was changed.";
      });
  });

  $("bulk-approve").addEventListener("click", function () { bulk("approve", this); });
  $("bulk-reject").addEventListener("click", function () { bulk("reject", this); });

  $("roll").addEventListener("click", function () {
    recover("roll", this, "Noting...", function () {
      return "New roll noted. The gauge starts from zero.";
    });
  });

  $("unstick").addEventListener("click", function () {
    recover("failed", this, "Requeueing...", function (data) {
      return data.requeued
        ? data.requeued + " message(s) put back in the queue."
        : "Nothing was stuck.";
    });
  });

  // Pages the whole archive and hands it over as a file. Done in script rather
  // than as a plain link because the archive is thousands of rows and one
  // unbounded request would time out; the pages are stitched together here.
  // Authentication is the session cookie, so nothing is carried in the URL.
  $("export").addEventListener("click", function () {
    var note = $("export-note");
    var lines = [];
    var after = 0;

    function nextPage() {
      note.textContent = "exporting… " + lines.length + " tickets";
      return api("/export?after=" + after + "&limit=500")
        .then(function (response) { return response.text(); })
        .then(function (body) {
          var page = body.split("\n").filter(Boolean);
          if (!page.length) return done();
          lines = lines.concat(page);
          after = JSON.parse(page[page.length - 1]).id;
          return page.length < 500 ? done() : nextPage();
        });
    }

    function done() {
      var blob = new Blob([lines.join("\n") + "\n"], { type: "application/x-ndjson" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = "print-on-my-desk-tickets-" + new Date().toISOString().slice(0, 10) + ".ndjson";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      note.textContent = lines.length + " tickets exported";
    }

    nextPage().catch(function (err) { note.textContent = "export failed: " + err.message; });
  });

  $("kill").addEventListener("click", function () {
    var on = $("kill").textContent.indexOf("Pause") === 0;
    api("/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "kill_switch", value: on ? "1" : "0" })
    }).then(load);
  });

  // Always. There is nothing to check first - whether this browser is allowed
  // in is the cookie's business, and the only way to ask is to ask.
  load();

  // --- refreshing the desk without grinding the database ---
  //
  // This reloaded every 30 seconds, and each reload pulls the pending list,
  // the archive, the counts, the device row, the paper gauge and the event
  // log. With a queue in the thousands that is tens of thousands of rows an
  // hour, for a tab sitting on a phone in somebody's pocket.
  //
  // Slower, and nothing at all while the tab is hidden - with an immediate
  // reload on return, so coming back never shows a stale queue.
  var DESK_INTERVAL_MS = 60000;
  var deskTimer = null;

  function deskVisible() {
    return !$("desk").classList.contains("hide");
  }

  function startDeskPolling() {
    if (deskTimer !== null) return;
    deskTimer = setInterval(function () {
      if (deskVisible()) load();
    }, DESK_INTERVAL_MS);
  }

  function stopDeskPolling() {
    if (deskTimer === null) return;
    clearInterval(deskTimer);
    deskTimer = null;
  }

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      stopDeskPolling();
    } else {
      if (deskVisible()) load();
      startDeskPolling();
    }
  });

  if (!document.hidden) startDeskPolling();
})();
</script>
</body>
</html>`;
