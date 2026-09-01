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
