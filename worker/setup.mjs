#!/usr/bin/env node
//
// The set-up step, done for you.
//
//   node setup.mjs            from inside worker/
//   node setup.mjs --new      again, replacing tokens you already have
//
// It does four things, in this order, and stops at the first one that cannot
// be done rather than carrying on:
//
//   1. checks that wrangler.jsonc knows your database id, and fills it in
//      from your Cloudflare account if it does not
//   2. invents three secrets that look like secrets
//   3. uploads them to your Worker, creating the Worker if it does not exist
//   4. writes the two you will need again into my-tokens.txt, and opens it
//
// WHY THIS EXISTS AT ALL, when the three wrangler commands are in the guide.
//
// Every one of those steps was a place somebody stopped. `openssl` is not a
// command on Windows, so the first instruction in the old step 3 failed before
// anything else could. `wrangler secret put` asks you to paste a value, which
// means holding three long strings somewhere while you do it, which means
// people held them nowhere. And the database id has to be copied by hand from
// the output of one command into a file, which is the single most-skipped line
// in the whole guide - it fails four steps later, with an error about an
// invalid uuid that names neither the file nor the line.
//
// So: no openssl, no pasting, no copying an id across, and the tokens end up
// in a file you can find again instead of in a terminal you will close.
//
// It is written to be read. If you would rather do it by hand, docs/01 still
// has every command it runs.

import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { platform } from "node:process";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG = join(HERE, "wrangler.jsonc");
const TOKENS = join(HERE, "my-tokens.txt");

// The secrets this project needs to run. ALTCHA_HMAC_KEY, ACCESS_KEY and the
// notification ones are all optional and all off by default - see
// docs/07-operating.md. Nothing here invents a secret you have not been told
// about.
const SECRETS = ["PRINTER_TOKEN", "ADMIN_TOKEN", "IP_SALT"];

const PLACEHOLDER = "PASTE_YOUR_DATABASE_ID_HERE";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const say = (...m) => console.log(...m);
const step = (n, m) => console.log(`\n[${n}/4] ${m}`);

/** Stop, with something the reader can act on rather than a stack trace. */
function stop(what, ...how) {
  console.error(`\n${what}\n`);
  // Indented, except the blank ones: trailing spaces on an empty line look
  // like something went wrong when they land in somebody's terminal.
  for (const line of how) console.error(line ? `  ${line}` : "");
  console.error("");
  process.exit(1);
}

// --- reading the config ----------------------------------------------------

/**
 * wrangler.jsonc is JSON with comments, and the comments are half of what that
 * file is for. So it is parsed here rather than JSON.parse'd directly, and the
 * ORIGINAL TEXT is what gets edited later: rewriting the file from the parsed
 * object would throw away every comment in it.
 */
export function stripJsonc(text) {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inLine) {
      if (c === "\n") { inLine = false; out += c; }
      continue;
    }
    if (inBlock) {
      if (c === "*" && next === "/") { inBlock = false; i++; }
      continue;
    }
    if (inString) {
      out += c;
      if (c === "\\") { out += text[++i] ?? ""; continue; }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === "/" && next === "/") { inLine = true; i++; continue; }
    if (c === "/" && next === "*") { inBlock = true; i++; continue; }
    out += c;
  }
  // A trailing comma is legal in JSONC and not in JSON.
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/**
 * The database id, written into the config text rather than into the parsed
 * object.
 *
 * Rewriting the file from JSON.stringify would produce a valid config and
 * throw away every comment in it - and this file's comments are the only
 * documentation of what account_id is for and why secrets do not go here.
 * So the edit is made on the one line that carries the old value.
 */
export function withDatabaseId(text, currentId, newId) {
  const exact = `"database_id": "${currentId}"`;
  if (text.includes(exact)) return text.replace(exact, `"database_id": "${newId}"`);
  // Same line, spaced differently by whoever last edited it.
  const escaped = currentId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(
    new RegExp(`"database_id"\\s*:\\s*"${escaped}"`),
    `"database_id": "${newId}"`
  );
}

function readConfig() {
  if (!existsSync(CONFIG)) {
    stop(
      "No wrangler.jsonc here.",
      "This script has to run from inside the worker/ directory:",
      "",
      "  cd worker",
      "  node setup.mjs"
    );
  }
  const text = readFileSync(CONFIG, "utf8");
  try {
    return { text, config: JSON.parse(stripJsonc(text)) };
  } catch (err) {
    stop(
      `wrangler.jsonc is not valid: ${err.message}`,
      "Something has been edited into it by hand. Open it and look for a",
      "missing comma or a missing quote, or take a fresh copy from the repository."
    );
  }
}

// --- running wrangler ------------------------------------------------------

/**
 * The local wrangler, run by this same Node, rather than `npx wrangler`.
 *
 * Two reasons, and the second one is the whole point of this file. `npx` picks
 * a version at run time and this repository has one pinned. And on Windows the
 * thing PATH finds for `npx` is a PowerShell script, which the default
 * execution policy refuses to run - the error names npm.ps1 and mentions
 * nothing about this project, and it is where a Windows install stops dead.
 * `node node_modules/wrangler/bin/wrangler.js` is neither.
 */
const WRANGLER = join(HERE, "node_modules", "wrangler", "bin", "wrangler.js");

function requireWrangler() {
  if (!existsSync(WRANGLER)) {
    stop(
      "wrangler is not installed here.",
      "Run this first, in this directory:",
      "",
      "  npm install"
    );
  }
}

/**
 * Run wrangler and hand back what it said.
 *
 * `input` is written to its stdin and the stream is closed. That is not a
 * detail: `wrangler secret put` reads the secret from stdin whenever stdin is
 * not a terminal, which is what lets this script set a value nobody has to
 * paste. It also means wrangler treats itself as non-interactive, so the
 * "there is no Worker with that name, create one?" question answers itself
 * with yes instead of waiting for a keypress.
 *
 * stderr is both shown and captured: shown because wrangler's own errors are
 * better than anything this script could write, captured because two of them
 * have a cure worth naming.
 */
function wrangler(args, { input = null, quiet = false } = {}) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [WRANGLER, ...args], {
      cwd: HERE,
      stdio: [input === null ? "inherit" : "pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => {
      out += d;
      if (!quiet) process.stdout.write(d);
    });
    child.stderr.on("data", (d) => {
      err += d;
      process.stderr.write(d);
    });
    if (input !== null) {
      child.stdin.end(input);
    }
    child.on("close", (code) => done({ code, out, err }));
  });
}

/**
 * The JSON array out of wrangler's stdout, which is not only the array.
 *
 * `--json` suppresses the banner but not a version notice, and that notice
 * contains "[WARNING]" - so the first "[" in the output is not the one that
 * matters, and taking it parses nothing. Working backwards from the last "]"
 * and stopping at the first bracket that yields an array does not care what
 * was printed before it, or how that wording changes next release.
 */
function parseJsonArray(out) {
  const end = out.lastIndexOf("]");
  if (end === -1) return null;
  for (let i = out.lastIndexOf("[", end); i !== -1; i = out.lastIndexOf("[", i - 1)) {
    try {
      const value = JSON.parse(out.slice(i, end + 1));
      if (Array.isArray(value)) return value;
    } catch {
      // An opening bracket that belongs to something else. Keep going left.
    }
  }
  return null;
}

/** The two failures worth translating, because their cure is not in the text. */
function diagnose(err) {
  const hints = [];
  if (/more than one account/i.test(err)) {
    hints.push(
      "Your Cloudflare login has more than one account, and wrangler cannot",
      "guess which. Uncomment the account_id line in wrangler.jsonc and paste",
      "in the id you want - wrangler printed the list just above."
    );
  }
  if (/not (logged in|authenticated)|wrangler login|credentials/i.test(err)) {
    hints.push(
      "You are not logged in to Cloudflare. Do that first:",
      "",
      "  npx wrangler login"
    );
  }
  return hints;
}

// --- step 1: the database id ----------------------------------------------

/**
 * The id has to get from `wrangler d1 create printer` into wrangler.jsonc, and
 * the guide used to ask you to carry it there by hand.
 *
 * Recent wrangler offers to write it for you - and then asks what to call the
 * binding, defaulting to the database's name. Accepting that default is the
 * trap: the code asks for `env.DB`, so a binding called `printer` is added
 * ALONGSIDE the DB one, the DB one keeps its placeholder, and the failure
 * arrives at the next step as "Invalid uuid" about a database nobody named.
 *
 * So this does not trust the config: it reads the id back out of your account.
 */
async function ensureDatabaseId() {
  const { text, config } = readConfig();
  const entries = config.d1_databases ?? [];
  const main = entries.find((e) => e.binding === "DB");

  if (!main) {
    stop(
      "wrangler.jsonc has no d1_databases entry with the binding DB.",
      "The Worker asks Cloudflare for a binding called DB by that exact name.",
      "Restore the entry from the repository, or add:",
      "",
      '  { "binding": "DB", "database_name": "printer", "database_id": "..." }'
    );
  }

  const strays = entries.filter((e) => e !== main);
  const name = main.database_name || "printer";

  if (UUID.test(main.database_id)) {
    say(`  wrangler.jsonc already points at a database (${main.database_id}).`);
  } else {
    say(`  No database id in wrangler.jsonc yet. Asking Cloudflare for one...`);
    const { code, out, err } = await wrangler(["d1", "list", "--json"], { quiet: true });
    if (code !== 0) {
      stop("Could not list your databases.", ...diagnose(err));
    }
    const dbs = parseJsonArray(out);
    if (!dbs) {
      stop(
        "Could not read the list of databases wrangler printed.",
        "Run `npx wrangler d1 list` yourself and paste the id of your database",
        "into wrangler.jsonc, replacing " + PLACEHOLDER + "."
      );
    }
    const found = dbs.filter((d) => d.name === name);
    if (found.length === 0) {
      stop(
        `You have no database called "${name}".`,
        "Create it first - it takes a few seconds:",
        "",
        `  npx wrangler d1 create ${name}`,
        "",
        "Then run this again. Answering its questions is optional; this script",
        "reads the id from your account either way."
      );
    }
    if (found.length > 1) {
      stop(
        `You have ${found.length} databases called "${name}", so this cannot choose.`,
        "Delete the ones you do not want in the Cloudflare dashboard, or paste",
        "the right id into wrangler.jsonc by hand. They are:",
        "",
        ...found.map((d) => `${d.uuid}  created ${d.created_at ?? "?"}`)
      );
    }

    const id = found[0].uuid;
    const updated = withDatabaseId(text, main.database_id, id);
    if (updated === text) {
      stop(
        "Could not find the database_id line to edit in wrangler.jsonc.",
        `Open it and set the DB entry's database_id to:`,
        "",
        `  ${id}`
      );
    }
    writeFileSync(CONFIG, updated);
    say(`  Wrote the id of "${name}" into wrangler.jsonc: ${id}`);
  }

  if (strays.length) {
    say("");
    say("  One thing to fix by hand, and it is not fatal:");
    for (const s of strays) {
      say(`    wrangler.jsonc has a second database binding, "${s.binding}".`);
    }
    say("    It was almost certainly added by `wrangler d1 create` offering to");
    say('    edit the file: the binding name it suggests is the database\'s name,');
    say("    and the answer here is DB. Nothing reads the extra one. Delete its");
    say("    four lines from d1_databases when you have a moment.");
  }
}

// --- step 2 and 3: the secrets ---------------------------------------------

/**
 * 32 bytes from the system's CSPRNG, in the alphabet that survives being
 * pasted anywhere.
 *
 * base64url rather than base64: the same 256 bits, but no "+", "/" or "="
 * to be mangled by a URL, a shell, or a chat window on the way to whatever is
 * driving your printer.
 */
const makeSecret = () => randomBytes(32).toString("base64url");

async function uploadSecrets(values) {
  let first = true;
  for (const name of SECRETS) {
    say(`  ${name}...`);
    const { code, err } = await wrangler(["secret", "put", name], {
      input: values[name],
      quiet: true,
    });
    if (code !== 0) {
      stop(
        `Could not set ${name}.`,
        ...diagnose(err),
        ...(first
          ? [
              "",
              "Nothing was uploaded, so nothing is half-done: fix the above and",
              "run this again.",
            ]
          : [
              "",
              `Some secrets were set before this one. Running this again is safe;`,
              "it replaces all three.",
            ])
      );
    }
    first = false;
  }
}

// --- step 4: the file you keep --------------------------------------------

function writeTokensFile(values, workerName) {
  const now = new Date().toISOString().slice(0, 10);
  const body = `Your tokens for ${workerName}
${"=".repeat(16 + workerName.length)}

Written by worker/setup.mjs on ${now}.

KEEP THIS FILE. These two are not recoverable: Cloudflare stores them for the
Worker but will not show them to you again, and nothing else has a copy.

git ignores this file. Do not commit it, do not paste it into an issue, and do
not put it anywhere a link would reach.


ADMIN_TOKEN
  ${values.ADMIN_TOKEN}

  Gets you into your admin page, at /admin. It is the only thing between a
  stranger and every message anybody has sent you.


PRINTER_TOKEN
  ${values.PRINTER_TOKEN}

  What your printer end - the browser bridge, the always-on agent, or the
  microcontroller - uses to take messages out of the queue. You paste it once,
  wherever that end lives.


IP_SALT is set too, and is deliberately NOT written here. Nothing ever needs to
read it back: it scrambles addresses for the rate limiter so the database never
holds anybody's actual IP. Replacing it costs you nothing but the rate-limit
counters that are open at that moment.


IF YOU LOSE THESE

Nobody can recover them, but you can replace them, and it takes a minute:

  npx wrangler secret put ADMIN_TOKEN
  npx wrangler secret put PRINTER_TOKEN

or, without a terminal, in the Cloudflare dashboard under
Workers & Pages -> ${workerName} -> Settings -> Variables and Secrets.

A replaced PRINTER_TOKEN has to be pasted into your printer end again; until
you do, it will say the token was refused.
`;
  writeFileSync(TOKENS, body);
  try {
    // Best effort: on a shared machine, do not leave it world-readable. Windows
    // ignores this, which is why it is not load-bearing anywhere.
    chmodSync(TOKENS, 0o600);
  } catch {
    // A filesystem that has no opinion about permissions is not a failure.
  }
}

/**
 * Open the file in whatever the machine uses for text.
 *
 * Best effort on purpose: this is a convenience, and a machine with no desktop
 * - a Raspberry Pi over ssh, a container - should not have the set-up fail
 * because nothing could be opened. The path is printed either way.
 */
function openFile(path) {
  const [cmd, args] =
    platform === "darwin"
      ? ["open", [path]]
      : platform === "win32"
        ? [process.env.COMSPEC || "cmd.exe", ["/c", "start", "", path]]
        : ["xdg-open", [path]];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // Printed below regardless.
  }
}

// --- the whole thing -------------------------------------------------------

async function main() {
  const rotate = process.argv.includes("--new");

  say("Setting up your Worker.\n");
  requireWrangler();

  if (existsSync(TOKENS) && !rotate) {
    stop(
      "You already have my-tokens.txt, so this has been run before.",
      "Running it again would replace all three secrets, and whatever is",
      "driving your printer would stop working until you pasted the new",
      "PRINTER_TOKEN into it.",
      "",
      "If that is what you want:",
      "",
      "  node setup.mjs --new",
      "",
      `Your existing tokens are in ${TOKENS}`
    );
  }

  step(1, "Checking the database");
  await ensureDatabaseId();

  step(2, "Inventing three secrets");
  const values = Object.fromEntries(SECRETS.map((n) => [n, makeSecret()]));
  say("  256 bits each, from this machine's random number generator.");

  step(3, "Uploading them to Cloudflare");
  say("  This creates the Worker if it does not exist yet. It has no code on it");
  say("  until you deploy, which is the next step in the guide.\n");
  await uploadSecrets(values);

  const { config } = readConfig();
  const workerName = config.name || "your Worker";

  step(4, "Writing them down");
  writeTokensFile(values, workerName);
  say(`  ${TOKENS}`);
  openFile(TOKENS);

  say(`
Done. Three secrets set, and the two you need again are in that file.

Next, from this directory, one at a time:

  npm run db:remote     create the tables
  npm run deploy        put it online
`);
}

// Imported by test/setup.test.mjs, which holds the two pieces above that can
// be checked without a Cloudflare account. Only a direct run does anything.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
