# Printers

## The short answer

**Buy the 58 mm Bluetooth one.** It is about €25, it works with the browser
version, and you can have it printing within the hour. Everything else in this
document is for when you want more.

---

## The three kinds

### 1 · 58 mm Bluetooth, battery, pocket-sized

Sold as **MXW01**, **M02**, **Phomemo M02**, **Cat printer**, and a dozen other
names. Often shaped like a small animal. €20–30.

* **Works with:** the browser bridge, and the Pico firmware.
* **Paper:** 57 mm rolls, sold everywhere, a few euros for several.
* **Width:** 384 dots, about 32 characters per line.

**Check before you buy** that the listing says the model name, or shows the
device appearing as `MXW01` in a phone app. The shells are identical across
several different boards, and the other boards speak a different protocol that
this code does not.

**Its quirks, which are the reason this project has a protocol document:**

* It sleeps after roughly ten minutes with nothing connected, and then only its
  own button wakes it. This is not a bug you can code around.
* It advertises one service id and exposes a different one. A scan filtering on
  the wrong one finds nothing at all.
* It reports its own head temperature, which is genuinely useful and which
  almost nothing else does.
* It runs on a battery. It will be flat one morning, and nothing will tell you
  in advance.

### 2 · 80 mm receipt printer, USB, mains powered

A real till printer. Epson TM-T20 and its clones, Aures, Bixolon, Star, and the
generic ones on auction sites for €40 second hand. Look for **ESC/POS** in the
description.

* **Works with:** the always-on agent (`agent/`), over USB.
* **Paper:** 80 mm rolls, cheap, and they last: an 80 mm roll holds several
  times what the small ones do.
* **Width:** typically 512 or 576 dots, 42 to 48 characters a line.
* **Speed:** absurd compared to the small ones. Thousands of tickets an hour.

**Why it is better if you can:** mains power rather than a battery, an
automatic cutter, paper that costs almost nothing, and no sleep behaviour to
work around. **Why it is worse:** it needs a machine plugged into it, it is the
size of a toaster, and second-hand ones sometimes arrive with a memory switch
set to something surprising.

Second hand is fine and is how most people should buy one. Print its self test
before anything else — hold FEED while switching it on — and it will tell you
its emulation, its character width, and its interface.

### 3 · Something else entirely

If it speaks ESC/POS over USB, `agent/escpos_printer.py` will probably drive
it, possibly after changing the width in `worker/src/profiles.js`.
[10-escpos](10-escpos.md) says how to find that width by measurement rather
than by trusting a listing — most 80 mm printers are 576 dots and some are
512, and the wrong one costs you an afternoon.

If it speaks something else, you are writing a driver. The interface it has to
meet is small — connect, status, print a bitmap, feed — and `agent/fakes.py`
lets you develop it without hardware.

---

## Paper

**Thermal paper only.** There is no ink; the paper darkens where it is heated,
which is why a receipt fades in a wallet and why you must not put a thermal
roll in a normal printer.

* Check the **width** (57 mm or 80 mm) and the **diameter**, which is what
  decides whether it fits.
* Thermal paper is coated. BPA-free rolls exist and cost slightly more; if
  tickets are going to be handled a lot, buy those.
* **Which side.** Thermal paper only prints on one face. If a ticket comes out
  blank, the roll is in upside down — this is the single most common "the
  printer is broken" that is not.

---

## What will not work

* **Anything with ink or toner.** This project sends bitmaps to a thermal head.
* **A label printer with proprietary drivers** (Brother QL, Dymo). They do not
  speak ESC/POS and their protocols are not compatible.
* **A printer over WiFi with only an AirPrint/IPP interface.** Possible in
  principle, not supported here.
* **Anything at all, from an iPhone or iPad.** That is about the browser rather
  than the printer: Safari and every browser on iOS lack Web Bluetooth. Use the
  always-on version instead, then your phone only needs `/admin`.
