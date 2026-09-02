#!/usr/bin/env node
// Renders a ticket to a PNG, so a layout can be judged without spending paper.
//
// Every print costs a few centimetres of a roll, and getting a margin wrong is
// exactly the sort of thing you find out by looking. This uses the Worker's own
// renderer, so what you see is what the printer would receive, bit for bit -
// the CRC it prints is the one the printer would echo back.
//
//   node tools/preview.mjs "Hello"              -> ticket.png
//   node tools/preview.mjs --ascii "Hello"      -> to the terminal
//   node tools/preview.mjs --probe 32           -> the transport test pattern
//   node tools/preview.mjs --out /tmp/x.png "Texte"
//   node tools/preview.mjs --profile mxw01 "x"  -> le ticket 58 mm, en pause
//
// With no --profile, the printer in service: the TRP 100 III since 31 August.

import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

import { renderTicket, renderProbe } from "../worker/src/render.js";
import { profileFor, CURRENT_PROFILE } from "../worker/src/profiles.js";

function crcTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
}
const CRC_TABLE = crcTable();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/**
 * 1-bit greyscale PNG.
 *
 * Two inversions, and forgetting either gives a picture that looks almost
 * right: the printer's format has bit 0 as the LEFTMOST pixel and a set bit
 * means ink, while PNG puts the leftmost pixel in bit 7 and treats 0 as black.
 */
function toPng(canvas, scale = 2) {
  const width = canvas.widthPixels * scale;
  const height = canvas.height * scale;
  const rowBytes = Math.ceil(width / 8);
  const raw = Buffer.alloc((rowBytes + 1) * height);

  for (let y = 0; y < canvas.height; y++) {
    const source = canvas.rows[y];
    const line = Buffer.alloc(rowBytes, 0xff); // start white
    for (let x = 0; x < canvas.widthPixels; x++) {
      if ((source[x >> 3] & (1 << (x & 7))) === 0) continue;
      for (let s = 0; s < scale; s++) {
        const px = x * scale + s;
        line[px >> 3] &= ~(0x80 >> (px & 7)); // ink = 0 in greyscale
      }
    }
    for (let s = 0; s < scale; s++) {
      const offset = (y * scale + s) * (rowBytes + 1);
      raw[offset] = 0; // filter: none
      line.copy(raw, offset + 1);
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 1; // bit depth
  ihdr[9] = 0; // greyscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const args = process.argv.slice(2);

// Boolean flags are named, rather than guessed at from what follows them.
//
// This used to decide by looking at the next argument: if it did not start
// with "--", it was taken as the flag's value and removed. So the usage in the
// header of this file, `preview.mjs --ascii "Hello"`, ate its own message
// and quietly previewed the default text instead - a bad failure in a tool
// whose whole job is to show exactly what will be printed.
const BOOLEAN = new Set(["--ascii"]);

const flag = (name) => {
  const i = args.indexOf(name);
  if (i === -1) return null;
  if (BOOLEAN.has(name)) {
    args.splice(i, 1);
    return true;
  }
  const value = args[i + 1];
  args.splice(i, value === undefined ? 1 : 2);
  return value ?? true;
};

const ascii = flag("--ascii") !== null;
const probe = flag("--probe");
const out = flag("--out") ?? "ticket.png";
const profile = profileFor(flag("--profile") ?? CURRENT_PROFILE);
const text = args.join(" ") || "Hello, this is a test ticket.";

const canvas = probe
  ? renderProbe(Number(probe) || 32, profile)
  : renderTicket(text, { id: 1, profile });

// Taken BEFORE the un-rotation below, because this is the checksum of the
// buffer the printer receives - which is what the header of this file promises
// and what makes it comparable with what the Worker and the machine report.
// Un-rotating first gives the checksum of a picture nobody transmits.
const crc = canvas.crc8();

// renderTicket hands back the buffer the print head receives, which on the
// MXW01 is stored pre-rotated. Undo that here: the point of a preview is to
// show the ticket the way a human will hold it, not the way the printer eats
// it. The TRP 100 III is not rotated, so there is nothing to undo.
if (profile.flip180 && !probe) canvas.rotate180();

console.log(
  `${profile.label}: ${canvas.height} lines, ` +
    `${canvas.height * profile.widthBytes} bytes, ` +
    `crc8 0x${crc.toString(16).padStart(2, "0")}`
);
console.log(
  `about ${(canvas.height / profile.dotsPerMm).toFixed(1)} mm of paper ` +
    `at ${profile.dotsPerMm.toFixed(2)} dots/mm`
);

if (ascii) {
  console.log(canvas.toAscii("#", " "));
} else {
  writeFileSync(out, toPng(canvas));
  console.log(`wrote ${out}`);
}
