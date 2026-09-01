// The filter's mechanics, tested against the list this repository ships.
//
// The project this came from has a much longer list and a much longer test
// file, and neither travels: a test suite that names every term at every
// severity IS the list, and publishing it hands anybody who wants past your
// filter a complete map of it.
//
// What is here instead is the part that matters when you write your own list -
// the engine's behaviour. It is worth understanding before you add a term,
// because most of what people write by hand is already covered, and the rest
// is usually a mistake.

import { test } from "node:test";
import assert from "node:assert/strict";

import { screen, normalize, collapse, tokenize } from "../src/blocklist.js";

// `screen` reports a severity; moderation.js turns that into a job status.
// The tests below assert on the severity, because that is the filter's own
// answer - what you do with it is policy, and policy is in moderation.js.
const sev = (text) => screen(text).severity;

test("plain text passes, and nothing is clever about it", () => {
  for (const ok of [
    "Hello from Berlin!",
    "Happy birthday, I hope the printer is warm.",
    "Ceci est un message parfaitement normal.",
  ]) {
    assert.equal(sev(ok), null, ok);
  }
});

// --- what you do NOT have to write by hand ---------------------------------

test("leetspeak is folded before anything is matched", () => {
  // Do not add "$h1t" to your list by hand. It is the same word.
  assert.equal(sev("$h1t"), sev("shit"));
  assert.equal(sev("p0rn"), sev("porn"));
});

test("the fold makes one choice per character, and you should know which", () => {
  // A digit can stand for more than one letter and the map picks one. `4` is
  // `a`, so "f4ck" folds to "fack" and is NOT caught - while "f*ck" and
  // "fuuuck" both are.
  //
  // This is not a bug to fix by adding more mappings: making `4` ambiguous
  // would fold ordinary words into terms and start eating real messages. It is
  // a limit to know about. If a particular spelling matters to you, add it to
  // your list as its own pattern - that is what the list is for.
  assert.equal(normalize("f4ck"), "fack");
  assert.equal(normalize("$h1t"), "shit");
  assert.equal(normalize("l33t"), "leet");
});

test("spacing a word out does not hide it", () => {
  assert.equal(sev("f u c k"), sev("fuck"));
  assert.equal(sev("p.o.r.n"), sev("porn"));
});

test("stretching a word out does not hide it", () => {
  assert.equal(sev("fuuuuuck"), sev("fuck"));
  assert.equal(sev("ffuuckk"), sev("fuck"));
});

test("lookalike letters from other alphabets are folded too", () => {
  // Cyrillic о and с. They are not Latin letters, and they read identically.
  assert.equal(sev("сock"), sev("cock"));
});

test("accents fold, so a French keyboard is not a way through", () => {
  assert.equal(normalize("CAFÉ"), "cafe");
});

// --- what the engine protects you FROM -------------------------------------

test("an exact term does not match inside another word", () => {
  // The Scunthorpe problem, and the reason `mode` exists. `cum` is an exact
  // term in the starter list; these words contain it and are not it.
  for (const innocent of [
    "this is cumbersome",
    "circumstances change",
    "the accumulation of paper",
  ]) {
    assert.equal(sev(innocent), null, innocent);
  }
});

test("a family term does match inside a word, which is the point", () => {
  // `porn` is family, so "pornographic" is caught without anybody listing it.
  assert.equal(sev("pornographic"), "medium");
});

test("a phrase term needs both words, not either one", () => {
  assert.equal(sev("kill the lights"), null);
  assert.equal(sev("you were amazing"), null);
  assert.equal(sev("i will kill you"), "medium");
  // The gap between the two words is capped, deliberately: without a cap,
  // "kill the lights, and I hope you enjoy it" would be a threat.
  assert.equal(sev("i will kill all of you"), null);
});

// --- severity --------------------------------------------------------------

test("severity decides the verdict, and the three are different", () => {
  // low prints and is recorded; medium waits for a person; high is refused
  // outright. Check the mapping rather than the words, so this test survives
  // you rewriting the list.
  const low = screen("fuck");
  assert.equal(low.severity, "low");
  assert.deepEqual(low.terms, ["swear"], "and it says which term, so the desk can show it");

  assert.equal(sev("porn"), "medium");
  assert.equal(sev("examplesluronly"), "high");
});

test("the worst hit in a message decides it", () => {
  assert.equal(sev("fuck this porn"), "medium", "medium beats low");
  assert.equal(sev("fuck this examplesluronly"), "high", "and high beats both");
});

// --- the pieces, on their own ----------------------------------------------

test("tokenising rejoins letters somebody spaced out", () => {
  assert.ok(tokenize(normalize("f u c k")).includes("fuck"));
});

test("collapsing runs makes both sides of the comparison agree", () => {
  assert.equal(collapse("fuuuuck"), collapse("fuck"));
});

test("the allowlist runs first, so a real word is never part of a hit", () => {
  // Add your own to ALLOW in blocklist.js the first time a filter eats
  // somebody's perfectly ordinary message. It will happen.
  assert.equal(sev("Scunthorpe"), null);
  assert.equal(sev("analysis"), null);
});
