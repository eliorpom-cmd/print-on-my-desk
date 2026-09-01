// Does the Worker load at all?
//
// This exists because of a bug that 273 green tests did not see. A comment
// marker was put around a function in notify.js and took the function with it;
// exactly one module imported it, nothing tested it, and the whole script
// stopped building. The only symptom was `wrangler dev` refusing to start,
// which no test had ever asked it to do.
//
// A suite that never loads the program does not test that the program loads.
// So this one imports the entry point and everything under it, which is the
// cheapest possible version of "does it start".
//
// It is not a substitute for running it. It cannot see a route that throws or
// a binding that is missing. What it catches is the whole class of failure
// where the module graph is broken - a deleted export, a renamed file, a typo
// in an import path - and that class costs a deploy every time.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

test("the entry point loads, with its whole module graph behind it", async () => {
  const worker = await import("../src/index.js");
  assert.equal(typeof worker.default, "object", "a Worker exports a default object");
  assert.equal(typeof worker.default.fetch, "function", "and it must answer requests");
  assert.equal(typeof worker.default.scheduled, "function", "and run its cron");
});

test("every module in src/ loads on its own", async () => {
  // Not just the ones the entry point happens to reach today. A module that
  // only the cron imports, or only a test, breaks just as loudly the moment
  // something needs it - and by then nobody is looking at this file.
  const dir = fileURLToPath(new URL("../src/", import.meta.url));
  const files = readdirSync(dir, { withFileTypes: true });

  for (const entry of files) {
    if (entry.isDirectory()) {
      for (const name of readdirSync(new URL(`${entry.name}/`, new URL("../src/", import.meta.url)))) {
        if (name.endsWith(".js")) await import(`../src/${entry.name}/${name}`);
      }
      continue;
    }
    if (!entry.name.endsWith(".js")) continue;
    await import(`../src/${entry.name}`);
  }
});

test("the entry point answers a request without a database", async () => {
  // A 500 is a fine answer here. A thrown exception before the handler runs is
  // not, and that is the difference this catches: routing, header hardening
  // and the JSON helpers all run before anything touches D1.
  const worker = await import("../src/index.js");
  const response = await worker.default.fetch(
    new Request("https://example.test/api/nothing-here"),
    {},
    { waitUntil() {}, passThroughOnException() {} }
  );
  assert.ok(response instanceof Response);
  assert.ok(response.status >= 400, `expected a refusal, got ${response.status}`);
  assert.ok(
    response.headers.get("content-security-policy"),
    "and the security headers are added by the same wrapper that routes"
  );
});
