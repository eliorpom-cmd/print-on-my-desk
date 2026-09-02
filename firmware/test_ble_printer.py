#!/usr/bin/env python3
"""Host-side check of the firmware's protocol layer against the M0 captures.

Runs on the Mac, not on the Pico: aioble and bluetooth are stubbed out, and
only the pure byte logic is exercised. The point is to prove that the frames
and the bitmaps the firmware produces are identical to the ones captured from
bleak, before spending any time on hardware.

    python firmware/test_ble_printer.py
"""

import json
import sys
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# --- MicroPython stubs, enough to import the driver on CPython -------------
_bluetooth = types.ModuleType("bluetooth")
_bluetooth.UUID = lambda value: value
sys.modules["bluetooth"] = _bluetooth

_aioble = types.ModuleType("aioble")
_aioble.scan = None
_aioble.config = lambda **kw: None
sys.modules["aioble"] = _aioble

sys.path.insert(0, str(ROOT / "firmware"))
import ble_printer as fw  # noqa: E402

FAILURES = []


def check(label, got, want):
    ok = got == want
    print(f"  {'ok  ' if ok else 'FAIL'} {label}")
    if not ok:
        print(f"       attendu {want!r}")
        print(f"       obtenu  {got!r}")
        FAILURES.append(label)
    return ok


# The captures the replay tests read, and the one place that knows they may not
# be here.
#
# `capture/` is the reverse-engineering bench: dozens of one-shot experiments
# and the traces they produced, several of them pointed at one specific board.
# What they FOUND is published as prose in the protocol document; the traces
# themselves are not, so an open-source checkout has this file and no captures.
#
# A missing bench is not a failing test. It is three tests that cannot run, and
# saying so out loud is better than a FileNotFoundError that reads like a
# broken checkout - which is exactly how CI reported it the first time.
TRACES = ROOT / "capture" / "traces"
HAVE_TRACES = TRACES.is_dir()


def load(trace):
    lines = (TRACES / f"{trace}.jsonl").read_text().splitlines()
    records = [json.loads(l) for l in lines]
    return records[0], records[1:]


def skip_without_traces(what):
    """True when the bench is absent, having said so."""
    if HAVE_TRACES:
        return False
    print(f"\n{what}")
    print(f"  -    skipped: no captures in {TRACES.relative_to(ROOT)}")
    print("       (the capture bench is not part of the public edition)")
    return True


def test_frames_match_captures():
    """Every control frame ever sent must be rebuildable byte for byte."""
    if skip_without_traces("Control frames replayed from the captures"):
        return
    print("\nControl frames replayed from the captures")
    seen = 0
    for trace in ["a", "b", "c", "d", "e", "f"]:
        _, events = load(trace)
        for event in events:
            if event["dir"] != "write" or not event["char"].startswith("0000ae01"):
                continue
            captured = bytes.fromhex(event["hex"])
            cmd_id = captured[2]
            n = captured[4] | (captured[5] << 8)
            payload = captured[6 : 6 + n]
            rebuilt = bytes(fw.build_frame(cmd_id, payload))
            if not check(f"{trace}: 0x{cmd_id:02X} {event['hex']}", rebuilt, captured):
                return
            seen += 1
    print(f"  {seen} trames reconstruites a l'identique")


def test_notifications_parse():
    """The 6+n+1 layout must hold for every notification we ever received."""
    if skip_without_traces("Decodage des notifications capturees"):
        return
    print("\nDecoding the captured notifications")
    total = 0
    for trace in ["a", "b", "c", "d", "e", "f"]:
        _, events = load(trace)
        for event in events:
            if event["dir"] != "notify":
                continue
            raw = bytes.fromhex(event["hex"])
            cmd_id, payload = fw.parse_notification(raw)
            total += 1
            if cmd_id is None:
                check(f"{trace}: {event['hex']}", "non decodee", "decodee")
                return
            # 6 header + payload + exactly one tail byte
            if len(raw) != 7 + len(payload):
                check(f"{trace}: longueur {event['hex']}", len(raw), 7 + len(payload))
                return
            if raw[-1] != 0x00:
                check(f"{trace}: octet de queue", hex(raw[-1]), "0x00")
                return
    print(f"  {total} notifications decoded, all 6+n+1 with a zero tail")


def image_buffer(trace):
    _, events = load(trace)
    return b"".join(
        bytes.fromhex(e["hex"])
        for e in events
        if e["dir"] == "write" and e["char"].startswith("0000ae03")
    )


def test_patterns_match_captures():
    """The hardcoded bitmaps must equal the ones the Mac actually sent."""
    if skip_without_traces("Firmware bitmaps against the captured buffers"):
        return
    print("\nFirmware bitmaps against the captured buffers")
    cases = [
        ("noir plein", "c", fw.pattern_solid_black, fw.EXPECTED_CRC_BLACK),
        ("damier 8x8", "e", fw.pattern_checkerboard, fw.EXPECTED_CRC_CHECKER),
    ]
    for label, trace, pattern, expected_crc in cases:
        captured = image_buffer(trace)
        generated = b"".join(bytes(line) for line in pattern())
        check(f"{label}: taille", len(generated), len(captured))
        check(f"{label}: bytes identical to trace {trace}", generated, captured)
        check(f"{label}: CRC8", fw.crc8(generated), expected_crc)


def test_crc_matches_printer_report():
    """The CRC we compute must equal the one the printer echoed in AA."""
    if skip_without_traces("CRC computed by the firmware against the one the printer returns"):
        return
    print("\nCRC computed by the firmware against the one the printer returns")
    for trace in ["c", "d", "e", "f"]:
        _, events = load(trace)
        aa = next(
            e for e in events if e["dir"] == "notify" and e["hex"].startswith("2221aa")
        )
        _, payload = fw.parse_notification(bytes.fromhex(aa["hex"]))
        check(f"trace {trace}", fw.crc8(image_buffer(trace)), payload[1])


def test_streaming_crc():
    """Incremental CRC over a stream must equal the one-shot CRC."""
    if skip_without_traces("CRC calcule en flux, contre un tampon capture"):
        return
    print("\nIncremental CRC, streamed")
    buffer = image_buffer("f")
    running = 0
    for offset in range(0, len(buffer), fw.WIDTH_BYTES):
        running = fw.crc8(buffer[offset : offset + fw.WIDTH_BYTES], running)
    check("line by line == in one block", running, fw.crc8(buffer))


def test_intensity_cap():
    print("\nIntensity ceiling")
    check("0xC0 is the project ceiling", fw.MAX_INTENSITY, 0xC0)


class _FakeResult:
    """One advertisement, shaped like aioble's ScanResult."""

    def __init__(self, address, name=None, services=()):
        self.device = address
        self._name = name
        self._services = services

    def name(self):
        return self._name

    def services(self):
        return self._services


class _FakeScanner:
    def __init__(self, results):
        self._results = results

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    def __aiter__(self):
        results = self._results

        class _Iter:
            def __init__(self):
                self._i = 0

            def __aiter__(self):
                return self

            async def __anext__(self):
                if self._i >= len(results):
                    raise StopAsyncIteration
                item = results[self._i]
                self._i += 1
                return item

        return _Iter()


def _scan_with(results):
    """Runs one scan against a canned list of advertisements."""
    import asyncio

    _aioble.scan = lambda *a, **kw: _FakeScanner(results)
    printer = fw.MXW01()
    found = asyncio.run(printer.scan(duration_ms=1))
    return printer, found


def test_scan_counts_peers():
    """The peer count is what tells a sleeping printer from a deaf radio.

    A scan that returns nothing is ambiguous on its own: the printer may be
    asleep, or the Pico's shared CYW43 radio may simply not be scanning after
    a WiFi/BLE toggle. Counting the other advertisers settles it.
    """
    print("\nCounting peers during the scan")

    others = [_FakeResult("aa:01", name="Casque"), _FakeResult("aa:02", name="TV")]
    printer, found = _scan_with(others)
    check("printer absent, 2 other peers seen", (found, printer.last_scan_peers),
          (None, 2))

    printer, found = _scan_with([])
    check("scan totalement vide, 0 pair", (found, printer.last_scan_peers), (None, 0))

    with_printer = others + [_FakeResult("bb:01", name=fw.DEVICE_NAME)]
    printer, found = _scan_with(with_printer)
    check("printer found by its name", found, "bb:01")
    check("the preceding peers are counted", printer.last_scan_peers, 3)

    # The same peer advertising repeatedly must count once, or the number
    # stops meaning "how busy is the air around the Pico".
    printer, _ = _scan_with([_FakeResult("aa:01", name="Casque")] * 5)
    check("a repeated peer counts once", printer.last_scan_peers, 1)


def test_asleep_message_carries_peers():
    print("\nThe PrinterAsleep message")
    import asyncio

    _aioble.scan = lambda *a, **kw: _FakeScanner(
        [_FakeResult("aa:01", name="Casque"), _FakeResult("aa:02", name="TV")]
    )
    printer = fw.MXW01()
    try:
        asyncio.run(printer.connect(scan_ms=1))
        check("connect leve PrinterAsleep", False, True)
    except fw.PrinterAsleep as exc:
        check("the peer count is in the message", "2 other peers" in str(exc), True)


def test_paper_is_checked_before_the_error_flag():
    """An empty roll must read as an empty roll, not as a mystery.

    The printer raises error flag 0x01 when the roll runs out, so checking the
    flag first hid the real cause: the loop got a PrinterError it could not
    interpret, never entered its no-paper state, and spun on the printer every
    nineteen seconds. Confirmed on 30 August.
    """
    print("\nOrder of the checks before printing")
    import inspect

    source = inspect.getsource(fw.MXW01.print_lines)
    paper_at = source.index('status["paper_ok"]')
    flag_at = source.index('status["error_flag"] != 0')
    check("paper is tested before the error flag", paper_at < flag_at, True)

    # And the frame travels with an unknown flag, or nobody will ever name it.
    tail = source[flag_at:]
    check_true = tail.find('status["raw"]') != -1
    check("the full frame accompanies an unknown flag", check_true, True)


if __name__ == "__main__":
    test_frames_match_captures()
    test_notifications_parse()
    test_patterns_match_captures()
    test_crc_matches_printer_report()
    test_streaming_crc()
    test_intensity_cap()
    test_scan_counts_peers()
    test_paper_is_checked_before_the_error_flag()
    test_asleep_message_carries_peers()
    print()
    if FAILURES:
        print(f"{len(FAILURES)} echec(s): {', '.join(FAILURES)}")
        sys.exit(1)
    if HAVE_TRACES:
        print("Everything agrees with the M0 captures.")
    else:
        # Not the same claim, and it must not read like it. Five tests replay
        # the M0 captures and they did not run; what passed here is the logic
        # that needs no bench - the framing, the caps, the order of the checks.
        print("Checked without the bench: the capture replays were skipped.")
