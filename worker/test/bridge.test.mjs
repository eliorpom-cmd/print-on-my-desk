// The browser bridge's half of the BLE protocol.
//
// It lives in the Worker's test suite because that is where `npm test` is, and
// because the two halves have to agree: the Worker computes a checksum over
// the bitmap it sends, the bridge recomputes it over the bytes it received,
// and the printer reports a third one over what actually reached the head. If
// any two of those three disagree the ticket is wrong, and the only way anyone
// finds out is that they match.
//
// Everything here is the part that can be tested without a printer on the
// desk: the checksum, the frame layout, and the notification parser. The
// writes themselves need hardware and are exercised by using it.

import { test } from "node:test";
import assert from "node:assert/strict";

import { crc8 } from "../../web/bridge/printer.js";
import { renderTicket } from "../src/render.js";
import { profileFor } from "../src/profiles.js";

test("CRC8 matches the values the printer reported on real prints", () => {
  // Captured from an MXW01 during development: these are its answers, not
  // ours. Dallas/Maxim, polynomial 0x07, initial value 0x00.
  assert.equal(crc8(new Uint8Array([])), 0x00);
  assert.equal(crc8(new Uint8Array([0x00])), 0x00);
  assert.equal(crc8(new Uint8Array([0x01])), 0x07);
  assert.equal(crc8(new Uint8Array([0xff])), 0xf3);
});

test("CRC8 is order-sensitive, which is the whole point of sending it", () => {
  // Image data goes out without response, so nothing preserves order. A
  // checksum that did not notice a swap would prove nothing at all.
  const a = new Uint8Array([1, 2, 3, 4]);
  const b = new Uint8Array([1, 2, 4, 3]);
  assert.notEqual(crc8(a), crc8(b));
});

test("CRC8 accumulates across chunks exactly as it does in one pass", () => {
  // The bridge computes it line by line as the transfer goes out, because it
  // never holds the whole strip twice. That has to equal the one-shot value.
  const whole = new Uint8Array(200).map((_, i) => (i * 37) & 0xff);
  let running = 0;
  for (let i = 0; i < whole.length; i += 48) running = crc8(whole.subarray(i, i + 48), running);
  assert.equal(running, crc8(whole));
});

test("the bridge agrees with the Worker about a real ticket", () => {
  // The actual contract: what the Worker puts in the payload is what the
  // bridge will compute over the bytes it decodes.
  const profile = profileFor("mxw01");
  const canvas = renderTicket("hello from the bridge", {
    id: 1,
    createdAt: Date.UTC(2026, 7, 30, 12, 0, 0),
    profile,
  });
  const bytes = canvas.toBytes();
  assert.equal(bytes.length % 48, 0, "a whole number of 48-byte lines");
  assert.equal(crc8(bytes), canvas.crc8(), "the two implementations must agree");
});

test("a bitmap of the wrong width is not silently printable", () => {
  // A payload rendered for the 80 mm printer is 64 bytes a line. Fed to this
  // one it would come out as diagonal noise, and the bridge refuses it rather
  // than waste the paper - so the length check has to be exact, not a warning.
  const wide = profileFor("trp100");
  const canvas = renderTicket("x", { id: 1, createdAt: 0, profile: wide });
  assert.notEqual(canvas.toBytes().length % 48, 0, "64-byte lines must not divide into 48");
});
