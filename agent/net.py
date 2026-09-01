# The Worker, seen from the Raspberry Pi.
#
# The counterpart of firmware/net.py, minus everything that file exists for.
# That one carries a radio lock, because constraint 6 forbids WiFi and BLE
# being on at once and a mistake wedges the board; and a chunked-transfer
# reader, because MicroPython has no HTTP client and Cloudflare answers
# `Transfer-Encoding: chunked` for a generated response. The Pi has neither
# problem: one radio, and urllib.
#
# Only the standard library, deliberately. The one dependency this agent has is
# pyusb, and it has it because there is no other way to speak to the printer.
# A second one, for HTTP that urllib already does, would be a package to keep
# up to date on a machine nobody logs into.
#
# CONSTRAINT 2 OF THE BRIEF STILL HOLDS
#
# No open port on the box. Every connection here is outbound, the Pi is never
# addressable from outside, and the residential IP is never exposed. Moving
# from a microcontroller to a Linux box with a real network stack is exactly
# the moment that quietly stops being true, so it is written down here.

import json
import socket
import time
import urllib.error
import urllib.request


def _seconds(value):
    """A header's worth of seconds, or zero. Never an exception."""
    try:
        return max(float(value), 0.0)
    except (TypeError, ValueError):
        return 0.0


class NetworkError(Exception):
    """The Worker could not be reached, or did not answer sensibly."""


class Api:
    """The four machine endpoints, and nothing else."""

    def __init__(self, base_url, token, device_id, profile, timeout_s=20):
        self.base = base_url.rstrip("/")
        self.token = token
        self.device_id = device_id
        self.profile = profile
        self.timeout_s = timeout_s
        # What the last poll was told to do, and how long it actually took.
        # main.py needs both to tell a long poll that waited its turn from an
        # empty answer that came back instantly.
        self.last_poll_after = 0.0
        self.last_poll_elapsed = 0.0

    # -- plumbing -------------------------------------------------------

    def _request(self, method, path, body=None, timeout_s=None):
        url = self.base + path
        data = None
        headers = {
            # Both are accepted (worker/src/auth.js). Bearer is the one the
            # Worker documents; the token never goes in a URL, because query
            # strings end up in logs.
            "Authorization": "Bearer " + self.token,
            "Accept": "application/json",
            "User-Agent": "print-on-my-desk-agent/1.0",
        }
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"

        request = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=timeout_s or self.timeout_s) as response:
                status = response.status
                raw = response.read()
                # The Worker says how long to wait before asking again. It is
                # read here rather than ignored because an empty answer that
                # comes back instantly, polled again instantly, is a hot loop
                # against a database with a daily allowance - see main.py.
                self.last_poll_after = _seconds(response.headers.get("x-poll-after"))
        except urllib.error.HTTPError as err:
            # An HTTP error is an answer, and some of them are meaningful.
            raise NetworkError("%s %s: HTTP %d" % (method, path, err.code))
        except (urllib.error.URLError, socket.timeout, OSError) as err:
            raise NetworkError("%s %s: %s" % (method, path, err))

        if status == 204 or not raw:
            return status, None
        try:
            return status, json.loads(raw.decode("utf-8"))
        except ValueError as err:
            raise NetworkError("%s %s: bad JSON: %s" % (method, path, err))

    # -- the endpoints --------------------------------------------------

    def next_job(self, batch=1, wait_s=0):
        """The next job, or None.

        `wait_s` asks the Worker to hold the connection open until there is
        something rather than answer 204 straight away, which is what turns
        "up to five seconds after the owner taps approve" into "about one". The
        Pico never asks for it: its cycle is ruled by a nine-minute BLE
        deadline and it cannot afford to sit on a socket.

        The read timeout has to outlast the wait, or the agent hangs up on the
        very request it asked to be slow, every time, forever.
        """
        self.last_poll_after = 0.0
        started = time.monotonic()
        path = "/api/machine/next?device=%s&profile=%s" % (self.device_id, self.profile)
        if batch > 1:
            path += "&batch=%d" % batch
        if wait_s > 0:
            path += "&wait=%d" % wait_s
        status, body = self._request("GET", path, timeout_s=self.timeout_s + wait_s)
        self.last_poll_elapsed = time.monotonic() - started
        if status == 204 or body is None:
            return None
        return body

    def report_done(self, payload):
        """Reports one strip's outcome.

        The device id is not optional and was, for one morning, missing. The
        Worker only settles a job `WHERE claimed_by = ?`, and a body without
        `device` makes it fall back to "pico-1" - so every ticket this agent
        printed stayed `printing`, answered 200 with `updated: 0`, and was
        swept into `failed / lease expired` two minutes later. Three a tip jar
        tickets came out of the printer and the queue recorded all three as
        never printed. Set here rather than by every caller: there is one
        device, it knows its own name, and nothing that reports a print may
        report it anonymously.
        """
        body = dict(payload)
        body["device"] = self.device_id
        return self._request("POST", "/api/machine/done", body)[1]

    def heartbeat(self, fields):
        body = dict(fields)
        body["device"] = self.device_id
        body["profile"] = self.profile
        return self._request("POST", "/api/machine/heartbeat", body)[1] or {}

    def probe(self, lines=32):
        """A test ticket that never touches the queue."""
        return self._request(
            "GET", "/api/machine/probe?lines=%d&profile=%s" % (lines, self.profile)
        )[1]
