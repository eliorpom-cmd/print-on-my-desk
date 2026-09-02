# The loop, on the Raspberry Pi.
#
# WHAT THIS FILE NO LONGER HAS TO DO, AND IT IS MOST OF IT
#
# firmware/main.py opens on a rule in capitals: the MXW01 stops advertising
# after about ten minutes without a GATT connection, and once it does, no BLE
# peer on earth can wake it - only its button. Every path through that loop,
# including every failure path, had to come back to the radio inside nine
# minutes. That is why its WiFi phase carried a deadline it could not talk its
# way out of, why a network outage SHORTENED its cycle, and why it would rather
# skip a poll than miss a keepalive.
#
# None of that is true over USB. The printer does not fall asleep, does not
# need to be kept awake, and cannot be lost to a timer. There is no radio lock
# either: constraint 6 existed because WiFi and BLE on one Pico is the first
# cause of a crash, and there is one radio here.
#
# So the loop is what it always wanted to be:
#
#   heartbeat -> ask for work, holding the line open -> print it -> say so
#
# WHAT IS STILL TRUE, AND HAD TO BE CARRIED OVER
#
#   - A result that cannot be reported is kept and replayed. A print that
#     happened and was never confirmed is the one failure that loses a message
#     while looking like success.
#   - `retry` is only true when NOTHING was sent. Re-sending a strip that
#     partly printed would print those tickets twice, and this project's
#     standing choice is a miss over a duplicate.
#   - `sent` and `spans` travel with a failure, so the Worker can requeue only
#     the tickets that never left. One stall used to take a whole strip down.
#   - The machine refuses to claim work it cannot print. Claiming a job with an
#     empty roll burns it for a reason its author had nothing to do with.

import argparse
import base64
import json
import signal
import sys
import time

import net

try:
    import config
except ImportError:
    raise SystemExit(
        "agent/config.py is missing. Copy config.example.py and fill it in."
    )


# Which printer this box is plugged into, and therefore which driver.
#
# Two machines, two buses, two profiles, and ONE loop above them: everything
# from here down is about the queue, the network and the paper, none of which
# cares how the bytes reach the head.
#
#   escpos   an 80 mm receipt printer over USB. The default, because it is what
#            this project runs on.
#   ble      the 58 mm Bluetooth one, over bleak. Needs `pip install bleak`.
#
# The two driver modules export the same names on purpose - the same four
# exceptions, the same WIDTH_BYTES, the same methods - so that the alternative
# to this dictionary would be branching in nine places, and one of them would
# eventually be forgotten.
DRIVERS = {
    "escpos": ("escpos_printer", "TRP100", "trp100"),
    "ble": ("ble_printer", "MXW01", "mxw01"),
}

DRIVER = getattr(config, "PRINTER", "escpos")
if DRIVER not in DRIVERS:
    raise SystemExit(
        "config.PRINTER is %r; it has to be one of %s"
        % (DRIVER, ", ".join(sorted(DRIVERS)))
    )

_module, _cls, PROFILE = DRIVERS[DRIVER]
ep = __import__(_module)
PrinterClass = getattr(ep, _cls)

# How long to hold /api/machine/next open waiting for work. The Worker clamps
# this to 25 s; asking for more is not an error, it just does not happen.
LONG_POLL_S = 25

# How often to say we are alive when nothing else is happening. The desk shows
# this, and a status page that says "last seen four minutes ago" is the whole
# reason anyone knows the machine is off.
HEARTBEAT_EVERY_S = 60

# After a network failure. Short, because the house WiFi goes off at night and
# the service should come back within a minute of it returning, not within
# whatever an exponential backoff has climbed to by morning.
NET_RETRY_S = 15
NET_RETRY_MAX_S = 120

# After the printer refuses - empty roll, open lid, unplugged. Long enough not
# to spin, short enough that the service restarts within a minute of somebody
# loading paper.
PRINTER_RETRY_S = 30

running = True


def log(event, **fields):
    """One JSON object per line, which is what journalctl is good at."""
    fields["event"] = event
    fields["t"] = round(time.time(), 3)
    print(json.dumps(fields, ensure_ascii=False), flush=True)


class Agent:
    def __init__(self, api, printer, batch_size):
        self.api = api
        self.printer = printer
        self.batch_size = batch_size

        self.started = time.monotonic()
        self.printer_state = "unknown"
        self.last_error = None
        self.prints_ok = 0
        self.prints_failed = 0

        # A result we printed but could not report, because the network was
        # down when we came back. Replayed before anything else is claimed.
        self.pending_done = None

        self.paused = False
        self.last_heartbeat = 0.0
        self.net_backoff = NET_RETRY_S

    # -- state ----------------------------------------------------------

    def heartbeat_fields(self):
        return {
            "printer_state": self.printer_state,
            # The MXW01 reported both in every status frame. The TRP 100 III
            # reports neither: it is mains powered and says nothing about its
            # head. Sent as null rather than omitted, so the desk's columns do
            # not change shape depending on which machine is plugged in.
            "temperature": None,
            "battery": None,
            "uptime_ms": int((time.monotonic() - self.started) * 1000),
            "firmware": "agent-1.0",
            "last_error": self.last_error,
            "prints_ok": self.prints_ok,
            "prints_failed": self.prints_failed,
        }

    def refresh_printer_state(self):
        """Looks at the printer and records what it says. Never raises."""
        try:
            self.printer.open()
            status = self.printer.status()
        except ep.PrinterError as err:
            # "offline" covers three causes that cannot be told apart, and
            # saying so is better than guessing.
            #
            # This printer LEAVES THE USB BUS when the roll is removed or the
            # lid is opened (31 August, docs/ESCPOS.md 3). From here that looks
            # exactly like the cable being pulled: the device is not there, and
            # a device that is not there cannot be asked why. So the message
            # names all three, and whoever reads it can look at the machine.
            self.printer_state = "offline"
            self.last_error = "imprimante injoignable (papier, capot ou cable) - %s" % (
                str(err)[:80]
            )
            return
        if status["cover"]:
            self.printer_state = "cover_open"
            self.last_error = "the lid is open"
        elif status["paper"] is False:
            self.printer_state = "no_paper"
            self.last_error = "the roll is empty"
        else:
            self.printer_state = "awake"
            self.last_error = None

    @property
    def can_print(self):
        return self.printer_state == "awake"

    # -- reporting ------------------------------------------------------

    def flush_pending(self):
        """Replays a result that could not be reported when it happened."""
        if not self.pending_done:
            return True
        try:
            reply = self.api.report_done(self.pending_done)
        except net.NetworkError as err:
            log("done_deferred", error=str(err))
            return False
        # The batch endpoint answers 200 whether or not it changed anything, so
        # a report that matched no row looks exactly like a report that worked.
        # That is how three priority tickets came out of the printer and were
        # recorded as never printed: the device id was missing, nothing
        # matched, and the 200 said nothing was wrong. Loud here, because the
        # next symptom is two minutes away and reads as a lease expiring.
        if isinstance(reply, dict) and reply.get("updated") == 0:
            log(
                "done_ignored",
                ids=self.pending_done.get("ids"),
                error="the Worker matched no job - wrong device id, or the lease is gone",
            )
        log("done_reported", ids=self.pending_done.get("ids"))
        self.pending_done = None
        return True

    def report(self, payload):
        self.pending_done = payload
        return self.flush_pending()

    # -- printing -------------------------------------------------------

    def print_job(self, job):
        job_id = job["id"]
        # A strip carries several tickets and is printed or lost as a whole.
        job_ids = job.get("ids") or [job_id]
        spans = job.get("spans")
        lines = job["lines"]
        width_bytes = job.get("width_bytes", ep.WIDTH_BYTES)
        feed = job.get("feed_lines", 0)
        announced = job.get("crc")

        # A payload rendered for the other printer would print as noise, at the
        # wrong width, silently. Refused rather than attempted: it means the
        # Worker and this agent disagree about what is plugged in, which is a
        # configuration fault and not a print to retry.
        if width_bytes != ep.WIDTH_BYTES:
            self.prints_failed += 1
            self.last_error = "payload is %d bytes wide, this printer is %d" % (
                width_bytes,
                ep.WIDTH_BYTES,
            )
            log("print_refused", id=job_id, error=self.last_error)
            self.report(
                {
                    "id": job_id, "ids": job_ids, "ok": False, "crc": None,
                    "error": self.last_error, "retry": True,
                    "sent": 0, "spans": spans,
                }
            )
            return False

        image = base64.b64decode(job["data"])
        started = time.monotonic()

        try:
            self.printer.open()
            # Before the image, so the noise and the paper arrive together.
            # Only priority tickets carry this flag (jobs.js), and the whole point
            # of them is not to be missed among five thousand others.
            if job.get("beep"):
                self.printer.beep(variant=getattr(config, "BEEP_VARIANT", 0), times=3)
            crc = self.printer.print_lines(
                ep.iter_lines(image, width_bytes),
                lines,
                width_bytes=width_bytes,
                feed_lines=feed,
            )
        except (ep.PrinterNoPaper, ep.PrinterCoverOpen) as err:
            # Nothing was sent: print_lines refuses before the first band.
            # So the strip goes back in the queue whole, and the attempt it was
            # charged on the way out is given back.
            self.printer_state = "no_paper" if isinstance(err, ep.PrinterNoPaper) else "cover_open"
            self.last_error = str(err)[:120]
            self.prints_failed += 1
            log("print_refused", id=job_id, error=self.last_error)
            self.report(
                {
                    "id": job_id, "ids": job_ids, "ok": False, "crc": None,
                    "error": self.last_error, "retry": True,
                    "sent": 0, "spans": spans,
                }
            )
            return False
        except Exception as err:
            # Deliberately broad. A PrinterError is the expected failure, but a
            # malformed payload raises ValueError out of raster_command, and
            # anything unforeseen raises whatever it likes. Letting those
            # escape left the job marked `printing` with nobody to report it,
            # until the two-minute lease swept it into `failed` - so the one
            # message that most needed an explanation got none.
            sent = self.printer.last_sent_lines
            self.printer_state = (
                "offline" if isinstance(err, ep.PrinterOffline) else "error"
            )
            self.last_error = str(err)[:120] or repr(err)[:120]
            self.prints_failed += 1
            log("print_failed", id=job_id, error=self.last_error, sent=sent)
            self.report(
                {
                    "id": job_id, "ids": job_ids, "ok": False, "crc": None,
                    "error": self.last_error,
                    # Bytes may already be on the floor. Only a transfer that
                    # sent nothing may go round again.
                    "retry": sent == 0,
                    "sent": sent, "spans": spans,
                }
            )
            return False

        # Two checksums have to agree: the one the Worker computed over the
        # bytes it rendered, and the one computed here while streaming.
        #
        # On the MXW01 there was a third - the printer echoed the CRC of what
        # it had actually received - and that one is gone for good, because
        # ESC/POS has no such reply. What is left proves the ticket survived
        # D1, HTTP and base64. It does not prove it survived the cable.
        ok = True
        if announced is not None and crc != announced:
            ok = False
            self.last_error = "crc %02X does not match the Worker's %02X" % (crc, announced)

        if ok:
            self.prints_ok += 1
            self.last_error = None
        else:
            self.prints_failed += 1

        log(
            "printed",
            id=job_id,
            tickets=len(job_ids),
            ok=ok,
            lines=lines,
            crc=crc,
            ms=int((time.monotonic() - started) * 1000),
        )
        self.report(
            {
                "id": job_id, "ids": job_ids, "ok": ok, "crc": crc,
                "error": None if ok else self.last_error,
                # Bytes went out either way, so this is never retried.
                "retry": False,
                "sent": self.printer.last_sent_lines, "spans": spans,
            }
        )
        return ok

    # -- the loop -------------------------------------------------------

    def beat(self):
        """Heartbeat, and what the Worker says back. Returns False on failure."""
        try:
            reply = self.api.heartbeat(self.heartbeat_fields())
        except net.NetworkError as err:
            log("heartbeat_failed", error=str(err))
            return False
        self.last_heartbeat = time.monotonic()
        self.paused = bool(reply.get("kill_switch")) or reply.get("open") is False
        return True

    def cycle(self):
        """One turn. Returns how long to wait before the next one."""
        self.refresh_printer_state()

        due = time.monotonic() - self.last_heartbeat >= HEARTBEAT_EVERY_S
        if due or not self.can_print:
            if not self.beat():
                return self.after_network_failure()
            self.net_backoff = NET_RETRY_S

        if not self.flush_pending():
            return self.after_network_failure()

        if self.paused:
            log("paused")
            return HEARTBEAT_EVERY_S

        if not self.can_print:
            # Deliberately does not ask for work. Claiming a job the machine
            # cannot print burns it for a reason its author had nothing to do
            # with - the lesson of ETAT 2.9, and it survives the change of
            # printer unchanged.
            log("waiting", state=self.printer_state, error=self.last_error)
            return PRINTER_RETRY_S

        try:
            job = self.api.next_job(batch=self.batch_size, wait_s=LONG_POLL_S)
        except net.NetworkError as err:
            log("poll_failed", error=str(err))
            return self.after_network_failure()

        self.net_backoff = NET_RETRY_S
        if job is None:
            return self.after_empty_poll()

        self.print_job(job)
        return 0

    def after_empty_poll(self):
        """How long to wait after being told there is nothing.

        Normally none at all: the long poll already spent twenty-five seconds
        waiting, so coming straight back costs one request a minute and keeps
        the delay between the owner tapping approve and paper moving at about a
        second.

        The exception is an empty answer that arrives FAST, which means the
        Worker refused to wait - the kill switch is on, the season is closed,
        or something upstream is unwell. Returning 0 there is a hot loop
        against a database with a daily allowance, and this project has already
        spent one of those. So a short answer is taken at its word: the Worker
        says how long to wait in x-poll-after, and this waits it.

        The Worker enforces the same floor on its own side, because the Pico's
        firmware is frozen and cannot learn this. Both are worth having: this
        one keeps the requests from being made, that one keeps them cheap when
        they are.
        """
        waited_its_turn = self.api.last_poll_elapsed >= LONG_POLL_S * 0.8
        if waited_its_turn:
            return 0
        return max(self.api.last_poll_after, 1.0)

    def after_network_failure(self):
        wait = self.net_backoff
        self.net_backoff = min(self.net_backoff * 2, NET_RETRY_MAX_S)
        return wait

    def run(self):
        log(
            "start",
            device=self.api.device_id,
            profile=PROFILE,
            base=self.api.base,
            batch=self.batch_size,
        )
        while running:
            try:
                wait = self.cycle()
            except Exception as err:  # a bug here must not end the service
                log("cycle_error", error=repr(err)[:200])
                wait = NET_RETRY_S
            slept = 0.0
            while running and slept < wait:
                time.sleep(min(0.5, wait - slept))
                slept += 0.5
        log("stop")


def stop(signum, frame):
    global running
    running = False


def main():
    parser = argparse.ArgumentParser(description="Print on my desk agent, USB/ESC/POS")
    parser.add_argument("--once", action="store_true", help="one cycle, then exit")
    parser.add_argument("--probe", type=int, metavar="LINES",
                        help="print the transport test pattern and exit")
    parser.add_argument("--status", action="store_true",
                        help="say what the printer says about itself, and exit")
    parser.add_argument("--batch", type=int, default=getattr(config, "BATCH_SIZE", 8))
    args = parser.parse_args()

    # Each driver takes what its own bus needs and ignores the rest, so the
    # config file can carry both without either complaining.
    if DRIVER == "ble":
        printer = PrinterClass(address=getattr(config, "BLE_ADDRESS", None))
    else:
        printer = PrinterClass(
            vendor_id=getattr(config, "USB_VENDOR_ID", None),
            product_id=getattr(config, "USB_PRODUCT_ID", None),
        )
    api = net.Api(config.WORKER_URL, config.PRINTER_TOKEN, config.DEVICE_ID, PROFILE)

    # --status and --probe are the first two things anybody runs, and a Python
    # traceback is a bad way to be told that a cable is not plugged in.
    if args.status:
        try:
            printer.open()
        except ep.PrinterError as err:
            print(err)
            return 1
        state = printer.status()
        print(json.dumps(state, indent=2))
        if state["paper"] is None:
            print(
                "\nThe printer did not answer. Either it has no bulk IN endpoint,\n"
                "or the status bits are not what the specification says.\n"
                "Run agent/probe_status.py - it settles that, and prints nothing."
            )
        return 0

    if args.probe is not None:
        try:
            job = api.probe(args.probe or 32)
        except net.NetworkError as err:
            print("could not reach the Worker: %s" % err)
            print("check WORKER_URL and PRINTER_TOKEN in agent/config.py")
            return 1
        # The probe is not a queue job: nothing to confirm, nothing to requeue.
        try:
            printer.open()
            crc = printer.print_lines(
                ep.iter_lines(base64.b64decode(job["data"]), job["width_bytes"]),
                job["lines"],
                width_bytes=job["width_bytes"],
                feed_lines=90,
            )
        except ep.PrinterError as err:
            print(err)
            return 1
        print("crc %02X, the Worker said %02X" % (crc, job["crc"]))
        return 0 if crc == job["crc"] else 1

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    agent = Agent(api, printer, args.batch)
    if args.once:
        agent.cycle()
        return 0
    agent.run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
