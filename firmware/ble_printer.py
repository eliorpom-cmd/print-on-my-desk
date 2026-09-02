# MXW01 thermal printer driver for MicroPython / aioble.
#
# Every byte in this file is backed by a capture in capture/traces and
# documented in docs/09-protocol.md. Nothing here is guessed from a reference
# implementation, and two things deliberately contradict them:
#
#   * The printer advertises service af30 but exposes ae30 in its GATT table.
#     Scanning for ae30 finds nothing.
#   * Notifications carry no CRC and no 0xFF footer. They are 6 bytes of
#     header, then the payload, then a single 0x00 tail byte.
#
# The important discovery this driver relies on: the AA notification sent at
# the end of a print carries the CRC8 of the image buffer the printer actually
# received. Since ae03 is written without response, and therefore without any
# delivery or ordering guarantee, that CRC is the only way to know a ticket
# came out intact. We compute the same CRC while streaming and compare.

import asyncio
import time

import aioble
import bluetooth

# --- GATT -----------------------------------------------------------------

# Advertised in the scan response, not the same as the one in the GATT table.
ADV_SERVICE_UUID = bluetooth.UUID(0xAF30)
# Actually exposed once connected.
GATT_SERVICE_UUID = bluetooth.UUID(0xAE30)

CHAR_CONTROL = bluetooth.UUID(0xAE01)  # write without response
CHAR_NOTIFY = bluetooth.UUID(0xAE02)  # notify
CHAR_DATA = bluetooth.UUID(0xAE03)  # write without response

DEVICE_NAME = "MXW01"

# --- Protocol -------------------------------------------------------------

CMD_GET_STATUS = 0xA1
CMD_SET_INTENSITY = 0xA2
CMD_EJECT_PAPER = 0xA3
CMD_PRINT = 0xA9
CMD_PRINT_COMPLETE = 0xAA
CMD_BATTERY = 0xAB
CMD_FLUSH = 0xAD
CMD_PRINT_TYPE = 0xB0
CMD_VERSION = 0xB1

MODE_1BPP = 0x00
MODE_1BPP_SHORT_FEED = 0x01
MODE_4BPP = 0x02

# Measured, not assumed. Mode 0x00 makes the printer eject about 3 cm of paper
# once it has finished; mode 0x01 prints identically and ejects almost none.
# On a ticket whose image is 4 mm tall that is the difference between 4 cm of
# paper and 1 cm. Feeding enough paper to tear the ticket off is then an
# explicit A3 command, which we control, rather than a fixed cost we do not.
DEFAULT_MODE = MODE_1BPP_SHORT_FEED

WIDTH_PIXELS = 384
WIDTH_BYTES = 48
# Upstream pads every buffer to 90 lines. Tested and disproved: the printer
# accepts a 32-line print request and returns the matching CRC, so the padding
# was a superstition copied from one reference implementation to the next.
# MIN_LINES is kept only to reproduce the M0 captures byte for byte.
MIN_LINES = 90
PADDING_REQUIRED = False

# Project constraint: never exceed this.
MAX_INTENSITY = 0xC0

# Print-head protection. The printer reports its own temperature in every A1
# status frame, which beats counting prints: it measures the thing we actually
# care about. Observed 23 C cold, rising about 1 C per 32-line black band.
MAX_HEAD_TEMPERATURE = 45
# The head keeps climbing for a second or two after a print ends, so checking
# only before starting is not enough: a status read said 39 C while the check a
# moment later found 46, and a cooling watch saw 52 after a full-black block
# (M4, 28 August). Starting a print needs headroom for that overshoot, and 45
# stays the absolute ceiling. A real ticket carries about 9 % ink and moves the
# head by a degree or two, so 38 refuses nothing the service actually prints.
PRE_PRINT_MAX_TEMPERATURE = 38
# Never fire two tickets truly back to back.
MIN_PRINT_INTERVAL_MS = 20000

# The printer stops advertising after roughly 10 minutes without a GATT
# connection, and no BLE peer can wake it after that - only the button.
# Measured between 9.3 and 10.3 minutes (docs/09-protocol.md, zone d'ombre 1).
SLEEP_TIMEOUT_MS = 9 * 60 * 1000
# Safety margin: reconnect well before the deadline.
KEEPALIVE_INTERVAL_MS = 5 * 60 * 1000

# Calibrated on hardware (firmware/m2_pacing.py), not inherited.
#
# The floor is 4 ms, and it is imposed by MicroPython's BLE stack rather than
# by the printer: below it, gattc_write raises OSError 114 EALREADY because the
# previous write is still in flight. The failure is loud, never a silently
# corrupted ticket - the CRC never diverged at any pacing. 8 ms is twice the
# measured floor.
#
# For reference, the macOS capture used 15 ms requested / 16.6 ms actual.
PACING_MS = 8
PACING_FLOOR_MS = 4

# The BLE stack raises this when the previous write has not completed. It is
# not fatal - the same line simply has to be sent again a moment later.
_EALREADY = 114
# How many times to retry one line before giving up on the ticket.
WRITE_RETRIES = 10
# When a line stalls, the pacing for the REST of the transfer goes up by this
# much, and never comes back down.
#
# Retrying the stalled line alone was enough for a 300-line ticket and is not
# enough for a 900-line strip: on 30 August, batching made the transfers three
# times longer and eighteen tickets died on OSError 114 in one afternoon. A
# stall is evidence that 8 ms is too tight for the conditions of this
# particular transfer - a warm head, a busy 2.4 GHz band - so the honest
# response is to slow down and stay slowed, not to retry at a cadence that has
# already been shown not to work.
PACING_BACKOFF_MS = 2
# Ceiling on that adaptation. Past this the transfer is so slow that something
# else is wrong, and failing loudly beats printing at one line per 40 ms.
PACING_MAX_MS = 40

# The printer answers a control command in 38-60 ms (traces b, c).
NOTIFY_TIMEOUT_MS = 4000
# AD -> AA took 3.5 s for 90 lines (trace c), plus margin per line.
PRINT_BASE_TIMEOUT_MS = 8000
PRINT_MS_PER_LINE = 70

# MicroPython defaults to an ATT MTU of 23, which leaves 20 usable bytes per
# write. A 48-byte line does not fit. This has to be raised before the data
# transfer or nothing works.
REQUESTED_MTU = 128

# --- CRC8, Dallas/Maxim, polynomial 0x07, init 0x00 -----------------------
# Same algorithm for the control frames and for the image buffer checksum the
# printer echoes back in AA.

_CRC8_TABLE = bytearray(256)
for _i in range(256):
    _c = _i
    for _ in range(8):
        _c = ((_c << 1) ^ 0x07) & 0xFF if (_c & 0x80) else ((_c << 1) & 0xFF)
    _CRC8_TABLE[_i] = _c
del _i, _c


def crc8(data, crc=0):
    for byte in data:
        crc = _CRC8_TABLE[crc ^ byte]
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
    frame[6 : 6 + n] = payload
    frame[6 + n] = crc8(payload)
    frame[7 + n] = 0xFF
    return frame


def parse_notification(data):
    """Returns (cmd_id, payload) or (None, None).

    Layout is 6 + n + 1, NOT the 8 + n the reference implementations expect.
    """
    if len(data) < 7 or data[0] != 0x22 or data[1] != 0x21:
        return None, None
    n = data[4] | (data[5] << 8)
    if len(data) < 6 + n:
        return None, None
    return data[2], bytes(data[6 : 6 + n])


class PrinterError(Exception):
    pass


class PrinterAsleep(PrinterError):
    """The printer is not advertising.

    Distinct from every other failure on purpose: this is the one condition no
    amount of retrying fixes. The printer has to be woken by hand, so the
    caller should stop hammering the radio, report it, and carry on with
    whatever else it has to do.
    """


class PrinterNoPaper(PrinterError):
    """The roll is empty.

    Worth its own class because it is the one failure that silently destroys a
    message: with no paper the printer still accepts the whole buffer, still
    answers with the right CRC - it did receive the bytes - and the job goes to
    'printed' with nothing on the floor. See docs/09-protocol.md 3.3.
    """


class PrinterTooHot(PrinterError):
    """Head temperature above the project's cap. Wait, do not print."""


class MXW01:
    def __init__(self):
        self._connection = None
        self._control = None
        self._notify = None
        self._data = None
        self.mtu = None
        self._last_print_ms = None
        self._last_contact_ms = None
        # Number of write stalls during the last print. Zero on a healthy
        # transfer; a rising count means the pacing is too tight for the
        # ticket lengths being sent.
        self.last_stalls = 0
        # Distinct BLE peers seen during the last scan, printer included.
        self.last_scan_peers = 0
        # Pacing the last transfer ended on, in ms. PACING_MS when nothing
        # stalled.
        self.last_pace_ms = PACING_MS
        # Lines actually written to the printer during the last print attempt.
        # Zero means nothing reached the paper, whatever went wrong.
        self.last_sent_lines = 0

    # -- connection --------------------------------------------------------

    async def scan(self, duration_ms=5000):
        """Finds the printer. Matches on the advertised af30, or on the name.

        Counts every distinct peer seen along the way, and leaves the count in
        ``last_scan_peers``. That number is the difference between the two ways
        a scan comes back empty, and we have no other way to tell them apart:
        zero peers in a busy flat means the Pico's radio is not scanning at all
        - the CYW43 is shared with WiFi and gets toggled every cycle - while a
        dozen peers without the printer means the printer really is gone. M0
        settled the same question on macOS by noting that the Mac saw 24 other
        devices while the printer was absent.
        """
        peers = set()
        try:
            async with aioble.scan(
                duration_ms, interval_us=30000, window_us=30000, active=True
            ) as scanner:
                async for result in scanner:
                    peers.add(str(result.device))
                    if (result.name() == DEVICE_NAME
                            or ADV_SERVICE_UUID in result.services()):
                        return result.device
        finally:
            self.last_scan_peers = len(peers)
        return None

    async def connect(self, device=None, timeout_ms=10000, scan_ms=5000):
        if device is None:
            device = await self.scan(duration_ms=scan_ms)
        if device is None:
            # The peer count rides along in the message: a caller logging this
            # keeps the one fact that distinguishes a sleeping printer from a
            # deaf radio, without having to reach back into the driver.
            raise PrinterAsleep(
                "printer not advertising (%d other peers seen): asleep, needs "
                "its button pressed" % self.last_scan_peers
            )

        # Raise the MTU before anything else: 48-byte lines do not fit in the
        # 20 usable bytes of the default 23-byte MTU.
        aioble.config(mtu=REQUESTED_MTU)

        self._connection = await device.connect(timeout_ms=timeout_ms)

        try:
            self.mtu = await self._connection.exchange_mtu(REQUESTED_MTU)
        except Exception as exc:
            raise PrinterError("MTU exchange failed: %s" % exc)

        if self.mtu is None or self.mtu < WIDTH_BYTES + 3:
            raise PrinterError(
                "MTU %s too small for %d-byte lines" % (self.mtu, WIDTH_BYTES)
            )

        service = await self._connection.service(GATT_SERVICE_UUID)
        if service is None:
            raise PrinterError("service ae30 not found")
        self._control = await service.characteristic(CHAR_CONTROL)
        self._notify = await service.characteristic(CHAR_NOTIFY)
        self._data = await service.characteristic(CHAR_DATA)
        if not (self._control and self._notify and self._data):
            raise PrinterError("missing characteristic")

        await self._notify.subscribe(notify=True)
        self._last_contact_ms = time.ticks_ms()
        return self.mtu

    async def disconnect(self):
        if self._connection is not None:
            try:
                await self._connection.disconnect()
            except Exception:
                pass
        self._connection = None
        self._control = self._notify = self._data = None

    def is_connected(self):
        return self._connection is not None and self._connection.is_connected()

    # -- commands ----------------------------------------------------------

    async def _send(self, cmd_id, payload):
        await self._control.write(build_frame(cmd_id, payload), response=False)

    async def _wait_for(self, cmd_id, timeout_ms=NOTIFY_TIMEOUT_MS):
        """Waits for a notification carrying cmd_id, ignoring the others.

        aioble's notify queue holds a single item by default, so a burst would
        drop frames. Every exchange here is request/response, so we are never
        waiting on two answers at once.
        """
        deadline = time.ticks_add(time.ticks_ms(), timeout_ms)
        while True:
            remaining = time.ticks_diff(deadline, time.ticks_ms())
            if remaining <= 0:
                return None
            try:
                data = await self._notify.notified(timeout_ms=remaining)
            except asyncio.TimeoutError:
                return None
            got_id, payload = parse_notification(data)
            if got_id == cmd_id:
                return payload

    async def get_status(self):
        """Returns a dict, or None on timeout.

        Offsets are relative to the FRAME, not the payload. The reference
        implementations get this wrong and give up on a short payload.
        """
        await self._send(CMD_GET_STATUS, b"\x00")
        payload = await self._wait_for(CMD_GET_STATUS)
        if payload is None or len(payload) < 9:
            return None
        # payload[i] == frame[6 + i]
        return {
            # 0 idle, 1 printing, 3 ejecting. Verified on this firmware in M4
            # by polling during a print; the reference table was right.
            "state": payload[0],  # frame[6]
            # Named battery because that is what it reads at rest, but it sags
            # under load - 0x64 down to 0x40 during a full-black block - so it
            # is a supply reading, not a charge level. PROTOCOL.md 6.2.
            "battery": payload[3],  # frame[9]
            "temperature": payload[4],  # frame[10], celsius
            # NOT the paper flag: it stays 0x00 with the roll out. PROTOCOL 3.3
            "error_flag": payload[6],  # frame[12], 0 = ok
            # 0x00 with paper, 0x07 with the roll empty, verified both ways on
            # 34 healthy frames and 5 empty ones. Any non-zero value is treated
            # as "cannot print": only 0x07 has been observed, so refusing on
            # anything else is a guess, but it is the safe direction - the cost
            # of being wrong is a job that waits, against a message destroyed.
            "paper_ok": len(payload) < 10 or payload[9] == 0,
            "raw": payload,
        }

    async def get_version(self):
        await self._send(CMD_VERSION, b"\x00")
        payload = await self._wait_for(CMD_VERSION)
        return payload.decode() if payload else None

    async def get_battery(self):
        await self._send(CMD_BATTERY, b"\x00")
        payload = await self._wait_for(CMD_BATTERY)
        return payload[0] if payload else None

    async def feed(self, lines):
        await self._send(CMD_EJECT_PAPER, bytes([lines & 0xFF, (lines >> 8) & 0xFF]))
        return await self._wait_for(CMD_EJECT_PAPER)

    # -- printing ----------------------------------------------------------

    async def print_lines(self, line_source, line_count, intensity=0x5D,
                          mode=DEFAULT_MODE, max_temp=None):
        """Streams a bitmap and verifies what the printer received.

        line_source yields 48-byte buffers. It is an iterator on purpose: the
        Pico has 520 KB of RAM and there is no reason to hold a whole ticket in
        memory when the printer consumes it one line at a time.

        Returns (ok, expected_crc, reported_crc).
        """
        # Reset before anything can fail. This counter is how the caller tells
        # a refusal from a truncation: every pre-print check - error flag, empty
        # roll, hot head - raises before a single line goes out, and a job that
        # never reached the paper can be requeued with no risk of a duplicate.
        # Enumerating the exception types instead was wrong twice in one
        # afternoon, because the list never includes the error nobody has seen
        # yet - 0x01 cost six tickets.
        self.last_sent_lines = 0
        if intensity > MAX_INTENSITY:
            raise PrinterError(
                "intensity 0x%02X exceeds the 0x%02X cap" % (intensity, MAX_INTENSITY)
            )
        if not self.is_connected():
            raise PrinterError("not connected")

        await self._send(CMD_SET_INTENSITY, bytes([intensity]))
        await asyncio.sleep_ms(100)

        if self._last_print_ms is not None:
            since = time.ticks_diff(time.ticks_ms(), self._last_print_ms)
            if since < MIN_PRINT_INTERVAL_MS:
                await asyncio.sleep_ms(MIN_PRINT_INTERVAL_MS - since)

        status = await self.get_status()
        if status is None:
            raise PrinterError("no answer to the status request")
        # Paper before the error flag, and the order is the whole point.
        #
        # An empty roll also raises the error flag - 0x01, confirmed on
        # 30 August when the owner went to look and found the roll finished. With
        # the flag checked first the paper byte was never read, so the loop
        # raised a cryptic PrinterError instead of PrinterNoPaper, never
        # entered the state that stops it claiming work, and hammered the
        # printer every nineteen seconds for as long as nobody noticed.
        if not status["paper_ok"]:
            raise PrinterNoPaper(
                "no paper: status byte 9 is 0x%02X, error flag 0x%02X"
                % (status["raw"][9], status["error_flag"])
            )
        if status["error_flag"] != 0:
            # The whole frame travels with the message. 0x01 turned out to mean
            # "no paper"; whatever the next unknown value means, the only way
            # anyone will identify it is by having the bytes that came with it.
            raise PrinterError(
                "printer reports error flag 0x%02X (status %s)"
                % (status["error_flag"],
                   "".join("%02x" % b for b in status["raw"]))
            )
        # The ceiling can be retuned from /admin, so it arrives with the job
        # rather than being frozen into the board. The constant remains the
        # default and the hard bound: a setting cannot raise it past what the
        # project decided is safe.
        ceiling = min(max_temp or PRE_PRINT_MAX_TEMPERATURE, MAX_HEAD_TEMPERATURE)
        if status["temperature"] > ceiling:
            raise PrinterTooHot(
                "head at %d C, will not start above %d C (ceiling %d)"
                % (status["temperature"], ceiling, MAX_HEAD_TEMPERATURE)
            )

        await self._send(
            CMD_PRINT,
            bytes([line_count & 0xFF, (line_count >> 8) & 0xFF, 0x30, mode]),
        )
        reply = await self._wait_for(CMD_PRINT)
        if reply is None:
            raise PrinterError("no answer to the print request")
        if reply[0] != 0x00:
            raise PrinterError("print request refused: %s" % reply)

        expected_crc = 0
        sent = 0
        stalls = 0
        # Starts at the calibrated pacing and only ever rises, for this
        # transfer alone. The next print starts optimistic again.
        pace = PACING_MS
        for line in line_source:
            # Retry on EALREADY instead of letting it kill the print.
            #
            # M2 calibrated the pacing on 32-line tickets and concluded 8 ms was
            # twice the floor. It is not enough for a 300-line one: the stack
            # occasionally still has the previous write in flight, raises
            # OSError 114, and the transfer dies half way. The printer then
            # prints what it did receive, which is exactly the truncated ticket
            # M4 saw on long messages.
            #
            # Backing off and retrying the same line keeps the fast path fast -
            # a ticket that never stalls pays nothing - while making a long one
            # survive. The line is only counted once, so the CRC stays correct.
            for attempt in range(WRITE_RETRIES):
                try:
                    await self._data.write(line, response=False)
                    break
                except OSError as exc:
                    if exc.args[0] != _EALREADY or attempt == WRITE_RETRIES - 1:
                        raise
                    stalls += 1
                    # Slow the rest of the transfer down, then wait out this
                    # line at the escalating delay.
                    if pace < PACING_MAX_MS:
                        pace = min(pace + PACING_BACKOFF_MS, PACING_MAX_MS)
                    await asyncio.sleep_ms(pace * (attempt + 2))
            expected_crc = crc8(line, expected_crc)
            sent += 1
            self.last_sent_lines = sent
            await asyncio.sleep_ms(pace)

        self.last_stalls = stalls
        # What the pacing had to climb to. A strip that keeps ending near
        # PACING_MAX_MS is telling us the batch is too long for this link.
        self.last_pace_ms = pace

        if sent != line_count:
            raise PrinterError("announced %d lines, sent %d" % (line_count, sent))

        await self._send(CMD_FLUSH, b"\x00")

        timeout = PRINT_BASE_TIMEOUT_MS + line_count * PRINT_MS_PER_LINE
        done = await self._wait_for(CMD_PRINT_COMPLETE, timeout)
        if done is None:
            return False, expected_crc, None

        self._last_print_ms = time.ticks_ms()
        reported = done[1] if len(done) > 1 else None
        return (reported == expected_crc), expected_crc, reported


    # -- reliability -------------------------------------------------------

    async def connect_with_retry(self, attempts=4, base_ms=1000, device=None,
                                 scan_ms=5000):
        """Connects, retrying with exponential backoff.

        A printer that is merely busy or momentarily out of range recovers on
        a retry. A printer that is asleep never will, so PrinterAsleep is
        raised immediately rather than after four pointless attempts: the
        caller has better things to do than wait on something only a human can
        fix.
        """
        delay = base_ms
        last = None
        for attempt in range(1, attempts + 1):
            try:
                # Lengthen the scan on each retry. A short scan can miss a
                # device that is advertising perfectly well - macOS coalesced
                # advertisements badly enough during M0 to nearly hand us a
                # sleep threshold of 1 minute instead of 10 - so "not found"
                # should not be declared on a brief look.
                return await self.connect(device=device, scan_ms=scan_ms * attempt)
            except PrinterAsleep:
                if attempt < attempts:
                    await asyncio.sleep_ms(delay)
                    delay *= 2
                    continue
                raise
            except Exception as exc:
                last = exc
                await self.disconnect()
                if attempt < attempts:
                    await asyncio.sleep_ms(delay)
                    delay *= 2
        raise PrinterError("connection failed after %d attempts: %s" % (attempts, last))

    async def keepalive(self):
        """One connect/status/disconnect, purely to reset the sleep timer.

        Costs a couple of seconds and no paper. Because BLE does not depend on
        WiFi, this also works at night with the network down, which is what
        would remove the need to press the button every morning.
        """
        try:
            await self.connect_with_retry(attempts=2)
            status = await self.get_status()
            return status
        finally:
            await self.disconnect()

    async def idle_wait(self, total_ms, on_keepalive=None):
        """Waits, slipping in a keepalive often enough that the printer never
        sleeps. This is the shape M3's polling loop will take."""
        waited = 0
        while waited < total_ms:
            step = min(KEEPALIVE_INTERVAL_MS, total_ms - waited)
            await asyncio.sleep_ms(step)
            waited += step
            if waited < total_ms:
                status = await self.keepalive()
                if on_keepalive:
                    on_keepalive(status)

    async def print_with_retry(self, make_source, line_count, attempts=2, **kwargs):
        # kwargs carries intensity, mode and max_temp straight through.
        """Prints, and reprints once if the CRC says bytes were lost.

        make_source is a callable returning a fresh line iterator, because a
        generator cannot be rewound.
        """
        last = None
        for attempt in range(1, attempts + 1):
            ok, computed, reported = await self.print_lines(
                make_source(), line_count, **kwargs
            )
            if ok:
                return True, computed, reported, attempt
            last = (computed, reported)
            if attempt < attempts:
                await asyncio.sleep_ms(2000)
        return False, last[0], last[1], attempts


# --- Test patterns --------------------------------------------------------
# Byte-for-byte identical to the buffers captured in M0, so the CRC the printer
# reports can be compared against a known value:
#   solid black -> 0x7D  (traces c and d)
#   checkerboard -> 0x9A (trace e)
# If the Pico gets the same CRC, its transfer is provably identical to the one
# that came out of the Mac. That is the M1 validation, and it is verifiable by
# machine rather than by eye.

# Padded to 90 lines, byte-identical to the M0 captures c and e.
EXPECTED_CRC_BLACK = 0x7D
EXPECTED_CRC_CHECKER = 0x9A
# The same patterns without padding, as the printer confirmed by echoing them.
EXPECTED_CRC_BLACK_32 = 0x71
EXPECTED_CRC_CHECKER_32 = 0x87


def pattern_solid_black(height=32, total_lines=MIN_LINES):
    """32 black lines, then blank padding up to 90 lines."""
    black = bytes(b"\xff" * WIDTH_BYTES)
    blank = bytes(WIDTH_BYTES)
    for y in range(total_lines):
        yield black if y < height else blank


def pattern_checkerboard(height=32, cell=8, total_lines=MIN_LINES):
    """8x8 checkerboard. Bit 0 of each byte is the leftmost pixel."""
    blank = bytes(WIDTH_BYTES)
    rows = {}
    for band in (0, 1):
        row = bytearray(WIDTH_BYTES)
        for x in range(WIDTH_PIXELS):
            if ((x // cell) + band) % 2 == 0:
                row[x >> 3] |= 1 << (x & 7)
        rows[band] = bytes(row)
    for y in range(total_lines):
        yield rows[(y // cell) % 2] if y < height else blank


def pattern_pacing_probe(total_lines=32):
    """Sparse pattern for calibrating the ae03 pacing.

    A blank image is useless here: CRC8 over a buffer of zeros is zero, and it
    stays zero when lines go missing, so it would certify a pacing that
    silently loses data. Each line therefore carries its own index in its
    first byte. That makes the CRC sensitive both to a lost line and to lines
    arriving out of order, which is the other thing write-without-response
    does not guarantee. Ink cost: a few pixels per line.
    """
    for y in range(total_lines):
        row = bytearray(WIDTH_BYTES)
        row[0] = (y + 1) & 0xFF
        yield bytes(row)


# --- Demo -----------------------------------------------------------------


async def demo(pattern="black"):
    """M1 acceptance run: the Pico alone, on a USB charger, prints and checks."""
    printer = MXW01()
    print("scanning...")
    mtu = await printer.connect()
    print("connected, MTU", mtu)

    status = await printer.get_status()
    print("status:", status)
    print("version:", await printer.get_version())

    if pattern == "checker":
        source, expected = pattern_checkerboard(), EXPECTED_CRC_CHECKER
    else:
        source, expected = pattern_solid_black(), EXPECTED_CRC_BLACK

    ok, computed, reported = await printer.print_lines(source, MIN_LINES)
    print("crc computed 0x%02X, reported %s" % (computed, reported))
    print("transfer intact:", ok)
    print("matches the M0 capture:", computed == expected and reported == expected)

    await printer.disconnect()
    print("disconnected")


if __name__ == "__main__":
    asyncio.run(demo())
