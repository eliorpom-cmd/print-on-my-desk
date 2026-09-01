// Closing the service, and the one way back in.
//
// The service was "closed" for a fortnight and the closure was thinner than it
// looked: the page hid the form, the submit handler refused, and the a tip jar
// webhook went on creating approved jobs. An approved job prints. So "closed"
// meant closed to anybody using the site, which is not the same statement.
//
// These tests are about the difference between those two statements.

import { test } from "node:test";
import assert from "node:assert/strict";

import { submissionGate, isOpen, acceptingMessages } from "../src/settings.js";
import { hasPrivateAccess, keyFrom, ACCESS_HEADER } from "../src/access.js";

const OPEN = { kill_switch: "0", closes_at: "0" };
const PAUSED = { kill_switch: "1", closes_at: "0" };
const OVER = { kill_switch: "0", closes_at: "1000" };

const request = (headers = {}) => new Request("https://example.test/", { headers });

test("an open service is open, and says nothing clever about it", () => {
  const gate = submissionGate(OPEN);
  assert.deepEqual(gate, { open: true, reason: "open", privately: false });
});

test("a closed season refuses, and says which kind of closed", () => {
  const gate = submissionGate(OVER, { now: 2000 });
  assert.equal(gate.open, false);
  assert.equal(gate.reason, "season_over");
});

test("a season with no end date never ends", () => {
  assert.equal(submissionGate(OPEN, { now: 8.64e15 }).open, true);
});

test("the private door opens a closed season", () => {
  const gate = submissionGate(OVER, { now: 2000, privateAccess: true });
  assert.equal(gate.open, true);
  assert.equal(gate.privately, true, "and says so, so the page can show it");
});

test("the private door does not open the kill switch", () => {
  // The whole reason the two are separate. A season closing is a schedule and
  // schedules have exceptions; the kill switch is somebody deciding the
  // machine stops NOW, and a switch with exceptions is not a switch.
  const gate = submissionGate(PAUSED, { privateAccess: true });
  assert.equal(gate.open, false);
  assert.equal(gate.reason, "paused");
  assert.equal(gate.privately, false);
});

test("the kill switch outranks a season that is still running", () => {
  assert.equal(submissionGate({ kill_switch: "1", closes_at: "0" }).open, false);
});

test("the gate agrees with the two readings it replaced", () => {
  // It was two checks in one handler, and a second way in was a second place
  // to remember. They must still mean the same thing on their own.
  for (const settings of [OPEN, PAUSED, OVER]) {
    const gate = submissionGate(settings, { now: 2000 });
    const expected =
      isOpen(settings).open && acceptingMessages(settings, 2000).accepting;
    assert.equal(gate.open, expected, JSON.stringify(settings));
  }
});

// --- the key ---------------------------------------------------------------

test("no configured key means no private door at all", async () => {
  // The safe direction: a deployment that has never been given a key has no
  // door, rather than one anybody can walk through.
  const req = request({ [ACCESS_HEADER]: "anything" });
  assert.equal(await hasPrivateAccess(req, {}), false);
  assert.equal(await hasPrivateAccess(req, { ACCESS_KEY: "" }), false);
});

test("the right key opens it and a wrong one does not", async () => {
  const env = { ACCESS_KEY: "s3cret-key-for-the-owner" };
  assert.equal(await hasPrivateAccess(request({ [ACCESS_HEADER]: env.ACCESS_KEY }), env), true);
  assert.equal(await hasPrivateAccess(request({ [ACCESS_HEADER]: "s3cret-key-for-the-owne" }), env), false);
  assert.equal(await hasPrivateAccess(request({ [ACCESS_HEADER]: "" }), env), false);
  assert.equal(await hasPrivateAccess(request(), env), false);
});

test("a key that is nearly right is not nearly enough", async () => {
  // Guards the hashing in safeEqual: two inputs sharing every byte but one
  // must not compare equal, whatever their lengths.
  const env = { ACCESS_KEY: "abcdefghijklmnop" };
  for (const wrong of ["abcdefghijklmnoq", "abcdefghijklmno", "abcdefghijklmnopq", "ABCDEFGHIJKLMNOP"]) {
    assert.equal(await hasPrivateAccess(request({ [ACCESS_HEADER]: wrong }), env), false, wrong);
  }
});

test("an absurd key is dropped before it is compared", () => {
  // A header is attacker-controlled and unbounded. Hashing a megabyte of it on
  // every request is work somebody else gets to choose for us.
  const long = "x".repeat(5000);
  assert.equal(keyFrom(request({ [ACCESS_HEADER]: long })), "");
  assert.equal(keyFrom(request({ [ACCESS_HEADER]: "short" })), "short");
});

// --- closing it from the desk ----------------------------------------------

test("the season switch writes through to the date, and back", async () => {
  // Closing the season was an UPDATE typed against production until today,
  // which is why it was only ever half done. The desk writes a switch; the
  // stored truth stays an instant, so "it ended at 22:14" survives reopening.
  const { resolveSetting, validateSetting } = await import("../src/admin.js");

  assert.deepEqual(validateSetting("season_closed", "1"), { ok: true, value: "1" });
  assert.deepEqual(resolveSetting("season_closed", "1", 1_700_000_000_000), [
    "closes_at",
    "1700000000000",
  ]);
  assert.deepEqual(resolveSetting("season_closed", "0", 1_700_000_000_000), [
    "closes_at",
    "0",
  ]);
  // Everything else passes through untouched.
  assert.deepEqual(resolveSetting("kill_switch", "1"), ["kill_switch", "1"]);
});

test("what the switch writes is what the gate reads", async () => {
  const { resolveSetting } = await import("../src/admin.js");
  const now = 1_700_000_000_000;

  const [, closed] = resolveSetting("season_closed", "1", now);
  assert.equal(submissionGate({ kill_switch: "0", closes_at: closed }, { now }).open, false);

  const [, reopened] = resolveSetting("season_closed", "0", now);
  assert.equal(submissionGate({ kill_switch: "0", closes_at: reopened }, { now }).open, true);
});

test("the desk shows the switch in the position it is actually in", async () => {
  const { loadDesk } = await import("../src/admin.js");
  const { makeDb } = await import("./helpers/d1.mjs");
  const db = makeDb();
  const now = 1_700_000_000_000;

  const open = await loadDesk(db, { closes_at: "0" }, now);
  assert.equal(open.settings.season_closed, "0");

  const shut = await loadDesk(db, { closes_at: String(now - 1) }, now);
  assert.equal(shut.settings.season_closed, "1");

  // A date in the future is a season still running, not one already over.
  const later = await loadDesk(db, { closes_at: String(now + 60_000) }, now);
  assert.equal(later.settings.season_closed, "0");
});
