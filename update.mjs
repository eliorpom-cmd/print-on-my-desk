#!/usr/bin/env node
//
// Bring a working copy up to date with upstream, and put it back online.
//
//   node update.mjs           fetch, show what is new, apply it, deploy
//   node update.mjs --check   say what is new and change nothing
//
// WHY A SCRIPT, when it is four commands
//
// Because it is four commands in a fixed order, two of which are easy to
// forget and only one of which fails loudly when you do. Skipping `npm
// install` after a release that added a dependency fails at deploy with a
// module-not-found error naming a package nobody has heard of. Skipping
// `npm run db:remote` after a release that added a column does not fail at
// all: the Worker deploys, serves, and then throws on the one path that reads
// the new column, hours later, at somebody else's expense.
//
// And because of what stands between a fix and the person who needs it. This
// repository is not a dependency, it is a thing people EDIT - their wording,
// their word list, their config - so updating is a merge, and a merge is where
// somebody who is not a git user stops. So this refuses to start one it cannot
// finish, and says what to type instead.
//
// WHAT IT WILL NOT DO
//
// Touch anything that is not committed. If there are uncommitted edits it
// stops and asks for a commit first - not because git could not stash them,
// but because a script that moves somebody's unsaved work somewhere they did
// not ask for it is a script that eventually loses it.

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = join(HERE, "worker");
const WRANGLER = join(WORKER, "node_modules", "wrangler", "bin", "wrangler.js");

const say = (...m) => console.log(...m);
const step = (m) => console.log(`\n${m}`);

/** Stop with something to do, not a stack trace. Same shape as setup.mjs. */
function stop(what, ...how) {
  console.error(`\n${what}\n`);
  for (const line of how) console.error(line ? `  ${line}` : "");
  console.error("");
  process.exit(1);
}

/** git, read-only, captured. Never the thing that changes the working copy. */
function git(...args) {
  const out = spawnSync("git", args, { cwd: HERE, encoding: "utf8" });
  return { code: out.status, out: (out.stdout ?? "").trim(), err: (out.stderr ?? "").trim() };
}

/**
 * Anything else, shown as it runs.
 *
 * `shell` on Windows only, and only because `npm` there is a batch script that
 * PATH cannot execute directly - the same fact that makes the first command in
 * the quick start fail on a fresh PowerShell. git and node are real binaries
 * and are spawned as themselves everywhere.
 */
function run(cmd, args, { cwd = HERE } = {}) {
  return new Promise((done) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: "inherit",
      shell: process.platform === "win32" && cmd === "npm",
    });
    child.on("close", (code) => done(code));
    child.on("error", () => done(-1));
  });
}

async function main() {
  const checkOnly = process.argv.includes("--check");

  // --- is this a clone at all -----------------------------------------------

  if (git("rev-parse", "--is-inside-work-tree").code !== 0) {
    stop(
      "This is not a git clone, so there is nothing to update from.",
      "You most likely downloaded the ZIP. Two ways out, and the first is",
      "worth the five minutes:",
      "",
      "  1. Clone it properly, once, and every future update is this script:",
      "",
      "     git clone https://github.com/eliorpom-cmd/print-on-my-desk.git",
      "",
      "     then copy your own edits across - your wording in web/index.html,",
      "     your word list in worker/src/terms.js, and the database id in",
      "     worker/wrangler.jsonc. Your secrets are on Cloudflare already and",
      "     do not need to move.",
      "",
      "  2. Or download the ZIP again and copy those same three things across.",
      "     That is the whole update, and you do it by hand every time."
    );
  }

  const branch = git("rev-parse", "--abbrev-ref", "HEAD").out;
  const upstream = git("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}");
  if (upstream.code !== 0) {
    stop(
      `Your branch "${branch}" is not following anything upstream.`,
      "Nothing can be fetched into it. If you cloned this repository and then",
      "made your own branch, point it at the original:",
      "",
      `  git branch --set-upstream-to=origin/main ${branch}`
    );
  }

  // --- what is new ----------------------------------------------------------

  step("Looking for changes...");
  if ((await run("git", ["fetch", "--quiet"])) !== 0) {
    stop(
      "Could not reach the repository.",
      "That is usually the network. If you cloned a private fork, it can also",
      "be a sign-in that has expired. `git fetch` on its own will say which."
    );
  }

  const behind = git("rev-list", "--count", `HEAD..${upstream.out}`).out;
  const ahead = git("rev-list", "--count", `${upstream.out}..HEAD`).out;

  if (behind === "0") {
    say(`  Already up to date with ${upstream.out}.`);
    if (ahead !== "0") {
      say(`  You have ${ahead} commit(s) of your own that are not pushed anywhere.`);
    }
    return;
  }

  say(`  ${behind} change(s) waiting:\n`);
  // git() trims, which would eat the indent of the first line only.
  say("  " + git("log", "--reverse", "--pretty=format:  %h  %s", `HEAD..${upstream.out}`).out);

  if (checkOnly) {
    say("\n  --check, so nothing was changed. Run `node update.mjs` to apply them.");
    return;
  }

  // --- refuse to start a merge that cannot finish ---------------------------

  const dirty = git("status", "--porcelain").out;
  if (dirty) {
    stop(
      "You have edits that are not committed, and updating would have to move them.",
      "Commit them first - they are yours, and this repository is meant to be",
      "edited, so having your own commits in it is normal:",
      "",
      '  git add -A && git commit -m "my changes"',
      "",
      "Then run this again. If git then reports a CONFLICT, it means the same",
      "lines changed on both sides; `git status` names the files, and the parts",
      "marked <<<<<<< are yours to choose between.",
      "",
      "What you have edited:",
      "",
      ...dirty.split("\n").slice(0, 20).map((line) => line.trim())
    );
  }

  // --- apply ---------------------------------------------------------------

  step("Applying them...");
  if ((await run("git", ["merge", "--ff-only", upstream.out])) !== 0) {
    say("");
    stop(
      "Your copy and the update have both moved, so this is a real merge.",
      "It is not hard, but it is not something to do blind:",
      "",
      `  git merge ${upstream.out}`,
      "",
      "If it reports a conflict, `git status` lists the files. Open each one,",
      "look for the <<<<<<< markers, keep the version you want, then:",
      "",
      "  git add -A && git commit",
      "",
      "Then run this again to install, test and deploy."
    );
  }

  step("Installing what it needs...");
  if ((await run("npm", ["install"], { cwd: WORKER })) !== 0) {
    stop("npm install failed. Nothing has been deployed; your site is still running the old version.");
  }

  // --- prove it works before it goes out ------------------------------------

  step("Checking it still works...");
  if ((await run("npm", ["test"], { cwd: WORKER })) !== 0) {
    stop(
      "The tests do not pass on this update, so nothing was deployed.",
      "Your site is untouched and still running the version it was.",
      "",
      "This is worth reporting - a failing test on a fresh update is a bug in",
      "the update, not in your copy:",
      "",
      "  https://github.com/eliorpom-cmd/print-on-my-desk/issues"
    );
  }

  // --- the database, then the deploy ---------------------------------------
  //
  // In this order, and never the other way round. schema.sql is idempotent by
  // design - every statement is CREATE IF NOT EXISTS or INSERT OR IGNORE - so
  // running it against an up-to-date database costs a few reads and changes
  // nothing. Running it AFTER the deploy would leave a window, however short,
  // where the new code queries a column that does not exist yet.

  step("Bringing the database up to date...");
  if (!existsSync(WRANGLER)) {
    stop("wrangler is missing from worker/node_modules.", "Run `npm install` in worker/ and try again.");
  }
  const d1 = await run(process.execPath, [
    WRANGLER, "d1", "execute", "printer", "--remote", "--yes", "--file=schema.sql",
  ], { cwd: WORKER });
  if (d1 !== 0) {
    stop(
      "The database step failed, so nothing was deployed.",
      "Your site is still running the version it was. If this says anything",
      "about an invalid uuid, wrangler.jsonc has lost its database id - see",
      "docs/01-quick-start.md step 3."
    );
  }

  step("Deploying...");
  if ((await run(process.execPath, [WRANGLER, "deploy"], { cwd: WORKER })) !== 0) {
    stop("The deploy failed. The database is up to date; the code is not.");
  }

  say(`
Updated and live.

Two things this does NOT touch, and does not need to:

  Your secrets. They live on Cloudflare, not in these files.
  Your printer end. The browser bridge picks up the new version when you
  reload its tab; an always-on agent needs a restart to take agent/ changes:

    sudo systemctl restart printer-agent
`);
}

main();
