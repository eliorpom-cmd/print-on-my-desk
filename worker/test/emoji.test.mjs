// The font has no emoji, and fold() turns anything it cannot draw into a
// question mark. That is invisible to the author: the message passes every
// other check and prints as "Bonjour ? le monde".
//
// These tests pin the two halves that have to agree - what fold() mangles and
// what undrawable() reports - because if they ever drift, the form starts
// refusing text that would have printed, or accepting text that will not.

import { test } from "node:test";
import assert from "node:assert/strict";

import { fold, undrawable, looksLikeEmoji, has } from "../src/font.js";

test("an emoji is reported, and it is the emoji that is reported", () => {
  assert.deepEqual(undrawable("Bonjour 👋 le monde"), ["👋"]);
  assert.ok(looksLikeEmoji("👋"));
});

test("ordinary French is left alone", () => {
  for (const text of ["Salut ça va", "aéîôù", "Ça marche ?", "L'été, 100%"]) {
    assert.deepEqual(undrawable(text), [], text);
    assert.equal(fold(text), text);
  }
});

test("undrawable() and fold() never disagree", () => {
  // The invariant that matters: a character is reported if and only if fold
  // would replace it with a question mark.
  const samples = [
    "Bonjour 👋", "привет", "aéîô", "100% ❤️", "naïve façade",
    "\n\nmultiline\n", "ﬁligrane", "Ⅻ siècle", "🎉🎉🎉", "ok",
  ];
  for (const text of samples) {
    const reported = undrawable(text);
    for (const ch of text) {
      const mangled = fold(ch) === "?" && ch !== "?";
      assert.equal(
        reported.includes(ch),
        mangled,
        `${JSON.stringify(ch)} in ${JSON.stringify(text)}`
      );
    }
  }
});

test("no repeats, and order is kept", () => {
  assert.deepEqual(undrawable("🎉 a 🎉 b 🥐"), ["🎉", "🥐"]);
});

test("a ligature folds rather than being refused", () => {
  // NFKD breaks these into letters the font has, so they must NOT be refused.
  assert.deepEqual(undrawable("ﬁligrane"), []);
  assert.equal(fold("ﬁligrane"), "filigrane");
});

test("the emoji wording only fires for something pictographic", () => {
  // Cyrillic cannot be drawn either, but telling someone to "remove the emoji"
  // when they wrote Russian would be nonsense.
  const bad = undrawable("привет");
  assert.ok(bad.length > 0);
  assert.equal(bad.filter(looksLikeEmoji).length, 0);
});

test("the question mark itself is printable", () => {
  assert.ok(has("?"));
  assert.deepEqual(undrawable("Really?"), []);
});
