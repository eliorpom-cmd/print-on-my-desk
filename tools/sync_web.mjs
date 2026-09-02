#!/usr/bin/env node
// Copies the rendering modules into web/lib so the browser preview runs the
// exact same code as the Worker.
//
// The brief asks for a client-side preview "reusing the same font atlas so the
// preview is faithful to the ticket". Reimplementing the blitter in the page
// would satisfy the letter of that and betray its point: two implementations
// drift, and the day they drift is the day someone's message comes out
// different from what they were shown.
//
// So there is one implementation, copied rather than rewritten, and
// `--check` fails the build if a copy has fallen behind its source.
//
//   node tools/sync_web.mjs           copy
//   node tools/sync_web.mjs --check   verify, exit 1 if stale

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";

const MODULES = [
  "bitmap.js",
  "font.js",
  "render.js",
  "font-atlas.js",
  "limits.js",
  // Since 31 August the geometry is per printer, and the preview has to use
  // the same table the Worker does or it draws a ticket for a machine that is
  // no longer in the flat.
  "profiles.js",
];
const SRC = new URL("../worker/src/", import.meta.url);
const DST = new URL("../web/lib/", import.meta.url);

const banner = (name) =>
  `// COPIED from worker/src/${name} by tools/sync_web.mjs - do not edit here.\n` +
  `// The preview and the ticket must come from one implementation, not two.\n`;

const check = process.argv.includes("--check");
let stale = 0;

for (const name of MODULES) {
  const source = readFileSync(new URL(name, SRC), "utf8");
  const wanted = banner(name) + source;
  const target = new URL(name, DST);

  if (check) {
    const current = existsSync(target) ? readFileSync(target, "utf8") : "";
    const same =
      createHash("sha256").update(current).digest("hex") ===
      createHash("sha256").update(wanted).digest("hex");
    if (!same) {
      console.error(`  perime: web/lib/${name}`);
      stale++;
    }
  } else {
    writeFileSync(target, wanted);
    console.log(`  web/lib/${name}`);
  }
}

if (check) {
  if (stale) {
    console.error(`\n${stale} copie(s) perimee(s). Lancer: node tools/sync_web.mjs`);
    process.exit(1);
  }
  console.log("web/lib is up to date");
}
