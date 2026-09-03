// The invitation, and the two ways it embarrasses its owner.
//
// It is the small dialog that slides up after a message has been sent, to send
// somebody somewhere else. It is OPTIONAL, most copies of this page will never
// fill it in, and the page itself is where it is configured - which makes both
// failures configuration failures rather than code ones, and neither shows up
// until after a stranger has already sent a message.
//
//   The empty one. A fresh install thanked somebody for their message and then
//   slid up a dialog titled "One more thing" with an empty paragraph and a
//   button pointing at "#". Found by the first person to follow the quick
//   start on a machine that was not this one, in the state the repository
//   ships in.
//
//   The half-filled one. A link pasted in with no sentence to explain it, or a
//   sentence with nowhere to go. Both are what somebody does at one in the
//   morning, and neither is visible from the editor.
//
// app.js is read as source rather than executed, for the reason
// site-polling.test.mjs gives: it imports browser modules and touches a dozen
// elements, and standing that up would test the harness. The page is read as a
// page, because that is what it is.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

// Comments stripped before matching, so that a comment quoting the old
// behaviour cannot pass for the behaviour. That has happened here before.
const APP = read("../../web/app.js")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

const { document } = parseHTML(read("../../web/index.html"));
const cta = document.getElementById("sheet-cta");
const body = document.getElementById("sheet-body");

/** The rule the page ships with: "#" and "" are placeholders, not places. */
const configured = (href) => href !== "" && !href.startsWith("#");

test("the invitation asks whether it has anywhere to send anybody", () => {
  assert.match(APP, /function inviteConfigured\(\)/,
    "the check must exist and be named, not be an inline condition");

  // First line of invitePending, before the once-a-day rule: an unconfigured
  // invitation is not pending, it does not exist.
  const pending = APP.match(/function invitePending\(\)\s*\{[\s\S]*?\n\}/);
  assert.ok(pending, "invitePending must still be a function");
  assert.match(pending[0], /^\s*if \(!inviteConfigured\(\)\) return false;/m);
});

test("the check reads the destination out of the page, not a constant", () => {
  const fn = APP.match(/function inviteConfigured\(\)\s*\{[\s\S]*?\n\}/)[0];
  assert.match(fn, /sheetCta/, "the page is the configuration");
  assert.match(fn, /getAttribute\("href"\)/);
});

test("this page's invitation is either filled in or not, never half", () => {
  assert.ok(cta, "#sheet-cta must exist; app.js reads it");
  assert.ok(body, "#sheet-body must exist");

  const href = cta.getAttribute("href") ?? "";
  const text = (body.textContent ?? "").trim();

  if (configured(href)) {
    assert.ok(
      text.length > 0,
      `the invitation points at ${href} and says nothing. Write the sentence, ` +
        "or take the link back out - a dialog with a button and no reason is worse " +
        "than no dialog."
    );
  } else {
    assert.equal(
      text.length,
      0,
      "the invitation says something and has nowhere to send anybody. Put the " +
        'link in #sheet-cta, or clear the text: with href="#" the dialog never opens, ' +
        "so that sentence is written for nobody."
    );
  }
});
