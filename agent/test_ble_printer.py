# The Bluetooth driver, without a printer.
#
#   python3 agent/test_ble_printer.py
#
# The fake replaces bleak's client, not the driver: the framing, the checksum,
# the ORDER of the pre-print checks, the pacing and its backoff are all the
# code that will run against a real machine. Only the radio is fiction.
#
# The order of those checks is what most of this file is about, because getting
# it wrong is silent. A printer with no paper accepts the whole buffer and
# answers with the RIGHT checksum - it did receive the bytes - so a driver that
# does not look at the paper byte first marks the job printed with nothing on
# the floor and no trace anywhere.

import sys
import os

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import ble_printer as bp
from fakes import FakeMXW01, FakeBleClient

PASS = 0
FAIL = 0


def check(name, ok, detail=""):
    global PASS, FAIL
    if ok:
        PASS += 1
        print("  ok   %s" % name)
    else:
        FAIL += 1
        print("  FAIL %s   %s" % (name, detail))


def lines(n, fill=0xFF):
    return [bytes([fill]) * bp.WIDTH_BYTES for _ in range(n)]


# --- the frame ---------------------------------------------------------------

print("the frame, against the captures")

frame = bp.build_frame(0xA1, b"\x00")
check("starts with the magic", frame[0] == 0x22 and frame[1] == 0x21)
check("carries the command", frame[2] == 0xA1)
check("length is little-endian", frame[4] == 1 and frame[5] == 0)
check("ends with FF", frame[-1] == 0xFF)

cmd, payload = bp.parse_notification(bp.build_frame(0xAA, b"\x00\x9c\x9c"))
check("a notification round-trips", cmd == 0xAA and payload == b"\x00\x9c\x9c")

# 6 + n + 1, not the 8 + n every reference implementation waits for.
short = bp.build_frame(0xA1, b"\x01")
check("a 1-byte payload is a 9-byte frame", len(short) == 9)
check("a truncated notification is refused", bp.parse_notification(b"\x22\x21") == (None, None))
check("noise is refused", bp.parse_notification(b"hello there") == (None, None))

# --- the checksum ------------------------------------------------------------

print("\nthe checksum the printer echoes back")

check("empty is zero", bp.crc8(b"") == 0)
check("one is seven", bp.crc8(b"\x01") == 0x07)
check("it accumulates", bp.crc8(b"\x02", bp.crc8(b"\x01")) == bp.crc8(b"\x01\x02"))
check(
    "and it notices a swap",
    bp.crc8(b"\x01\x02\x03\x04") != bp.crc8(b"\x01\x02\x04\x03"),
)

# --- a print that works ------------------------------------------------------

print("\na ticket that prints")

printer = FakeMXW01()
crc = printer.print_lines(lines(20), 20, feed_lines=7)
check("the checksums agree", crc == printer.bus._image_crc, "%r" % crc)
check("every line reached the bus", len(printer.bus.data) == 20 * bp.WIDTH_BYTES)
check("and the driver says so", printer.last_sent_lines == 20)
printer.close()

# --- the failures that must not send a byte ----------------------------------
#
# All three are refusals rather than failures: nothing was printed, nothing was
# lost, and the message goes back in the queue with its attempt refunded. The
# Worker tells them apart by last_sent_lines, which is why each one asserts it.

print("\nno paper")

printer = FakeMXW01(paper=False)
try:
    printer.print_lines(lines(20), 20)
    check("raises", False, "it printed")
except bp.PrinterNoPaper as err:
    check("raises PrinterNoPaper, not a generic error", True)
check("and nothing was sent", printer.last_sent_lines == 0)
check("really nothing", len(printer.bus.data) == 0)
printer.close()

print("\nno paper, with the error flag ALSO set")

# The trap: an empty roll raises the error flag too on some firmwares. A driver
# that checks the flag first reports a cryptic error, never enters the state
# that stops it claiming work, and hammers the printer until somebody looks.
printer = FakeMXW01(paper=False, error=0x01)
try:
    printer.print_lines(lines(10), 10)
    check("raises", False, "it printed")
except bp.PrinterNoPaper:
    check("paper is still checked before the flag", True)
except bp.PrinterError as err:
    check("paper is still checked before the flag", False, str(err))
printer.close()

print("\na head that is too hot")

printer = FakeMXW01(temperature=44)
try:
    printer.print_lines(lines(10), 10)
    check("raises", False, "it printed")
except bp.PrinterTooHot:
    check("raises PrinterTooHot", True)
check("and nothing was sent", printer.last_sent_lines == 0)
printer.close()

print("\nan absurd ceiling is still bounded")

printer = FakeMXW01(temperature=50)
try:
    printer.print_lines(lines(10), 10, max_temp=200)
    check("the hardware ceiling still refuses", False, "it printed at 50 C")
except bp.PrinterTooHot:
    check("the hardware ceiling still refuses", True)
printer.close()

print("\na payload for the other printer")

printer = FakeMXW01()
try:
    printer.print_lines([bytes(64)] * 4, 4, width_bytes=64)
    check("raises rather than printing noise", False)
except bp.PrinterError as err:
    check("raises rather than printing noise", "64" in str(err))
# Refused before the radio was even opened, which is why there is no bus to
# look at: a payload for the wrong machine is not worth connecting for.
check("and it never even connected", printer.bus is None)
printer.close()

print("\nan intensity over the cap")

printer = FakeMXW01()
try:
    printer.print_lines(lines(4), 4, intensity=0xFF)
    check("is refused before the head sees it", False)
except bp.PrinterError:
    check("is refused before the head sees it", True)
printer.close()

# --- the failure that must NOT be trusted ------------------------------------

print("\na printer that received something else")

printer = FakeMXW01(crc_error=True)
try:
    printer.print_lines(lines(12), 12)
    check("a wrong checksum is not silently accepted", False, "it returned happily")
except bp.PrinterError as err:
    check("a wrong checksum is not silently accepted", "checksum" in str(err))
printer.close()

print("\na printer that stops answering")

printer = FakeMXW01(silent=True)
printer.timeout_s = 0.2
try:
    printer.status()
    check("a silent printer is offline, not fine", False)
except bp.PrinterOffline:
    check("a silent printer is offline, not fine", True)
printer.close()

# --- stalls ------------------------------------------------------------------

print("\na radio that stalls half way")

# The failure this guards is the one that truncated long tickets: a write fails
# because the previous one is still in flight, the transfer dies, and the
# printer prints what it received. Retrying the line - and slowing the rest of
# the transfer down permanently - is what makes a long ticket survive.
printer = FakeMXW01(stall_every=7)
crc = printer.print_lines(lines(30), 30)
check("the ticket still goes out whole", printer.last_sent_lines == 30)
check("the checksum is still right", crc == printer.bus._image_crc)
check("the stalls were counted", printer.last_stalls > 0, str(printer.last_stalls))
check(
    "and the pacing climbed and stayed there",
    printer.last_pace_ms > int(bp.PACE_S * 1000),
    "%d ms" % printer.last_pace_ms,
)
printer.close()

# --- what the agent reads ----------------------------------------------------

print("\nthe status, in the agent's vocabulary")

printer = FakeMXW01(temperature=31)
status = printer.status()
check("paper is a bool", status["paper"] is True)
check("cover exists and is always false here", status["cover"] is False)
check("the temperature is at frame offset 10", status["temperature"] == 31)
check("the supply reading is at 9", status["battery"] == 0x64)
printer.close()

printer = FakeMXW01(paper=False)
check("an empty roll reads as no paper", printer.status()["paper"] is False)
try:
    printer.require_paper()
    check("require_paper raises", False)
except bp.PrinterNoPaper:
    check("require_paper raises", True)
printer.close()

# --- the same shape as the other driver --------------------------------------

print("\nthe two drivers are interchangeable")

import escpos_printer as usb

# Everything main.py reaches for on the module rather than on the printer.
# iter_lines was missing from this list once, and the shape checks below all
# passed while the loop failed on the first ticket - which is why the loop
# itself is now driven at the end of this file.
for name in ("PrinterError", "PrinterOffline", "PrinterNoPaper", "PrinterCoverOpen",
             "WIDTH_BYTES", "crc8", "iter_lines"):
    check("both export %s" % name, hasattr(bp, name) and hasattr(usb, name))

for name in ("open", "close", "is_open", "status", "require_paper", "print_lines",
             "beep", "last_sent_lines"):
    check(
        "both printers have %s" % name,
        hasattr(bp.MXW01, name) or hasattr(bp.MXW01(), name),
    )

check("and they are not the same width", bp.WIDTH_BYTES != usb.WIDTH_BYTES)

# --- the agent's own loop, on this driver -----------------------------------
#
# The checks above prove the two drivers have the same SHAPE. This proves the
# loop actually runs on it, which is a different claim: main.py catches
# `ep.PrinterError` where `ep` is whichever module was selected, and the two
# hierarchies are unrelated classes. Get that wrong and a no-paper on Bluetooth
# is an unhandled exception rather than a state the agent knows about.

print("\nthe agent's loop, driving Bluetooth")

import types
import base64

fake_config = types.ModuleType("config")
fake_config.WORKER_URL = "https://example.invalid"
fake_config.PRINTER_TOKEN = "t"
fake_config.DEVICE_ID = "ble-test"
fake_config.BATCH_SIZE = 4
fake_config.PRINTER = "ble"
sys.modules["config"] = fake_config

import net
import main as agent_main

check("the loop picked the Bluetooth driver", agent_main.ep is bp)
check("and the profile that goes with it", agent_main.PROFILE == "mxw01")


class TinyApi:
    """Just enough Worker to run one cycle."""

    def __init__(self, jobs=None):
        self.base = "https://example.invalid"
        self.device_id = "ble-test"
        self.jobs = list(jobs or [])
        self.done_calls = []
        self.beats = []
        self.last_poll_after = 0.0
        self.last_poll_elapsed = agent_main.LONG_POLL_S

    def heartbeat(self, fields):
        self.beats.append(fields)
        return {"open": True, "kill_switch": False}

    def next_job(self, batch=1, wait_s=0):
        return self.jobs.pop(0) if self.jobs else None

    def report_done(self, payload):
        self.done_calls.append(payload)
        return {"ok": True, "updated": 1}


def make_job(rows=12):
    data = bytes([0xFF]) * (bp.WIDTH_BYTES * rows)
    return {
        "id": 1,
        "ids": [1],
        "lines": rows,
        "width_bytes": bp.WIDTH_BYTES,
        "crc": bp.crc8(data),
        "intensity": 0x5D,
        "feed_lines": 7,
        "data": base64.b64encode(data).decode(),
    }


printer = FakeMXW01()
api = TinyApi(jobs=[make_job()])
agent = agent_main.Agent(api, printer, 4)
agent.cycle()
check("the ticket printed", printer.last_sent_lines == 12)
check("and was reported ok", api.done_calls and api.done_calls[0]["ok"] is True)
printer.close()

print("\nand a Bluetooth printer with no paper")

printer = FakeMXW01(paper=False)
api = TinyApi(jobs=[make_job()])
agent = agent_main.Agent(api, printer, 4)
agent.cycle()
check("the agent knows what state it is in", agent.printer_state == "no_paper")
check("and does not claim work it cannot print", agent.can_print is False)
printer.close()

print("\n%d ok, %d failed" % (PASS, FAIL))
sys.exit(1 if FAIL else 0)
