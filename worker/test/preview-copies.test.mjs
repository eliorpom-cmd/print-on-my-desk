// web/lib must be the Worker's own renderer, byte for byte.
//
// The page draws the ticket with the same code the print head will consume, so
// that what somebody watches on screen IS what comes out. That guarantee is
// held up by a copy - tools/sync_web.mjs writes worker/src/*.js into web/lib -
// and a copy drifts SILENTLY: both sides go on working, the preview simply
// stops being the truth.
//
// It had drifted by one comment block when this test was written, which is
// harmless and is exactly the point: nothing anywhere would have said so, and
// the next drift is not guaranteed to be a comment.
//
// A test rather than a CI step, because it has to run in both repositories and
// in front of whoever is editing the renderer, not only on a server.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const LIB = fileURLToPath(new URL("../../web/lib/", import.meta.url));

/** Every .js under web/lib, including the font atlases in their subdirectory. */
function copies(dir, base = "") {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const rel = base ? `${base}/${entry}` : entry;
    if (statSync(full).isDirectory()) out.push(...copies(full, rel));
    else if (entry.endsWith(".js")) out.push(rel);
  }
  return out;
}

test("every module in web/lib is its source, unedited", () => {
  assert.ok(existsSync(LIB), "web/lib is missing; run node tools/sync_web.mjs");
  const found = copies(LIB);
  assert.ok(found.length >= 6, `only ${found.length} copies found`);

  const stale = [];
  for (const rel of found) {
    const source = join(SRC, rel);
    assert.ok(existsSync(source), `web/lib/${rel} has no source in worker/src`);

    // The first two lines are the banner sync_web.mjs writes; the rest must be
    // the source exactly.
    const copy = readFileSync(join(LIB, rel), "utf8").split("\n");
    const banner = copy.slice(0, 2).join("\n");
    assert.match(banner, /COPIED from worker\/src/, `web/lib/${rel}: no banner`);

    if (copy.slice(2).join("\n") !== readFileSync(source, "utf8")) stale.push(rel);
  }

  assert.deepEqual(
    stale,
    [],
    `stale: ${stale.join(", ")}\nRun: node tools/sync_web.mjs`
  );
});

test("nothing in worker/src that the preview needs is missing from web/lib", () => {
  // The other direction, and the one that bites when a feature is added: the
  // renderer grows an import, the module never gets copied, and the preview
  // fails to load in the browser with a 404 nobody sees in a test.
  const needed = new Set();
  const seen = new Set();
  const queue = ["render.js"];

  while (queue.length) {
    const name = queue.pop();
    if (seen.has(name)) continue;
    seen.add(name);
    const path = join(SRC, name);
    if (!existsSync(path)) continue;
    needed.add(name);
    const text = readFileSync(path, "utf8");
    for (const m of text.matchAll(/from\s+"\.\/([^"]+)"/g)) queue.push(m[1]);
  }

  const missing = [...needed].filter((name) => !existsSync(join(LIB, name)));
  assert.deepEqual(
    missing,
    [],
    `the preview imports these and web/lib does not have them: ${missing.join(", ")}`
  );
});
