// The MXW01 thermal printer, over Web Bluetooth.
//
// A port of the MicroPython firmware in ../firmware/ble_printer.py, which is
// where the protocol was worked out - byte by byte, against a real machine,
// with captures. Several things in here contradict every other MXW01
// implementation on the internet, and each one is a measurement rather than an
// opinion. The comments say which.
//
// WHAT THIS RUNS ON
//
// Web Bluetooth: Chrome, Edge and Opera on desktop, and Chrome on Android.
// Not Safari, not any browser on iOS or iPadOS - Apple has not shipped it and
// says it will not. If you are on a Mac you can still use this, in Chrome.
//
// It also needs HTTPS (or localhost), and a real click to start: a browser
// will not open a Bluetooth chooser that the user did not ask for.

// --- GATT -------------------------------------------------------------------

// The printer ADVERTISES af30 and EXPOSES ae30. Both are real, and they are
// not the same number: a scan filtering on ae30 finds nothing at all. Every
// reference implementation that guesses assumes this is a macOS quirk. It is
// not - the two coexist, verified on Linux, macOS and a Pico.
export const ADV_SERVICE = 0xaf30;
const GATT_SERVICE = 0x0000ae30;
const CHAR_CONTROL = 0x0000ae01; // write without response
const CHAR_NOTIFY = 0x0000ae02; // notify
const CHAR_DATA = 0x0000ae03; // write without response

const uuid = (n) => `0000${n.toString(16).padStart(4, "0")}-0000-1000-8000-00805f9b34fb`;

// --- commands ---------------------------------------------------------------

const CMD_STATUS = 0xa1;
const CMD_INTENSITY = 0xa2;
const CMD_FEED = 0xa3;
const CMD_PRINT = 0xa9;
const CMD_PRINT_DONE = 0xaa;
const CMD_FLUSH = 0xad;

// Two print modes, and the difference is centimetres of your paper.
//
// Mode 0x00 makes the printer eject about 3 cm of its own accord once it has
// finished. Mode 0x01 prints identically and ejects almost none, which means
// the feed needed to tear a ticket off becomes an explicit command we control
// rather than a fixed cost we do not. On a short ticket that is the difference
// between 4 cm of paper and 1 cm.
const MODE_SHORT_FEED = 0x01;

export const WIDTH_BYTES = 48; // 384 pixels, 1 bit per pixel

// Never exceed this. Above it the head cooks.
const MAX_INTENSITY = 0xc0;

// The head keeps climbing for a second or two after a print ends - a reading of
// 39 became 46 - so starting needs headroom under whatever the hardware
// tolerates. 45 is the absolute ceiling; 38 is where we refuse to start.
const MAX_HEAD_C = 45;
const START_BELOW_C = 38;

// Never fire two tickets truly back to back.
const MIN_PRINT_GAP_MS = 20_000;

// The printer stops advertising after roughly ten minutes with no GATT
// connection, and then NOTHING can wake it but its own button - not a scan,
// not a direct connect. Measured between 9.3 and 10.3 minutes. So the bridge
// reconnects every five minutes for as long as the tab is open, and that
// single fact is why leaving the tab open works and closing it does not.
export const KEEPALIVE_MS = 5 * 60 * 1000;

// How fast lines may go out on the data characteristic.
//
// The floor was measured at 4 ms on a Pico, imposed by its BLE stack rather
// than by the printer. A browser's stack is slower and queues differently, so
// this starts more conservatively and climbs when a write stalls - and never
// comes back down within a transfer. A stall is evidence that the pacing is
// too tight for the conditions of THIS transfer (a warm head, a busy 2.4 GHz
// band), so the honest response is to slow down and stay slowed.
const PACE_MS = 10;
const PACE_BACKOFF_MS = 3;
const PACE_MAX_MS = 45;
const WRITE_RETRIES = 8;

const NOTIFY_TIMEOUT_MS = 4000;
const PRINT_BASE_TIMEOUT_MS = 8000;
const PRINT_MS_PER_LINE = 70;

// --- CRC8, Dallas/Maxim, polynomial 0x07, init 0x00 -------------------------
//
// The same algorithm for the control frames and for the image checksum the
// printer echoes back. That echo is the most useful thing in this protocol and
// no reference implementation documents it: see waitPrintDone.

const CRC8_TABLE = (() => {
  const table = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let bit = 0; bit < 8; bit++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
    table[i] = c;
  }
  return table;
})();

export function crc8(bytes, crc = 0) {
  for (const byte of bytes) crc = CRC8_TABLE[crc ^ byte];
  return crc;
}

/** `22 21 | cmd | 00 | len_le(2) | payload | crc8(payload) | FF` */
function frame(cmd, payload) {
  const out = new Uint8Array(8 + payload.length);
  out[0] = 0x22;
  out[1] = 0x21;
  out[2] = cmd;
  out[3] = 0x00;
  out[4] = payload.length & 0xff;
  out[5] = (payload.length >> 8) & 0xff;
  out.set(payload, 6);
  out[6 + payload.length] = crc8(payload);
  out[7 + payload.length] = 0xff;
  return out;
}

/**
 * Reads a notification.
 *
 * The layout is 6 + n + 1, NOT the 8 + n every reference implementation
 * expects. They wait for a trailing byte that does not exist and log
 * "notification possibly truncated" on every single reply. Verified over 13
 * notifications: one tail byte, always 0x00, and it is not a checksum.
 */
function parseNotification(view) {
  const data = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  if (data.length < 7 || data[0] !== 0x22 || data[1] !== 0x21) return null;
  const n = data[4] | (data[5] << 8);
  if (data.length < 6 + n) return null;
  return { cmd: data[2], payload: data.slice(6, 6 + n) };
}

// --- errors -----------------------------------------------------------------

export class PrinterError extends Error {}

/** The roll is empty. Its own class because it is the failure that eats a
 *  message silently: with no paper the printer still accepts the whole buffer
 *  and still answers with the right checksum. It did receive the bytes. */
export class NoPaper extends PrinterError {}

/** The head is too hot to start. Wait; do not print. */
export class TooHot extends PrinterError {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- the printer ------------------------------------------------------------

export class Printer {
  constructor({ log = () => {} } = {}) {
    this.log = log;
    this.device = null;
    this.control = null;
    this.data = null;
    this.notify = null;
    this.waiters = new Map();
    this.lastPrintAt = 0;
    this.lastSentLines = 0;
    this.lastStalls = 0;
    this.lastPaceMs = PACE_MS;
  }

  get connected() {
    return Boolean(this.device?.gatt?.connected);
  }

  /**
   * Opens the browser's device chooser. MUST be called from a click.
   *
   * The filter is on the ADVERTISED service, which is af30. Filtering on the
   * one in the GATT table finds nothing, and that is the single most common
   * way an MXW01 project fails to see a printer that is sitting right there.
   */
  async choose() {
    if (!navigator.bluetooth) {
      throw new PrinterError(
        "This browser has no Web Bluetooth. Chrome or Edge on desktop, or Chrome on Android."
      );
    }
    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [ADV_SERVICE] }, { namePrefix: "MXW01" }],
      optionalServices: [GATT_SERVICE],
    });
    this.device.addEventListener("gattserverdisconnected", () => {
      this.log("disconnected");
      this.control = null;
      this.data = null;
    });
    return this.device.name ?? "printer";
  }

  async connect() {
    if (!this.device) throw new PrinterError("no printer chosen yet");
    if (this.connected && this.control) return;

    const server = await this.device.gatt.connect();
    const service = await server.getPrimaryService(uuid(GATT_SERVICE & 0xffff));
    this.control = await service.getCharacteristic(uuid(CHAR_CONTROL & 0xffff));
    this.data = await service.getCharacteristic(uuid(CHAR_DATA & 0xffff));
    this.notify = await service.getCharacteristic(uuid(CHAR_NOTIFY & 0xffff));

    this.notify.addEventListener("characteristicvaluechanged", (event) => {
      const parsed = parseNotification(event.target.value);
      if (!parsed) return;
      const waiter = this.waiters.get(parsed.cmd);
      if (waiter) {
        this.waiters.delete(parsed.cmd);
        waiter.resolve(parsed.payload);
      }
    });
    await this.notify.startNotifications();
    this.log("connected");
  }

  async disconnect() {
    if (this.device?.gatt?.connected) this.device.gatt.disconnect();
  }

  async send(cmd, payload) {
    if (!this.control) throw new PrinterError("not connected");
    await this.control.writeValueWithoutResponse(frame(cmd, Uint8Array.from(payload)));
  }

  waitFor(cmd, timeoutMs = NOTIFY_TIMEOUT_MS) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(cmd);
        resolve(null);
      }, timeoutMs);
      this.waiters.set(cmd, {
        resolve: (payload) => {
          clearTimeout(timer);
          resolve(payload);
        },
      });
    });
  }

  /**
   * The A1 status frame, read at the right offsets.
   *
   * Upstream indexes this on the payload as if it were the frame, runs off the
   * end, and gives up. Recalibrated against captures: state, then battery,
   * then temperature in Celsius, then the error flag - and the paper byte,
   * which is the one that matters and which the error flag does NOT stand in
   * for.
   */
  async status() {
    await this.send(CMD_STATUS, [0x00]);
    const p = await this.waitFor(CMD_STATUS);
    if (!p || p.length < 9) return null;
    return {
      state: p[0], // 0 idle, 1 printing, 3 ejecting
      // Reads as a charge level at rest and sags under load - 0x64 down to
      // 0x40 during a full-black block - so it is a supply reading.
      battery: p[3],
      temperature: p[4],
      errorFlag: p[6],
      // 0x00 with paper, 0x07 with the roll out, verified both ways. NOT the
      // error flag, which stays 0x00 with the roll empty.
      paperOk: p.length < 10 || p[9] === 0,
      raw: p,
    };
  }

  /** Feeds blank lines, so the last printed line clears the tear bar. */
  async feed(lines) {
    await this.send(CMD_FEED, [lines & 0xff, (lines >> 8) & 0xff]);
    return await this.waitFor(CMD_FEED);
  }

  /**
   * A keepalive: one status read, to reset the printer's sleep timer.
   *
   * Scanning does not reset it. Only a GATT connection does. This is why the
   * bridge has to stay connected rather than connect when there is work.
   */
  async keepalive() {
    if (!this.connected) await this.connect();
    return await this.status();
  }

  /**
   * Prints one bitmap and verifies that the printer received it intact.
   *
   * `lines` is a Uint8Array of exactly 48 bytes per printed line, top row
   * first, bit 0 of each byte the leftmost pixel.
   *
   * THE CHECKSUM IS THE POINT. Image data goes out on ae03 with no response,
   * so nothing acknowledges it and nothing preserves its order. The printer's
   * AA notification carries `00 <crc8(image)> <crc8(image)>` - which three
   * reference implementations describe as "payload unknown" - and comparing it
   * to what we computed on the way out is the only proof a ticket came out
   * whole. Never remove that check.
   */
  async print(lines, { intensity = 0x5d, feedLines = 7, maxTempC = START_BELOW_C } = {}) {
    if (!this.connected) await this.connect();
    if (intensity > MAX_INTENSITY) {
      throw new PrinterError(`intensity 0x${intensity.toString(16)} is over the cap`);
    }
    if (lines.length % WIDTH_BYTES !== 0) {
      throw new PrinterError(`${lines.length} bytes is not a whole number of lines`);
    }
    const lineCount = lines.length / WIDTH_BYTES;

    // Reset before anything can fail. This is how the caller tells a refusal
    // from a truncation: every check below happens before a single byte goes
    // out, so a job that was refused never reached the paper and can be put
    // straight back in the queue with no risk of printing twice.
    this.lastSentLines = 0;

    await this.send(CMD_INTENSITY, [intensity]);
    await sleep(100);

    const since = Date.now() - this.lastPrintAt;
    if (this.lastPrintAt && since < MIN_PRINT_GAP_MS) await sleep(MIN_PRINT_GAP_MS - since);

    const status = await this.status();
    if (!status) throw new PrinterError("the printer did not answer a status request");

    // Paper BEFORE the error flag, and the order is the whole point: an empty
    // roll also raises the error flag, so checking the flag first means the
    // paper byte is never read, and the caller gets a cryptic error instead of
    // "there is no paper" - and never enters the state that stops it asking
    // for more work.
    if (!status.paperOk) throw new NoPaper("the roll is empty");
    if (status.errorFlag !== 0) {
      const hex = [...status.raw].map((b) => b.toString(16).padStart(2, "0")).join("");
      throw new PrinterError(`printer error flag 0x${status.errorFlag.toString(16)} (${hex})`);
    }
    const ceiling = Math.min(maxTempC, MAX_HEAD_C);
    if (status.temperature > ceiling) {
      throw new TooHot(`head at ${status.temperature} C, will not start above ${ceiling}`);
    }

    await this.send(CMD_PRINT, [lineCount & 0xff, (lineCount >> 8) & 0xff, 0x30, MODE_SHORT_FEED]);
    const accepted = await this.waitFor(CMD_PRINT);
    if (!accepted) throw new PrinterError("no answer to the print request");
    if (accepted[0] !== 0x00) throw new PrinterError(`print request refused: ${accepted[0]}`);

    let expected = 0;
    let sent = 0;
    let stalls = 0;
    let pace = PACE_MS;

    for (let i = 0; i < lineCount; i++) {
      const line = lines.subarray(i * WIDTH_BYTES, (i + 1) * WIDTH_BYTES);
      for (let attempt = 0; ; attempt++) {
        try {
          await this.data.writeValueWithoutResponse(line);
          break;
        } catch (err) {
          // The browser's GATT queue is full, or the previous write is still in
          // flight. Not fatal, and not a corrupted ticket - the same line is
          // simply sent again, and it is counted once, so the checksum stays
          // right.
          if (attempt >= WRITE_RETRIES - 1) throw err;
          stalls++;
          if (pace < PACE_MAX_MS) pace = Math.min(pace + PACE_BACKOFF_MS, PACE_MAX_MS);
          await sleep(pace * (attempt + 2));
        }
      }
      expected = crc8(line, expected);
      sent++;
      this.lastSentLines = sent;
      await sleep(pace);
    }

    this.lastStalls = stalls;
    this.lastPaceMs = pace;

    await this.send(CMD_FLUSH, [0x00]);

    const done = await this.waitFor(
      CMD_PRINT_DONE,
      PRINT_BASE_TIMEOUT_MS + lineCount * PRINT_MS_PER_LINE
    );
    this.lastPrintAt = Date.now();
    if (!done) return { ok: false, expected, reported: null, sent };

    const reported = done.length > 1 ? done[1] : null;
    if (feedLines > 0) await this.feed(feedLines);
    return { ok: reported === expected, expected, reported, sent };
  }
}
