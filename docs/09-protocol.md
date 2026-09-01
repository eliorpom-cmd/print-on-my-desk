# The MXW01 protocol, as it actually behaves

The 58 mm Bluetooth thermal printer has no documentation. Everything here was
found by capturing traffic to a real machine and testing what it did.

**Several of these contradict every open implementation of this printer.** Each
one is a measurement, and it says how it was measured. If you are writing your
own driver, this document is the most useful thing in this repository.

The working code is `firmware/ble_printer.py` (MicroPython) and
`web/bridge/printer.js` (Web Bluetooth). They agree, and their comments point
back here.

---

## 1 · It advertises one service and exposes another

The scan response carries `0000af30-…`. The GATT table exposes `0000ae30-…`.

Both are real and they coexist. **A scan filtering on `ae30` finds nothing at
all**, which is the single most common way a project fails to see a printer
sitting on the desk in front of it. Filter on `af30`, or on the name `MXW01`.

One reference implementation assumes this is a macOS quirk. It is not; it
happens on Linux and on a Pico too.

The characteristics used:

| UUID | Use |
| :-- | :-- |
| `ae01` | control, write without response |
| `ae02` | notifications |
| `ae03` | image data, write without response |

There are also `ae04`, `ae05` (indicate), `ae10` and a second service `ae3a`,
unknown to every reference implementation. They stay silent during a print.

## 2 · The completion notification carries a checksum of the image

**The most useful finding here, and three reference implementations describe
the field as "payload unknown".**

The `AA` notification is `00 <crc8(image)> <crc8(image)>` — verified over five
prints from a laptop and twenty from a microcontroller.

Why it matters: image data goes to `ae03` *without response*, so nothing
acknowledges delivery and nothing preserves order. That checksum is the only
way to know a ticket came out intact, and it costs no round trip — compute it
as the bytes go out and compare at the end.

**Never remove that comparison.**

## 3 · Notifications have no trailing byte

The real layout is **6 bytes of header, the payload, and one tail byte of
`0x00`**. Total 7 + n, not the 8 + n that reference implementations expect.

They wait for a byte that does not exist, and log "notification possibly
truncated" on every single reply. Verified over 13 notifications: the tail is
always `0x00`, and it is not a checksum — the `B0` reply has payload `01`,
whose CRC8 is `07`, and a tail of `00`.

Frames going the other way are
`22 21 | cmd | 00 | len_le(2) | payload | crc8(payload) | FF`.

## 4 · The status frame is indexed on the frame, not the payload

Upstream reads `payload[9]` of a 10-byte payload and gives up. Recalibrated
against the frame:

| Frame offset | Meaning |
| :-- | :-- |
| `[6]` | state: 0 idle, 1 printing, 3 ejecting |
| `[9]` | supply level |
| `[10]` | head temperature, °C |
| `[12]` | error flag |
| `[15]` | **paper**: `0x00` loaded, `0x07` empty |

The temperature is real: it rises about 1 °C per 32-line black band and falls
at rest. It is what makes a thermal cut-out possible.

`[9]` reads like a charge level at rest and sags under load — 0x64 down to 0x40
during a full-black block — so treat it as a supply reading, not a battery
percentage.

## 5 · The paper flag is not the error flag, and this one destroys messages

With the roll empty, `[15]` is `0x07` and **the error flag `[12]` stays
`0x00`**. Verified over 34 healthy frames and 5 empty ones.

Why it is the worst failure in the whole protocol: with no paper, the printer
**accepts the entire buffer and returns the correct checksum** — it really did
receive the bytes. So a driver watching only the error flag marks the job
printed, with nothing on the paper and no trace anywhere. Every other failure
mode is loud. That one is silent.

**Check paper before the error flag**, in that order. An empty roll also raises
the error flag on some firmwares, and checking the flag first means the paper
byte is never read — so the caller gets a cryptic error instead of "there is no
paper", and never enters the state that stops it claiming more work.

## 6 · It sleeps after ten minutes, and only its button wakes it

Measured between **9.3 and 10.3 minutes** without a GATT connection. Scanning
does not reset the timer; only a connection does.

Once asleep it stops advertising entirely. It is not off — its light is still
on — but no Bluetooth peer can reach it, including by direct connection to its
address. **Only the button.**

Hence the rule that shapes every driver here:

> The whole cycle must never exceed nine minutes, including every retry and
> backoff.

A keepalive every five minutes holds it open indefinitely, and **costs no
paper**: three connections in ten minutes with no print advanced the roll by
zero. Since Bluetooth does not depend on WiFi, the keepalive survives a network
outage — the printer is awake in the morning and nobody has to touch it.

## 7 · Padding to 90 lines is a superstition

Three reference implementations pad every buffer to 4320 bytes. Tested: the
printer accepts a 32-line print request and returns the matching checksum.

That is 58 lines saved per ticket, about 7 mm of paper.

## 8 · Print mode `0x01` removes the automatic eject

Mode `0x00` ejects about 3 cm after every print. Mode `0x01` prints identically
and ejects almost nothing.

Combined with §7, a short ticket goes from about 4 cm of paper to about 1 cm —
the roll lasts four times longer. The feed needed to clear the tear bar becomes
an explicit `A3` command you control, instead of a fixed cost you do not.

## 9 · The write pacing is the driver's limit, not the printer's

The floor is **4 ms**, and it is imposed by the host's Bluetooth stack: below
it, the write call fails because the previous write is still in flight. The
printer has nothing to do with it.

The failure mode is the good one — an immediate exception, never a silently
corrupted ticket. The checksum never diverged at any pacing.

**But a calibration is only valid for the size it was measured at.** 8 ms was
calibrated on 32-line tickets and held. On 320 lines the stall reappears
sporadically, the transfer dies half way, and the printer prints what it
received: the ticket comes out cut off. That is what long messages looked like
before anybody understood why.

So: retry the stalled line with a growing delay, and **slow the rest of the
transfer down permanently** when it happens. A stall is evidence that the
current pacing is too tight for this transfer's conditions — a warm head, a
busy 2.4 GHz band — and retrying at a cadence already shown not to work is not
a fix. Count the line once, so the checksum stays correct.

There is **no line limit on the printer's side**: 320 lines sent, matching
checksums, everything printed. The truncation was entirely the stall.

## 10 · Paper feed, measured

* **8 dots/mm confirmed.** Assumed for a long time, never measured. An 84-line
  block is 10.5 mm. Every length calculation depends on it.
* **One `A3` unit is about 1.5 mm — twelve lines — not 1/8 mm.** A factor of
  twelve. A `feed_lines` of 80 asks for about twelve centimetres.
* **The commanded feed is reproducible**: three `A3(8)` gave three times 13 mm.
* **There is no automatic feed after printing.** Without an explicit `A3` the
  ticket stays under the head and cannot be torn off, so the feed must never be
  zero.
* **Head to tear bar: about 10 mm**, which is `feed_lines = 7` on this machine.

**You cannot measure anything from a torn edge**, because the tear happens at
the bar rather than at a known point. Two contradictory estimates — "4 cm" and
"10 cm" for the same command — came from exactly that. To measure a distance on
paper: print two marks and measure the white between them.

---

## The sequence, end to end

```
  A2  set intensity            -> wait
  A1  status                   -> check paper, error flag, temperature
  A9  print request            -> the printer accepts (payload[0] == 0x00)
      lines on ae03, one at a time, paced, checksum accumulating
  AD  flush                    -> the printer starts consuming
  AA  completion notification  -> compare its checksum with yours
  A3  feed                     -> so the ticket clears the tear bar
```

## What is still unknown

* What `ae04`, `ae05`, `ae10` and the `ae3a` service are for. They stay silent
  through a print. Worth probing if a reliability problem resists everything
  else.
* Whether the 4 bpp mode (`0x02`) is usable for greyscale. Never tried.
* What error flag values other than `0x01` mean. Only that one has ever been
  seen, which is why the drivers here refuse to print on **any** non-zero
  value: the cost of being wrong is a job that waits, against a message
  destroyed.
