// The two halves of setup.mjs that can be checked without a Cloudflare account.
//
// Everything else in that script is one wrangler call after another, and a
// test of those would be a test of a mock. What is here instead is the part
// that reads and EDITS somebody's wrangler.jsonc - the part where a mistake is
// silent, lands in a file full of comments people rely on, and is discovered
// four steps later as an error about an invalid uuid.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { stripJsonc, withDatabaseId } from "../setup.mjs";

const WORKER = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = readFileSync(join(WORKER, "wrangler.jsonc"), "utf8");

// The point of the whole exercise: the config this repository ships must be
// readable by the script that fills it in. If somebody adds a comment shape
// the stripper cannot handle, this fails here rather than on a stranger's
// first evening.
test("the shipped wrangler.jsonc parses, comments and all", () => {
  const config = JSON.parse(stripJsonc(CONFIG));
  assert.equal(config.name, "print-on-my-desk");
  const db = config.d1_databases.find((e) => e.binding === "DB");
  assert.ok(db, "the DB binding is what src/index.js asks Cloudflare for");
  assert.equal(db.database_name, "printer");
});

test("a comment cannot hide inside a string, and a string cannot hide a comment", () => {
  const text = `{
    // a real comment
    "url": "https://example.com/a//b",   // and a trailing one
    /* and a
       block one, with "quotes" in it */
    "kept": true,
  }`;
  const parsed = JSON.parse(stripJsonc(text));
  assert.equal(parsed.url, "https://example.com/a//b");
  assert.equal(parsed.kept, true);
});

test("an escaped quote does not end the string it is in", () => {
  const parsed = JSON.parse(stripJsonc('{"a": "say \\"//\\" here", "b": 1}'));
  assert.equal(parsed.a, 'say "//" here');
  assert.equal(parsed.b, 1);
});

// --- writing the id back ---------------------------------------------------

const ID = "8f3c1a44-0000-4000-8000-000000009b2e";

test("the placeholder is replaced and every comment survives", () => {
  const out = withDatabaseId(CONFIG, "PASTE_YOUR_DATABASE_ID_HERE", ID);
  assert.ok(out.includes(`"database_id": "${ID}"`));
  assert.ok(!out.includes("PASTE_YOUR_DATABASE_ID_HERE"));
  // The file is mostly explanation, and a rewrite that reformats it would take
  // that away without anybody noticing.
  const comments = (s) => (s.match(/^\s*\/\//gm) ?? []).length;
  assert.equal(comments(out), comments(CONFIG));
  assert.equal(out.split("\n").length, CONFIG.split("\n").length);
  // And it is still a config.
  const config = JSON.parse(stripJsonc(out));
  assert.equal(config.d1_databases.find((e) => e.binding === "DB").database_id, ID);
});

test("a value spaced differently is still found", () => {
  const text = '{ "database_id"  :   "PASTE_YOUR_DATABASE_ID_HERE" }';
  const out = withDatabaseId(text, "PASTE_YOUR_DATABASE_ID_HERE", ID);
  assert.equal(JSON.parse(out).database_id, ID);
});

// A value that is not there is the caller's cue to stop and say so rather than
// write a second entry or a broken file. setup.mjs compares the result with
// what it passed in for exactly this.
test("nothing changes when the old value is not in the file", () => {
  const out = withDatabaseId(CONFIG, "something-that-is-not-in-there", ID);
  assert.equal(out, CONFIG);
});
