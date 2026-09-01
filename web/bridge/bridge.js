// The bridge: this tab is the printer's connection to the internet.
//
// It does what the Raspberry Pi does in the always-on setup, and what the Pico
// does in the microcontroller one - asks the Worker for a ticket, prints it,
// says whether it worked - except that it runs in a browser tab and stops when
// you close it.
//
// That last part is a feature, and it is why this exists. "It works while the
// tab is open" is a sentence anybody understands. No service files, no boot
// scripts, no wondering whether the thing is running: look at the tab.
//
// WHAT IT NEEDS
//
//   * Chrome, Edge or Opera on a desktop, or Chrome on Android. Web Bluetooth
//     is not in Safari and not on iOS.
//   * The page served over HTTPS from your own Worker, so that it and the API
//     share an origin and no CORS is involved.
//   * Your PRINTER_TOKEN, pasted in once.
//
// ABOUT THAT TOKEN
//
// It lives in this browser's localStorage, which means anybody who can use
// this computer can read it, and it grants the right to take messages out of
// your queue and mark them printed. That is fine on your own machine and not
// fine on a shared one. There is a "forget" button, and using it is the whole
// of the security model.

import { Printer, NoPaper, TooHot, KEEPALIVE_MS, WIDTH_BYTES } from "./printer.js";

const $ = (id) => document.getElementById(id);

const TOKEN_KEY = "bridge.token";
const DEVICE_KEY = "bridge.device";

// The profile to ask the Worker for. This bridge speaks to one machine - the
// MXW01, 58 mm, 384 dots - so it says so, and the Worker renders to that width
// and that rotation. See worker/src/profiles.js.
const PROFILE = "mxw01";

// How long to let the Worker hold the connection open waiting for work. The
// Pico cannot afford this - its whole cycle is ruled by a nine-minute deadline
// - but a browser tab has nothing better to do, and it turns "up to five
// seconds after somebody presses approve" into "about one".
const LONG_POLL_S = 25;

// One heartbeat a minute, so the admin page can tell a printer that is idle
// from one that is gone.
const HEARTBEAT_MS = 60_000;

// After a network failure, back off rather than hammer.
const RETRY_MS = 5_000;
const RETRY_MAX_MS = 60_000;

const printer = new Printer({ log: (what) => say(what) });

let token = "";
let deviceId = "";
let running = false;
let backoff = RETRY_MS;
let lastBeat = 0;
let lastKeepalive = 0;
let printedCount = 0;
let failedCount = 0;
let lastError = null;
let printerState = "unknown";

// --- talking to the Worker ---------------------------------------------------

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { authorization: `Bearer ${token}`, ...(options.headers ?? {}) },
  });
  if (response.status === 401) throw new Error("the token was refused");
  return response;
}

async function nextJob() {
  const query = new URLSearchParams({
    device: deviceId,
    profile: PROFILE,
    wait: String(LONG_POLL_S),
  });
  const response = await api(`/api/machine/next?${query}`);
  if (response.status === 204) return null;
  if (!response.ok) throw new Error(`the queue answered ${response.status}`);
  return await response.json();
}

async function reportDone(body) {
  const response = await api("/api/machine/done", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...body, device: deviceId }),
  });
  return await response.json().catch(() => ({}));
}

async function heartbeat() {
  const response = await api("/api/machine/heartbeat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      device: deviceId,
      profile: PROFILE,
      printer_state: printerState,
      firmware: "browser-bridge/1.0",
      last_error: lastError,
      prints_ok: printedCount,
      prints_failed: failedCount,
    }),
  });
  return await response.json().catch(() => ({}));
}

// --- printing ----------------------------------------------------------------

/** base64 -> bytes. The Worker sends the bitmap that way; nothing else here
 *  ever touches base64, so this stays small and local. */
function decode(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function printJob(job) {
  const bytes = decode(job.data);
  if (job.width_bytes !== WIDTH_BYTES) {
    // The Worker rendered for another machine. Hand it back rather than print
    // nonsense: a ticket sent to the wrong width comes out as diagonal noise.
    await reportDone({
      id: job.id,
      ids: job.ids ?? [job.id],
      ok: false,
      retry: true,
      error: `rendered ${job.width_bytes} bytes wide, this printer is ${WIDTH_BYTES}`,
    });
    return;
  }

  say(`printing #${job.id} (${job.lines} lines)`);
  try {
    const result = await printer.print(bytes, {
      intensity: job.intensity,
      feedLines: job.feed_lines,
    });
    if (result.ok) {
      printedCount++;
      lastError = null;
      say(`#${job.id} printed`);
    } else {
      failedCount++;
      lastError = `checksum ${result.reported} != ${result.expected}`;
      say(`#${job.id} came out wrong: ${lastError}`, true);
    }
    await reportDone({
      id: job.id,
      ids: job.ids ?? [job.id],
      ok: result.ok,
      crc: result.expected,
      // A transfer that died half way has already put ink on paper, so it is
      // NOT retried: a duplicate is more confusing than a miss, and a miss can
      // be asked for again.
      retry: false,
      error: result.ok ? null : lastError,
      sent_lines: result.sent,
      spans: job.spans ?? null,
    });
  } catch (err) {
    // These three sent nothing, so the message goes back in the queue with its
    // attempt refunded. A ticket must never be burned by a condition its
    // author had nothing to do with.
    const refusal = err instanceof NoPaper || err instanceof TooHot;
    failedCount++;
    lastError = err.message;
    printerState = err instanceof NoPaper ? "no_paper" : printerState;
    say(`#${job.id}: ${err.message}`, true);
    await reportDone({
      id: job.id,
      ids: job.ids ?? [job.id],
      ok: false,
      retry: refusal || printer.lastSentLines === 0,
      error: err.message,
      sent_lines: printer.lastSentLines,
      spans: job.spans ?? null,
    });
  }
}

// --- the loop ----------------------------------------------------------------

async function cycle() {
  const now = Date.now();

  // Keep the printer awake. It stops advertising after about ten minutes with
  // no GATT connection and then only its button wakes it, so this is the one
  // thing the loop must never skip.
  if (now - lastKeepalive >= KEEPALIVE_MS || !printer.connected) {
    const status = await printer.keepalive();
    lastKeepalive = Date.now();
    if (status) {
      printerState = status.paperOk ? "awake" : "no_paper";
      paint(status);
    }
  }

  if (now - lastBeat >= HEARTBEAT_MS) {
    await heartbeat();
    lastBeat = Date.now();
  }

  if (printerState === "no_paper") {
    // Deliberately does not ask for work: claiming a job the machine cannot
    // print burns it for a reason nobody chose.
    say("waiting: the roll is empty");
    return 15_000;
  }

  const job = await nextJob();
  if (!job) return 0; // the long poll already did the waiting
  await printJob(job);
  return 0;
}

async function loop() {
  while (running) {
    let wait = RETRY_MS;
    try {
      wait = await cycle();
      backoff = RETRY_MS;
    } catch (err) {
      lastError = err.message;
      say(err.message, true);
      wait = backoff;
      backoff = Math.min(backoff * 2, RETRY_MAX_MS);
    }
    // Never spin: even a zero wait yields, so a Worker answering instantly
    // cannot turn this into a loop that hammers the database.
    await new Promise((r) => setTimeout(r, Math.max(wait, 250)));
  }
}

// --- the page ----------------------------------------------------------------

function say(what, bad = false) {
  const line = document.createElement("li");
  line.textContent = `${new Date().toLocaleTimeString()}  ${what}`;
  if (bad) line.className = "bad";
  const log = $("log");
  log.prepend(line);
  while (log.children.length > 60) log.lastChild.remove();
}

function paint(status) {
  $("temp").textContent = status ? `${status.temperature} C` : "-";
  $("battery").textContent = status ? `${status.battery}` : "-";
  $("paper").textContent = status ? (status.paperOk ? "loaded" : "EMPTY") : "-";
  $("done").textContent = `${printedCount} printed, ${failedCount} failed`;
}

function setRunning(on) {
  running = on;
  $("start").hidden = on;
  $("stop").hidden = !on;
  $("dot").className = on ? "dot dot--on" : "dot";
  $("status").textContent = on ? "running — leave this tab open" : "stopped";
}

$("connect").addEventListener("click", async () => {
  try {
    const name = await printer.choose();
    await printer.connect();
    say(`connected to ${name}`);
    $("start").disabled = false;
    paint(await printer.status());
  } catch (err) {
    say(err.message, true);
  }
});

$("start").addEventListener("click", async () => {
  token = $("token").value.trim();
  if (!token) {
    say("paste your PRINTER_TOKEN first", true);
    return;
  }
  localStorage.setItem(TOKEN_KEY, token);
  setRunning(true);
  loop();
});

$("stop").addEventListener("click", () => {
  setRunning(false);
  say("stopped");
});

$("forget").addEventListener("click", () => {
  localStorage.removeItem(TOKEN_KEY);
  $("token").value = "";
  token = "";
  say("token forgotten from this browser");
});

// Closing the tab stops everything, which is the whole point - but say so
// rather than let somebody close it by accident mid-ticket.
window.addEventListener("beforeunload", (event) => {
  if (!running) return;
  event.preventDefault();
  event.returnValue = "";
});

(function start() {
  token = localStorage.getItem(TOKEN_KEY) ?? "";
  $("token").value = token;
  deviceId = localStorage.getItem(DEVICE_KEY) ?? `browser-${Math.random().toString(36).slice(2, 8)}`;
  localStorage.setItem(DEVICE_KEY, deviceId);
  $("device").textContent = deviceId;
  $("start").disabled = true;
  setRunning(false);
  if (!navigator.bluetooth) {
    say("This browser has no Web Bluetooth. Use Chrome or Edge on a desktop, or Chrome on Android.", true);
    $("connect").disabled = true;
  }
})();
