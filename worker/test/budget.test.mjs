// The print budget: "run a thousand of the backlog off this roll, then stop."
//
// The queue had two speeds and needed a third. Idle prints nothing but a tip jar
// thank-yous; live prints the whole approved backlog, one after another, until
// somebody is standing there to turn it off. Neither is what a fresh roll
// wants, and "flip it to live and watch it" is not a mechanism - it is a
// person promising to be in the room.
//
// What these tests defend is the moment the budget hits zero, because that is
// the moment that has to work with nobody watching:
//
//   * it must stop on the number asked for, not on the batch boundary above it
//     - a budget of 1,000 spent eight tickets at a time is 1,000 only by luck;
//   * it must flip to idle exactly once, or the priority tickets that go on
//     printing afterwards would each re-trigger it;
//   * it must never go negative, because a negative budget read back as a
//     number would be "no budget" and print the rest of the queue.

import { test } from "node:test";
import assert from "node:assert/strict";

import { makeDb } from "./helpers/d1.mjs";
import { budgetedBatch, spendBudget, saveSetting } from "../src/admin.js";
import { loadSettings } from "../src/settings.js";
import { recent } from "../src/events.js";

async function setBudget(db, n) {
  await saveSetting(db, "print_budget", String(n));
}

async function budgetOf(db) {
  return Number((await loadSettings(db)).print_budget);
}

async function isIdle(db) {
  return (await loadSettings(db)).only_supporters === "1";
}

// --- the last strip is short ------------------------------------------------

test("a budget shorter than the strip shortens the strip", () => {
  assert.equal(budgetedBatch(8, 3), 3);
  assert.equal(budgetedBatch(8, 1), 1);
});

test("a budget longer than the strip leaves it alone", () => {
  assert.equal(budgetedBatch(8, 900), 8);
});

test("no budget is not a budget of nothing", () => {
  // 0 means "no bound" everywhere in settings.js, and reading it as "hand out
  // zero tickets" would stop the printer for everyone who has never set one.
  assert.equal(budgetedBatch(8, 0), 8);
});

// --- spending it ------------------------------------------------------------

test("spending leaves the remainder", async () => {
  const db = makeDb();
  await setBudget(db, 1000);
  assert.equal(await spendBudget(db, 8), 992);
  assert.equal(await budgetOf(db), 992);
  assert.equal(await isIdle(db), false, "992 left is not the end of the run");
});

test("the last ticket of the budget puts the queue back to idle", async () => {
  const db = makeDb();
  await setBudget(db, 5);
  assert.equal(await spendBudget(db, 5), 0);
  assert.equal(await budgetOf(db), 0);
  assert.equal(await isIdle(db), true);

  const events = await recent(db, 10);
  assert.equal(
    events.filter((e) => e.detail?.includes("print budget spent")).length,
    1,
    "the run has to leave a trace of why the printer went quiet"
  );
});

test("what is stored is a whole number, spelt as one", async () => {
  // Found on a local run, not here: the tickets arrive as a JS number, SQLite
  // takes it as a float, and the row was written "992.0" and then "0.0".
  // Number() reads both, so every assertion in this file passed while
  // queue.sh - which compares the stored text against "0" - reported a run
  // still in progress with nothing left in it.
  const db = makeDb();
  await setBudget(db, 1000);
  await spendBudget(db, 8);
  const stored = (key) => db.raw.prepare("SELECT value FROM settings WHERE key = ?").get(key).value;
  assert.equal(stored("print_budget"), "992");
  await spendBudget(db, 992);
  assert.equal(stored("print_budget"), "0");
});

test("no budget running means nothing to charge", async () => {
  const db = makeDb();
  assert.equal(await spendBudget(db, 8), null, "0 is no budget, not an empty one");
  assert.equal(await isIdle(db), false, "and it must not flip an unbudgeted queue to idle");
});

test("a spent budget stays spent while the thank-yous print", async () => {
  // Once the budget is gone the mode is idle, and idle is exactly the mode in
  // which priority tickets still come out. If those charged the budget again, the
  // second one would record a fresh "back to idle" - and a budget that can be
  // charged below zero is one bad read away from printing the whole queue.
  const db = makeDb();
  await setBudget(db, 2);
  await spendBudget(db, 2);
  await saveSetting(db, "only_supporters", "0"); // somebody flips it back to live

  assert.equal(await spendBudget(db, 1), null, "an exhausted budget charges nothing");
  assert.equal(await budgetOf(db), 0);
  assert.equal(await isIdle(db), false, "and does not flip the mode a second time");

  const events = await recent(db, 10);
  assert.equal(
    events.filter((e) => e.detail?.includes("print budget spent")).length,
    1,
    "exactly once, however many times it is charged afterwards"
  );
});

test("overspending the last strip floors at zero", async () => {
  // Belt and braces: budgetedBatch already caps the strip, so this can only
  // happen if two devices claim in the same second. It must land on 0 rather
  // than on -3, which loadSettings would hand back as a number and the claim
  // path would read as "no bound".
  const db = makeDb();
  await setBudget(db, 3);
  assert.equal(await spendBudget(db, 8), 0);
  assert.equal(await budgetOf(db), 0);
  assert.equal(await isIdle(db), true);
});

test("two devices in the same second cannot both spend the last ticket", async () => {
  const db = makeDb();
  await setBudget(db, 10);
  const [a, b] = await Promise.all([spendBudget(db, 6), spendBudget(db, 6)]);
  // One of them found 4 left and took them; neither invented paper.
  assert.deepEqual([a, b].sort(), [0, 4]);
  assert.equal(await budgetOf(db), 0);
});

// --- the whole run ----------------------------------------------------------

test("a budget of 1000 hands out 1000 tickets, eight at a time", async () => {
  const db = makeDb();
  await setBudget(db, 1000);

  let handed = 0;
  // The claim path's own arithmetic: cap the strip, then charge what it holds.
  for (let poll = 0; poll < 500; poll++) {
    const budget = await budgetOf(db);
    if (!budget) break;
    const strip = budgetedBatch(8, budget);
    handed += strip;
    await spendBudget(db, strip);
  }

  assert.equal(handed, 1000, "not 1004, and not 996");
  assert.equal(await isIdle(db), true, "and the machine is quiet at the end of it");
});
