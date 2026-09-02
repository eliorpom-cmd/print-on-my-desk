# The 80 mm receipt printer

The other printer this project drives. Where [09-protocol](09-protocol.md) is a
protocol reverse-engineered from captures, this one is an ordinary ESC/POS
receipt printer doing what it was designed to do — so this page is shorter, and
it is mostly about the four places where "ordinary" is a trap.

Written against an **AURES TRP 100 III** (USB `0525:A700`, "Sewoo POS PRINTER"
underneath, firmware 5.16AR). Most 80 mm receipt printers speak the same
commands. The numbers below are the ones that will differ, and §1 says how to
find yours.

The driver is [`agent/escpos_printer.py`](../agent/escpos_printer.py). It is
reached over USB by the always-on agent, never by the browser bridge — a web
page cannot open a USB printer.

---

## 1 · 512 dots, not 576

Put this first because it is the trap that costs a day.

Almost every 80 mm printer is **576 dots at 203 dpi**. This one is **512 dots
at 180 dpi**. The manual says so (§7-1, "Printing Width Max 72mm (512 dots)"),
and 512 ÷ 7.0866 = 72.2 mm, which agrees.

Nothing fails if you get it wrong. The ticket simply comes out at the wrong
size, or wrapped where you did not ask for a wrap.

**How to find yours without trusting a listing.** Hold the FEED button while
switching the printer on: it prints its own settings and cuts the paper. Look
for a line like `42 Char/Line`. ESC/POS font A is 12 dots wide, so 42 columns
needs 504 dots — which rules out 576, and would have said 48 on a 576-dot
machine. That is a measurement. The number in a shop listing is not.

Everything downstream is in [`worker/src/profiles.js`](../worker/src/profiles.js):

* a line is **64 bytes**, not 72;
* a vertical dot is **1/7.0866 mm**, not 1/8, so anything measured in "lines"
  on a 58 mm printer comes out **13% longer** here;
* the same font atlas draws letters 1.69 mm wide instead of 1.50, which is why
  no atlas is rebuilt when you switch machines.

## 2 · What is sent, and nothing else

Four commands. That is the whole driver.

| Command | Bytes | What it does |
| :-- | :-- | :-- |
| `ESC @` | `1B 40` | initialise, once when the device is opened |
| `GS v 0` | `1D 76 30 m xL xH yL yH …` | the image, as a raster |
| `ESC J n` | `1B 4A n` | feed `n` dots without printing |
| `DLE EOT n` | `10 04 n` | ask for status, in real time |

### 2.1 · The cutter is never sent anything

**This project does not cut tickets.** There is nothing to disable. A receipt
printer cuts because its driver tells it to, and the three commands that tell
it to are `GS V` (`1D 56`), `ESC i` (`1B 69`) and `ESC m` (`1B 6D`). None of
them appears in the driver, and that is the entire mechanism.

It is not left to review. `agent/test_escpos_printer.py` walks every byte a
realistic print produces, and every byte a feed of any size produces, and
refuses all three sequences. A regression here does not give you a crooked
pixel. It gives you a ticket in two pieces.

The printer's own self-test does cut. That is the FEED button, not us.

### 2.2 · `GS v 0` packs its bits the other way round

The one real difficulty, and it is silent.

| | least significant bit | most significant bit |
| :-- | :-- | :-- |
| this project's canvas | the **left** pixel | the right pixel |
| `GS v 0` | the right pixel | the **left** pixel |

The canvas is packed that way because that is what the 58 mm printer's captures
showed ([09-protocol §5.1](09-protocol.md)). It is the pocket printer that is
unusual here, not ESC/POS.

**Getting it wrong does not produce noise.** It produces a ticket where every
group of eight pixels is mirrored in place, which from arm's length looks like
a slightly odd typeface. So it survives a glance and gets paid for in paper.
`REVERSE8` in the driver is the correction, and two tests pin it at both ends
of the byte.

### 2.3 · The image goes out in bands of 128 lines

`GS v 0` will accept 65,535 lines. The printer's buffer will not, and a band
that overruns it is **dropped, not refused**.

The banding earns its place twice over, though. It also yields `sent`: how many
lines actually left before a failure. That is what lets the Worker requeue only
the tickets that never reached the machine, instead of losing the whole band.
At 64 bytes a line, 128 lines is 8 KB.

### 2.4 · `ESC J`, and never `ESC d`

`ESC J n` feeds `n` **vertical motion units** — one dot at 180 dpi, the same
unit the Worker's `feed_lines` counts in, so there is no conversion anywhere.

`ESC d n` feeds `n` **character lines**, each about twenty dots. The two take
one byte, look alike, and sit next to each other in every command table. One
turns a 90-dot feed into 90 dots. The other turns it into 25 cm of paper.

`n` caps at 255, so a longer feed is split across several commands rather than
truncated.

---

## 3 · Status, and how the roll is read

`DLE EOT n` for n = 1..4, answered in real time — the printer replies even
while it is stopped, which is the whole point of asking.

| Physical state | `EOT 1` | `EOT 2` | `EOT 3` | `EOT 4` |
| :-- | :-- | :-- | :-- | :-- |
| roll loaded, lid closed | `0x16` | `0x12` | `0x12` | `0x12` |
| lid open | — | `0x36` | — | `0x7E` |

Four bits are fixed and read `0x12` once masked with `0x93`. What is left:

| Byte | Bits set | Meaning |
| :-- | :-- | :-- |
| `0x16` on `EOT 1` | 2 | cash-drawer pin. Bit 3, "offline", is 0 |
| `0x12` anywhere | none | all well |
| `0x7E` on `EOT 4` | 2, 3, 5, 6 | 2,3 = near end · **5,6 = no roll** |
| `0x36` on `EOT 2` | 2, 5 | 2 = lid open · **5 = stopped, out of paper** |

**Two sources, not one.** `EOT 4` is a sensor reading; `EOT 2` bit 5 is the
printer saying it has stopped because of paper. Either one alone is enough to
refuse to print. A second opinion on the only fault that can lose a message
silently costs nothing.

Opening the lid lifts the roll off the sensor, which is why `EOT 4` reports
"absent" in that state. That is correct, not a bug.

**Changing a roll needs nothing special.** Lid open, the printer still answers
and still says what is wrong. Lid closed, it is usable again in about 0.3 s
with no intervention, and the agent — which checks every 30 seconds — picks up
on its own. This is the opposite of the 58 mm Bluetooth printer, where only the
button wakes it.

**If your printer never answers at all**, it has no bulk IN endpoint and there
is no status, ever. The driver keeps that path: no answer means *unknown*,
never *empty*, and it prints. The obvious implementation — no status, so
refuse — turns a one-way cable into a service that prints nothing while
announcing an empty roll. A test holds this.

### 3.1 · Head to tear bar: measure it, do not inherit it

`feedLines` is how much blank paper is pushed out after a print so the last
line clears the tear bar. It is a property of the machine.

On the TRP 100 III it is **29 mm, which is 206 lines**, measured by printing a
mark with no feed at all — so it stayed exactly under the head — then tearing
normally and measuring to the edge. This is the one place in this project where
measuring from a torn edge is correct, because the torn edge *is* the bar.

The shipped setting is **220**, about 31 mm, so the tear falls roughly 2 mm
past the last line rather than through it. Tearing by hand is not accurate to
the millimetre, and a ticket torn exactly on its last line loses its descenders
with no way to get them back.

It was 90 once, carried over from the 58 mm printer's 10 mm, and wrong by a
factor of two and a half — that printer has no guillotine between its head and
its exit, and this one does, so the paper path is longer. At 90 every ticket
stayed under the head, undetachable, and **nothing in any log said so**. That
is the failure mode of this number when it is short.

Paid once per strip rather than per ticket, since batched tickets go out in one
print. At eight to a strip it is under 4 mm each.

---

## 4 · There is no buzzer

Not "it is off". This printer cannot be made to beep by a command.

Four candidates were tried on the machine and none made a sound: `ESC B n t`
(Sewoo, Citizen), `BEL`, `ESC ( A` (Epson), and `ESC p` (the drawer kick).

That is consistent with the documentation rather than surprising. The manual
lists no buzzer command at all, and Sewoo — whose hardware this is — describes
the buzzer as an accessory: *"a melody box or external buzzer can be connected
to the DK Port"*. There is no internal buzzer. The beep you hear when the lid
opens is an alarm wired to the sensors, which no command can reach.

**So the print head is the buzzer.** A band of solid black is by far the
loudest thing it does — every element on the line fires at once — and a ticket
that carries three of them, separated by silence, makes a rhythm you do not
confuse with a page of text and can hear from the next room. That is what a
beep was for, and it depends on no command.

If you want a real one: a melody box on the cash-drawer port, triggered by
`ESC p`. The code is already there — `BEEP_VARIANT` in `agent/config.py`.

---

## 5 · Checking yours

With the printer plugged in and switched on:

```sh
python3 agent/diagnose.py
```

It finds the printer, asks what it is, reads all four status bytes, and prints
a test ticket. `--paper` and `--gaps` measure what actually came out, which is
the only way to settle a dot pitch or a feed distance. Run it before starting
the service: a service that fails at boot is much harder to read than a script
that fails in front of you.

If you get **"No backend available"**, libusb is missing — the error mentions
neither USB nor libusb. See [02-always-on](02-always-on.md) §3.
