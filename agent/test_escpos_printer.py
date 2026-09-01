# Host tests for the ESC/POS driver. No printer, no USB, no paper.
#
#   python3 agent/test_escpos_printer.py
#
# The counterpart of firmware/test_ble_printer.py, and it exists for the same
# reason: the bytes are the contract, and the only way to keep a driver honest
# without spending a roll is to assert on them.
#
# Two of these tests are worth more than the rest.
#
#   "no cut command ever leaves this driver" is the one the owner asked for in so
#   many words. It greps every byte the driver produces for GS V, ESC i and
#   ESC m, on a realistic print. A regression here is not a wrong pixel, it is
#   a ticket in two pieces.
#
#   "the bit order is reversed, and the reversal is right" is the one most
#   likely to be got wrong by someone reading only the ESC/POS spec. Our canvas
#   packs bit 0 as the leftmost pixel; GS v 0 wants bit 7. The failure mode is
#   subtle enough to survive a glance at the paper.

import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import escpos_printer as ep
from fakes import FakePrinter, row


PASS = 0
FAIL = 0


def check(name, condition, detail=""):
    global PASS, FAIL
    if condition:
        PASS += 1
        print("  ok   %s" % name)
    else:
        FAIL += 1
        print("  FAIL %s %s" % (name, detail))


def raises(name, exception, fn):
    try:
        fn()
    except exception:
        check(name, True)
        return
    except Exception as err:
        check(name, False, "raised %r instead" % err)
        return
    check(name, False, "did not raise")


# --- bit order --------------------------------------------------------------

print("\nbit order")

check(
    "REVERSE8 is an involution",
    all(ep.REVERSE8[ep.REVERSE8[i]] == i for i in range(256)),
)
check("REVERSE8[0x01] is 0x80", ep.REVERSE8[0x01] == 0x80)
check("REVERSE8[0x0F] is 0xF0", ep.REVERSE8[0x0F] == 0xF0)
check("REVERSE8[0xA5] is 0xA5", ep.REVERSE8[0xA5] == 0xA5)

# A row with only the leftmost pixel of the whole line inked. In our packing
# that is bit 0 of byte 0; on the wire it has to be bit 7, or the pixel lands
# eight dots to the right and every glyph is mirrored inside its byte.
command = ep.raster_command([row(0x01)])
check(
    "the bit order is reversed, and the reversal is right",
    command[8] == 0x80,
    "wire byte is 0x%02X, expected 0x80" % command[8],
)

# And the other end of the byte, so a table that reversed nothing would fail
# one of the two.
check("the rightmost pixel of a byte moves to bit 0", ep.raster_command([row(0x80)])[8] == 0x01)


# --- GS v 0 header ----------------------------------------------------------

print("\nGS v 0")

command = ep.raster_command([row(0xFF) for _ in range(3)])
check("starts with GS v 0", command[0:3] == bytes([0x1D, 0x76, 0x30]))
check("mode is normal size", command[3] == 0x00)
check("width is 64 bytes, little endian", command[4] == 64 and command[5] == 0)
check("height is the row count, little endian", command[6] == 3 and command[7] == 0)
check("body is exactly rows x width", len(command) == 8 + 3 * 64)

# 300 rows exercises the high byte, which a 128-row band never would.
tall = ep.raster_command([row(0x01) for _ in range(300)])
check("a height over 255 fills the high byte", tall[6] == 300 & 0xFF and tall[7] == 1)

raises("a raster command with no rows is refused", ValueError, lambda: ep.raster_command([]))
raises(
    "a row of the wrong width is refused",
    ValueError,
    lambda: ep.raster_command([bytes(48)]),
)


# --- feed -------------------------------------------------------------------

print("\nfeed")

check("ESC J carries the dot count", ep.feed_command(90) == bytes([0x1B, 0x4A, 90]))
check("no feed is no bytes", ep.feed_command(0) == b"")
check("a negative feed is no bytes", ep.feed_command(-5) == b"")
# 600 dots is 8.5 cm, more than one ESC J can express.
check(
    "a feed over 255 is split rather than truncated",
    ep.feed_command(600) == bytes([0x1B, 0x4A, 255, 0x1B, 0x4A, 255, 0x1B, 0x4A, 90]),
)
check(
    "the split feeds add up to what was asked",
    sum(ep.feed_command(600)[2::3]) == 600,
)


# --- CRC, against the Worker ------------------------------------------------

print("\nCRC")

# 0x14 is what worker/src/bitmap.js computes for the bytes 0..255. Not copied
# from this file's own output: run
#   node -e "import('./worker/src/bitmap.js').then(m=>console.log(m.crc8(Uint8Array.from({length:256},(_,i)=>i))))"
# The two implementations have to agree or the check in print_lines is theatre.
check(
    "crc8 agrees with the Worker on 0..255",
    ep.crc8(bytes(range(256))) == 0x14,
    "got 0x%02X" % ep.crc8(bytes(range(256))),
)
check("crc8 of nothing is zero", ep.crc8(b"") == 0)


# --- printing ---------------------------------------------------------------

print("\nprinting")

printer = FakePrinter()
rows = [row(i & 0xFF, 0x5A) for i in range(300)]
crc = printer.print_lines(iter(rows), 300, feed_lines=90)

check("every line was sent", printer.last_sent_lines == 300)
check(
    "the CRC is over our packing, not the wire's",
    crc == ep.crc8(b"".join(rows)),
)
check(
    "300 lines are banded into three commands",
    printer.sent.count(bytes([0x1D, 0x76, 0x30])) == 3,
    "found %d" % printer.sent.count(bytes([0x1D, 0x76, 0x30])),
)
check("the feed comes after the image", printer.sent.rindex(bytes([0x1B, 0x4A])) > printer.sent.rindex(bytes([0x1D, 0x76, 0x30])))

# The whole point of the exercise.
print("\nthe cutter")
check(
    "no cut command ever leaves this driver",
    bytes([0x1D, 0x56]) not in printer.sent  # GS V
    and bytes([0x1B, 0x69]) not in printer.sent  # ESC i
    and bytes([0x1B, 0x6D]) not in printer.sent,  # ESC m
)
# ESC @ and ESC J share a prefix with nothing dangerous, but a driver that grew
# a cut by accident would most likely grow it in the feed path.
check(
    "a feed of any size stays clear of the cut opcodes",
    all(
        bytes([0x1D, 0x56]) not in ep.feed_command(n)
        and bytes([0x1B, 0x69]) not in ep.feed_command(n)
        and bytes([0x1B, 0x6D]) not in ep.feed_command(n)
        for n in (1, 90, 255, 256, 600, 5000)
    ),
)


# --- refusals ---------------------------------------------------------------

print("\nrefusals")

raises(
    "an empty roll is refused before a byte of image goes out",
    ep.PrinterNoPaper,
    lambda: FakePrinter(paper=False).print_lines(iter([row(0xFF)]), 1),
)

empty = FakePrinter(paper=False)
try:
    empty.print_lines(iter([row(0xFF)]), 1)
except ep.PrinterNoPaper:
    pass
check(
    "and nothing of the image was written",
    bytes([0x1D, 0x76, 0x30]) not in empty.sent,
)

raises(
    "an open lid is refused, and is not called 'no paper'",
    ep.PrinterCoverOpen,
    lambda: FakePrinter(cover=True).print_lines(iter([row(0xFF)]), 1),
)

raises(
    "a short image is a failure, not a short ticket",
    ep.PrinterError,
    lambda: FakePrinter().print_lines(iter([row(0xFF)]), 5),
)

# A printer with no bulk IN cannot answer, and must still print. This was worth
# a test because the obvious implementation - "no status means refuse" - turns
# a one-way cable into a service that never prints anything, with a message
# that says the roll is empty.
silent = FakePrinter(answers=False)
silent.print_lines(iter([row(0xFF)]), 1)
check("a printer that cannot answer still prints", silent.last_sent_lines == 1)


# --- iter_lines -------------------------------------------------------------

print("\niter_lines")

flat = bytes(range(256)) * 16  # 4096 bytes = 64 rows of 64
sliced = list(ep.iter_lines(flat))
check("slices into full-width rows", len(sliced) == 64 and all(len(r) == 64 for r in sliced))
check("and loses nothing", b"".join(sliced) == flat)


print("\n%d ok, %d failed" % (PASS, FAIL))
sys.exit(1 if FAIL else 0)
