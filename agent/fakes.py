# The stand-ins the tests print against, so that nothing here needs a printer.
#
# In their own module rather than in one of the test files, because both test
# files want them and a test file that imports another test file also runs its
# assertions and inherits its exit code.
#
# FakePrinter subclasses the real driver rather than replacing it. Everything
# above the two io methods - the banding, the CRC, the refusals, the feed, the
# bit reversal - is the code that will run on the Pi. Only the bus is fiction.

import escpos_printer as ep


class FakePrinter(ep.TRP100):
    """A TRP100 whose USB bus is a bytearray.

    `paper`, `cover` and `answers` set what the printer will claim about
    itself. `answers=False` is a printer with no bulk IN endpoint - it cannot
    report anything, and must still print.
    """

    def __init__(self, paper=True, cover=False, answers=True, present=True):
        """`present=False` is a printer that is not on the bus at all.

        Distinct from `answers=False`, which is a printer that is there and
        cannot reply. The two used to look the same to the agent, and that was
        a bug worth a test of its own.
        """
        super().__init__()
        self._present = present
        self.sent = bytearray()
        self._paper = paper
        self._cover = cover
        self._answers = answers
        self._out = object()  # anything not None: is_open, and write() proceeds
        self._in = object() if answers else None
        self._pending = []

    def open(self):
        # Already "open". The real one would go to the bus.
        return

    def write(self, data):
        if not self._present:
            self._out = None
            raise ep.PrinterOffline("write failed: no such device")
        data = bytes(data)
        self.sent += data
        # Answer a real-time status request the way the printer would.
        #
        # The four fixed bits are in every reply - bit 0 = 0, bit 1 = 1,
        # bit 4 = 1, bit 7 = 0, which is 0x12 - and the machine confirmed them
        # on 31 August by answering exactly 0x12 with a roll loaded and the lid
        # shut. The fake used to answer 0x00, which no real printer ever sends,
        # so the driver's frame check had nothing to bite on.
        # The values are the machine's own, read on 31 August: 0x12 when all is
        # well, 0x7E on DLE EOT 4 with the roll away, 0x36 on DLE EOT 2 with
        # the lid up. Not invented - a fake that answers bytes no printer sends
        # lets the driver's frame check pass on nonsense.
        if len(data) == 3 and data[0] == ep.DLE and data[1] == ep.EOT:
            reply = ep.TRP100.STATUS_FIXED_BITS
            if data[2] == 4 and not self._paper:
                reply |= 0x6C  # bits 2,3 near end + bits 5,6 roll out -> 0x7E
            elif data[2] == 2:
                if self._cover:
                    reply |= 0x04  # bit 2: cover open
                if not self._paper:
                    reply |= 0x20  # bit 5: stopped on paper end
            self._pending.append(reply)
        return len(data)

    def read(self, length=1, timeout_ms=None):
        if not self._answers or not self._pending:
            return b""
        return bytes([self._pending.pop(0)])


def row(*first_bytes):
    """A full-width row whose leading bytes are given and the rest zero."""
    buf = bytearray(ep.WIDTH_BYTES)
    for i, value in enumerate(first_bytes):
        buf[i] = value
    return bytes(buf)


# --- the Bluetooth printer --------------------------------------------------
#
# Same idea as FakePrinter above, one bus lower: FakeBle replaces bleak's
# client, not the driver. Everything in ble_printer.py above the two
# write_gatt_char calls - the framing, the checksum, the order of the pre-print
# checks, the pacing and its backoff - is the code that will run against a real
# printer. Only the radio is fiction.

import ble_printer as bp


class FakeBleClient:
    """A stand-in for bleak's client that answers like an MXW01.

    `paper`, `temperature` and `error` set what the printer will claim about
    itself. `crc_error` makes it report a checksum that does not match what it
    was sent, which is the one failure that has to be caught rather than
    trusted - see print_lines.
    """

    def __init__(self, driver, paper=True, temperature=25, error=0,
                 crc_error=False, silent=False, stall_every=0):
        self.driver = driver
        self.paper = paper
        self.temperature = temperature
        self.error = error
        self.crc_error = crc_error
        # A printer that is connected and says nothing. Distinct from one that
        # is not there: the driver has to time out rather than hang.
        self.silent = silent
        # Raise on every nth data write, so the retry and the pacing backoff
        # are exercised without a radio.
        self.stall_every = stall_every

        self.is_connected = False
        self.data = bytearray()
        self.control = []
        self.writes = 0
        self._image_crc = 0
        self._announced = 0

    async def connect(self):
        self.is_connected = True

    async def disconnect(self):
        self.is_connected = False

    async def start_notify(self, _char, _handler):
        return None

    async def write_gatt_char(self, char, data, response=False):
        if char == bp.CHAR_DATA:
            self.writes += 1
            if self.stall_every and self.writes % self.stall_every == 0:
                raise OSError("the queue is full")
            self.data.extend(data)
            self._image_crc = bp.crc8(data, self._image_crc)
            return
        self.control.append(bytes(data))
        if not self.silent:
            self._answer(bytes(data))

    def _answer(self, frame):
        cmd, payload = bp.parse_notification(frame)
        if cmd == bp.CMD_STATUS:
            self._notify(cmd, self._status_payload())
        elif cmd == bp.CMD_PRINT:
            self._announced = payload[0] | (payload[1] << 8)
            self._notify(cmd, bytes([0x00]))
        elif cmd == bp.CMD_FEED:
            self._notify(cmd, bytes([0x00]))
        elif cmd == bp.CMD_FLUSH:
            reported = (self._image_crc + 1) & 0xFF if self.crc_error else self._image_crc
            self._notify(bp.CMD_PRINT_DONE, bytes([0x00, reported, reported]))

    def _status_payload(self):
        # Ten bytes, laid out at the offsets docs/09-protocol.md gives: state,
        # then two spare, then supply, temperature, spare, error flag, two
        # spare, paper.
        p = bytearray(10)
        p[0] = 0x00
        p[3] = 0x64
        p[4] = self.temperature & 0xFF
        p[6] = self.error & 0xFF
        p[9] = 0x00 if self.paper else 0x07
        return bytes(p)

    def _notify(self, cmd, payload):
        self.driver._on_notify(None, bp.build_frame(cmd, payload))


class FakeMXW01(bp.MXW01):
    """The real driver, with a bytearray where the radio should be."""

    def __init__(self, **kwargs):
        client = kwargs.pop("client", None)
        super().__init__()
        self._fake = client
        self._fake_kwargs = kwargs

    async def _connect(self):
        if self._fake is None:
            self._fake = FakeBleClient(self, **self._fake_kwargs)
        await self._fake.connect()
        await self._fake.start_notify(bp.CHAR_NOTIFY, self._on_notify)
        self._client = self._fake

    @property
    def bus(self):
        return self._fake
