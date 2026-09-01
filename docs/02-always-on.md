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

Two paths from here, and they use different code in this repository:

| Your printer | Connected by | Use |
| :-- | :-- | :-- |
| A proper receipt printer (ESC/POS, 80 mm) | USB | `agent/` — this page |
| A cheap 58 mm Bluetooth one | Bluetooth | `agent/` won't do it; see below |

`agent/` speaks **ESC/POS over USB**. That covers essentially every till
printer ever made and most of the 80 mm ones sold for point-of-sale.

If yours is the little Bluetooth kind, the Pi can still drive it, but through
the Bluetooth protocol rather than USB — the code for that is `firmware/`,
written for a microcontroller. Running it on a Pi means porting it to `bleak`,
which is a genuine afternoon of work and not documented here. **If you have the
Bluetooth printer, the browser bridge is the supported answer.**

## 2 · Set up the machine

On a fresh Raspberry Pi: install Raspberry Pi OS Lite (64-bit) with the
Raspberry Pi Imager, and in the Imager's settings screen turn on SSH and fill
in your WiFi. That saves you a screen and a keyboard.

Then, from your own computer:

```sh
ssh pi@raspberrypi.local
```

## 3 · Install

```sh
git clone https://github.com/YOUR-ACCOUNT/print-on-my-desk.git
cd print-on-my-desk
bash agent/install.sh
```

It asks three things — your Worker's address, your `PRINTER_TOKEN`, and a name
for this machine — and does everything else. It is safe to run again if a step
fails.

The one part it cannot do for you is the USB permission rule, because it needs
your printer's ids. It prints `lsusb` output and tells you exactly what to
edit.

> **"No backend available"** is the error you get when `libusb` is missing. It
> mentions neither USB nor libusb. `install.sh` installs it; if you are doing
> this by hand, do not skip it.

## 4 · Check the printer before starting anything

```sh
python3 agent/diagnose.py
```

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
