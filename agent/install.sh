#!/usr/bin/env bash
#
# Sets up the always-on agent on a Raspberry Pi, or any Debian-ish Linux.
#
#   bash agent/install.sh
#
# Safe to run again. Every step checks before it acts, so re-running after a
# failure picks up where it stopped rather than starting over.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
USER_NAME="$(id -un)"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ask() { local prompt="$1" var="$2" current="${3:-}"; local answer
        read -r -p "$prompt${current:+ [$current]}: " answer
        printf -v "$var" '%s' "${answer:-$current}"; }

say "0/5  Which printer"
echo "  1) An 80 mm receipt printer, over USB   (ESC/POS)"
echo "  2) The 58 mm Bluetooth one             (MXW01 and its many names)"
# Anything that is not recognised is asked again rather than assumed. It used
# to be `if answer = 2 then ble else escpos`, so somebody who typed "ble" -
# which is the word this script and the documentation both use for it - got the
# USB driver, silently, and found out when the service could not find a printer
# that was sitting there connected over Bluetooth.
DRIVER=""
while [ -z "$DRIVER" ]; do
  ask "Which one" PRINTER_CHOICE "1"
  case "$(printf '%s' "$PRINTER_CHOICE" | tr '[:upper:]' '[:lower:]')" in
    1|usb|escpos|esc/pos) DRIVER=escpos ;;
    2|ble|bt|bluetooth|mxw01) DRIVER=ble ;;
    *) echo "  Please answer 1 or 2." ;;
  esac
done
echo "  -> $DRIVER"

say "1/5  System packages"
# libusb is NOT pulled in by pip. pyusb is only the bindings; libusb is what
# talks to the bus. Without it the single error you get is "No backend
# available", which says nothing about libusb at all.
sudo apt-get update -qq
sudo apt-get install -y python3-pip git libusb-1.0-0

say "2/5  Python dependencies"
pip3 install --break-system-packages -r "$HERE/requirements.txt"
if [ "$DRIVER" = "ble" ]; then
  # Not in requirements.txt on purpose: a USB printer has no business pulling
  # in a Bluetooth stack, and ble_printer.py imports it inside a try/except so
  # that the tests run on a machine that has never had a radio.
  pip3 install --break-system-packages bleak
fi

say "3/5  Configuration"
if [ -f "$HERE/config.py" ]; then
  echo "config.py already exists; leaving it alone."
else
  ask "Your Worker's address, like https://YOUR-WORKER.workers.dev" WORKER_URL
  ask "PRINTER_TOKEN" PRINTER_TOKEN
  ask "A name for this machine" DEVICE_ID "$(hostname)"
  cat > "$HERE/config.py" <<PY
# Written by install.sh. This file is gitignored: it holds a secret.
PRINTER = "$DRIVER"
WORKER_URL = "${WORKER_URL%/}"
PRINTER_TOKEN = "$PRINTER_TOKEN"
DEVICE_ID = "$DEVICE_ID"
PY
  chmod 600 "$HERE/config.py"
  echo "wrote agent/config.py"
fi

say "4/5  USB permissions"
if [ "$DRIVER" = "ble" ]; then
  echo "Bluetooth: nothing to install here."
  echo "If a scan finds nothing, check the printer is ON - it sleeps after ten"
  echo "minutes and only its own button wakes it."
elif [ -f /etc/udev/rules.d/99-thermal-printer.rules ]; then
  echo "udev rule already installed."
else
  echo "Your printer's USB ids, from lsusb:"
  lsusb || true
  echo
  echo "Edit agent/99-thermal-printer.rules with your vendor and product ids,"
  echo "then run:"
  echo "  sudo cp agent/99-thermal-printer.rules /etc/udev/rules.d/"
  echo "  sudo udevadm control --reload && sudo udevadm trigger"
  echo "  # then unplug the printer and plug it back in"
fi
sudo usermod -aG plugdev "$USER_NAME" || true

say "5/5  The service"
UNIT=/etc/systemd/system/printer-agent.service
sed -e "s|^User=.*|User=$USER_NAME|" \
    -e "s|^WorkingDirectory=.*|WorkingDirectory=$ROOT|" \
    -e "s|^ExecStart=.*|ExecStart=$(command -v python3) $ROOT/agent/main.py|" \
    -e "s|^ReadWritePaths=.*|ReadWritePaths=$ROOT|" \
    "$HERE/printer-agent.service" | sudo tee "$UNIT" > /dev/null
sudo systemctl daemon-reload
echo "installed $UNIT"

say "Done. Start it with:"
echo "  sudo systemctl enable --now printer-agent"
echo "  journalctl -u printer-agent -f"
echo
echo "Or check the printer first, without starting anything:"
if [ "$DRIVER" = "ble" ]; then
  echo "  python3 -c \"import sys; sys.path.insert(0,'agent'); import ble_printer as b; p=b.MXW01(); p.open(); print(p.status())\""
else
  echo "  python3 agent/diagnose.py"
fi
