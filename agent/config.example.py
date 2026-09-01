# Copy to agent/config.py and fill in. config.py is gitignored, this file is not.
#
# The same split as firmware/config.example.py, and for the same reason: the
# token belongs to the machine, not to the repository.

# The deployed Worker. No trailing slash.
WORKER_URL = "https://YOUR-WORKER.workers.dev"

# PRINTER_TOKEN, the Worker secret for the machine endpoints. A different
# secret from ADMIN_TOKEN on purpose: this one sits in plain text on a box on a
# shelf, and it should not also be the key to approving what gets printed.
PRINTER_TOKEN = "..."

# What this machine calls itself in the heartbeat and on the desk. Worth
# changing from the Pico's "pico-1": the two are different devices with
# different states, and sharing a name would have each overwrite the other's
# row in `devices` - which is exactly how a printer that is unplugged goes on
# reporting itself awake.
DEVICE_ID = "pi-1"

# How many tickets to ask for on one strip.
#
# The MXW01 needed this badly: it ejected ~3 cm of its own accord after every
# print, so sixteen tickets sent one at a time cost sixteen of those margins.
# The TRP 100 III does not, and what batching saves here is smaller and duller:
# one feed to the tear bar instead of eight, and one USB transfer instead of
# eight round trips. 8 rather than 16 because a strip is torn off as one piece,
# and a strip nobody wants to hold is too long.
BATCH_SIZE = 8

# Pin the USB device, when there is more than one printer on the bus.
#
# Normally leave both None: the driver finds the printer by its USB class (7),
# which is in the descriptor of every USB printer ever made. Vendor and product
# ids differ between production runs of the same model, so hard-coding a pair
# found in a forum post is how a driver stops working after a revision nobody
# announced. `lsusb` gives them when you do need them.
USB_VENDOR_ID = None
USB_PRODUCT_ID = None

# Which buzzer command to try on a priority ticket. 0=ESC B, 1=BEL, 2=ESC ( A,
# 3=ESC p (cash-drawer kick).
#
# NONE of them makes this printer beep - tried on the machine, 31 August. It
# has no internal buzzer: Sewoo put it on the cash-drawer port as an external
# melody box, and the AURES manual documents no buzzer command at all. The beep
# you hear on an open lid is an alarm wired to the sensors.
#
# The thank-you ticket makes its noise with the print head instead: three bands
# of solid black, which is the loudest thing the head does. See docs/ESCPOS.md.
#
# 3 rather than 0, so that plugging a melody box into the drawer port would
# just work, with nothing else to change.
BEEP_VARIANT = 3
