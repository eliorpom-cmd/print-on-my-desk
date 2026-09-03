#!/usr/bin/env python3
"""Host test of the M3 loop: no Pico, no printer, no network, no paper.

test_ble_printer.py proves the driver builds the right bytes. test_sequence.py
proves it runs the right sequence. This one proves the loop around it obeys the
two rules the whole milestone rests on:

  1. THE NINE-MINUTE RULE. The printer sleeps after ~10 minutes without a GATT
     connection and only its button revives it. Every path through the loop -
     including "the WiFi is down and every request times out" - has to come
     back to the radio inside that window. The clock here is simulated, so a
     whole night runs in a fraction of a second and an overrun is a failed
     assertion instead of a dead service discovered the next morning.

  2. CONSTRAINT 6. WiFi and BLE are never on at once. The fake radio records
     every transition and fails the moment both are live.

It also covers the cases that only appear when things go wrong: a printer that
is asleep, a network that dies between printing and confirming, a CRC that
disagrees with the Worker, and a job arriving right behind another.

    python firmware/test_loop.py
"""

import asyncio
import sys
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

# --- Simulated clock ------------------------------------------------------
#
# Time only moves when the loop sleeps. That makes an eight-hour night take
# milliseconds, and makes every timing assertion exact rather than flaky.

NOW = [0]

_time = types.ModuleType("time")
_time.ticks_ms = lambda: NOW[0]
_time.ticks_add = lambda t, d: t + d
_time.ticks_diff = lambda a, b: a - b


def _sleep_ms(ms):
    NOW[0] += int(ms)


_time.sleep_ms = _sleep_ms
sys.modules["time"] = _time

_real_sleep = asyncio.sleep


async def _fake_sleep_ms(ms):
    NOW[0] += int(ms)
    await _real_sleep(0)


async def _fake_sleep(s):
    NOW[0] += int(s * 1000)
    await _real_sleep(0)


asyncio.sleep_ms = _fake_sleep_ms
asyncio.sleep = _fake_sleep

# --- Fake hardware --------------------------------------------------------

RESETS = []

_machine = types.ModuleType("machine")


class _Pin:
    OUT = 1

    def __init__(self, *a, **k):
        self.state = 0

    def on(self):
        self.state = 1

    def off(self):
        self.state = 0


_machine.Pin = _Pin
_machine.reset = lambda: RESETS.append(NOW[0]) or (_ for _ in ()).throw(_Reset())


class _Reset(Exception):
    """Stands in for machine.reset(), which never returns."""


_machine.reset = lambda: (RESETS.append(NOW[0]), (_ for _ in ()).throw(_Reset()))[0]
sys.modules["machine"] = _machine

_bluetooth = types.ModuleType("bluetooth")
_bluetooth.UUID = lambda value: value
sys.modules["bluetooth"] = _bluetooth

_aioble = types.ModuleType("aioble")
_aioble.config = lambda **k: None
_aioble.scan = lambda *a, **k: None
sys.modules["aioble"] = _aioble

_config = types.ModuleType("config")
_config.WIFI_SSID = "ssid"
_config.WIFI_PASSWORD = "pw"
_config.WIFI_COUNTRY = "FR"
_config.API_BASE = "https://worker.test"
_config.API_TOKEN = "tok"
_config.DEVICE_ID = "pico-test"
_config.DEFAULT_INTENSITY = 0x5D
sys.modules["config"] = _config

# --- Fake radio, net and printer -----------------------------------------

FAILURES = []


def check(label, got, want):
    ok = got == want
    print(f"  {'ok  ' if ok else 'FAIL'} {label}")
    if not ok:
        print(f"       attendu {want!r}, obtenu {got!r}")
        FAILURES.append(label)


def check_true(label, got):
    check(label, bool(got), True)


class Radio:
    """Records every transition and refuses to have both radios live."""

    def __init__(self):
        self.wifi = False
        self.ble = False
        self.violations = []
        self.ble_sessions = 0
        # Timestamps of every moment a GATT connection was held.
        self.contacts = []

    def _assert_exclusive(self):
        if self.wifi and self.ble:
            self.violations.append(NOW[0])


class FakeNet:
    RadioConflict = type("RadioConflict", (Exception,), {})
    NetworkError = type("NetworkError", (Exception,), {})
    HttpError = type("HttpError", (Exception,), {})

    def __init__(self, radio, api):
        self.radio = radio
        self.Api = lambda *a, **k: api
        self.wifi_available = True
        self.wifi_attempts = 0
        self.wifi_fail_ms = 20000  # what a failed connection costs in time

    def wifi_up(self, ssid, password, timeout_ms=20000, country=None):
        if self.radio.ble:
            raise self.RadioConflict("BLE still active")
        self.wifi_attempts += 1
        if not self.wifi_available:
            NOW[0] += min(self.wifi_fail_ms, timeout_ms)
            raise self.NetworkError("access point not found")
        NOW[0] += 3000
        self.radio.wifi = True
        self.radio._assert_exclusive()
        return "192.168.1.42"

    def wifi_down(self):
        self.radio.wifi = False

    def ble_up(self):
        if self.radio.wifi:
            raise self.RadioConflict("WiFi still active")
        self.radio.ble = True
        self.radio.ble_sessions += 1
        self.radio._assert_exclusive()

    def ble_down(self):
        self.radio.ble = False

    def wifi_rssi(self):
        return -55

    def wifi_is_active(self):
        return self.radio.wifi

    def ble_is_active(self):
        return self.radio.ble


class FakeApi:
    def __init__(self):
        self.queue = []
        self.done_calls = []
        # One entry per batched reply: the ids that shared a strip.
        self.batches = []
        # What was handed out and not yet confirmed, so a retry can put it back.
        self.in_flight = []
        # The thermostat this Worker is serving.
        self.head_max_c = 38
        self.cool_to_c = 34
        self.heartbeats = []
        self.open = True
        self.poll_after = 5
        self.network_down = False

    def _guard(self):
        if self.network_down:
            raise FakeNet.HttpError("connection reset")

    def next_job(self, batch=1):
        self._guard()
        NOW[0] += 300
        if not self.open or not self.queue:
            return None, self.poll_after
        if batch <= 1:
            job = self.queue.pop(0)
            self.in_flight = [job]
            return job, 0
        # The Worker's batch reply: several tickets rendered onto one strip,
        # one bitmap, one crc, and an `ids` list naming every ticket on it.
        taken = [self.queue.pop(0) for _ in range(min(batch, len(self.queue)))]
        strip = dict(taken[0])
        strip["ids"] = [job["id"] for job in taken]
        strip["lines"] = sum(job["lines"] for job in taken)
        bitmap = bytearray()
        for job in taken:
            bitmap += job["bitmap"]
        strip["bitmap"] = bytes(bitmap)
        crc = 0
        for byte in strip["bitmap"]:
            crc = (crc + byte) & 0xFF
        strip["crc"] = crc
        self.batches.append(strip["ids"])
        self.in_flight = taken
        return strip, 0

    def done(self, job_id, ok, crc=None, error=None, ids=None, retry=False,
             sent=None, spans=None, pace=None, stalls=None):
        self._guard()
        NOW[0] += 300
        self.done_calls.append(
            {"id": job_id, "ids": ids, "ok": ok, "crc": crc, "error": error,
             "retry": retry, "sent": sent, "spans": spans, "pace": pace,
             "stalls": stalls}
        )
        # What the Worker does with a retryable failure: the tickets go back at
        # the head of the queue, because nothing of them reached the paper.
        if not ok and retry:
            self.queue[0:0] = self.in_flight
        self.in_flight = []
        return True

    def heartbeat(self, **state):
        self._guard()
        NOW[0] += 300
        self.heartbeats.append(state)
        return {
            "ok": True,
            "open": self.open,
            "poll_interval_s": self.poll_after,
            "kill_switch": False,
            # The thermostat, as the Worker serves it.
            "head_max_c": self.head_max_c,
            "cool_to_c": self.cool_to_c,
        }


class FakePrinterError(Exception):
    pass


class FakeAsleep(FakePrinterError):
    pass


class FakeNoPaper(FakePrinterError):
    pass


class FakeTooHot(FakePrinterError):
    pass


class FakePrinter:
    """Just enough MXW01 to drive the loop."""

    def __init__(self, radio):
        self.radio = radio
        self.asleep = False
        self.prints = []
        self.feeds = []
        self.temperature = 27
        self.paper_ok = True
        self.crc_override = None
        self.connected = False
        # An exception class to raise at print time, leaving connect and
        # get_status healthy.
        self.fail_print_with = None
        # Mirrors the driver: reported on every print so a strip that is too
        # long for the link is visible in the trace.
        self.last_pace_ms = 8
        self.last_stalls = 0
        self.last_sent_lines = 0
        # When true, every status read drops the head by a degree.
        self.cools = False
        # Mirrors the driver: the loop logs this on a failed keepalive to tell
        # a sleeping printer apart from a radio that scanned nothing.
        self.last_scan_peers = 0

    async def connect_with_retry(self, attempts=4, base_ms=1000, device=None,
                                 scan_ms=5000):
        if not self.radio.ble:
            raise AssertionError("connected while the BLE radio was down")
        if self.radio.wifi:
            raise AssertionError("connected while WiFi was up")
        NOW[0] += 1500
        if self.asleep:
            raise FakeAsleep("not advertising")
        self.connected = True
        self.radio.contacts.append(NOW[0])
        return 128

    async def get_status(self):
        if not self.connected:
            return None
        NOW[0] += 50
        # A real head sheds about a degree per keepalive. Modelling that lets a
        # single run cover "too hot -> waits -> cools -> prints", which two
        # run_for calls cannot: the second wraps the first's counter and stops
        # on the opening keepalive.
        if self.cools and self.temperature > 20:
            self.temperature -= 1
        return {
            "state": 0,
            "battery": 100,
            "temperature": self.temperature,
            "error_flag": 0,
            "paper_ok": self.paper_ok,
        }

    async def print_with_retry(self, make_source, line_count, attempts=2, **kwargs):
        if not self.connected:
            raise FakePrinterError("not connected")
        # Refusals that happen before a single line is sent, exactly as the
        # driver does. That is what makes them safe to retry. fail_print_with
        # fires only here, so the printer still looks healthy to the keepalive
        # - which is the real sequence: the roll runs out, or the head heats
        # up, between the poll and the print.
        if self.fail_print_with is not None:
            raise self.fail_print_with("refused before sending anything")
        if not self.paper_ok:
            raise FakeNoPaper("roll empty")
        ceiling = kwargs.get("max_temp") or 38
        if self.temperature > ceiling:
            raise FakeTooHot("head at %d C, ceiling %d" % (self.temperature, ceiling))
        lines = list(make_source())
        if len(lines) != line_count:
            raise FakePrinterError("announced %d lines, got %d" % (line_count, len(lines)))
        NOW[0] += 3500
        crc = 0
        for line in lines:
            for byte in line:
                crc = (crc + byte) & 0xFF
        if self.crc_override is not None:
            crc = self.crc_override
        self.prints.append({"lines": line_count, "crc": crc})
        return True, crc, crc, 1

    async def feed(self, lines):
        self.feeds.append(lines)
        NOW[0] += 200
        return b"\x00"

    async def disconnect(self):
        self.connected = False


# --- Wiring ---------------------------------------------------------------

radio = Radio()
api = FakeApi()
fake_net = FakeNet(radio, api)
sys.modules["net"] = fake_net

_fw = types.ModuleType("ble_printer")
_fw.WIDTH_BYTES = 48
_fw.KEEPALIVE_INTERVAL_MS = 5 * 60 * 1000
_fw.PrinterError = FakePrinterError
_fw.PrinterAsleep = FakeAsleep
_fw.PrinterTooHot = FakeTooHot
# Was missing, and nothing noticed because no test reached the handler: main.py
# names fw.PrinterNoPaper in an except clause, which would have raised
# AttributeError on the stub the first time a print hit an empty roll.
_fw.PrinterNoPaper = FakeNoPaper
# The thermostat the loop reads from the Worker, clamped against these.
_fw.PRE_PRINT_MAX_TEMPERATURE = 38
_fw.MAX_HEAD_TEMPERATURE = 45
printer = FakePrinter(radio)
_fw.MXW01 = lambda: printer
sys.modules["ble_printer"] = _fw

import main  # noqa: E402

main.gc = types.SimpleNamespace(collect=lambda: None, mem_free=lambda: 400000)
main.net = fake_net


def make_job(job_id, lines=32, crc=None):
    bitmap = bytearray()
    for y in range(lines):
        row = bytearray(48)
        row[0] = (y + 1) & 0xFF
        bitmap += row
    expected = 0
    for byte in bitmap:
        expected = (expected + byte) & 0xFF
    return {
        "id": job_id,
        "lines": lines,
        "width_bytes": 48,
        "crc": expected if crc is None else crc,
        "intensity": 0x5D,
        "feed_lines": 80,
        "bitmap": bytes(bitmap),
    }


async def run_for(service, cycles):
    """Runs the loop, stopping it after a number of trips round the top."""
    counter = {"n": 0}
    original = service.ble_phase

    async def counting(job=None):
        result = await original(job)
        if job is None:
            counter["n"] += 1
            if counter["n"] >= cycles:
                raise _Stop()
        return result

    service.ble_phase = counting
    try:
        await service.run()
    except _Stop:
        pass
    except _Reset:
        pass


class _Stop(Exception):
    pass


def reset_world():
    NOW[0] = 0
    radio.__init__()
    api.__init__()
    printer.__init__(radio)
    fake_net.wifi_available = True
    fake_net.wifi_attempts = 0
    RESETS.clear()


# --- Tests ----------------------------------------------------------------

print("\nSafety constants")
check("the BLE deadline is under 9 minutes", main.BLE_DEADLINE_MS < 9 * 60 * 1000, True)
# The acceptance run lost the printer at 7.8 minutes, so the old 9-minute
# figure is not something to design against any more.
check("the BLE deadline is under 7 minutes", main.BLE_DEADLINE_MS < 7 * 60 * 1000, True)
check("the keepalive is more frequent than the deadline", main.KEEPALIVE_DUE_MS < main.BLE_DEADLINE_MS, True)

print("\nNominal cycle, nothing to print")
reset_world()
service = main.Service()
asyncio.run(run_for(service, 4))
check("no breach of constraint 6", radio.violations, [])
check("the WiFi is off at the end", radio.wifi, False)
check("the BLE is off at the end", radio.ble, False)
check_true("heartbeats were sent", len(api.heartbeats) >= 3)
gaps = [b - a for a, b in zip(radio.contacts, radio.contacts[1:])]
check_true("the BLE contacts are regular", len(radio.contacts) >= 4)
# Asserted against the INTENDED interval, not against the printer's sleep
# threshold. The first version of this test allowed anything under 9 minutes,
# which let a real bug through: the loop was stretching the interval to 8.4
# minutes and the printer fell asleep anyway. A test that only catches a
# violation of the outer limit cannot catch the drift towards it.
check(
    "the BLE contacts hold the interval they were given",
    max(gaps) <= main.KEEPALIVE_DUE_MS + 60000 if gaps else True,
    True,
)

print("\nOvernight: WiFi off, printer alone")
reset_world()
fake_net.wifi_available = False
service = main.Service()
# Cycle count, not a duration: the loop decides how long a cycle is, and the
# count has to be large enough that this still covers a real stretch of night
# after the 30 August retuning shortened the cycle to ~90 s.
asyncio.run(run_for(service, 40))
check("no breach of constraint 6", radio.violations, [])
gaps = [b - a for a, b in zip(radio.contacts, radio.contacts[1:])]
check_true("the printer is kept in touch with despite the network being gone", len(radio.contacts) >= 10)
check(
    "the overnight cycle keeps the interval it should",
    max(gaps) <= main.KEEPALIVE_DUE_MS + 60000 if gaps else True,
    True,
)
# The point is that the night run covers a long stretch, not that it covers a
# particular number of cycles: half an hour is already several times the window
# in which the printer has ever been observed to disappear.
check_true("a long simulated stretch has gone by", NOW[0] > 30 * 60 * 1000)
check_true("the WiFi was retried regularly", fake_net.wifi_attempts >= 10)

print("\nPrinting one job")
reset_world()
job = make_job(101)
api.queue.append(job)
service = main.Service()
asyncio.run(run_for(service, 3))
check("no breach of constraint 6", radio.violations, [])
check("the ticket was printed", len(printer.prints), 1)
check("the right number of lines", printer.prints[0]["lines"], 32)
check("the paper feed was asked for", printer.feeds, [80])
check("the job was reported done", [d["id"] for d in api.done_calls], [101])
check("reported as a success", api.done_calls[0]["ok"], True)
check("the CRC is reported back to the Worker", api.done_calls[0]["crc"], job["crc"])

print("\nTwo jobs in a row: one single strip")
# The whole point of batching. Two tickets used to mean two prints and two of
# the printer's end-of-print eject margins; they now share one strip and cost
# one. A backlog of nineteen emptied the roll on 30 August doing it the old way.
reset_world()
api.queue.extend([make_job(1), make_job(2)])
service = main.Service()
asyncio.run(run_for(service, 3))
check("one print for two tickets", len(printer.prints), 1)
check("both travelled on the same strip", api.batches, [[1, 2]])
check("the strip carries the lines of both", printer.prints[0]["lines"], 64)
check("one confirmation round trip", len(api.done_calls), 1)
check("both are confirmed", api.done_calls[0]["ids"], [1, 2])
check("reported as a success", api.done_calls[0]["ok"], True)
check("no breach of constraint 6", radio.violations, [])

print("\nA failed batch: every ticket on the strip fails together")
# A strip is printed or lost as a whole. Reporting only its first ticket would
# leave the rest claimed until their lease expired, and the Worker would fail
# them with no explanation.
reset_world()
api.queue.extend([make_job(31), make_job(32), make_job(33)])
printer.crc_override = 0x99  # the strip arrives corrupted
service = main.Service()
asyncio.run(run_for(service, 3))
printer.crc_override = None
check("all three are reported together", api.done_calls[0]["ids"], [31, 32, 33])
check("rapportes comme echoues", api.done_calls[0]["ok"], False)
check_true("a diverging CRC is not replayed", api.done_calls[0]["retry"] is False)

print("\nA hot head makes the loop wait rather than burn its attempts")
# Three refusals in 45 seconds killed tickets 173 and 174 on 30 August: the job
# went back in the queue, was claimed again seconds later, and the head was
# still at 39 C. The loop must now wait for the temperature to come down.
reset_world()
api.queue.append(make_job(51))
printer.temperature = 44
printer.cools = True
service = main.Service()
asyncio.run(run_for(service, 3))
check("the state moves to cooling", service.printer_state, "cooling")
check_true("one attempt, not three", len(api.done_calls) == 1)
check_true("and it asks to be replayed", api.done_calls[0]["retry"] is True)
check_true("nothing was printed", len(printer.prints) == 0)
# The Worker put the ticket back, and the loop left it alone while cooling.
check_true("the ticket went back in the queue", len(api.queue) == 1)
check_true("and it was not re-claimed", len(api.done_calls) == 1)

print("\nOnce cooled, the loop restarts on its own")
# Same run, the head simply cools as the keepalives read it.
reset_world()
api.queue.append(make_job(52))
printer.temperature = 44
printer.cools = True
service = main.Service()
asyncio.run(run_for(service, 16))
check("the state is back to awake", service.printer_state, "awake")
check_true("and the ticket came out in the end", len(printer.prints) >= 1)

print("\nA strip refused before its first byte is replayed")
# The head was too hot, the roll was empty, or the printer was asleep. In all
# three the Pico refuses before sending anything, so nothing is on the floor
# and the whole strip belongs back in the queue. Marking these final failed
# five good messages on 30 August because the head had reached 40 C.
for failure, label in (
    (FakeTooHot, "trop chaude"),
    (FakeNoPaper, "no paper"),
    (FakeAsleep, "endormie"),
):
    setup = lambda f=failure: setattr(printer, "fail_print_with", f)
    reset_world()
    api.queue.extend([make_job(41), make_job(42)])
    setup()
    service = main.Service()
    asyncio.run(run_for(service, 3))
    check_true(
        "strip %s: replay asked for" % label,
        api.done_calls and api.done_calls[0]["retry"] is True,
    )
    check_true(
        "strip %s: both ids are given back" % label,
        api.done_calls and api.done_calls[0]["ids"] == [41, 42],
    )

print("\nA CRC that differs from the Worker's")
reset_world()
api.queue.append(make_job(7))
printer.crc_override = 0x99  # not what the Worker announced
service = main.Service()
asyncio.run(run_for(service, 3))
check("the job is reported as failed", api.done_calls[0]["ok"], False)
check_true("the reason mentions the CRC", "crc" in (api.done_calls[0]["error"] or "").lower())
printer.crc_override = None

print("\nPrinter asleep: the message must survive")
reset_world()
printer.asleep = True
api.queue.append(make_job(55))
service = main.Service()
asyncio.run(run_for(service, 4))
check("no ticket was printed", printer.prints, [])
check("the job is not claimed, so not burned", api.done_calls, [])
check("it is still waiting in the queue", [j["id"] for j in api.queue], [55])
check_true("the Pico goes on talking to the Worker", len(api.heartbeats) >= 2)
states = [h["printer_state"] for h in api.heartbeats]
check_true("the heartbeat reports the printer asleep", "asleep" in states)
check("no breach of constraint 6", radio.violations, [])
check_true(
    "the printer is retried often, to restart quickly after the button",
    NOW[0] / max(1, radio.ble_sessions) < 2 * 60 * 1000,
)

print("\nSomebody presses the button")
reset_world()
printer.asleep = True
api.queue.append(make_job(56))
service = main.Service()


async def wake_up_scenario():
    counter = {"n": 0}
    original_ble = service.ble_phase

    async def counting(job=None):
        if job is None:
            counter["n"] += 1
            if counter["n"] == 3:
                printer.asleep = False  # the button is pressed
            if counter["n"] >= 8:
                raise _Stop()
        return await original_ble(job)

    service.ble_phase = counting
    try:
        await service.run()
    except (_Stop, _Reset):
        pass


asyncio.run(wake_up_scenario())
check("the waiting message comes out in the end", len(printer.prints), 1)
check("and it is confirmed", [d["id"] for d in api.done_calls], [56])
check("no breach of constraint 6", radio.violations, [])
printer.asleep = False

print("\nNetwork lost between the print and the confirmation")
reset_world()
api.queue.append(make_job(77))
service = main.Service()


async def scenario():
    # Print the job, then lose the network before /done can go out.
    counter = {"n": 0}
    original_ble = service.ble_phase

    async def counting(job=None):
        result = await original_ble(job)
        if job is not None:
            api.network_down = True
        if job is None:
            counter["n"] += 1
            if counter["n"] == 2:
                api.network_down = False  # the network comes back
            if counter["n"] >= 4:
                raise _Stop()
        return result

    service.ble_phase = counting
    try:
        await service.run()
    except (_Stop, _Reset):
        pass


asyncio.run(scenario())
check("the ticket did come out", len(printer.prints), 1)
check("the confirmation got through in the end", [d["id"] for d in api.done_calls], [77])
check("no breach of constraint 6", radio.violations, [])

print("\nShop shut")
reset_world()
api.open = False
api.poll_after = 300
api.queue.append(make_job(9))
service = main.Service()
asyncio.run(run_for(service, 4))
check("nothing is printed outside opening hours", printer.prints, [])
check_true("the printer is kept awake anyway", len(radio.contacts) >= 3)
gaps = [b - a for a, b in zip(radio.contacts, radio.contacts[1:])]
check(
    "the interval holds even with the shop shut",
    max(gaps) <= main.KEEPALIVE_DUE_MS + 60000 if gaps else True,
    True,
)
api.open = True

print("\nRadio conflict: restart rather than carry on")
reset_world()
service = main.Service()
original_wifi_up = fake_net.wifi_up


def conflicting(*a, **k):
    raise fake_net.RadioConflict("both radios are on")


fake_net.wifi_up = conflicting
try:
    asyncio.run(run_for(service, 5))
except _Reset:
    pass
fake_net.wifi_up = original_wifi_up
check_true("the board restarted", len(RESETS) >= 1)

print()
if FAILURES:
    print(f"{len(FAILURES)} echec(s): " + ", ".join(FAILURES))
    sys.exit(1)
print("tout passe")

print("\nThe thermostat comes from the Worker, not the firmware")
# The two thresholds used to be frozen into the board, so retuning them meant
# reflashing mid-queue and risking the strip in flight. They now arrive with
# every heartbeat.
reset_world()
api.head_max_c = 41
api.cool_to_c = 37
api.queue.append(make_job(61))
printer.temperature = 40          # too hot at 38, fine at 41
service = main.Service()
asyncio.run(run_for(service, 3))
check("the Worker's ceiling is adopted", service.head_max_c, 41)
check("and so is the resume threshold", service.cool_to_c, 37)
check_true("and the ticket comes out at 40 C", len(printer.prints) >= 1)

print("\nAn absurd setting cannot cook the head")
reset_world()
api.head_max_c = 90               # far past the driver's hard ceiling
api.cool_to_c = 34
api.queue.append(make_job(62))
printer.temperature = 44
service = main.Service()
asyncio.run(run_for(service, 3))
check("the absurd ceiling is ignored", service.head_max_c, 38)
check_true("and nothing was printed at 44 C", len(printer.prints) == 0)

if FAILURES:
    print(f"\n{len(FAILURES)} echec(s): {', '.join(FAILURES)}")
    sys.exit(1)
