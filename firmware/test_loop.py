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

print("\nConstante de securite")
check("la deadline BLE est sous les 9 minutes", main.BLE_DEADLINE_MS < 9 * 60 * 1000, True)
# The acceptance run lost the printer at 7.8 minutes, so the old 9-minute
# figure is not something to design against any more.
check("la deadline BLE est sous les 7 minutes", main.BLE_DEADLINE_MS < 7 * 60 * 1000, True)
check("le keepalive est plus frequent que la deadline", main.KEEPALIVE_DUE_MS < main.BLE_DEADLINE_MS, True)

print("\nCycle nominal, rien a imprimer")
reset_world()
service = main.Service()
asyncio.run(run_for(service, 4))
check("aucune violation de la contrainte 6", radio.violations, [])
check("le WiFi est coupe a la fin", radio.wifi, False)
check("le BLE est coupe a la fin", radio.ble, False)
check_true("des heartbeats ont ete envoyes", len(api.heartbeats) >= 3)
gaps = [b - a for a, b in zip(radio.contacts, radio.contacts[1:])]
check_true("des contacts BLE reguliers", len(radio.contacts) >= 4)
# Asserted against the INTENDED interval, not against the printer's sleep
# threshold. The first version of this test allowed anything under 9 minutes,
# which let a real bug through: the loop was stretching the interval to 8.4
# minutes and the printer fell asleep anyway. A test that only catches a
# violation of the outer limit cannot catch the drift towards it.
check(
    "les contacts BLE tiennent l'intervalle voulu",
    max(gaps) <= main.KEEPALIVE_DUE_MS + 60000 if gaps else True,
    True,
)

print("\nLa nuit: WiFi coupe, imprimante seule")
reset_world()
fake_net.wifi_available = False
service = main.Service()
# Cycle count, not a duration: the loop decides how long a cycle is, and the
# count has to be large enough that this still covers a real stretch of night
# after the 30 August retuning shortened the cycle to ~90 s.
asyncio.run(run_for(service, 40))
check("aucune violation de la contrainte 6", radio.violations, [])
gaps = [b - a for a, b in zip(radio.contacts, radio.contacts[1:])]
check_true("l'imprimante reste touchee malgre l'absence de reseau", len(radio.contacts) >= 10)
check(
    "le cycle de nuit tient l'intervalle voulu",
    max(gaps) <= main.KEEPALIVE_DUE_MS + 60000 if gaps else True,
    True,
)
# The point is that the night run covers a long stretch, not that it covers a
# particular number of cycles: half an hour is already several times the window
# in which the printer has ever been observed to disappear.
check_true("une longue periode simulee s'est ecoulee", NOW[0] > 30 * 60 * 1000)
check_true("le WiFi a bien ete retente regulierement", fake_net.wifi_attempts >= 10)

print("\nImpression d'un job")
reset_world()
job = make_job(101)
api.queue.append(job)
service = main.Service()
asyncio.run(run_for(service, 3))
check("aucune violation de la contrainte 6", radio.violations, [])
check("le ticket a ete imprime", len(printer.prints), 1)
check("le bon nombre de lignes", printer.prints[0]["lines"], 32)
check("l'avance papier a ete demandee", printer.feeds, [80])
check("le job a ete confirme", [d["id"] for d in api.done_calls], [101])
check("confirme comme reussi", api.done_calls[0]["ok"], True)
check("le CRC est remonte au Worker", api.done_calls[0]["crc"], job["crc"])

print("\nDeux jobs a la suite: une seule bande")
# The whole point of batching. Two tickets used to mean two prints and two of
# the printer's end-of-print eject margins; they now share one strip and cost
# one. A backlog of nineteen emptied the roll on 30 August doing it the old way.
reset_world()
api.queue.extend([make_job(1), make_job(2)])
service = main.Service()
asyncio.run(run_for(service, 3))
check("une seule impression pour deux tickets", len(printer.prints), 1)
check("les deux ont voyage sur la meme bande", api.batches, [[1, 2]])
check("la bande porte les lignes des deux", printer.prints[0]["lines"], 64)
check("un seul aller-retour de confirmation", len(api.done_calls), 1)
check("les deux sont confirmes", api.done_calls[0]["ids"], [1, 2])
check("confirme comme reussi", api.done_calls[0]["ok"], True)
check("aucune violation de la contrainte 6", radio.violations, [])

print("\nUn lot rate: tous les tickets de la bande echouent ensemble")
# A strip is printed or lost as a whole. Reporting only its first ticket would
# leave the rest claimed until their lease expired, and the Worker would fail
# them with no explanation.
reset_world()
api.queue.extend([make_job(31), make_job(32), make_job(33)])
printer.crc_override = 0x99  # the strip arrives corrupted
service = main.Service()
asyncio.run(run_for(service, 3))
printer.crc_override = None
check("les trois sont rapportes ensemble", api.done_calls[0]["ids"], [31, 32, 33])
check("rapportes comme echoues", api.done_calls[0]["ok"], False)
check_true("un CRC divergent ne se rejoue pas", api.done_calls[0]["retry"] is False)

print("\nLa tete chaude fait attendre la boucle au lieu de bruler les essais")
# Three refusals in 45 seconds killed tickets 173 and 174 on 30 August: the job
# went back in the queue, was claimed again seconds later, and the head was
# still at 39 C. The loop must now wait for the temperature to come down.
reset_world()
api.queue.append(make_job(51))
printer.temperature = 44
printer.cools = True
service = main.Service()
asyncio.run(run_for(service, 3))
check("l'etat passe en refroidissement", service.printer_state, "cooling")
check_true("une seule tentative, pas trois", len(api.done_calls) == 1)
check_true("et elle demande le rejeu", api.done_calls[0]["retry"] is True)
check_true("rien n'a ete imprime", len(printer.prints) == 0)
# The Worker put the ticket back, and the loop left it alone while cooling.
check_true("le ticket est retourne en file", len(api.queue) == 1)
check_true("et il n'a pas ete rereclame", len(api.done_calls) == 1)

print("\nUne fois refroidie, la boucle repart seule")
# Same run, the head simply cools as the keepalives read it.
reset_world()
api.queue.append(make_job(52))
printer.temperature = 44
printer.cools = True
service = main.Service()
asyncio.run(run_for(service, 16))
check("l'etat est revenu a awake", service.printer_state, "awake")
check_true("et le ticket a fini par sortir", len(printer.prints) >= 1)

print("\nUne bande refusee avant le premier octet se rejoue")
# The head was too hot, the roll was empty, or the printer was asleep. In all
# three the Pico refuses before sending anything, so nothing is on the floor
# and the whole strip belongs back in the queue. Marking these final failed
# five good messages on 30 August because the head had reached 40 C.
for failure, label in (
    (FakeTooHot, "trop chaude"),
    (FakeNoPaper, "sans papier"),
    (FakeAsleep, "endormie"),
):
    setup = lambda f=failure: setattr(printer, "fail_print_with", f)
    reset_world()
    api.queue.extend([make_job(41), make_job(42)])
    setup()
    service = main.Service()
    asyncio.run(run_for(service, 3))
    check_true(
        "bande %s: rejeu demande" % label,
        api.done_calls and api.done_calls[0]["retry"] is True,
    )
    check_true(
        "bande %s: les deux ids sont rendus" % label,
        api.done_calls and api.done_calls[0]["ids"] == [41, 42],
    )

print("\nCRC divergent du Worker")
reset_world()
api.queue.append(make_job(7))
printer.crc_override = 0x99  # not what the Worker announced
service = main.Service()
asyncio.run(run_for(service, 3))
check("le job est signale en echec", api.done_calls[0]["ok"], False)
check_true("le motif mentionne le CRC", "crc" in (api.done_calls[0]["error"] or "").lower())
printer.crc_override = None

print("\nImprimante endormie: le message doit survivre")
reset_world()
printer.asleep = True
api.queue.append(make_job(55))
service = main.Service()
asyncio.run(run_for(service, 4))
check("aucun ticket n'a ete imprime", printer.prints, [])
check("le job n'est pas reclame, donc pas brule", api.done_calls, [])
check("il attend toujours dans la file", [j["id"] for j in api.queue], [55])
check_true("le Pico continue de parler au Worker", len(api.heartbeats) >= 2)
states = [h["printer_state"] for h in api.heartbeats]
check_true("le heartbeat signale l'imprimante endormie", "asleep" in states)
check("aucune violation de la contrainte 6", radio.violations, [])
check_true(
    "l'imprimante est retentee souvent, pour repartir vite apres le bouton",
    NOW[0] / max(1, radio.ble_sessions) < 2 * 60 * 1000,
)

print("\nQuelqu'un appuie sur le bouton")
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
check("le message en attente finit par sortir", len(printer.prints), 1)
check("et il est confirme", [d["id"] for d in api.done_calls], [56])
check("aucune violation de la contrainte 6", radio.violations, [])
printer.asleep = False

print("\nReseau perdu entre l'impression et la confirmation")
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
check("le ticket est bien sorti", len(printer.prints), 1)
check("la confirmation a fini par passer", [d["id"] for d in api.done_calls], [77])
check("aucune violation de la contrainte 6", radio.violations, [])

print("\nBoutique fermee")
reset_world()
api.open = False
api.poll_after = 300
api.queue.append(make_job(9))
service = main.Service()
asyncio.run(run_for(service, 4))
check("rien n'est imprime hors horaires", printer.prints, [])
check_true("l'imprimante est quand meme maintenue eveillee", len(radio.contacts) >= 3)
gaps = [b - a for a, b in zip(radio.contacts, radio.contacts[1:])]
check(
    "l'intervalle est tenu meme boutique fermee",
    max(gaps) <= main.KEEPALIVE_DUE_MS + 60000 if gaps else True,
    True,
)
api.open = True

print("\nConflit radio: on redemarre plutot que de continuer")
reset_world()
service = main.Service()
original_wifi_up = fake_net.wifi_up


def conflicting(*a, **k):
    raise fake_net.RadioConflict("les deux radios sont allumees")


fake_net.wifi_up = conflicting
try:
    asyncio.run(run_for(service, 5))
except _Reset:
    pass
fake_net.wifi_up = original_wifi_up
check_true("la carte a redemarre", len(RESETS) >= 1)

print()
if FAILURES:
    print(f"{len(FAILURES)} echec(s): " + ", ".join(FAILURES))
    sys.exit(1)
print("tout passe")

print("\nLe thermostat vient du Worker, pas du firmware")
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
check("le plafond du Worker est adopte", service.head_max_c, 41)
check("le seuil de reprise aussi", service.cool_to_c, 37)
check_true("et le ticket sort a 40 C", len(printer.prints) >= 1)

print("\nUn reglage aberrant ne peut pas cuire la tete")
reset_world()
api.head_max_c = 90               # far past the driver's hard ceiling
api.cool_to_c = 34
api.queue.append(make_job(62))
printer.temperature = 44
service = main.Service()
asyncio.run(run_for(service, 3))
check("le plafond absurde est ignore", service.head_max_c, 38)
check_true("et rien n'a ete imprime a 44 C", len(printer.prints) == 0)

if FAILURES:
    print(f"\n{len(FAILURES)} echec(s): {', '.join(FAILURES)}")
    sys.exit(1)
