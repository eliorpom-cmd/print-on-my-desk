// Drawing a ticket for a PERSON, and the two ways it has already gone wrong.
//
// The MXW01 renders pre-rotated, because its head is mounted upside down. That
// is correct for the print head and wrong for eyes, and undoing it used to be
// a line you had to remember in every place that drew a ticket. Two places out
// of three forgot, and neither author could see it, because both were written
// while the page previewed the TRP 100 III - a profile with no rotation at all.
//
// So: one door (web/ticket.js), and these tests on it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

import { renderTicket } from "../src/render.js";
import { PROFILES } from "../src/profiles.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WEB = join(ROOT, "web");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

const { PROFILE, renderForScreen } = await import(
  new URL("../../web/ticket.js", import.meta.url)
);

const TICKET = { id: 1, createdAt: 0 };

test("a rotated profile comes back the right way up", () => {
  const mxw01 = PROFILES.mxw01;
  assert.equal(mxw01.flip180, true, "this test is about a rotated profile");

  const forEyes = renderForScreen("Bonjour", { ...TICKET, profile: mxw01 });
  const forHead = renderTicket("Bonjour", { ...TICKET, profile: mxw01 });

  // Not "they differ" - that would pass if renderForScreen returned anything
  // at all. They must be each other's 180-degree turn, exactly.
  assert.notEqual(forEyes.crc8(), forHead.crc8(), "nothing was undone");
  forHead.rotate180();
  assert.equal(forEyes.crc8(), forHead.crc8(), "not the same picture turned over");
  assert.equal(forEyes.height, forHead.height);
});

test("an unrotated profile is left alone", () => {
  const trp100 = PROFILES.trp100;
  assert.equal(trp100.flip180, false, "this test is about an unrotated profile");
  const forEyes = renderForScreen("Bonjour", { ...TICKET, profile: trp100 });
  const forHead = renderTicket("Bonjour", { ...TICKET, profile: trp100 });
  assert.equal(forEyes.crc8(), forHead.crc8(), "an unrotated ticket was turned over");
});

test("the page previews the printer the bridge asks the Worker for", () => {
  // The one that shipped: the page rendered trp100 while bridge.js claimed
  // mxw01, so the preview was eight columns wider than the paper. Read out of
  // bridge.js rather than restated, because a copy of the answer here would
  // agree with itself forever.
  const declared = read("web/bridge/bridge.js").match(/const PROFILE = "([a-z0-9]+)"/);
  assert.ok(declared, "web/bridge/bridge.js no longer declares a PROFILE");
  assert.equal(PROFILE.id, declared[1],
    `the page previews ${PROFILE.id} and the bridge prints ${declared[1]}`);
});

test("nothing draws a ticket for a person except through ticket.js", () => {
  // A source check, and it earns its place: the failure it guards is a file
  // that renders correctly in isolation and is simply never asked the
  // question. No assertion at runtime can see a caller that took the other
  // door - it just draws something upside down for whoever loads that page.
  for (const rel of ["web/preview.js", "tools/og.html"]) {
    const src = read(rel);
    assert.ok(!/\brenderTicket\b/.test(src),
      `${rel} calls renderTicket directly; use renderForScreen from web/ticket.js`);
    assert.ok(!/\bflip180\b/.test(src),
      `${rel} has its own copy of the rotation rule; ticket.js owns it`);
    assert.match(src, /["'\/]ticket\.js["']|\/ticket\.js/,
      `${rel} draws a ticket without going through web/ticket.js`);
  }
});
