# Network side of the Pico: radio arbitration and a minimal HTTPS client.
#
# Two jobs, and the first one matters more than it looks.
#
# 1. RADIO ARBITRATION. Constraint 6 of the brief: WiFi and BLE never run at
#    the same time on the CYW43439, because that is the first cause of lockups
#    on this part. A convention would be enough if nobody ever made a mistake,
#    so instead the check reads the hardware: wifi_up() refuses to run while
#    the BLE stack is active, and ble_up() refuses while the WLAN interface is.
#    Getting it wrong raises immediately instead of wedging the board somewhere
#    a power cycle is the only way out.
#
# 2. HTTP. MicroPython ships `requests`, and it would work. It is not used here
#    because it gives no reliable control over socket timeouts, and a socket
#    that blocks forever is not a slow request on this device - it is a cycle
#    that overruns nine minutes, a printer that falls asleep, and a service
#    that is down until someone walks over and presses a button. Every read
#    below has a deadline for that reason.

import json
import socket
import ssl
import time

import binascii

# --- radio arbitration -----------------------------------------------------


class RadioConflict(Exception):
    """Both radios were about to be on at once. Refuse, loudly."""


class NetworkError(Exception):
    pass


# How long after connect() a status error is treated as not yet meaningful.
# See the comment in wifi_up(): a precaution, not something observed here.
WIFI_STATUS_GRACE_MS = 4000


def _wlan():
    import network

    return network.WLAN(network.STA_IF)


def _ble():
    import bluetooth

    return bluetooth.BLE()


def ble_is_active():
    try:
        return bool(_ble().active())
    except Exception:
        return False


def wifi_is_active():
    try:
        return bool(_wlan().active())
    except Exception:
        return False


def ble_up():
    """Hands the radio to BLE. Call before anything touches aioble."""
    if wifi_is_active():
        raise RadioConflict("WiFi still active; call wifi_down() first")
    _ble().active(True)


def ble_down():
    """Releases the radio from BLE.

    aioble has no teardown of its own, so the BLE modem is switched off at the
    bluetooth module level. The singleton survives, and comes back on the next
    active(True).
    """
    try:
        _ble().active(False)
    except Exception:
        pass


def wifi_down():
    """Releases the radio from WiFi. Safe to call when it is already down."""
    try:
        wlan = _wlan()
        try:
            wlan.disconnect()
        except Exception:
            pass
        wlan.active(False)
    except Exception:
        pass


def wifi_up(ssid, password, timeout_ms=20000, country=None):
    """Connects to WiFi and returns the IP address.

    Raises NetworkError rather than looping: the caller has a keepalive to run
    and cannot afford to sit here.
    """
    if ble_is_active():
        raise RadioConflict("BLE still active; call ble_down() first")

    if country:
        try:
            import rp2

            rp2.country(country)
        except Exception:
            pass

    import network

    wlan = _wlan()
    wlan.active(True)
    if wlan.isconnected():
        return wlan.ifconfig()[0]

    # Clear any association left over from a previous attempt, otherwise the
    # status read below can describe that one instead of this one.
    try:
        wlan.disconnect()
    except Exception:
        pass

    wlan.connect(ssid, password)

    # A precaution, NOT a measurement - the one time this looked like a stale
    # status on hardware, the real cause turned out to be a bad SSID, so the
    # behaviour is unproven here. It is kept because the cost is bounded (a
    # few seconds only on the failure path) and because reading a status the
    # instant after connect() is asking the driver a question it has not had
    # time to answer. If a genuine case ever confirms it, say so here.
    grace_ms = min(WIFI_STATUS_GRACE_MS, timeout_ms // 2)
    grace_until = time.ticks_add(time.ticks_ms(), grace_ms)

    deadline = time.ticks_add(time.ticks_ms(), timeout_ms)
    while True:
        status = wlan.status()
        if status == network.STAT_GOT_IP and wlan.isconnected():
            return wlan.ifconfig()[0]

        if time.ticks_diff(time.ticks_ms(), grace_until) > 0:
            # These are final: retrying in this loop only wastes the deadline.
            if status == network.STAT_WRONG_PASSWORD:
                wifi_down()
                raise NetworkError("wrong WiFi password")
            if status == network.STAT_NO_AP_FOUND:
                wifi_down()
                raise NetworkError("access point not found")
            if status == network.STAT_CONNECT_FAIL:
                wifi_down()
                raise NetworkError("connection failed")

        if time.ticks_diff(deadline, time.ticks_ms()) <= 0:
            wifi_down()
            raise NetworkError("WiFi timeout after %d ms" % timeout_ms)
        time.sleep_ms(200)


def wifi_rssi():
    try:
        return _wlan().status("rssi")
    except Exception:
        return None


# --- minimal HTTPS client --------------------------------------------------


class HttpError(Exception):
    def __init__(self, message, status=None):
        Exception.__init__(self, message)
        self.status = status


def _split_url(url):
    if url.startswith("https://"):
        scheme, rest = "https", url[8:]
    elif url.startswith("http://"):
        scheme, rest = "http", url[7:]
    else:
        raise HttpError("unsupported URL: %s" % url)
    slash = rest.find("/")
    if slash == -1:
        host, path = rest, "/"
    else:
        host, path = rest[:slash], rest[slash:]
    port = 443 if scheme == "https" else 80
    if ":" in host:
        host, _, port_str = host.partition(":")
        port = int(port_str)
    return scheme, host, port, path


def _readline(sock, limit=512):
    """Reads one CRLF-terminated line.

    Written a byte at a time on purpose: readline() on a wrapped TLS socket
    will happily read past the header block and swallow part of the body.
    """
    out = bytearray()
    while len(out) < limit:
        chunk = sock.read(1)
        if not chunk:
            break
        if chunk == b"\n":
            break
        if chunk != b"\r":
            out += chunk
    return bytes(out)


def _read_exactly(sock, n, max_bytes):
    if n > max_bytes:
        raise HttpError("response of %d bytes exceeds the %d cap" % (n, max_bytes))
    out = bytearray()
    while len(out) < n:
        chunk = sock.read(min(1024, n - len(out)))
        if not chunk:
            raise HttpError("connection closed after %d of %d bytes" % (len(out), n))
        out += chunk
    return bytes(out)


def _read_chunked(sock, max_bytes):
    """Cloudflare answers a generated response with chunked encoding.

    `requests` gets this wrong often enough that it is worth 15 lines to get it
    right: a silently truncated ticket is exactly the failure this project
    spent M0 learning to detect.
    """
    out = bytearray()
    while True:
        line = _readline(sock)
        if not line:
            raise HttpError("truncated chunked body")
        semi = line.find(b";")
        if semi != -1:
            line = line[:semi]
        try:
            size = int(line, 16)
        except ValueError:
            raise HttpError("bad chunk size %r" % line)
        if size == 0:
            _readline(sock)  # trailing CRLF
            break
        if len(out) + size > max_bytes:
            raise HttpError("chunked body exceeds the %d byte cap" % max_bytes)
        out += _read_exactly(sock, size, max_bytes)
        _readline(sock)  # CRLF after each chunk
    return bytes(out)


def request(
    method,
    url,
    token=None,
    body=None,
    timeout_ms=10000,
    max_bytes=96 * 1024,
    verify=False,
):
    """One HTTPS request. Returns (status, headers, body_bytes).

    `verify` is False by default, and that is a deliberate, documented
    limitation rather than an oversight. Certificate validation on MicroPython
    means carrying a root bundle and paying for the chain check in RAM, and the
    only thing it would buy here is protection against an attacker already
    sitting on the home WiFi. The shared token would be what leaks. Revisit if
    the Pico ever runs anywhere but this flat - see docs/ETAT.md.
    """
    scheme, host, port, path = _split_url(url)
    timeout_s = timeout_ms / 1000

    addr = socket.getaddrinfo(host, port, 0, socket.SOCK_STREAM)[0][-1]
    sock = socket.socket()
    sock.settimeout(timeout_s)
    try:
        sock.connect(addr)
        if scheme == "https":
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
            context.verify_mode = ssl.CERT_REQUIRED if verify else ssl.CERT_NONE
            sock = context.wrap_socket(sock, server_hostname=host)

        payload = None
        headers = [
            "%s %s HTTP/1.1" % (method, path),
            "Host: %s" % host,
            "Connection: close",
        ]
        if token:
            headers.append("Authorization: Bearer %s" % token)
        if body is not None:
            payload = json.dumps(body).encode()
            headers.append("Content-Type: application/json")
            headers.append("Content-Length: %d" % len(payload))

        sock.write(("\r\n".join(headers) + "\r\n\r\n").encode())
        if payload:
            sock.write(payload)

        status_line = _readline(sock)
        if not status_line:
            raise HttpError("no response")
        parts = status_line.split(b" ", 2)
        if len(parts) < 2:
            raise HttpError("bad status line %r" % status_line)
        status = int(parts[1])

        received = {}
        while True:
            line = _readline(sock)
            if not line:
                break
            colon = line.find(b":")
            if colon == -1:
                continue
            key = line[:colon].decode().strip().lower()
            received[key] = line[colon + 1 :].decode().strip()

        if received.get("transfer-encoding", "").lower() == "chunked":
            content = _read_chunked(sock, max_bytes)
        elif "content-length" in received:
            length = int(received["content-length"])
            content = _read_exactly(sock, length, max_bytes) if length else b""
        elif status == 204:
            content = b""
        else:
            # No length and no chunking: read until the server closes.
            out = bytearray()
            while len(out) < max_bytes:
                chunk = sock.read(1024)
                if not chunk:
                    break
                out += chunk
            content = bytes(out)

        return status, received, content
    finally:
        try:
            sock.close()
        except Exception:
            pass


class Api:
    """The Worker, as seen from the Pico."""

    def __init__(self, base_url, token, device_id, timeout_ms=10000):
        self.base = base_url.rstrip("/")
        self.token = token
        self.device_id = device_id
        self.timeout_ms = timeout_ms

    def _json(self, method, path, body=None):
        status, headers, content = request(
            method, self.base + path, token=self.token, body=body,
            timeout_ms=self.timeout_ms,
        )
        if status == 401:
            raise HttpError("token refused by the Worker", status)
        if status == 204:
            return 204, None, headers
        if not content:
            return status, None, headers
        try:
            return status, json.loads(content), headers
        except Exception:
            raise HttpError("malformed JSON from %s" % path, status)

    def next_job(self, batch=1):
        """Returns (job_or_None, poll_after_seconds).

        The job comes back with its bitmap already decoded into a bytearray:
        constraint 6 forbids streaming a socket into the BLE stack, so the
        whole ticket has to be in RAM before the radio changes hands. A
        200-line ticket is 9.6 KB against 441 KB free.

        With batch > 1 the Worker may answer with several tickets rendered onto
        one strip, and the reply then carries an `ids` list instead of a single
        id. It is one print either way, which is the entire point: the printer
        ejects a few centimetres of paper at the end of every print, so ten
        tickets sent one at a time cost ten of those margins.
        """
        query = "/api/machine/next?device=" + self.device_id
        if batch > 1:
            query += "&batch=%d" % batch
        status, body, headers = self._json("GET", query)
        poll_after = 5
        try:
            poll_after = int(headers.get("x-poll-after", 5))
        except Exception:
            pass
        if status == 204 or body is None:
            return None, poll_after
        if status != 200:
            raise HttpError("unexpected status %d from /next" % status, status)

        data = binascii.a2b_base64(body["data"])
        expected = body["lines"] * body["width_bytes"]
        if len(data) != expected:
            raise HttpError(
                "ticket is %d bytes, announced %d" % (len(data), expected)
            )
        body["bitmap"] = data
        del body["data"]
        return body, poll_after

    def done(self, job_id, ok, crc=None, error=None, ids=None, retry=False,
             sent=None, spans=None, pace=None, stalls=None):
        """Confirms one ticket, or every ticket that shared a strip.

        `ids` wins when both are given: a strip is printed or lost as a whole,
        so reporting only its first ticket would leave the rest claimed until
        their lease expired.
        """
        payload = {
            "device": self.device_id,
            "ok": bool(ok),
            "crc": crc,
            "error": error,
        }
        if ids:
            payload["ids"] = ids
            # Only meaningful for a strip: says nothing was sent, so putting it
            # back in the queue cannot reprint anything.
            payload["retry"] = bool(retry)
            # How far the transfer got, and where each ticket sat on the strip.
            # Together they let the Worker requeue precisely the tickets whose
            # first byte never went out, instead of giving up on all of them
            # because one write stalled.
            if sent is not None:
                payload["sent"] = sent
            if spans:
                payload["spans"] = spans
            # Telemetry, so the strip length can be tuned from measurements
            # rather than from the one afternoon it was first guessed on.
            if pace is not None:
                payload["pace"] = pace
            if stalls is not None:
                payload["stalls"] = stalls
        else:
            payload["id"] = job_id
        status, body, _ = self._json("POST", "/api/machine/done", payload)
        # 409 means the lease had already expired and the Worker gave up on the
        # job. Nothing the Pico can do about it, and not worth a retry storm.
        return status in (200, 409)

    def heartbeat(self, **state):
        state["device"] = self.device_id
        status, body, _ = self._json("POST", "/api/machine/heartbeat", state)
        if status != 200 or not body:
            raise HttpError("heartbeat failed with status %d" % status, status)
        return body
