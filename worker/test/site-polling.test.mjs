// The public page's polling rhythm.
//
// This was one API call a minute for every tab anyone had left open, phones in
// pockets included. On the day the link went round Threads it was the largest
// single source of traffic on the service - ahead of the messages themselves -
// and Workers AI hit its daily ceiling by teatime.
//
// The file is checked as source rather than executed: app.js imports four
// browser modules and touches a dozen elements, and standing all that up would
// test the harness more than the behaviour. What matters here is small and
// exact, so it is asserted exactly.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SOURCE = readFileSync(
  fileURLToPath(new URL("../../web/app.js", import.meta.url)),
  "utf8"
);

// Comments stripped before matching. The first version of this file failed
// against correct code because the comment explaining the removal quoted the
// removed line - a test that reads prose as if it were behaviour.
const APP = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("the status is not polled every minute any more", () => {
  assert.ok(
    !/setInterval\(refreshState,\s*60000\)/.test(APP),
    "the once-a-minute poll is what flooded the Worker"
  );
});

test("the interval is three minutes, and stated once", () => {
  const decl = APP.match(/STATE_INTERVAL_MS\s*=\s*([^;]+);/);
  assert.ok(decl, "the interval must be a named constant, not a literal");
  assert.match(decl[1], /3\s*\*\s*60\s*\*\s*1000/);
});

test("polling stops while the tab is hidden and resumes when it returns", () => {
  assert.match(APP, /visibilitychange/, "the page must react to being hidden");
  assert.match(APP, /document\.hidden/);
  assert.match(APP, /clearInterval\(stateTimer\)/, "hiding must clear the timer");

  // Coming back has to ask immediately: the pill on screen can be three
  // minutes stale, and the person is looking at it again.
  const handler = APP.match(/visibilitychange[\s\S]{0,400}/)[0];
  assert.match(handler, /refreshState\(\)/, "returning must refresh at once");
  assert.match(handler, /startPolling\(\)/);
});

test("a tab that opens hidden never starts a timer", () => {
  // Links opened in a background tab are common, and one that polls forever
  // without ever being looked at is the exact waste this removes.
  assert.match(APP, /if \(!document\.hidden\) startPolling\(\);/);
});

test("starting twice cannot leave two timers running", () => {
  // Two intervals would double the traffic and never be noticed.
  const start = APP.match(/function startPolling\(\)[\s\S]{0,200}?\}/)[0];
  assert.match(start, /if \(stateTimer !== null\) return;/);
});
