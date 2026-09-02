#!/usr/bin/env node
// Dumps a rendered ticket as the raw bytes the printer receives, so a probe on
// the Pico can print the very bitmap the service would have sent.
//
// The whole point is to move the mystery margin out of the service and into a
// direct test, where a single variable can be changed at a time. Anything the
// Worker does to a ticket is done here too, by the Worker's own renderer.
//
//   node tools/dump_bitmap.mjs "Texte" --out ticket.bin
//   node tools/dump_bitmap.mjs "Texte" --roll-tail --out rolled.bin
//   node tools/dump_bitmap.mjs "Texte" --frame --out framed.bin
//   node tools/dump_bitmap.mjs "Texte" --invert --out inverted.bin
//
// --frame and --invert make the same ticket carry more ink, which is the only
// lever the renderer has over the ejection phase of docs/09-protocol.md 6.2.
// --invert is white on black, so it costs a lot of heat as well as ink.
//
// --roll-tail moves the blank lines at the end of the buffer - the ones sent
// last, and printed last - to the front. Line count, byte count and ink are
// untouched; only where the blank sits changes. That is what makes it a
// single-variable test against the plain dump.

import { writeFileSync } from "node:fs";

import { renderTicket } from "../worker/src/render.js";
import { WIDTH_BYTES, crc8 } from "../worker/src/bitmap.js";

const args = process.argv.slice(2);
let out = "ticket.bin";
let rollTail = false;
let frame = false;
let invert = false;
const words = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--out") out = args[++i];
  else if (args[i] === "--roll-tail") rollTail = true;
  else if (args[i] === "--frame") frame = true;
  else if (args[i] === "--invert") invert = true;
  else words.push(args[i]);
}
const text = words.join(" ");
if (!text) {
  console.error('usage: node tools/dump_bitmap.mjs "votre texte" [--roll-tail] [--out fichier.bin]');
  process.exit(1);
}

const isBlank = (bytes, y) => {
  for (let x = 0; x < WIDTH_BYTES; x++) if (bytes[y * WIDTH_BYTES + x]) return false;
  return true;
};

// A fixed id and date keep two runs byte-identical, which is what a
// single-variable test needs.
const canvas = renderTicket(text, { id: 173, createdAt: Date.UTC(2026, 7, 27, 12, 0) });
let bytes = canvas.toBytes();
let lines = bytes.length / WIDTH_BYTES;

let head = 0;
while (head < lines && isBlank(bytes, head)) head++;
let tail = 0;
while (tail < lines && isBlank(bytes, lines - 1 - tail)) tail++;

if (rollTail && tail) {
  const cut = (lines - tail) * WIDTH_BYTES;
  const rolled = new Uint8Array(bytes.length);
  rolled.set(bytes.subarray(cut), 0);
  rolled.set(bytes.subarray(0, cut), bytes.length - cut);
  bytes = rolled;
}

if (frame) {
  // A 4 px border, inset by 1 px so nothing sits on the very edge of the head.
  const set = (x, y) => {
    if (x < 0 || x >= WIDTH_BYTES * 8 || y < 0 || y >= lines) return;
    bytes[y * WIDTH_BYTES + (x >> 3)] |= 1 << (x & 7);
  };
  for (let t = 1; t < 5; t++) {
    for (let x = 1; x < WIDTH_BYTES * 8 - 1; x++) { set(x, t); set(x, lines - 1 - t); }
    for (let y = 1; y < lines - 1; y++) { set(t, y); set(WIDTH_BYTES * 8 - 1 - t, y); }
  }
}

if (invert) {
  for (let i = 0; i < bytes.length; i++) bytes[i] = ~bytes[i] & 0xff;
}

const ink = bytes.reduce((n, b) => n + b.toString(2).split("1").length - 1, 0);

writeFileSync(out, bytes);
console.log(`${out}: ${lines} lignes, ${bytes.length} octets, crc8 0x${crc8(bytes).toString(16).padStart(2, "0")}`);
console.log(`encre: ${ink} points, ${(100 * ink / (lines * WIDTH_BYTES * 8)).toFixed(1)} %`);
console.log(`lignes blanches en tete (imprimees en premier): ${rollTail ? head + tail : head}`);
console.log(`lignes blanches en queue (imprimees en dernier): ${rollTail ? 0 : tail}`);
