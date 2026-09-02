// The admin page, actually run.
//
// This file exists because "the JavaScript parses" was the check that let a
// broken desk reach production on 30 August. The page rendered nothing at all
// and the browser said only "the operation would yield an incorrect node
// tree": a checkbox had been named `box`, shadowing the container variable a
// few lines above it, so every card was appended into an <input>.
//
// Parsing cannot catch that. Running it can.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";

import { ADMIN_PAGE } from "../src/admin-page.js";

/** Loads the page into a DOM, with fetch stubbed to canned desk data. */
function openDesk(desk) {
  const { window, document } = parseHTML(ADMIN_PAGE);

  const replies = {
    "/queue": desk,
    "/search": { rows: [], total: 0 },
    "/bulk": { ok: true, changed: 0 },
    "/recover": { ok: true, requeued: 0 },
  };
  const calls = [];
  window.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const key = Object.keys(replies).find((k) => String(url).includes(k));
    return {
      status: 200,
      ok: true,
      async json() {
        return replies[key] ?? {};
      },
    };
  };
  // The page authenticates itself by the session cookie now, so there is no
  // storage to seed: the stub above answers /queue with 200 and the desk
  // renders. What still has to hold is that it renders AT ALL - a page that
  // stops at the gate makes every query below match nothing, and the
  // assertions then pass while testing precisely nothing, which is how the
  // first version of this file "passed" against the broken desk. The card
  // count assertions are what catch that.
  window.confirm = () => true;

  // Timers are dead on purpose. The desk re-polls itself on an interval, and a
  // stub that ran the callback would re-enter the poll forever - the first
  // version of this test hung for two minutes doing exactly that. Nothing here
  // needs the polling: one render is the whole subject.
  const errors = [];
  const noTimer = () => 0;

  // The tag carries a CSP nonce placeholder now, so the match cannot assume
  // a bare <script>.
  const script = ADMIN_PAGE.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];
  const run = new Function(
    "window", "document", "fetch", "confirm", "location",
    "history", "setTimeout", "clearTimeout", "setInterval", "clearInterval",
    "alert",
    script
  );
  try {
    run(
      window, document, window.fetch, window.confirm,
      { pathname: "/admin", hash: "", search: "", reload() {} },
      { replaceState() {} },
      noTimer, noTimer, noTimer, noTimer, () => {}
    );
  } catch (err) {
    errors.push(err);
  }
  return { window, document, calls, errors };
}

/** Runs the page, then lets its fetch promises settle before asserting. */
async function loadedDesk(desk) {
  const ctx = openDesk(desk);
  // The desk renders inside a promise chain; a few microtask turns is enough.
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise((r) => setImmediate(r));
  return ctx;
}

const CARD = (id, verdict) => ({
  id,
  text: "message " + id,
  created_at: Date.now() - 60000,
  expires_at: null,
  verdict: verdict ?? "approved",
  source: verdict === "approved" ? null : "spam",
  reason: verdict === "approved" ? null : "link",
  handle: null,
});

const DESK = {
  now: Date.now(),
  pending: [CARD(1), CARD(2, "rejected"), CARD(3)],
  recent: [{ id: 9, text: "old", status: "printed", created_at: Date.now() - 1e6 }],
  today: { printed: 3 },
  device: { last_seen: Date.now(), printer_state: "awake", temperature: 28, battery: 100, prints_ok: 3, prints_failed: 0 },
  settings: { kill_switch: "0" },
  paper: { usedMm: 1200, rollMm: 10000, leftMm: 8800, tickets: 4, since: 0 },
  events: [{ at: Date.now(), kind: "printer_state", detail: "awake -> no_paper", temperature: 30 }],
  open: true,
  reason: "open",
  pending_ttl_h: 0,
};

test("the page loads without throwing", async () => {
  const { errors } = await loadedDesk(DESK);
  assert.deepEqual(errors.map((e) => e.message), [], "no error while running the page");
});

test("the desk really renders, and every card carries a checkbox", async () => {
  const { document } = await loadedDesk(DESK);

  // First: the render happened at all. This is the assertion that would have
  // failed on the broken desk, where appendChild threw and #pending stayed
  // empty.
  const cards = document.querySelectorAll("#pending .card");
  assert.equal(cards.length, DESK.pending.length, "one card per pending message");

  const boxes = document.querySelectorAll("#pending input[type=checkbox]");
  assert.equal(boxes.length, DESK.pending.length, "one checkbox per card");

  // And the card, not the checkbox, is what holds the message.
  for (const card of cards) {
    assert.ok(card.textContent.includes("message"), "the card shows its text");
  }
});

test("the archive, the paper gauge and the event log all render", async () => {
  const { document } = await loadedDesk(DESK);
  assert.equal(document.querySelectorAll("#recent tr").length, DESK.recent.length);
  assert.equal(document.querySelectorAll("#events tr").length, DESK.events.length);
  assert.match(document.getElementById("paper").textContent, /m printed/);
});

test("an input can never be given children", () => {
  // The specific mistake, pinned. linkedom is permissive where browsers are
  // not, so this asserts the shape we rely on rather than the throw.
  const { document } = openDesk(DESK);
  const inputs = document.querySelectorAll("input");
  for (const input of inputs) {
    assert.equal(
      input.children.length,
      0,
      "an <input> with children is the bug that broke the desk"
    );
  }
});

test("the page carries no backtick, which would end its template literal", () => {
  const src = ADMIN_PAGE;
  assert.ok(src.length > 1000, "the page must have survived being built at all");
  // If a backtick had slipped in, this module would have failed to parse and
  // the import above would already have thrown - so reaching here is the test.
});

test("the bulk bar and its controls are present", async () => {
  const { document } = await loadedDesk(DESK);
  for (const id of [
    "bulkbar", "bulk-count", "bulk-approve", "bulk-reject", "bulk-none",
    "pick-all", "pick-clean", "pick-flagged", "q", "more", "events", "paper",
    "roll", "unstick",
  ]) {
    assert.ok(document.getElementById(id), "missing #" + id);
  }
});

test("the count in the header is the real one, not the page size", async () => {
  // A queue of 377 read "200" because the header showed the length of the list
  // it had been handed. That number is what decides whether the owner has an
  // evening's work waiting, so it has to be true.
  const { document } = await loadedDesk({ ...DESK, pending_total: 377 });
  assert.equal(document.getElementById("pending-count").textContent, "377");
  assert.match(
    document.getElementById("pending-note").textContent,
    /Showing the oldest 3 of 377/
  );
});

test("no note when the page is showing everything", async () => {
  const { document } = await loadedDesk({ ...DESK, pending_total: 3 });
  assert.equal(document.getElementById("pending-note").textContent, "");
});

test("the card text is given a real width, not an intrinsic one", () => {
  // The bug this pins: as a flex item the paragraph's automatic minimum size
  // is its longest unbreakable run, and .text sets word-break: break-word, so
  // that minimum was one character - the message rendered as a vertical column
  // of letters on a phone.
  //
  // The layout now states the width instead of negotiating it: a grid with an
  // explicit 1fr track for the text.
  const css = ADMIN_PAGE.match(/<style[^>]*>([\s\S]*?)<\/style>/)[1];

  const container = css.match(/\.card > label\.pick \{([^}]*)\}/);
  assert.ok(container, "the card layout rule must exist");
  assert.match(container[1], /display:\s*grid/);
  assert.match(container[1], /grid-template-columns:[^;]*1fr/,
    "the text needs a track that takes the remaining width");

  const text = css.match(/\.card > label\.pick p\.text \{([^}]*)\}/);
  assert.ok(text, "the paragraph rule must exist");
  assert.match(text[1], /width:\s*100%/);
  assert.match(text[1], /min-width:\s*0/);
});

test("the very short messages can be picked out, and are labelled", async () => {
  // 17% of a queue of 662 were three words or fewer, and each still cost a
  // full ticket - title, rule, reference line, eject margin.
  const desk = {
    ...DESK,
    pending: [
      { ...CARD(1), text: "hello" },
      { ...CARD(2), text: "merci beaucoup" },
      { ...CARD(3), text: "this one actually says something worth printing" },
    ],
    pending_total: 3,
  };
  const { document } = await loadedDesk(desk);

  const button = document.getElementById("pick-short");
  assert.ok(button, "the short-message selector must exist");

  const tags = [...document.querySelectorAll("#pending .tag")].map((t) => t.textContent);
  assert.ok(tags.includes("1 word"), "a one-word message says so");
  assert.ok(tags.includes("2 words"), "a two-word message says so");
  assert.ok(
    !tags.some((t) => /^\d+ words$/.test(t) && parseInt(t) > 3),
    "a real message is not labelled by length"
  );
});

test("the desk stops reloading while the tab is hidden", () => {
  // Each reload pulls the pending page, the archive, the counts, the device
  // row, the paper gauge and the event log. Every 30 seconds, for a tab in
  // somebody's pocket, against a queue in the thousands.
  const src = ADMIN_PAGE
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  assert.ok(
    !/setInterval\([^)]*\},\s*30000\)/.test(src),
    "the 30-second reload is what made a large queue expensive"
  );
  assert.match(src, /DESK_INTERVAL_MS\s*=\s*60000/);
  assert.match(src, /visibilitychange/);
  assert.match(src, /clearInterval\(deskTimer\)/, "hiding must clear the timer");
  assert.match(src, /if \(!document\.hidden\) startDeskPolling\(\);/);

  const start = src.match(/function startDeskPolling\(\)[\s\S]{0,220}?\}/)[0];
  assert.match(start, /if \(deskTimer !== null\) return;/, "two timers would double the load");
});

// --- the printer in service -----------------------------------------------
//
// printer_profile shipped as a setting the API accepted, the paper gauge read,
// and the desk could not touch: no control here, no line in any document. A
// deployment whose printer was not the shipped default divided its roll by the
// wrong dot pitch - 7.0866 against 8, which is 13% - and had nowhere to say so.
//
// What these guard is the wiring, because it is the half that fails silently:
// a select whose options never arrived looks exactly like a select.

test("the printer in service is a select, built from the profiles the Worker sent", async () => {
  const { document } = await loadedDesk({
    ...DESK,
    settings: { ...DESK.settings, printer_profile: "trp100" },
    profiles: ["mxw01", "trp100"],
  });

  const select = document.querySelector('#settings select[data-key="printer_profile"]');
  assert.ok(select, "printer_profile renders a control");
  assert.equal(select.tagName.toLowerCase(), "select", "an enum is not a number box");

  const ids = Array.from(select.querySelectorAll("option")).map((o) => o.value);
  assert.deepEqual(ids, ["mxw01", "trp100"], "every profile the Worker knows is offered");

  const chosen = Array.from(select.querySelectorAll("option")).filter((o) => o.selected);
  assert.deepEqual(chosen.map((o) => o.value), ["trp100"], "the current setting is the selected one");
});

test("a Worker that sends no profile list leaves an empty select rather than throwing", async () => {
  // Older deployment, newer page: the queue answer has no `profiles` key. The
  // desk must still render - every other setting on this page is behind the
  // same loop, and one throw takes all of them out.
  const { document, errors } = await loadedDesk({
    ...DESK,
    settings: { ...DESK.settings, printer_profile: "mxw01" },
  });

  assert.deepEqual(errors.map((e) => e.message), [], "no error while running the page");
  const select = document.querySelector('#settings select[data-key="printer_profile"]');
  assert.ok(select, "the control is still there");
  assert.equal(select.querySelectorAll("option").length, 0, "with nothing to offer");
});
