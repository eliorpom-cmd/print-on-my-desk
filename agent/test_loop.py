# Host tests for the agent's loop. No network, no USB, no paper.
#
#   python3 agent/test_loop.py
#
# firmware/test_loop.py found a bug that never showed on the bench: a sleeping
# printer left the Pico unable to reach the network, so the system went mute
# exactly when it needed to raise the alarm. That bug was found here, in a test
# with a fake clock, and not on the shelf. This file is the same idea for the
# same reasons, against a fake Worker and a fake printer.
#
# The properties worth guarding are the ones that lose messages rather than the
# ones that print them, because a print that fails is visible and a message
# that quietly disappears is not.

import sys
import os
import types

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

# main.py refuses to import without a config, which is the right behaviour on
# the Pi and unhelpful here. Supplied before the import rather than after.
fake_config = types.ModuleType("config")
fake_config.WORKER_URL = "https://example.invalid"
fake_config.PRINTER_TOKEN = "t"
fake_config.DEVICE_ID = "pi-test"
fake_config.BATCH_SIZE = 8
sys.modules["config"] = fake_config

import base64

import escpos_printer as ep
import net
import main as agent_main

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


class FakeApi:
    """A Worker that answers from a script and records what it was told."""

    def __init__(self, jobs=None, heartbeat=None, fail_done=False, fail_poll=False):
        self.base = "https://example.invalid"
        self.device_id = "pi-test"
        self.jobs = list(jobs or [])
        self.heartbeat_reply = heartbeat or {"open": True, "kill_switch": False}
        self.fail_done = fail_done
        self.fail_poll = fail_poll
        self.done_calls = []
        self.poll_calls = []
        self.beats = []
        # What the real client records about the last poll. The loop reads both
        # to tell a long poll that waited its turn from an empty answer that
        # came back instantly - see Agent.after_empty_poll.
        self.last_poll_after = 0.0
        self.last_poll_elapsed = agent_main.LONG_POLL_S

    def heartbeat(self, fields):
        self.beats.append(fields)
        return self.heartbeat_reply

    def next_job(self, batch=1, wait_s=0):
        self.poll_calls.append((batch, wait_s))
        if self.fail_poll:
            raise net.NetworkError("no route to host")
        return self.jobs.pop(0) if self.jobs else None

    def answers_instantly(self, poll_after=5.0):
        """A Worker refusing to wait: the kill switch, or a closed season."""
        self.last_poll_elapsed = 0.01
        self.last_poll_after = poll_after

    def report_done(self, payload):
        if self.fail_done:
            raise net.NetworkError("no route to host")
        self.done_calls.append(payload)
        return {"ok": True}


def make_job(lines=10, width_bytes=64, crc=None, ids=None):
    rows = [row(i & 0xFF, 0x3C) for i in range(lines)]
    image = b"".join(rows)
    return {
        "id": ids[0] if ids else 1,
        "ids": ids or [1],
        "spans": [{"id": i, "start": 0, "lines": lines} for i in (ids or [1])],
        "lines": lines,
        "width_bytes": width_bytes,
        "profile": "trp100",
        "crc": ep.crc8(image) if crc is None else crc,
        "feed_lines": 90,
        "data": base64.b64encode(image).decode(),
    }


def build(printer=None, api=None):
    api = api or FakeApi()
    printer = printer or FakePrinter()
    return agent_main.Agent(api, printer, 8), api, printer


# --- the happy path ---------------------------------------------------------

print("\na ticket that prints")

job = make_job()
agent, api, printer = build(api=FakeApi(jobs=[job]))
agent.cycle()

check("the job was printed", printer.last_sent_lines == 10)
check("and confirmed", len(api.done_calls) == 1 and api.done_calls[0]["ok"] is True)
check("the CRC went back with it", api.done_calls[0]["crc"] == job["crc"])
check("the counter moved", agent.prints_ok == 1 and agent.prints_failed == 0)
check("the poll asked to be held open", api.poll_calls[0][1] == agent_main.LONG_POLL_S)
check("and asked for a strip", api.poll_calls[0][0] == 8)
check("no cut command was sent", bytes([0x1D, 0x56]) not in printer.sent)


# --- the refusals that must not burn a message ------------------------------

print("\nan empty roll")

agent, api, printer = build(printer=FakePrinter(paper=False), api=FakeApi(jobs=[make_job()]))
agent.cycle()

check("the state is reported as no_paper", agent.printer_state == "no_paper")
check(
    "and no job was claimed",
    api.poll_calls == [],
    "polled %r" % (api.poll_calls,),
)
check("nothing was printed", printer.last_sent_lines == 0)
check("the heartbeat still went out", len(api.beats) == 1)

print("\nan open lid")

agent, api, printer = build(printer=FakePrinter(cover=True), api=FakeApi(jobs=[make_job()]))
agent.cycle()
check("is its own state, not 'no paper'", agent.printer_state == "cover_open")
check("and does not claim work either", api.poll_calls == [])

print("\nthe printer unplugged mid-strip")

class DiesHalfway(FakePrinter):
    def write(self, data):
        # Let the status exchange through, then die on the first raster band.
        if data[:3] == bytes([0x1D, 0x76, 0x30]):
            self.last_sent_lines = 0
            raise ep.PrinterOffline("cable pulled")
        return super().write(data)


agent, api, printer = build(printer=DiesHalfway(), api=FakeApi(jobs=[make_job()]))
agent.cycle()
report = api.done_calls[0]
check("the failure was reported", report["ok"] is False)
check(
    "and it may go round again, because nothing was sent",
    report["retry"] is True and report["sent"] == 0,
)


class DiesLate(FakePrinter):
    """Fails on the second band, after the first is on the floor."""

    def __init__(self):
        super().__init__()
        self.bands = 0

    def write(self, data):
        if data[:3] == bytes([0x1D, 0x76, 0x30]):
            self.bands += 1
            if self.bands == 2:
                raise ep.PrinterOffline("cable pulled")
        return super().write(data)


agent, api, printer = build(
    printer=DiesLate(), api=FakeApi(jobs=[make_job(lines=300, ids=[1])])
)
agent.cycle()
report = api.done_calls[0]
check(
    "a strip that partly printed is NEVER retried",
    report["retry"] is False,
    "retry was %r" % report["retry"],
)
check(
    "and says how far it got, so the Worker can rescue the rest",
    report["sent"] == agent_main.ep.BAND_LINES,
    "sent %r" % report["sent"],
)
check("the spans travel with it", report["spans"] is not None)


# --- the printer that is not there ------------------------------------------

print("\nthe printer unplugged")

agent, api, printer = build(
    printer=FakePrinter(present=False), api=FakeApi(jobs=[make_job()])
)
agent.cycle()

# The bug this replaces: status() swallowed the write failure and answered
# paper=None, cover=None - which is the same answer a printer with no bulk IN
# endpoint gives, and the agent read it as "nothing wrong". It then claimed job
# after job, failed each one instantly, and charged an attempt. Three rounds
# and a message was dead for a reason its author had nothing to do with.
check("is reported as offline, not as fine", agent.printer_state == "offline")
check("and no job is claimed", api.poll_calls == [], "polled %r" % (api.poll_calls,))

print("\nunplugged, then plugged back in")

class Reappears(FakePrinter):
    """Absent for the first cycle, present afterwards."""

    def write(self, data):
        if not self._present:
            # Let the real driver's recovery path run: it closes the handle.
            self._present = True
            self._out = None
            raise ep.PrinterOffline("write failed: no such device")
        return super().write(data)


printer = Reappears(present=False)
agent, api, _ = build(printer=printer, api=FakeApi(jobs=[make_job()]))
agent.cycle()
check("the first cycle sees it gone", agent.printer_state == "offline")
printer._out = object()  # what open() does once the device is back
agent.cycle()
check(
    "and the next one finds it again, without a restart",
    agent.printer_state == "awake",
    "state is %r" % agent.printer_state,
)
check("then the job prints", printer.last_sent_lines == 10)


# --- a payload nothing can print --------------------------------------------

print("\na payload that is not printable at all")

# 64 bytes a row is announced, 30 bytes of image are sent: raster_command
# raises ValueError, which is not a PrinterError. It used to escape print_job
# entirely, so the job stayed `printing` with nobody to report it until the
# two-minute lease swept it into `failed` - the one message that most needed an
# explanation got none.
broken = make_job(lines=10)
broken["data"] = base64.b64encode(bytes(30)).decode()
agent, api, printer = build(api=FakeApi(jobs=[broken]))
agent.cycle()
check("is reported rather than left hanging", len(api.done_calls) == 1)
check("as a failure", api.done_calls[0]["ok"] is False)
check("with an error a person can read", bool(api.done_calls[0]["error"]))


# --- the checksum -----------------------------------------------------------

print("\na payload that does not match its checksum")

agent, api, printer = build(api=FakeApi(jobs=[make_job(crc=0x01)]))
agent.cycle()
check("is printed but reported as failed", api.done_calls[0]["ok"] is False)
check("and is not retried, because it is on the floor", api.done_calls[0]["retry"] is False)
check("the error names both checksums", "crc" in (api.done_calls[0]["error"] or ""))


print("\na payload rendered for the other printer")

agent, api, printer = build(api=FakeApi(jobs=[make_job(width_bytes=48)]))
agent.cycle()
check("is refused before anything is sent", printer.last_sent_lines == 0)
check("and requeued rather than burned", api.done_calls[0]["retry"] is True)
check(
    "no raster reached the printer",
    bytes([0x1D, 0x76, 0x30]) not in printer.sent,
)


# --- the network ------------------------------------------------------------

print("\nthe network dropping after a successful print")

agent, api, printer = build(api=FakeApi(jobs=[make_job()], fail_done=True))
agent.cycle()
check("the ticket was printed", printer.last_sent_lines == 10)
check("the result is kept rather than lost", agent.pending_done is not None)
check("nothing reached the Worker yet", api.done_calls == [])

# The network comes back.
api.fail_done = False
agent.cycle()
check("and is replayed on the next cycle", len(api.done_calls) == 1)
check("then forgotten", agent.pending_done is None)

print("\nthe network being down at the poll")

agent, api, printer = build(api=FakeApi(fail_poll=True))
first = agent.cycle()
second = agent.cycle()
check("the wait backs off", second > first, "%r then %r" % (first, second))
check(
    "but never past the ceiling",
    all(agent.cycle() <= agent_main.NET_RETRY_MAX_S for _ in range(8)),
)


# --- the kill switch --------------------------------------------------------

print("\nthe kill switch")

# The first cycle after a start MUST beat before it does anything else.
#
# It did not, and the bug was invisible on every machine anybody develops on.
# `due` was `time.monotonic() - last_heartbeat >= 60` with last_heartbeat at
# zero, which is really "has this computer been up for a minute" - monotonic's
# zero is the boot and its reference point is explicitly undefined. On a
# Raspberry Pi that starts this service AT boot, the first cycle found a
# healthy printer, decided no heartbeat was due, and polled: the agent printed
# a ticket before it had ever been told the service was paused.
#
# Caught by CI on a runner eight seconds old. It passed on every laptop, all of
# which had been up for days. Which is why the check below is on the FIRST
# cycle and asserts the beat rather than the poll.
agent, api, printer = build(
    api=FakeApi(jobs=[make_job()], heartbeat={"open": True, "kill_switch": True})
)

# A machine that booted eight seconds ago, which is what a Pi looks like when
# systemd starts this at boot - and what the CI runner was. The clock is moved
# rather than the agent's own field, so this tests the condition the bug
# actually needed rather than the shape of the fix.
_real_monotonic = agent_main.time.monotonic
agent_main.time.monotonic = lambda: 8.0
try:
    agent.cycle()
finally:
    agent_main.time.monotonic = _real_monotonic

check("the very first cycle beats before anything else", len(api.beats) == 1)
check("even on a machine that booted a moment ago", api.poll_calls == [])
check("and nothing was printed", printer.last_sent_lines == 0)

agent, api, printer = build(
    api=FakeApi(jobs=[make_job()], heartbeat={"open": True, "kill_switch": True})
)
agent.cycle()
check("stops the machine claiming work", api.poll_calls == [])
check("and nothing was printed", printer.last_sent_lines == 0)

agent, api, printer = build(
    api=FakeApi(jobs=[make_job()], heartbeat={"open": False, "kill_switch": False})
)
agent.cycle()
check("so does the service being closed", api.poll_calls == [])


# --- a bug in the loop must not end the service -----------------------------

print("\na bug inside a cycle")

class Explodes(FakePrinter):
    def status(self):
        raise ValueError("something nobody predicted")


agent, api, printer = build(printer=Explodes())
try:
    wait = agent.cycle()
    survived = True
except Exception:
    survived = False
# refresh_printer_state only catches PrinterError, so this one escapes cycle()
# and is caught by run(). What matters is that run() has that net at all.
check(
    "run() catches what cycle() does not",
    "except Exception" in open(os.path.join(HERE, "main.py")).read(),
)


# --- a print must never be reported anonymously -----------------------------
#
# The regression that cost three priority tickets. The Worker settles a job
# `WHERE claimed_by = ?` and falls back to "pico-1" when the body says nothing,
# so a done without a device id matches no row, answers 200, and lets the
# lease expire two minutes later onto a ticket that is already on the floor.
#
# Tested against net.Api rather than FakeApi on purpose: FakeApi is where the
# bug was invisible. Only the real client builds the body.

print("\nreporting a print")

sent_bodies = []


class SpyApi(net.Api):
    def _request(self, method, path, body=None, timeout_s=None):
        sent_bodies.append((path, body))
        return 200, {"ok": True, "updated": 1}


spy = SpyApi("https://example.invalid", "t", "pi-1", "trp100")
spy.report_done({"id": 7, "ids": [7], "ok": True})
check("done carries the device id", sent_bodies[-1][1].get("device") == "pi-1")
check("and still carries the result", sent_bodies[-1][1].get("ok") is True)

spy.report_done({"id": 8, "ids": [8], "ok": True, "device": "someone-else"})
check(
    "the device id cannot be overridden by a caller",
    sent_bodies[-1][1].get("device") == "pi-1",
)

before = {"id": 9, "ids": [9], "ok": True}
spy.report_done(before)
check("and the caller's payload is left alone", "device" not in before)


# A report the Worker matched to nothing has to say so in the log, because the
# next thing that happens is silence followed by "lease expired".
class IgnoringApi(FakeApi):
    def report_done(self, payload):
        self.done_calls.append(payload)
        return {"ok": True, "updated": 0}


agent, _, _ = build(api=IgnoringApi())
lines = []
old_log = agent_main.log
agent_main.log = lambda event, **fields: lines.append(event)
try:
    agent.report({"id": 11, "ids": [11], "ok": True})
finally:
    agent_main.log = old_log
check("a report that matched no job is logged, loudly", "done_ignored" in lines)


# --- the empty answer -------------------------------------------------------
#
# This project exhausted D1's daily allowance of five million rows read on
# 1 September. Three queries were the cause, and all three were made expensive
# by the same thing: something asking often. So how the loop behaves when it is
# told "nothing for you" is now a property worth testing, and not a detail.

print("\nan empty answer after the long poll waited its turn")

agent, api, printer = build(api=FakeApi())
wait = agent.cycle()
check("costs no delay at all", wait == 0)
check("and the poll did ask to wait", api.poll_calls[0][1] == agent_main.LONG_POLL_S)

print("\nan empty answer that comes back instantly")

agent, api, printer = build(api=FakeApi())
api.answers_instantly(poll_after=5.0)
wait = agent.cycle()
check("is taken at its word rather than retried at once", wait == 5.0)

# A Worker that says nothing about when to come back still must not be spun
# against: the floor holds whatever the header says or fails to say.
agent, api, printer = build(api=FakeApi())
api.answers_instantly(poll_after=0.0)
check("and a missing header still leaves a second between tries", agent.cycle() == 1.0)

# --- what a refused token looks like in the journal ------------------------
#
# The one mistake almost everybody makes on a first install is a PRINTER_TOKEN
# that does not match the Worker's, and until now it reached the journal as
# "...: HTTP 401" under the event name `poll_failed` - which docs/02 reads as a
# wrong address or bad DNS. Somebody would have spent an evening on their
# router. The Pico has said "token refused" since it was written; this is the
# Pi agent catching up, and the assertion is on the words because the words are
# the entire fix.

print("\na token the Worker will not take")

import urllib.error
import net as agent_net


class _RefusingOpener:
    """Stands in for urlopen and answers every request with a 401."""

    def __init__(self, code):
        self.code = code

    def __call__(self, request, timeout=None):
        raise urllib.error.HTTPError(
            request.full_url, self.code, "Unauthorized", {}, None
        )


def _error_from(code):
    api = agent_net.Api("https://example.invalid", "wrong-token", "pi", "mxw01")
    saved = agent_net.urllib.request.urlopen
    agent_net.urllib.request.urlopen = _RefusingOpener(code)
    try:
        api.next_job()
    except agent_net.NetworkError as err:
        return str(err)
    finally:
        agent_net.urllib.request.urlopen = saved
    return ""


message = _error_from(401)
check("says the token was refused, in words", "the token was refused" in message)
check("and names the setting to go and look at", "PRINTER_TOKEN" in message)

# The special case must stay special. Every other HTTP answer keeps the plain
# shape, or a 500 starts telling people to check their token.
other = _error_from(500)
check("a 500 is still reported as a 500", "HTTP 500" in other)
check("and does not mention the token", "the token was refused" not in other)

print("\n%d ok, %d failed" % (PASS, FAIL))
sys.exit(1 if FAIL else 0)
