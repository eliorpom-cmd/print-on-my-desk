# The microcontroller version

A Raspberry Pi Pico 2 W, on a shelf, printing to a Bluetooth thermal printer.
No computer, no tab, two watts.

This is the version the project started as, and it is the one with the most
interesting engineering in it. It is also the fiddliest. Do the browser version
first — [01-quick-start](01-quick-start.md) — so that when something here does
not work you already know the Worker end is fine.

**You need:** a Pico 2 W (the W matters, it is the one with WiFi and
Bluetooth), a USB cable, and one of the 58 mm Bluetooth printers from
[04-printers](04-printers.md).

---

## 1 · Flash MicroPython

Download the Pico 2 W build from
[micropython.org/download](https://micropython.org/download/RPI_PICO2_W/).

Hold **BOOTSEL** on the Pico, plug in the USB cable, and let go. A drive
appears. Drag the `.uf2` file onto it. The drive disappears and the Pico
reboots — that is what success looks like.

## 2 · Get a tool for copying files

```sh
pip install mpremote
mpremote connect list        # find your Pico's port
```

## 3 · Configure and copy

```sh
cp firmware/config.example.py firmware/config.py
```

Edit `firmware/config.py`: your WiFi, your Worker's address, your
`PRINTER_TOKEN` — the one in `worker/my-tokens.txt`, if you set the Worker up
with `setup.mjs`. Then:

```sh
mpremote cp firmware/config.py firmware/main.py firmware/net.py \
            firmware/ble_printer.py :
```

## 4 · Watch it start

```sh
mpremote repl
```

Press the reset button, or Ctrl-D. You should see it join the WiFi, find the
printer, and settle into its loop.

---

## The one thing you must know

**The printer falls asleep after about ten minutes without a Bluetooth
connection, and then nothing can wake it but its own button.** Not a scan, not
a direct connect, not power cycling the Pico. Measured between 9.3 and 10.3
minutes.

Everything about the firmware's shape follows from that:

> **The Pico's whole cycle must never exceed nine minutes** — including every
> network retry, every backoff, every wait.

`ble_printer.idle_wait()` implements it: a wait that slips a keepalive in every
five minutes. Do not lengthen a timeout anywhere in `main.py` without checking
this still holds. A Pico that spends eleven minutes retrying a dead WiFi comes
back to a printer that nobody can reach until somebody presses a button, and
there is nothing in any log to say so.

Since Bluetooth does not depend on WiFi, the keepalive works through a network
outage. The printer is awake in the morning and nobody has to touch it.

## The second thing

**Never remove the checksum comparison in `print_lines`.** Image data goes out
without acknowledgement, so nothing guarantees it arrived or arrived in order.
The printer's completion notification carries a CRC of what it actually
received — three other implementations of this protocol call that field
"unknown" — and comparing it is the only proof a ticket came out whole. It
costs nothing.

[09-protocol](09-protocol.md) has the rest, including the four other things
every reference implementation of this printer gets wrong.

## Testing without hardware

```sh
python3 firmware/test_loop.py
python3 firmware/test_ble_printer.py
```

They run on your computer, with a fake clock and a fake printer. The bug they
were written for never showed on the bench: a sleeping printer left the Pico
unable to reach the network, so the system went silent exactly when it needed
to raise the alarm.
