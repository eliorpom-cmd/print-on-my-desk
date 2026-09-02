"""The MXW01 thermal printer, over Bluetooth, from a computer that stays on.

The missing quadrant. There were three ways to drive a printer here and they
covered three of the four cases people actually have:

    printer         always on          a tab must be open
    ------------------------------------------------------
    USB, 80 mm      agent/ (escpos)    -
    BLE, 58 mm      THIS FILE          web/bridge/

The fourth was the common one. The cheap 58 mm Bluetooth printer is what most
people buy, and the only way to run it unattended was to port the firmware to
a computer - an afternoon of work that the documentation honestly admitted
nobody had done. This is that afternoon.

WHAT IT IS A PORT OF

firmware/ble_printer.py, which is where the protocol was worked out, byte by
byte, against a real machine, with captures. Several things in here contradict
every other implementation of this printer on the internet, and each one is a
measurement rather than an opinion - docs/09-protocol.md says which and how.

The JavaScript in web/bridge/printer.js is the same port again, for a browser.
Three implementations of one protocol is two too many, and it is deliberate:
they run in a microcontroller, a browser and CPython, which share no Bluetooth
API at all. What they DO share is this file's constants and its order of
operations, and a change to any of them belongs in all three.

ASYNC UNDER A SYNCHRONOUS SKIN

bleak is asyncio and main.py is not, and neither should change: the agent's
loop is readable precisely because it reads top to bottom. So the event loop
runs in a background thread for the life of the process and every method here
hands it a coroutine and waits.

That is not a detail. The connection has to PERSIST - see SLEEP_AFTER_MS - so
`asyncio.run()` per call is not an option: it would tear the connection down
between operations and the printer would fall asleep inside ten minutes with
nothing able to wake it but its own button.
"""

import threading
import asyncio
import time

try:
    from bleak import BleakClient, BleakScanner
except ImportError:  # pragma: no cover - the tests never touch Bluetooth
    BleakClient = None
    BleakScanner = None


# --- GATT -------------------------------------------------------------------

# The printer ADVERTISES af30 and EXPOSES ae30. Both are real and they are not
# the same number: a scan filtering on ae30 finds nothing at all. Every
# reference implementation that guesses assumes this is a macOS quirk. It is
# not - the two coexist, verified on Linux, macOS and a Pico.
ADV_SERVICE = "0000af30-0000-1000-8000-00805f9b34fb"
CHAR_CONTROL = "0000ae01-0000-1000-8000-00805f9b34fb"  # write without response
CHAR_NOTIFY = "0000ae02-0000-1000-8000-00805f9b34fb"  # notify
CHAR_DATA = "0000ae03-0000-1000-8000-00805f9b34fb"  # write without response

DEVICE_NAME = "MXW01"

# --- protocol ---------------------------------------------------------------

CMD_STATUS = 0xA1
CMD_INTENSITY = 0xA2
CMD_FEED = 0xA3
CMD_PRINT = 0xA9
CMD_PRINT_DONE = 0xAA
CMD_FLUSH = 0xAD

# Two print modes, and the difference is centimetres of paper.
#
# Mode 0x00 ejects about 3 cm of its own accord after every ticket. Mode 0x01
# prints identically and ejects almost none, which turns the feed needed to
# reach the tear bar into an explicit command we control rather than a fixed
# cost we do not. On a short ticket that is 4 cm of paper against 1 cm.
MODE_SHORT_FEED = 0x01

# 384 dots across, one bit per pixel. NOT the 64 of the 80 mm printer, and the
# agent checks: a payload rendered for the wrong width prints as diagonal noise.
WIDTH_PIXELS = 384
WIDTH_BYTES = 48

# Never exceed this. Above it the head cooks.
MAX_INTENSITY = 0xC0
DEFAULT_INTENSITY = 0x5D

# The head keeps climbing for a second or two after a print ends - a reading of
# 39 became 46 - so starting needs headroom under whatever the hardware
# tolerates. 45 is the absolute ceiling; 38 is where we refuse to start.
MAX_HEAD_C = 45
START_BELOW_C = 38

# Never fire two tickets truly back to back.
MIN_PRINT_GAP_S = 20.0

# The printer stops advertising after roughly ten minutes with no GATT
# connection, and then NOTHING wakes it but its own button - not a scan, not a
# direct connect. Measured between 9.3 and 10.3 minutes.
#
# This is why the connection is held open for the life of the process, and why
# a keepalive goes out well inside the deadline.
SLEEP_AFTER_MS = 9 * 60 * 1000
KEEPALIVE_EVERY_S = 5 * 60

# How fast lines may go out on the data characteristic.
#
# The floor measured 4 ms on a microcontroller, imposed by its Bluetooth stack
# rather than by the printer. A desktop stack queues differently, so this
# starts more conservatively and CLIMBS when a write stalls - and never comes
# back down within a transfer. A stall is evidence that the pacing is too tight
# for the conditions of this transfer (a warm head, a busy 2.4 GHz band), so
# the honest response is to slow down and stay slowed, not to retry at a
# cadence already shown not to work.
PACE_S = 0.008
PACE_BACKOFF_S = 0.003
PACE_MAX_S = 0.045
WRITE_RETRIES = 8

NOTIFY_TIMEOUT_S = 4.0
PRINT_BASE_TIMEOUT_S = 8.0
PRINT_S_PER_LINE = 0.07

SCAN_TIMEOUT_S = 8.0


# --- CRC8, Dallas/Maxim, polynomial 0x07, init 0x00 -------------------------
#
# The same algorithm for the control frames and for the image checksum the
# printer echoes back. That echo is the most useful thing in this protocol and
# no reference implementation documents it: see print_lines.

def _crc8_table():
    table = []
    for i in range(256):
        c = i
        for _ in range(8):
            c = ((c << 1) ^ 0x07) & 0xFF if c & 0x80 else (c << 1) & 0xFF
        table.append(c)
    return table


_CRC8 = _crc8_table()


def crc8(data, crc=0):
    for byte in data:
        crc = _CRC8[crc ^ byte]
    return crc


def build_frame(cmd_id, payload):
    """22 21 | cmd | 00 | len_le(2) | payload | crc8(payload) | FF"""
    n = len(payload)
    frame = bytearray(8 + n)
    frame[0] = 0x22
    frame[1] = 0x21
    frame[2] = cmd_id
    frame[3] = 0x00
    frame[4] = n & 0xFF
    frame[5] = (n >> 8) & 0xFF
    frame[6:6 + n] = payload
    frame[6 + n] = crc8(payload)
    frame[7 + n] = 0xFF
    return bytes(frame)


def parse_notification(data):
    """Returns (cmd_id, payload) or (None, None).

    The layout is 6 + n + 1, NOT the 8 + n every reference implementation
    expects. They wait for a trailing byte that does not exist and log
    "notification possibly truncated" on every single reply. Verified over 13
    notifications: one tail byte, always 0x00, and it is not a checksum.
    """
    if len(data) < 7 or data[0] != 0x22 or data[1] != 0x21:
        return None, None
    n = data[4] | (data[5] << 8)
    if len(data) < 6 + n:
        return None, None
    return data[2], bytes(data[6:6 + n])


def iter_lines(data, width_bytes=WIDTH_BYTES):
    """Slices a flat image buffer into rows, without copying it whole.

    The same helper the USB driver exports, under the same name, because
    main.py calls it on whichever module it selected. Two drivers that agree on
    their classes and disagree on their module functions are two drivers that
    work until the day somebody switches - which is exactly what happened here,
    caught by running the agent's own loop against this one.
    """
    view = memoryview(data)
    for at in range(0, len(view), width_bytes):
        yield bytes(view[at:at + width_bytes])


# --- errors -----------------------------------------------------------------
#
# The same four names escpos_printer.py exports, so that main.py can drive
# either driver without knowing which it has.

class PrinterError(Exception):
    pass


class PrinterOffline(PrinterError):
    """Not on the air.

    On this machine that means one of two things and they cannot be told apart
    from here: it is switched off, or it has fallen asleep. Asleep is the one
    no amount of retrying fixes - only the button - so the caller should report
    it and carry on rather than hammer the radio.
    """


class PrinterNoPaper(PrinterError):
    """The roll is empty.

    Its own class because it is the one failure that destroys a message in
    silence: with no paper the printer still accepts the whole buffer and still
    answers with the RIGHT checksum - it did receive the bytes - so a driver
    watching anything else marks the job printed with nothing on the floor.
    """


class PrinterCoverOpen(PrinterError):
    """Never raised here, and exported anyway.

    The 80 mm printer has a lid switch and this one does not. main.py reads the
    same field from both, so the name has to exist; it simply never fires.
    """


class PrinterTooHot(PrinterError):
    """The head is above its ceiling. Wait; do not print."""


# --- the loop that lives in a thread ----------------------------------------

class _Loop:
    """One asyncio loop, in one thread, for the life of the process.

    Started lazily so that importing this module on a machine with no
    Bluetooth - the test machine, the CI runner - costs nothing and starts
    nothing.
    """

    def __init__(self):
        self._loop = None
        self._thread = None

    def start(self):
        if self._loop is not None:
            return
        self._loop = asyncio.new_event_loop()
        self._thread = threading.Thread(
            target=self._run, name="ble-printer", daemon=True
        )
        self._thread.start()

    def _run(self):
        asyncio.set_event_loop(self._loop)
        self._loop.run_forever()

    def call(self, coro, timeout=None):
        self.start()
        future = asyncio.run_coroutine_threadsafe(coro, self._loop)
        return future.result(timeout)

    def stop(self):
        if self._loop is None:
            return
        self._loop.call_soon_threadsafe(self._loop.stop)
        self._thread.join(timeout=5)
        self._loop = None
        self._thread = None


# --- the printer ------------------------------------------------------------

class MXW01:
    """The 58 mm Bluetooth printer, driven from a computer that stays on.

    The public surface is the one escpos_printer.TRP100 has, method for method,
    because main.py drives whichever it was given and must not care.
    """

    def __init__(self, address=None, name=DEVICE_NAME, timeout_s=NOTIFY_TIMEOUT_S):
        """`address` pins one machine; without it the first MXW01 seen wins.

        Worth setting if there are two in the flat, and worth leaving alone
        otherwise: a Bluetooth address is not stable across every platform, and
        macOS in particular hands out a per-host UUID rather than the real one.
        """
        self.address = address
        self.name = name
        self.timeout_s = timeout_s

        self._loop = _Loop()
        self._client = None
        self._waiters = {}
        self._last_print_at = 0.0
        self._last_contact_at = 0.0

        # What the caller needs after a failure, and the reason both are reset
        # before anything can fail: they are how a REFUSAL is told from a
        # TRUNCATION. Every pre-print check happens before a byte goes out, so
        # a job that was refused never reached the paper and can go straight
        # back in the queue with no risk of printing twice.
        self.last_sent_lines = 0
        self.last_stalls = 0
        self.last_pace_ms = int(PACE_S * 1000)

    # -- connection ----------------------------------------------------------

    def is_open(self):
        return self._client is not None and self._client.is_connected

    def open(self, attempts=3, pause_s=1.0):
        """Finds the printer and connects. Idempotent, like the USB driver's.

        The missing-bleak check is in _connect rather than here, and that is
        not tidiness: the tests substitute a fake bus by overriding _connect,
        and a guard at this level would refuse them on a machine that has never
        needed Bluetooth - which is every machine that runs the suite.
        """
        if self.is_open():
            return

        last = None
        for attempt in range(attempts):
            try:
                self._loop.call(self._connect(), timeout=SCAN_TIMEOUT_S + 20)
                return
            except PrinterError as err:
                last = err
                if attempt < attempts - 1:
                    time.sleep(pause_s * (attempt + 1))
        raise last if last else PrinterOffline("could not reach the printer")

    async def _connect(self):
        if BleakClient is None:
            raise PrinterError(
                "bleak is not installed. Run: pip install bleak\n"
                "(or set PRINTER = \"escpos\" in config.py for a USB printer)"
            )
        address = self.address
        if address is None:
            # Filtering on the ADVERTISED service, af30. Filtering on the one
            # in the GATT table finds nothing, and that is the single most
            # common way a project fails to see a printer sitting in front of
            # it. The name is a second chance for firmware that advertises
            # neither.
            device = await BleakScanner.find_device_by_filter(
                lambda d, ad: (
                    ADV_SERVICE in (ad.service_uuids or [])
                    or (d.name or "").startswith(self.name)
                ),
                timeout=SCAN_TIMEOUT_S,
            )
            if device is None:
                raise PrinterOffline(
                    "no %s on the air - it is off, or asleep. Only its button "
                    "wakes it." % self.name
                )
            address = device
        client = BleakClient(address)
        try:
            await client.connect()
        except Exception as err:  # bleak raises a zoo of platform exceptions
            raise PrinterOffline("could not connect: %s" % str(err)[:120])

        await client.start_notify(CHAR_NOTIFY, self._on_notify)
        self._client = client
        self._last_contact_at = time.monotonic()

    def close(self):
        if self._client is not None:
            try:
                self._loop.call(self._client.disconnect(), timeout=10)
            except Exception:
                pass
            self._client = None
        self._loop.stop()

    def _on_notify(self, _characteristic, data):
        cmd, payload = parse_notification(data)
        if cmd is None:
            return
        waiter = self._waiters.pop(cmd, None)
        if waiter is not None and not waiter.done():
            waiter.get_loop().call_soon_threadsafe(_resolve, waiter, payload)

    # -- the wire ------------------------------------------------------------

    async def _send(self, cmd_id, payload):
        await self._client.write_gatt_char(
            CHAR_CONTROL, build_frame(cmd_id, payload), response=False
        )

    def _expect(self, cmd_id):
        """Registers interest in a reply BEFORE the question goes out.

        The order matters and it is a real race, not a nicety. Sending first
        and then awaiting leaves a window - the send yields, the notification
        callback runs, and it finds nobody listening - so the reply is dropped
        and the caller times out against a printer that answered perfectly.

        It showed up first against the fake bus, which replies instantly and
        therefore always loses that race. A real printer answers in 38-60 ms
        and would have lost it rarely, on a busy machine, months from now.
        """
        waiter = asyncio.get_running_loop().create_future()
        self._waiters[cmd_id] = waiter
        return waiter

    async def _collect(self, cmd_id, waiter, timeout_s=None):
        try:
            return await asyncio.wait_for(waiter, timeout_s or self.timeout_s)
        except asyncio.TimeoutError:
            self._waiters.pop(cmd_id, None)
            return None

    async def _wait_for(self, cmd_id, timeout_s=None):
        return await self._collect(cmd_id, self._expect(cmd_id), timeout_s)

    async def _ask(self, cmd_id, payload, timeout_s=None):
        waiter = self._expect(cmd_id)
        await self._send(cmd_id, payload)
        return await self._collect(cmd_id, waiter, timeout_s)

    # -- state ---------------------------------------------------------------

    def status(self):
        """What the printer says about itself, in main.py's vocabulary.

        The offsets are the FRAME's, not the payload's. Upstream reads
        payload[9] of a 10-byte payload, runs off the end, and gives up.

        `cover` is always False: this machine has no lid switch. It is in the
        dictionary because the 80 mm driver returns one and main.py reads the
        same field from both.
        """
        self.open()
        payload = self._loop.call(self._ask(CMD_STATUS, b"\x00"), timeout=self.timeout_s + 5)
        self._last_contact_at = time.monotonic()
        if payload is None or len(payload) < 9:
            raise PrinterOffline("the printer did not answer a status request")
        return {
            "state": payload[0],  # 0 idle, 1 printing, 3 ejecting
            # Reads as a charge level at rest and sags under load - 0x64 down
            # to 0x40 during a full-black block - so it is a supply reading.
            "battery": payload[3],
            "temperature": payload[4],
            "error": payload[6],
            # 0x00 with paper, 0x07 with the roll out, verified both ways over
            # 34 healthy frames and 5 empty ones. NOT the error flag, which
            # stays 0x00 with the roll empty - see PrinterNoPaper.
            "paper": len(payload) < 10 or payload[9] == 0,
            "cover": False,
            "raw": payload,
        }

    def require_paper(self):
        if not self.status()["paper"]:
            raise PrinterNoPaper("the roll is empty")

    def keepalive(self):
        """One status read, to reset the printer's sleep timer.

        Scanning does not reset it. Only a GATT connection does, which is why
        the agent holds one open and why this exists at all.
        """
        return self.status()

    def beep(self, variant=0, times=1):
        """No buzzer a command can reach. Kept so main.py need not branch.

        Not an oversight in this driver: the machine has no speaker. A ticket
        that should be noticed is announced on a phone instead - see notify.js
        in the Worker.
        """
        return False

    def feed(self, lines):
        self.open()
        self._loop.call(
            self._ask(CMD_FEED, bytes([lines & 0xFF, (lines >> 8) & 0xFF])),
            timeout=self.timeout_s + 5,
        )

    # -- printing ------------------------------------------------------------

    def print_lines(self, rows, line_count, width_bytes=WIDTH_BYTES, feed_lines=0,
                    intensity=DEFAULT_INTENSITY, max_temp=START_BELOW_C):
        """Sends one image and verifies that the printer received it intact.

        `rows` is an iterable of width_bytes-long buffers in transmission
        order, consumed once. Returns the CRC8 of everything sent, so it can be
        compared with what the Worker announced - computed the same way.

        THE CHECKSUM IS THE POINT. Image data goes out without response, so
        nothing acknowledges it and nothing preserves its order. The printer's
        completion notification carries `00 <crc8> <crc8>` - which three
        reference implementations describe as "payload unknown" - and comparing
        it is the only proof a ticket came out whole. Never remove that check.
        """
        if width_bytes != WIDTH_BYTES:
            raise PrinterError(
                "this printer is %d bytes wide, the payload is %d"
                % (WIDTH_BYTES, width_bytes)
            )
        if intensity > MAX_INTENSITY:
            raise PrinterError(
                "intensity 0x%02X exceeds the 0x%02X cap" % (intensity, MAX_INTENSITY)
            )
        self.open()
        return self._loop.call(
            self._print(rows, line_count, feed_lines, intensity, max_temp),
            timeout=PRINT_BASE_TIMEOUT_S + line_count * PRINT_S_PER_LINE + 60,
        )

    async def _print(self, rows, line_count, feed_lines, intensity, max_temp):
        self.last_sent_lines = 0
        self.last_stalls = 0

        await self._send(CMD_INTENSITY, bytes([intensity]))
        await asyncio.sleep(0.1)

        since = time.monotonic() - self._last_print_at
        if self._last_print_at and since < MIN_PRINT_GAP_S:
            await asyncio.sleep(MIN_PRINT_GAP_S - since)

        payload = await self._ask(CMD_STATUS, b"\x00")
        if payload is None or len(payload) < 9:
            raise PrinterOffline("the printer did not answer a status request")

        # PAPER BEFORE THE ERROR FLAG, and the order is the whole point.
        #
        # An empty roll also raises the error flag on some firmwares, so
        # checking the flag first means the paper byte is never read - and the
        # caller gets a cryptic error instead of "there is no paper", never
        # enters the state that stops it claiming work, and hammers the printer
        # for as long as nobody notices.
        if len(payload) >= 10 and payload[9] != 0:
            raise PrinterNoPaper("the roll is empty (status byte 9 = 0x%02X)" % payload[9])
        if payload[6] != 0:
            # The whole frame travels with the message. 0x01 turned out to mean
            # "no paper"; whatever the next unknown value means, the only way
            # anybody identifies it is by having the bytes that came with it.
            raise PrinterError(
                "printer reports error flag 0x%02X (status %s)"
                % (payload[6], payload.hex())
            )
        ceiling = min(max_temp, MAX_HEAD_C)
        if payload[4] > ceiling:
            raise PrinterTooHot(
                "head at %d C, will not start above %d C" % (payload[4], ceiling)
            )

        reply = await self._ask(
            CMD_PRINT,
            bytes([line_count & 0xFF, (line_count >> 8) & 0xFF, 0x30, MODE_SHORT_FEED]),
        )
        if reply is None:
            raise PrinterError("no answer to the print request")
        if reply[0] != 0x00:
            raise PrinterError("print request refused: %s" % reply.hex())

        expected = 0
        sent = 0
        pace = PACE_S

        for line in rows:
            if len(line) != WIDTH_BYTES:
                raise PrinterError(
                    "line %d is %d bytes, expected %d" % (sent, len(line), WIDTH_BYTES)
                )
            for attempt in range(WRITE_RETRIES):
                try:
                    await self._client.write_gatt_char(CHAR_DATA, bytes(line), response=False)
                    break
                except Exception:
                    # The stack's queue is full, or the previous write is still
                    # in flight. Not fatal, and never a corrupted ticket: the
                    # same line is sent again and counted once, so the checksum
                    # stays right.
                    if attempt == WRITE_RETRIES - 1:
                        raise
                    self.last_stalls += 1
                    if pace < PACE_MAX_S:
                        pace = min(pace + PACE_BACKOFF_S, PACE_MAX_S)
                    await asyncio.sleep(pace * (attempt + 2))
            expected = crc8(line, expected)
            sent += 1
            self.last_sent_lines = sent
            await asyncio.sleep(pace)

        self.last_pace_ms = int(pace * 1000)
        if sent != line_count:
            raise PrinterError("announced %d lines, sent %d" % (line_count, sent))

        # Registered before the flush, for the reason _expect gives: the
        # completion notification is the one reply that arrives at a moment
        # nobody controls.
        done_waiter = self._expect(CMD_PRINT_DONE)
        await self._send(CMD_FLUSH, b"\x00")
        done = await self._collect(
            CMD_PRINT_DONE,
            done_waiter,
            PRINT_BASE_TIMEOUT_S + line_count * PRINT_S_PER_LINE,
        )
        self._last_print_at = time.monotonic()
        self._last_contact_at = self._last_print_at

        if done is None:
            raise PrinterError("the printer never said it had finished")
        reported = done[1] if len(done) > 1 else None
        if reported != expected:
            raise PrinterError(
                "checksum: sent 0x%02X, printer received 0x%02X" % (expected, reported)
            )

        if feed_lines > 0:
            await self._ask(
                CMD_FEED, bytes([feed_lines & 0xFF, (feed_lines >> 8) & 0xFF])
            )
        return expected


def _resolve(future, value):
    if not future.done():
        future.set_result(value)
