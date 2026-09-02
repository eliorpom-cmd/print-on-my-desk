#!/usr/bin/env node
// Renders the social card from tools/og.html to web/og.png.
//
//   node tools/og_image.mjs
//
// Run it by hand when the card changes, and RUN IT AGAIN IF YOU CHANGE THE
// TICKET FONT: the strip on the card is drawn by web/lib, the same renderer
// the Worker uses, so the card carries whichever atlas is currently built. It
// prints the font name at the end so you can see which one you got.
//
// The output is committed, because a social card that has to be built is a
// social card that is missing the first time somebody shares a fresh deploy.
//
// It needs Chrome. If you do not have it, set CHROME to any Chromium binary,
// or delete the og:image line from web/index.html - a missing card is tidier
// than a broken one.

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { extname, join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = resolve(import.meta.dirname, "..");
const WEB = join(ROOT, "web");
const PORT = 8907;
const CHROME =
  process.env.CHROME ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const TYPES = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",   // the card imports web/lib as ES modules
  ".json": "application/json",
  ".svg": "image/svg+xml",
};

// The page is served rather than opened from disk: ES modules do not load over
// file://, and the card would render with an empty strip and no error.
const server = createServer(async (req, res) => {
  const path = new URL(req.url, "http://localhost").pathname;
  const file = path === "/" ? join(ROOT, "tools/og.html") : join(WEB, path);
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      "content-type": TYPES[extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});

await new Promise((ready) => server.listen(PORT, ready));

const out = join(WEB, "og.png");
await run(CHROME, [
  "--headless",
  "--disable-gpu",
  "--hide-scrollbars",
  "--window-size=1200,630",
  `--screenshot=${out}`,
  "--virtual-time-budget=8000",
  `http://127.0.0.1:${PORT}/`,
]).catch(() => {
  // Chrome writes the file and then exits non-zero often enough that its
  // status is not worth trusting; the check below is the real one.
});

server.close();

const { default: ATLAS } = await import(join(WEB, "lib/font-atlas.js"));
const { size } = await stat(out);
console.log(`web/og.png  1200x630  ${Math.round(size / 1024)} KB  ·  ${ATLAS.name}`);
