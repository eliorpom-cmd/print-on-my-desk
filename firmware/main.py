# The loop. Polls the Worker, prints what it hands over, and keeps the printer
# awake around the clock.
#
# THE ONE RULE THIS FILE EXISTS TO ENFORCE
#
# The printer stops advertising after roughly ten minutes without a GATT
# connection, and once it does, no BLE peer on earth can wake it - only its
# button (docs/09-protocol.md, zone d'ombre 1). So every path through this loop,
# including every failure path, has to come back to the radio inside nine
# minutes. That is why the WiFi phase carries a deadline it cannot talk its way
# out of, why a network outage shortens rather than lengthens the cycle, and
# why the loop would rather skip a poll than miss a keepalive.
#
# Get that wrong and the service is down until somebody walks over to it.
#
# THE OTHER RULE
#
# Constraint 6: WiFi and BLE never on at once. Enforced in net.py against the
# actual hardware state, not by convention, so a mistake here raises instead of
# wedging the board.
#
# The shape of a cycle:
#
#   [ WiFi up ] heartbeat, poll /next every few seconds, up to ~4 min
#        |                    |
#        |                    +-- a job -> WiFi down -> BLE up -> print
#        |                                              -> BLE down -> WiFi up
#        |                                              -> POST /done
#        +-- deadline reached -> WiFi down -> BLE up -> keepalive -> BLE down
#
# With no network at all - the house WiFi is off at night - the WiFi phase
# fails fast and the loop degrades to keepalive only. The printer is therefore
# already awake in the morning, and nobody has to press anything.

import asyncio
import gc
import time

import machine

import ble_printer as fw
import net

try:
    import config
except ImportError:
    raise SystemExit(
        "firmware/config.py is missing. Copy config.example.py and fill it in."
    )

LED = machine.Pin("LED", machine.Pin.OUT)

# --- Timings ---------------------------------------------------------------

# Hard ceiling on time away from the printer.
#
# M0 measured the sleep threshold at 9.3 to 10.3 minutes, and M2's endurance
# run agreed. The M3 acceptance run did not: keepalives 7.74 to 8.41 minutes
# apart, never over 9, and the printer was gone anyway. Either the threshold is
# lower than M0 concluded, or it depends on something we have not identified.
#
# Until that is understood, these numbers are deliberately conservative rather
# than tuned to a threshold we evidently do not know. The cost of being early
# is a few seconds of radio; the cost of being late is a service that is down
# until someone walks over and presses a button.
#
# 30 August, measured rather than reasoned. A 92 minute capture over the serial
# port (capture/keepalive_watch.py) held 31 contacts with no gap above 3.45
# min, and the printer was lost 3.63 min after a perfectly healthy keepalive -
# the single largest gap of the run, and the only one over 3.45. The scan that
# missed it saw 19 other BLE peers, so the radio was listening and there was
# nothing to hear. Both surviving theories died there: it is not a 9 minute
# timer, and it is not a deaf CYW43.
#
# These numbers cut the cycle to roughly 90 s, comfortably under the 3.45 min
# that was survived 31 times. That is a bet on one observation, which the
# project has been burned by twice - so it is also the experiment: if the
# printer still disappears at 90 s intervals, the interval is not the variable
# and this file should stop pretending it is.
BLE_DEADLINE_MS = 150 * 1000
# Nominal length of a WiFi phase. Ends early on a job, or on the deadline.
WIFI_PHASE_MS = 60 * 1000
# How often the printer gets touched when nothing else is happening.
KEEPALIVE_DUE_MS = 90 * 1000
# How soon to try the printer again once it is known to be asleep. Only its
# button revives it, so this is really "how long after the owner presses it does the
# service come back".
ASLEEP_RECHECK_MS = 45 * 1000
# Between polls while the shop is open. The Worker can override this with its
# x-poll-after header.
POLL_INTERVAL_S = 5
# Consecutive cycles that achieved nothing at all before we stop trusting our
# own state and reboot. Constraint 4: the Pico comes back on its own.
MAX_BARREN_CYCLES = 20
# How many tickets to ask for at once. The printer ejects a few centimetres of
# its own accord at the end of every print, so a queue drained one ticket at a
# time pays that margin once per message - on 30 August a backlog of nineteen
# emptied the roll. Sent as one strip it is paid once. The real ceiling is the
# Worker's line budget, which is bounded by this board's RAM, so this number
# only has to be generous enough not to be the binding constraint.
BATCH_SIZE = 8
# The head refuses to start above 38 C. Coming back at 38 would fail the next
# print and bounce straight back into cooling, so the loop waits for real
# margin before it claims work again. Measured on 30 August: the head sheds
# about one degree per keepalive at 90 s, so this is a few minutes of waiting,
# not tens.
COOL_ENOUGH_C = 34
# Both of the above are only defaults now: the Worker sends the current values
# in every heartbeat, so the thermostat can be retuned from /admin without
# reflashing the board. Raising BOTH is what buys throughput - cooling is
# proportional to the gap with room air, so a head working hotter sheds heat
# faster, while raising only the ceiling just lengthens both halves of the
# cycle.

WIDTH_BYTES = fw.WIDTH_BYTES


# --- Feedback --------------------------------------------------------------


async def blink(count, on_ms=80, off_ms=120):
    for _ in range(count):
        LED.on()
        await asyncio.sleep_ms(on_ms)
        LED.off()
        await asyncio.sleep_ms(off_ms)


def log(event, **fields):
    """One line of JSON per event, so a host can capture the run.

    Hand-rolled rather than json.dumps because this runs on every poll and
    there is no reason to build a dict just to serialise it.
    """
    parts = ['"event":"%s"' % event, '"t":%d' % time.ticks_ms()]
    for key, value in fields.items():
        if value is None:
            parts.append('"%s":null' % key)
        elif isinstance(value, bool):
            parts.append('"%s":%s' % (key, "true" if value else "false"))
        elif isinstance(value, (int, float)):
            parts.append('"%s":%s' % (key, value))
        else:
            parts.append('"%s":"%s"' % (key, str(value).replace('"', "'")))
    print("JSON {" + ",".join(parts) + "}")


# --- Bitmap streaming ------------------------------------------------------


def iter_lines(bitmap):
    """Yields 48-byte views into the ticket, without copying it.

    The whole bitmap is already in RAM - constraint 6 forbids streaming a
    socket into the BLE stack, so it has to be - and a memoryview keeps the
    per-line cost at zero allocations rather than one 48-byte object per line.
    """
    view = memoryview(bitmap)
    for offset in range(0, len(bitmap), WIDTH_BYTES):
        yield view[offset : offset + WIDTH_BYTES]


# --- The loop --------------------------------------------------------------


class Service:
    def __init__(self):
        self.printer = fw.MXW01()
        self.api = net.Api(config.API_BASE, config.API_TOKEN, config.DEVICE_ID)
        self.started_ms = time.ticks_ms()

        # Last time we held a GATT connection. Everything below is scheduled
        # against this, because it is the only clock the printer cares about.
        self.last_ble_ms = None

        self.printer_state = "unknown"
        self.temperature = None
        self.battery = None
        self.last_error = None
        self.prints_ok = 0
        self.prints_failed = 0
        self.barren_cycles = 0

        # A result we printed but could not report yet, because the network was
        # down when we came back. Replayed on the next WiFi phase.
        self.pending_done = None
        # The thermostat, refreshed from every heartbeat.
        self.head_max_c = fw.PRE_PRINT_MAX_TEMPERATURE
        self.cool_to_c = COOL_ENOUGH_C

    # -- state ------------------------------------------------------------

    def ble_overdue(self):
        if self.last_ble_ms is None:
            return True
        return time.ticks_diff(time.ticks_ms(), self.last_ble_ms) >= BLE_DEADLINE_MS

    def ble_margin_ms(self):
        """How long we may stay on WiFi before the printer is at risk."""
        if self.last_ble_ms is None:
            return 0
        elapsed = time.ticks_diff(time.ticks_ms(), self.last_ble_ms)
        return BLE_DEADLINE_MS - elapsed

    def note_contact(self, status):
        self.last_ble_ms = time.ticks_ms()
        if status:
            self.temperature = status.get("temperature")
            self.battery = status.get("battery")
            if self.printer_state == "cooling":
                # Hysteresis, not the bare threshold: coming back at exactly
                # the refusal temperature would fail the very next print and
                # put us straight back here.
                if (self.temperature is not None
                        and self.temperature <= self.cool_to_c):
                    self.printer_state = "awake"
                    self.last_error = None
            else:
                self.printer_state = "awake"

    def heartbeat_fields(self):
        return {
            "printer_state": self.printer_state,
            "temperature": self.temperature,
            "battery": self.battery,
            "uptime_ms": time.ticks_diff(time.ticks_ms(), self.started_ms),
            "firmware": "m3",
            "last_error": self.last_error,
            "prints_ok": self.prints_ok,
            "prints_failed": self.prints_failed,
        }

    # -- BLE phase --------------------------------------------------------

    async def ble_phase(self, job=None):
        """Owns the radio for BLE. Prints a job if given one, else keepalives.

        Always leaves the radio free, whatever happens inside.
        """
        net.wifi_down()
        net.ble_up()
        try:
            if job is None:
                return await self._keepalive()
            return await self._print(job)
        finally:
            try:
                await self.printer.disconnect()
            except Exception:
                pass
            net.ble_down()
            # Stamped whatever happened, including a printer that turned out
            # to be asleep. The deadline exists to stop the printer drifting
            # off while we are busy elsewhere; once it HAS drifted off, there
            # is nothing left to protect and holding the loop against the
            # radio would only keep it off the network - which is exactly
            # when we most need to report that a human has to press a button.
            self.last_ble_ms = time.ticks_ms()

    async def _keepalive(self):
        try:
            await self.printer.connect_with_retry(attempts=2, scan_ms=12000)
            status = await self.printer.get_status()
            self.note_contact(status)
            if status is None:
                # Connected, subscribed, and then nothing came back on the
                # notify channel. Reported rather than swallowed: this used to
                # log a plain "keepalive" and leave printer_state at whatever
                # it was, which is how the status page ends up claiming a
                # healthy printer while nothing works. The link is up, so this
                # is not sleep - keep the state honest and let the next
                # keepalive settle it.
                self.printer_state = "error"
                self.last_error = "connected but no status notification"
                log("keepalive_mute", peers=self.printer.last_scan_peers)
                return False
            if not status["paper_ok"]:
                # Found here rather than at print time, which matters: the
                # keepalive runs every few minutes whether or not anyone has
                # written, so the status page knows the roll is empty before
                # the next message arrives rather than after it is destroyed.
                self.printer_state = "no_paper"
                self.last_error = "out of paper"
                log("keepalive", temperature=self.temperature, paper=False)
                return False
            log("keepalive", temperature=self.temperature, battery=self.battery)
            return True
        except fw.PrinterAsleep:
            # The one failure retrying cannot fix. Record it, tell the Worker,
            # and carry on: the loop still has a job to do, and M6's status
            # page needs to be able to say the printer needs a human.
            self.printer_state = "asleep"
            self.last_error = "printer asleep, needs its button"
            # peers is the diagnostic that matters here. Zero means the scan
            # itself came back empty-handed and the printer is only a suspect;
            # a non-zero count means the radio worked and the printer was
            # genuinely not advertising.
            log("keepalive_failed", error="asleep",
                peers=self.printer.last_scan_peers)
            return False
        except Exception as exc:
            self.printer_state = "error"
            self.last_error = "%s: %s" % (type(exc).__name__, exc)
            log("keepalive_failed", error=self.last_error)
            return False

    async def _print(self, job):
        job_id = job["id"]
        # A strip carries several tickets and is printed or lost as a whole.
        # Older Workers answer with a single id and no list, hence the fallback.
        job_ids = job.get("ids") or [job_id]
        # Where each ticket starts in the transmission. Echoed back on failure
        # so the Worker can tell the tickets that printed from the ones that
        # never left, instead of writing off the whole strip.
        spans = job.get("spans")
        lines = job["lines"]
        bitmap = job["bitmap"]
        intensity = job.get("intensity", config.DEFAULT_INTENSITY)
        started = time.ticks_ms()

        try:
            await self.printer.connect_with_retry()
            status = await self.printer.get_status()
            self.note_contact(status)

            ok, computed, reported, attempts = await self.printer.print_with_retry(
                lambda: iter_lines(bitmap), lines, intensity=intensity,
                max_temp=self.head_max_c
            )

            # Three checksums have to agree: the one the Worker computed over
            # the bytes it rendered, the one we computed while streaming, and
            # the one the printer echoed back from what it actually received.
            # Any disagreement means the ticket on the floor is not the ticket
            # in the database, and that is worth failing over.
            announced = job.get("crc")
            if ok and announced is not None and computed != announced:
                ok = False
                self.last_error = "crc %02X does not match the Worker's %02X" % (
                    computed,
                    announced,
                )

            feed = job.get("feed_lines", 0)
            if ok and feed:
                await self.printer.feed(feed)

            self.last_ble_ms = time.ticks_ms()
            if ok:
                self.prints_ok += 1
            else:
                self.prints_failed += 1
            log(
                "printed",
                id=job_id,
                # How many tickets rode on this strip. One line in the trace
                # that says whether batching is actually happening.
                tickets=len(job_ids),
                ok=ok,
                lines=lines,
                crc=computed,
                reported=reported,
                attempts=attempts,
                # How far the pacing had to climb, and how many writes
                # stalled. Both at their floor means the strip could be longer;
                # a pace near PACING_MAX_MS means it is already too long.
                pace=self.printer.last_pace_ms,
                stalls=self.printer.last_stalls,
                ms=time.ticks_diff(time.ticks_ms(), started),
            )
            self.pending_done = {
                "job_id": job_id,
                "ids": job_ids,
                "ok": ok,
                "crc": computed,
                "error": None if ok else (self.last_error or "crc mismatch"),
                # Bytes went out. Some of the strip may already be on the
                # floor, so it must never be sent again.
                "retry": False,
                "sent": self.printer.last_sent_lines,
                "spans": spans,
                "pace": self.printer.last_pace_ms,
                "stalls": self.printer.last_stalls,
            }
            return ok

        except fw.PrinterAsleep:
            self.printer_state = "asleep"
            self.last_error = "printer asleep, needs its button"
            self.prints_failed += 1
            log("print_failed", id=job_id, error="asleep")
            self.pending_done = {
                "job_id": job_id, "ids": job_ids, "ok": False, "crc": None,
                "error": "printer asleep", "retry": True,
                "sent": 0, "spans": spans,
            }
            return False

        except fw.PrinterNoPaper:
            # Nothing was printed and nothing was lost: print_lines refuses
            # before sending a single line. The job is reported failed so the
            # Worker can put it back, and the state stops the loop claiming
            # another one until someone reloads the roll.
            self.printer_state = "no_paper"
            self.last_error = "out of paper"
            self.prints_failed += 1
            log("print_failed", id=job_id, error="no_paper")
            self.pending_done = {
                "job_id": job_id, "ids": job_ids, "ok": False, "crc": None,
                "error": "out of paper", "retry": True,
                "sent": 0, "spans": spans,
            }
            return False
        except fw.PrinterTooHot as exc:
            # A state to wait out, not an error to retry immediately.
            #
            # Requeueing was right and hammering was not: the job went back,
            # the loop claimed it again seconds later, the head was still at
            # 39 C, and three attempts burned in 45 seconds killed the ticket.
            # A head cools over minutes. "cooling" stops the loop claiming
            # anything until a keepalive sees the temperature come down, which
            # is exactly how an empty roll already behaves.
            self.printer_state = "cooling"
            self.last_error = "too hot: %s" % exc
            self.prints_failed += 1
            log("print_failed", id=job_id, error=self.last_error)
            self.pending_done = {
                "job_id": job_id, "ids": job_ids, "ok": False, "crc": None,
                "error": "printer too hot", "retry": True,
                "sent": 0, "spans": spans,
            }
            return False
        except Exception as exc:
            self.last_error = "%s: %s" % (type(exc).__name__, exc)
            self.prints_failed += 1
            # Not a guess any more: the driver counts the lines it actually
            # wrote. Nothing sent means nothing on the floor, so the strip goes
            # back whatever the exception was - which is what six tickets lost
            # to an undocumented "error flag 0x01" needed.
            sent = self.printer.last_sent_lines
            log("print_failed", id=job_id, error=self.last_error, sent=sent)
            self.pending_done = {
                "job_id": job_id, "ids": job_ids, "ok": False, "crc": None,
                "error": self.last_error[:120], "retry": sent == 0,
                "sent": sent, "spans": spans,
                "pace": self.printer.last_pace_ms,
                "stalls": self.printer.last_stalls,
            }
            return False

    # -- WiFi phase -------------------------------------------------------

    async def wifi_phase(self):
        """Owns the radio for WiFi. Returns a job to print, or None.

        Ends on a job, on the phase timer, or on the BLE deadline - whichever
        comes first. The deadline always wins.
        """
        net.ble_down()
        try:
            ip = net.wifi_up(
                config.WIFI_SSID,
                config.WIFI_PASSWORD,
                timeout_ms=min(20000, max(5000, self.ble_margin_ms())),
                country=getattr(config, "WIFI_COUNTRY", None),
            )
        except net.RadioConflict:
            raise
        except Exception as exc:
            # No network. Not a fault - the house WiFi is off at night. Say so
            # and get back to the printer.
            log("wifi_failed", error=str(exc))
            net.wifi_down()
            return None

        log("wifi_up", ip=ip, rssi=net.wifi_rssi())

        try:
            return await self._poll_while_connected()
        finally:
            net.wifi_down()

    async def _poll_while_connected(self):
        # Anything printed but unreported goes first: the Worker's lease is
        # ticking, and a job it gives up on is a job that never prints again.
        if self.pending_done:
            try:
                self.api.done(**self.pending_done)
                log("done_reported", id=self.pending_done["job_id"], ok=self.pending_done["ok"])
                self.pending_done = None
            except Exception as exc:
                log("done_failed", error=str(exc))

        poll_interval = POLL_INTERVAL_S
        try:
            reply = self.api.heartbeat(**self.heartbeat_fields())
            poll_interval = reply.get("poll_interval_s", POLL_INTERVAL_S)
            # Clamped against the driver's own hard ceiling, so a bad setting
            # cannot cook the head even if it gets past the Worker.
            head_max = reply.get("head_max_c")
            if isinstance(head_max, int) and 25 <= head_max <= fw.MAX_HEAD_TEMPERATURE:
                self.head_max_c = head_max
            cool_to = reply.get("cool_to_c")
            if isinstance(cool_to, int) and 20 <= cool_to < self.head_max_c:
                self.cool_to_c = cool_to
            log("heartbeat", open=reply.get("open"), poll=poll_interval)
            if not reply.get("open"):
                # Closed or paused. Nothing will be handed out, so there is no
                # point holding the radio: go back to keeping the printer warm.
                return None
        except Exception as exc:
            log("heartbeat_failed", error=str(exc))

        if self.printer_state in ("asleep", "no_paper", "cooling"):
            # Claiming a job we cannot print would burn it: the Worker would
            # hand it over, we would fail it, and the message would be gone
            # for a reason its author had nothing to do with. Leave it queued
            # and go back to trying the human-shaped problem instead. The
            # heartbeat above has already told the Worker why.
            #
            # An empty roll belongs here for a sharper reason than a sleeping
            # printer does. Asleep, the print fails loudly. With no paper the
            # printer accepts every byte and answers with the correct CRC -
            # it did receive them - so the job would go to 'printed' with
            # nothing on the floor and no trace anywhere. See docs/09-protocol.md 3.3.
            log("poll_skipped", reason="printer_" + self.printer_state)
            return None

        phase_deadline = time.ticks_add(time.ticks_ms(), WIFI_PHASE_MS)
        while True:
            # The BLE deadline outranks everything, including a poll we are
            # about to make.
            if self.ble_overdue() or self.ble_margin_ms() < 20000:
                log("wifi_phase_end", reason="ble_deadline")
                return None
            if time.ticks_diff(phase_deadline, time.ticks_ms()) <= 0:
                log("wifi_phase_end", reason="phase_timer")
                return None

            try:
                job, poll_after = self.api.next_job(batch=BATCH_SIZE)
                if job:
                    log("job", id=job["id"], lines=job["lines"], bytes=len(job["bitmap"]))
                    return job
                if poll_after:
                    poll_interval = poll_after
            except Exception as exc:
                log("poll_failed", error=str(exc))
                # A dead socket here usually means the WiFi went away under us.
                return None

            if poll_interval > 60:
                # The Worker is telling us the shop is closed. Believe it, but
                # never sleep past the printer's deadline.
                return None
            await asyncio.sleep(poll_interval)

    # -- main -------------------------------------------------------------

    async def run(self):
        log("start", base=config.API_BASE, device=config.DEVICE_ID, free=gc.mem_free())

        # Start on the printer. We have no idea how long it has been alone -
        # this may be a cold boot after a power cut in the middle of the night.
        await self.ble_phase()

        while True:
            gc.collect()
            job = None

            # Skip the network entirely when the printer is close to its
            # deadline. Nothing on the Worker is more urgent than not having to
            # walk over and press a button.
            if not self.ble_overdue() and self.ble_margin_ms() > 60000:
                try:
                    job = await self.wifi_phase()
                except net.RadioConflict as exc:
                    # A bug, not a condition. Reboot rather than continue with
                    # both radios in a state we no longer understand.
                    log("radio_conflict", error=str(exc))
                    await blink(10, 40, 40)
                    machine.reset()
            else:
                log("wifi_skipped", reason="ble_deadline")

            if job is not None:
                LED.on()
                ok = await self.ble_phase(job)
                LED.off()
                await blink(3 if ok else 1, 60, 60)
                await self.report_pending()
                self.barren_cycles = 0
                # Another job may be waiting right behind this one. Go straight
                # back to polling instead of sitting out a keepalive interval.
                continue

            # Nothing to print. Keep the printer awake if it is due, then wait
            # out the rest of the interval.
            elapsed = (
                BLE_DEADLINE_MS
                if self.last_ble_ms is None
                else time.ticks_diff(time.ticks_ms(), self.last_ble_ms)
            )
            # A sleeping printer is checked far more often than a healthy one:
            # the fix is someone pressing a button, and the service should come
            # back within a minute of them doing it, not within five.
            due = (ASLEEP_RECHECK_MS
                   if self.printer_state in ("asleep", "no_paper", "cooling")
                   else KEEPALIVE_DUE_MS)
            if elapsed >= due:
                ok = await self._keepalive_phase()
                self.barren_cycles = 0 if ok else self.barren_cycles + 1
            else:
                # Wait out the remainder, then touch the printer - do NOT loop
                # back to another WiFi phase first.
                #
                # That is what the first version did, and it quietly stretched
                # the interval from the intended 5 minutes to 4 + 1 + 4, capped
                # only by the BLE deadline. Measured on hardware: keepalives
                # landed 7.74 to 8.41 minutes apart, and the printer fell
                # asleep anyway. The loop was obeying its own rule and still
                # losing the printer.
                #
                # This branch is also the one the night runs in: WiFi is down,
                # the WiFi phase fails in seconds, and sleeping the remainder
                # in one go keeps the loop to a handful of wake-ups an hour
                # instead of hammering a router that is switched off.
                await asyncio.sleep_ms(due - elapsed)
                ok = await self._keepalive_phase()
                self.barren_cycles = 0 if ok else self.barren_cycles + 1

            if self.barren_cycles >= MAX_BARREN_CYCLES:
                # Nothing has worked for a long time, and our own state is the
                # last suspect standing. Start again from a known one.
                log("reset", reason="barren", cycles=self.barren_cycles)
                machine.reset()

    async def _keepalive_phase(self):
        return await self.ble_phase()

    async def report_pending(self):
        """Brings WiFi up just long enough to POST /done, then lets go.

        Separate from a full WiFi phase because a ticket that just came out
        deserves to be confirmed in seconds, not at the end of a four-minute
        poll: the Worker's lease is running, and a lease it gives up on becomes
        a job that never prints again.
        """
        if not self.pending_done:
            return
        net.ble_down()
        try:
            net.wifi_up(
                config.WIFI_SSID,
                config.WIFI_PASSWORD,
                timeout_ms=15000,
                country=getattr(config, "WIFI_COUNTRY", None),
            )
            self.api.done(**self.pending_done)
            log("done_reported", id=self.pending_done["job_id"], ok=self.pending_done["ok"])
            self.pending_done = None
        except Exception as exc:
            # Keep it for the next WiFi phase. If the lease expires first the
            # Worker marks the job failed and never reprints it, which is the
            # behaviour we chose over risking a duplicate ticket.
            log("done_deferred", error=str(exc))
        finally:
            net.wifi_down()


async def main():
    service = Service()
    try:
        await service.run()
    except Exception as exc:
        log("fatal", error="%s: %s" % (type(exc).__name__, exc))
        # Constraint 4: the Pico comes back on its own, with nobody there.
        await blink(6, 60, 60)
        machine.reset()


if __name__ == "__main__":
    asyncio.run(main())
