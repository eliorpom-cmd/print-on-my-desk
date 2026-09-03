# The driver for the AURES TRP 100 III, over USB, in ESC/POS.
#
# The counterpart of firmware/ble_printer.py, and deliberately its shape: same
# exception names, same "refuse before sending" checks, same habit of counting
# what actually went out. The transport is the only thing that changed.
#
# WHAT THIS FILE WILL NEVER SEND
#
# GS V, ESC i and ESC m are the three cut commands (manual, command list,
# section 8). None of them appears anywhere below, and that is the whole
# mechanism by which this printer does not cut: it has a guillotine, it is
# idle, and nothing here wakes it. There is no setting to turn off - a
# receipt printer cuts because its driver told it to.
#
# THE ONE THING THAT IS EASY TO GET WRONG
#
# The bit order is REVERSED between our canvas and ESC/POS.
#
#   worker/src/bitmap.js packs bit 0 of a byte as the LEFTMOST pixel, because
#   that is what the MXW01 capture showed (docs/09-protocol.md 5.1).
#   GS v 0 wants the MOST significant bit as the leftmost pixel, like every
#   other raster format on earth.
#
# Getting this wrong does not produce garbage. It produces a ticket where every
# group of eight pixels is mirrored in place, which at a glance looks like a
# slightly wrong font - so it would survive a look and fail on paper. REVERSE8
# below is the whole fix, and test_escpos_printer.py pins it against a hand-
# computed row.
#
# WHAT WAS LOST IN THE MOVE, AND IT IS WORTH NAMING
#
# The MXW01 echoed back a CRC8 of the image buffer it had received,
# which made a print provable end to end. ESC/POS has nothing of the kind: the
# printer never says what it got. The CRC the Worker sends is still checked
# here, but it only proves D1 -> HTTP -> base64 -> this process. From here to
# the paper there is no receipt, and no amount of ESC/POS makes one.
#
# STATUS DECODING IS CONFIRMED ON THIS MACHINE - 31 August
#
# It was not, for a day, and the file said so. It is now, and every bit below
# was seen to move on the hardware rather than read in a specification:
#
#   roll in, lid shut   DLE EOT 4 = 0x12   DLE EOT 2 = 0x12
#   lid open            DLE EOT 4 = 0x7E   DLE EOT 2 = 0x36
#
# 0x7E lights bits 2,3 (near end) and 5,6 (roll out); 0x36 lights bit 2 (cover
# open) and bit 5 (stopped on paper end). Exactly where the specification puts
# them, and all four readings carry the fixed-bit pattern. Fifteen rounds of
# all four queries came back identical, with no shift.
#
# The machine is a Sewoo underneath - 0525:A700, "Sewoo POS PRINTER" - which is
# worth knowing the day this needs documentation AURES does not publish.

import time

try:
    import usb.core
    import usb.util
except ImportError:  # pragma: no cover - the tests never touch USB
    usb = None


# --- geometry ---------------------------------------------------------------

# 512 dots across, 64 bytes a line, 180 dpi both ways. From the manufacturer's
# manual section 7-1, not from a shop listing: this printer is NOT 576 dots,
# which is what most 80 mm printers do and what one would otherwise assume.
WIDTH_PIXELS = 512
WIDTH_BYTES = 64
DOTS_PER_MM = 180 / 25.4  # 7.0866

# The Worker decides the ticket, always (constraint 7 of the brief). These are
# here to refuse a payload that does not match the machine, not to render.


# --- ESC/POS ----------------------------------------------------------------

ESC = 0x1B
GS = 0x1D
DLE = 0x10
EOT = 0x04

CMD_INIT = bytes([ESC, 0x40])  # ESC @

# GS v 0: print raster bit image. m = 0 is normal size, the only one we use.
RASTER_NORMAL = 0x00

# How many rows go in one GS v 0 command.
#
# The command itself allows 65535, but a receipt printer's input buffer does
# not, and a band that overruns it is dropped rather than refused. Banding also
# buys something the Worker needs: `sent`, the number of lines that actually
# reached the printer before a failure, which is what lets a half-printed strip
# requeue only the tickets that never left (jobs.js, completeBatch).
#
# 128 rows is 8 KB a band at this width. Small enough for any buffer, large
# enough that a full ticket is a handful of writes.
BAND_LINES = 128

# ESC J n: print and feed n vertical motion units. On a 180 dpi printer one
# unit is one dot row, which is the same unit the Worker counts feed_lines in,
# so no conversion. ESC d n would feed n CHARACTER lines instead - about 24
# dots each - and quietly turn a 90-dot feed into 25 cm of paper.
FEED_MAX = 255

# How long to leave the printer alone after ESC @. See open().
INIT_SETTLE_S = 0.3

# The buzzer. NOT in the AURES command list (manual section 8).
#
# The machine plainly has one - it beeps on an error - but no documented
# command sounds it, so this is the one place in the driver that is a guess.
# It is a guess with a reason: the printer is a Sewoo underneath (0525:A700,
# "Sewoo POS PRINTER"), and ESC B n t is the buzzer on Sewoo and Citizen
# hardware. n is how many times, t the length in 100 ms units.
#
# agent/diagnose.py --beep tries the candidates one at a time and asks which
# one made a noise. Until that has been done on the machine, a beep that does
# nothing is harmless: the bytes are ignored by a printer that does not know
# them, and the ticket prints either way.
BEEP_CANDIDATES = [
    ("ESC B n t   (Sewoo, Citizen)", lambda n, t: bytes([ESC, 0x42, n, t])),
    ("BEL         (the ASCII bell)", lambda n, t: bytes([0x07]) * n),
    ("ESC ( A     (Epson buzzer)",
     lambda n, t: bytes([ESC, 0x28, 0x41, 0x05, 0x00, 97, 100, n, t, t])),
    # The drawer kick, and not a mistake in this list.
    #
    # On a lot of POS hardware the buzzer is wired into the cash-drawer port
    # rather than to a command of its own, and this is what fires it. The
    # self-test points that way: it reports "Beep with Cutter: No Beep", which
    # says the buzzer this machine has is tied to the cutter - a thing we never
    # use - and switched off besides. If that is the only path, no ESC/POS
    # buzzer command will ever do anything here.
    ("ESC p       (drawer kick, buzzer on the drawer port)",
     lambda n, t: bytes([ESC, 0x70, 0x00, 50, 50])),
]


def _reverse8_table():
    table = bytearray(256)
    for i in range(256):
        r = 0
        for bit in range(8):
            if i & (1 << bit):
                r |= 1 << (7 - bit)
        table[i] = r
    return bytes(table)


REVERSE8 = _reverse8_table()


def raster_command(rows, width_bytes=WIDTH_BYTES):
    """One GS v 0 command carrying `rows`, with the bit order corrected.

    `rows` is a sequence of width_bytes-long buffers in OUR packing (bit 0 =
    leftmost). What comes back is ready to write to the printer.
    """
    count = len(rows)
    if count == 0:
        raise ValueError("a raster command with no rows is not a command")
    if count > 0xFFFF:
        raise ValueError("a raster command carries at most 65535 rows")
    header = bytes(
        [
            GS,
            0x76,  # 'v'
            0x30,  # '0'
            RASTER_NORMAL,
            width_bytes & 0xFF,
            (width_bytes >> 8) & 0xFF,
            count & 0xFF,
            (count >> 8) & 0xFF,
        ]
    )
    body = bytearray(count * width_bytes)
    at = 0
    for row in rows:
        if len(row) != width_bytes:
            raise ValueError(
                "row is %d bytes, expected %d" % (len(row), width_bytes)
            )
        for byte in row:
            body[at] = REVERSE8[byte]
            at += 1
    return header + bytes(body)


def feed_command(lines):
    """ESC J, as many times as it takes. One unit is one dot row at 180 dpi."""
    if lines <= 0:
        return b""
    out = bytearray()
    left = int(lines)
    while left > 0:
        step = min(left, FEED_MAX)
        out += bytes([ESC, 0x4A, step])
        left -= step
    return bytes(out)


# --- CRC, the same one the Worker computes ----------------------------------


def _crc8_table():
    table = bytearray(256)
    for i in range(256):
        c = i
        for _ in range(8):
            c = ((c << 1) ^ 0x07) & 0xFF if c & 0x80 else (c << 1) & 0xFF
        table[i] = c
    return bytes(table)


_CRC8 = _crc8_table()


def crc8(data, crc=0):
    """CRC-8 Dallas/Maxim, poly 0x07. Identical to worker/src/bitmap.js."""
    for byte in data:
        crc = _CRC8[crc ^ byte]
    return crc


# --- errors, named as the firmware names them -------------------------------


class PrinterError(Exception):
    """Anything the printer or its cable did wrong."""


class PrinterOffline(PrinterError):
    """No printer on the bus, or it stopped answering.

    The USB equivalent of PrinterAsleep, and a much better position to be in:
    the MXW01 could only be woken by its own button, so a sleeping printer was
    an outage until somebody walked over to it. This one is either plugged in
    or it is not, and plugging it back in is the whole fix.
    """


class PrinterNoPaper(PrinterError):
    """The roll is empty, or the cover is open.

    The MXW01 had a silent version of this that cost real messages: it accepted
    the whole buffer with no paper, echoed the correct CRC, and the job went to
    'printed' with nothing on the floor. The check below runs
    BEFORE any raster goes out, for the same reason.
    """


class PrinterCoverOpen(PrinterError):
    """The lid is up. Distinct from no paper, because the fix is different."""


# --- the driver -------------------------------------------------------------


class TRP100:
    """A TRP 100 III on the USB bus.

    Found by USB class rather than by vendor and product id. The printer class
    is 7, which is in the descriptor of every USB printer ever made, whereas the
    ids differ between production runs of the same model - and guessing an id
    from a forum post is how a driver stops working after a hardware revision
    nobody told you about. config.py may still pin them when there are two
    printers on one bus.
    """

    PRINTER_CLASS = 0x07

    def __init__(self, vendor_id=None, product_id=None, timeout_ms=5000):
        self.vendor_id = vendor_id
        self.product_id = product_id
        self.timeout_ms = timeout_ms
        self.device = None
        self._out = None
        self._in = None
        self._detached = None

        # What the last print did, for the heartbeat and for the Worker's
        # partial-failure arithmetic.
        self.last_sent_lines = 0
        self.last_crc = None

    # -- connection -----------------------------------------------------

    def _find(self):
        if usb is None:
            raise PrinterError(
                "pyusb is not installed. pip3 install pyusb  (or -r agent/requirements.txt)"
            )
        try:
            if self.vendor_id and self.product_id:
                device = usb.core.find(idVendor=self.vendor_id, idProduct=self.product_id)
                if device is None:
                    raise PrinterOffline(
                        "no USB device %04x:%04x" % (self.vendor_id, self.product_id)
                    )
                return device
            device = usb.core.find(
                custom_match=lambda d: any(
                    interface.bInterfaceClass == self.PRINTER_CLASS
                    for configuration in d
                    for interface in configuration
                )
            )
        except usb.core.NoBackendError:
            # The first error anybody hits, and pyusb's own message for it is
            # "No backend available" with no hint of what a backend is. pyusb
            # is only bindings; libusb is the thing that talks to the bus, and
            # it is a separate install that pip will not do for you.
            raise PrinterError(
                "libusb is missing. pyusb is only the bindings.\n"
                "  Raspberry Pi / Debian:  sudo apt install libusb-1.0-0\n"
                "  macOS:                  brew install libusb"
            )
        if device is None:
            raise PrinterOffline("no USB printer-class device on the bus")
        return device

    def open(self, attempts=3, pause_s=1.0):
        """Claims the printer. Idempotent.

        Retries, because this printer LEAVES THE BUS. Observed on 31 August:
        taking the roll out, or opening the lid, makes it vanish - writes fail
        with errno 19, ENODEV, "No such device" - and it comes back as a newly
        enumerated device once the fault is cleared. Coming back takes longer
        than the first attempt allows, so a single try reports a printer that
        is on its way back as one that is gone.
        """
        if self._out is not None:
            return
        last = None
        for attempt in range(attempts):
            try:
                return self._open_once()
            except PrinterOffline as err:
                last = err
                if attempt + 1 < attempts:
                    time.sleep(pause_s)
        raise last

    def _open_once(self):
        device = self._find()

        # usblp binds printer-class devices at plug time and owns the endpoints
        # until it is asked to let go. Without this, every write fails with
        # "Resource busy" and the message reads like a permissions problem,
        # which sends you into udev rules that were never wrong.
        for configuration in device:
            for interface in configuration:
                number = interface.bInterfaceNumber
                try:
                    if device.is_kernel_driver_active(number):
                        device.detach_kernel_driver(number)
                        self._detached = number
                except (NotImplementedError, usb.core.USBError):
                    # Not every platform has kernel drivers to detach.
                    pass

        device.set_configuration()
        configuration = device.get_active_configuration()
        interface = next(
            (
                candidate
                for candidate in configuration
                if candidate.bInterfaceClass == self.PRINTER_CLASS
            ),
            configuration[(0, 0)],
        )

        self._out = usb.util.find_descriptor(
            interface,
            custom_match=lambda e: usb.util.endpoint_direction(e.bEndpointAddress)
            == usb.util.ENDPOINT_OUT,
        )
        # Bidirectional is optional on a USB printer. Without a bulk IN there
        # is no status at all, which is a real loss - it is how the empty roll
        # is caught - but not a reason to refuse to print.
        self._in = usb.util.find_descriptor(
            interface,
            custom_match=lambda e: usb.util.endpoint_direction(e.bEndpointAddress)
            == usb.util.ENDPOINT_IN,
        )
        if self._out is None:
            raise PrinterError("the printer exposes no bulk OUT endpoint")
        self.device = device
        self.write(CMD_INIT)  # may raise, which _open_once's caller retries
        # ESC @ is a reset, and the printer is not listening while it runs.
        #
        # A fixed delay was tried first and was not enough. On 31 August, with
        # 300 ms, the first query of the run still went unanswered - and worse,
        # its answer turned up later and was read as the answer to the NEXT
        # question. DLE EOT 1 reported nothing and DLE EOT 2 reported 0x16,
        # which is DLE EOT 1's value; every reading after that was one question
        # behind. That is a silent wrong answer, not a missing one.
        #
        # So the delay is followed by a throwaway question. Whatever it costs
        # in time, it is asked while nothing depends on the answer, and the
        # drain that follows guarantees the pipe is empty before the first
        # question anybody cares about.
        time.sleep(INIT_SETTLE_S)
        try:
            self._ask(1, timeout_ms=2000)
        except PrinterError:
            pass
        self.drain()

    def close(self):
        if self.device is not None:
            try:
                usb.util.dispose_resources(self.device)
            except Exception:
                pass
        self.device = None
        self._out = None
        self._in = None

    @property
    def is_open(self):
        return self._out is not None

    # -- raw io ---------------------------------------------------------

    def write(self, data):
        if self._out is None:
            raise PrinterOffline("printer is not open")
        try:
            return self._out.write(data, self.timeout_ms)
        except Exception as err:  # pyusb raises USBError, and USBTimeoutError
            # Drop the handle before raising. It refers to a device that is no
            # longer there, and open() returns early when it is set - so
            # without this, unplugging the printer and plugging it back in
            # would leave the agent writing into a dead handle forever, and the
            # only cure would be restarting the service. Somebody will unplug
            # it; that is what USB cables are for.
            self.close()
            raise PrinterOffline("write failed: %s" % err)

    def read(self, length=1, timeout_ms=None):
        if self._in is None:
            return b""
        try:
            data = self._in.read(length, timeout_ms or self.timeout_ms)
            return bytes(data)
        except Exception:
            # A status read that times out means "it did not answer", which is
            # information, not a fault. Callers treat empty as unknown.
            return b""

    # -- status ---------------------------------------------------------

    def status(self):
        """What the printer says about itself, or {} when it says nothing.

        The bit meanings were confirmed on the hardware on 31 August - see the
        header, and docs/10-escpos.md section 3 for the readings.

        Returns a dict with `paper`, `cover` and `raw`, any of which may be
        None when the printer did not answer.

        "Did not answer" means it took the question and said nothing, which is
        what a printer with no bulk IN endpoint does. A printer that is not
        THERE raises PrinterOffline instead, and the difference matters: the
        first must still be allowed to print, the second must not be asked to.
        """
        out = {"paper": None, "cover": None, "near_end": None, "raw": {}}
        if self._in is None:
            return out

        # DLE EOT 4: paper roll sensor. Real-time, so it answers even when the
        # printer is busy - which is the point, and why this is not GS r.
        paper = self._dle_eot(4)
        if paper is not None:
            out["raw"]["paper"] = paper
            # Bits 5 and 6 together: the roll is out. Confirmed on the machine,
            # which answered 0x7E with the lid open - the roll lifts off the
            # sensor - against 0x12 with it shut.
            out["paper"] = not (paper & 0x60 == 0x60)
            # Bits 2 and 3: near end. Reported for the paper gauge, and worth
            # having because the self-test says "Paper-Low Detect: OFF" and
            # these bits were seen set anyway. Whether they ever fire on a roll
            # that is merely LOW, rather than absent, is still unknown.
            out["near_end"] = paper & 0x0C == 0x0C

        # DLE EOT 2: offline cause. Two bits matter, and they are a second
        # opinion rather than a duplicate - bit 5 is the printer saying it
        # STOPPED because of paper, which is the condition we actually care
        # about, while EOT 4 is a sensor reading.
        offline = self._dle_eot(2)
        if offline is not None:
            out["raw"]["offline"] = offline
            out["cover"] = bool(offline & 0x04)
            if offline & 0x20:
                out["paper"] = False
        return out

    def drain(self):
        """Throws away anything still sitting in the IN endpoint.

        Without this, a reply that arrived too late to be read is still in the
        pipe, and the NEXT question reads it as its own answer. Every reply
        after that is one question behind, and since a healthy answer to two
        different questions can be the same byte, nothing looks wrong.

        Observed on the machine, 31 August: DLE EOT 4 read nothing and DLE
        EOT 2 read 0x12 - which is a valid answer to either, so the shift was
        invisible in the result and only showed as the first query "failing".
        """
        dropped = 0
        while True:
            leftover = self.read(1, timeout_ms=50)
            if not leftover:
                return dropped
            dropped += 1
            if dropped > 64:  # something is talking continuously; stop asking
                return dropped

    # Every real-time status reply carries the same four fixed bits: bit 0 = 0,
    # bit 1 = 1, bit 4 = 1, bit 7 = 0. Masked, that is exactly 0x12.
    #
    # This is spec-derived, but unlike the meaning of the other bits it is
    # CHECKABLE, and the machine confirmed it on the first byte it ever sent
    # back: 0x12 exactly. It is worth checking on every read, because it is
    # what tells a status byte apart from a byte of something else that
    # happened to be in the pipe.
    STATUS_FIXED_MASK = 0x93
    STATUS_FIXED_BITS = 0x12

    def _dle_eot(self, n, timeout_ms=1500):
        """Asks, and drains first so no stale byte can be mistaken for this."""
        self.drain()
        return self._ask(n, timeout_ms)

    def _ask(self, n, timeout_ms=1500):
        # Deliberately NOT catching PrinterOffline.
        #
        # It used to, and returned None - the same answer as "the printer has
        # no way to reply". So a printer that had been unplugged reported
        # paper=None, cover=None, which the agent read as "nothing wrong" and
        # went on claiming jobs. Each one was handed out, failed instantly, and
        # charged an attempt; three rounds of that and a message was dead, for
        # a reason its author had nothing to do with. That this must not
        # happen is the whole point of the rule.
        self.write(bytes([DLE, EOT, n]))
        # Read in slices rather than in one long wait. The first query after
        # ESC @ was the one that timed out on the machine, and a printer that
        # is slow once should not make every later answer late as well.
        waited = 0
        while waited < timeout_ms:
            answer = self.read(1, timeout_ms=250)
            waited += 250
            if not answer:
                continue
            byte = answer[0]
            if byte & self.STATUS_FIXED_MASK == self.STATUS_FIXED_BITS:
                return byte
            # Not a status byte at all. Keep reading rather than returning it:
            # returning it would put a meaning on a byte that has none.

        # Timed out. Give the late answer a last chance to arrive and throw it
        # away, because the alternative is that the NEXT question reads it and
        # believes it. A missing reading is visible; a shifted one is not.
        time.sleep(0.3)
        self.drain()
        return None

    def require_paper(self):
        """Raises before a print rather than discovering it afterwards.

        Silent about a printer that does not answer, on purpose: a machine with
        no bulk IN endpoint would otherwise never print at all. A missing
        status is 'unknown', and unknown is not 'empty'.
        """
        state = self.status()
        if state["cover"]:
            raise PrinterCoverOpen("the lid is open")
        if state["paper"] is False:
            raise PrinterNoPaper("the roll is empty")

    # -- printing -------------------------------------------------------

    def print_lines(self, rows, line_count, width_bytes=WIDTH_BYTES, feed_lines=0):
        """Sends one image, band by band, and feeds to the tear bar.

        `rows` is an iterable of width_bytes-long buffers, in transmission
        order. It is consumed once and never held whole: the Pi has the memory
        for the image, but streaming keeps this function honest about what it
        has actually written when something fails half way.

        Returns the CRC8 of everything sent, over OUR packing - so it can be
        compared with what the Worker announced, which is computed the same way.
        `self.last_sent_lines` is how far it got, which is what the Worker
        needs to rescue the tickets that never left.
        """
        self.require_paper()
        self.last_sent_lines = 0
        crc = 0
        band = []

        def flush():
            nonlocal crc, band
            if not band:
                return
            self.write(raster_command(band, width_bytes))
            for row in band:
                crc = crc8(row, crc)
            self.last_sent_lines += len(band)
            band = []

        for row in rows:
            band.append(row)
            if len(band) >= BAND_LINES:
                flush()
        flush()

        if self.last_sent_lines != line_count:
            raise PrinterError(
                "sent %d lines, the job said %d"
                % (self.last_sent_lines, line_count)
            )

        # The feed goes out only once the image has, so a transfer that dies
        # half way does not also advance the paper past what it managed to
        # print. Never zero: a ticket still under the head is a ticket nobody
        # can tear off.
        if feed_lines:
            self.write(feed_command(feed_lines))

        self.last_crc = crc
        return crc

    def feed(self, lines):
        self.write(feed_command(lines))

    def beep(self, times=3, length=2, variant=0):
        """Makes a noise, if this printer knows how.

        Sent BEFORE the print rather than after, so the noise and the paper
        arrive together rather than the noise arriving once the ticket is
        already on the floor.

        A printer that does not recognise these bytes drops them, and a
        thank-you that fails to beep is still a thank-you. Only a dead cable is
        worth failing over, and write() already raises for that.
        """
        _, build = BEEP_CANDIDATES[variant % len(BEEP_CANDIDATES)]
        self.write(build(max(1, min(times, 9)), max(1, min(length, 9))))


def iter_lines(data, width_bytes=WIDTH_BYTES):
    """Slices a flat image buffer into rows, without copying it whole."""
    view = memoryview(data)
    for at in range(0, len(view), width_bytes):
        yield bytes(view[at : at + width_bytes])
