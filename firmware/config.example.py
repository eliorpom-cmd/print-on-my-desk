# Copy to firmware/config.py and fill in. config.py is gitignored and must
# never be committed: it holds the WiFi password and the Worker token.
#
#   cp firmware/config.example.py firmware/config.py
#   # edit it, then
#   ./firmware/deploy.sh

# --- WiFi -----------------------------------------------------------------
WIFI_SSID = "ton-reseau"
WIFI_PASSWORD = "ton-mot-de-passe"
# Regulatory domain. Affects which channels the CYW43439 will use, and a wrong
# one shows up as an access point the Pico cannot see while your phone can.
WIFI_COUNTRY = "FR"

# --- Worker ---------------------------------------------------------------
API_BASE = "https://YOUR-WORKER.workers.dev"
# Same value as the Worker's PRINTER_TOKEN secret and worker/.dev.vars.
API_TOKEN = "a-remplir"

# Identifies this board in the devices table. Only matters if a second Pico
# ever joins.
DEVICE_ID = "pico-1"

# --- Behaviour ------------------------------------------------------------
# Print intensity. The Worker sends its own value with each job; this is only
# the fallback. Never above 0xC0 (project constraint 8).
DEFAULT_INTENSITY = 0x5D
