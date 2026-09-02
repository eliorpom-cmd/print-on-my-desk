# Always on: a computer that stays running

The browser version stops when you close the tab. This one does not stop at
all.

**What changes:** nothing on the web side. Same Worker, same queue, same link,
same admin page. You are only replacing what is at the far end.

**What you need:** a computer that stays on — a Raspberry Pi is the obvious
one, but an old laptop with the lid open works fine — and a printer it can
reach, over USB or Bluetooth.

Budget an hour, most of it waiting.

---

## 1 · Which printer, which cable

Both kinds work, and they are one line of config apart:

| Your printer | Connected by | `PRINTER =` |
| :-- | :-- | :-- |
| A receipt printer (ESC/POS, 80 mm) | USB | `"escpos"` |
| The cheap 58 mm Bluetooth one | Bluetooth | `"ble"` |

The agent is the same above that line: the same queue, the same long poll, the
same heartbeat, the same refusal to claim work it cannot print. Only the driver
underneath changes.

**For Bluetooth you also need a radio and one package:**

```sh
pip3 install --break-system-packages bleak
```

A Raspberry Pi Zero 2 W, a 3, 4 or 5 all have Bluetooth built in. An old
desktop probably does not; a €10 USB dongle fixes that.

**And one thing that is not software.** The 58 mm printer stops advertising
after about ten minutes with no Bluetooth connection, and then nothing wakes it
but its own button. The agent holds a connection open for exactly that reason,
which means it must keep running — if you stop it overnight, somebody has to
press the button in the morning. The USB printer has no such behaviour.

## 2 · Set up the machine

On a fresh Raspberry Pi: install Raspberry Pi OS Lite (64-bit) with the
Raspberry Pi Imager. In the Imager's settings screen, set a **hostname**, set a
**username and password**, turn on **SSH**, and fill in your WiFi. That saves
you a screen and a keyboard.

Write the username and hostname down. There is no default `pi` user any more —
Raspberry Pi OS stopped shipping one in 2022 — so the address to connect to is
the two things you just chose:

```sh
ssh YOUR-USERNAME@YOUR-HOSTNAME.local
```

If the name does not resolve, give it another two minutes: the first boot
resizes the disk and joins the WiFi before it answers to anything. After that,
look in your router for the address it took and use that instead.

> **A Pi 3 Model B has no 5 GHz radio.** If your router broadcasts both bands
> under different names, give the Imager the 2.4 GHz one. With the other, every
> single thing looks right — the card is written, the Pi boots, the lights
> blink — and it searches for a network it cannot hear, forever, saying nothing.

## 3 · Install

```sh
git clone https://github.com/eliorpom-cmd/print-on-my-desk.git
cd print-on-my-desk
bash agent/install.sh
```

It asks four things — **which printer you have** (USB or Bluetooth), your
Worker's address, your `PRINTER_TOKEN`, and a name for this machine — and does
everything else. It is safe to run again if a step fails.

The name matters if you ever run two of these: the Worker keeps one row per
device, so two machines sharing a name overwrite each other's status and
neither is wrong enough to notice.

The one part it cannot do for you is the USB permission rule, because it needs
your printer's ids. It prints `lsusb` output and tells you exactly what to
edit. On Bluetooth there is no rule to install — skip that step entirely.

> **"No backend available"** is the error you get when `libusb` is missing. It
> mentions neither USB nor libusb. `install.sh` installs it; if you are doing
> this by hand, do not skip it.

## 4 · Check the printer before starting anything

```sh
python3 agent/diagnose.py          # USB
```

On Bluetooth, ask the printer what it thinks — with it switched **on**:

```sh
python3 -c "
import sys; sys.path.insert(0, 'agent')
import ble_printer as bp
p = bp.MXW01(); p.open(); print(p.status()); p.close()"
```

You should get a dictionary with `paper`, a temperature and a supply reading.
`no MXW01 on the air` means it is off or asleep: press its button.

This finds the printer, asks it what it is, and prints a test ticket. Do this
before starting the service: a service that fails at boot is much harder to
read than a script that fails in front of you.

## 5 · Start it

```sh
sudo systemctl enable --now printer-agent
journalctl -u printer-agent -f
```

The log is one JSON object per line. Leave it running and approve a message
from `/admin` on your phone: within a second or two you should see the claim,
the print, and the report.

---

## What it does while you are not looking

* **Long-polls** for work: it holds a connection open for 25 seconds rather
  than asking every few seconds, so a message you approve prints in about a
  second and the database is barely touched.
* **Heartbeats** once a minute, so `/admin` can tell an idle printer from an
  absent one.
* **Refuses to claim work it cannot print.** Out of paper, or the head too hot,
  and it stops asking rather than taking messages and failing them. A message
  must never be burned by a condition its author had nothing to do with.
* **Keeps a failed report** and replays it. If the network drops after a ticket
  is printed but before the Worker is told, the report is held and sent on the
  next cycle — otherwise the queue would think the ticket never came out and
  print it again.
* **Backs off** when the network is down: 5 seconds, then 10, then 20, up to a
  minute.

## When it stops working

```sh
systemctl status printer-agent
journalctl -u printer-agent -n 50
```

| The log says | What it is |
| :-- | :-- |
| `No backend available` | libusb is not installed |
| `Access denied` / `Operation not permitted` | the udev rule, step 3 |
| `the token was refused` | `PRINTER_TOKEN` differs from the Worker's |
| `no printer found` | check the cable, then `lsusb` |
| `poll_failed` repeatedly | the Worker's address is wrong, or DNS is |

More in [08-troubleshooting](08-troubleshooting.md).

## Two printers, or none

The queue does not care how many bridges connect to it. Two machines polling at
once cannot be handed the same message — the claim is a single atomic
statement, and that is tested. Give each one a different `DEVICE_ID` so the
admin page can tell them apart.

Zero is equally fine: messages queue up, and print when something comes back.
