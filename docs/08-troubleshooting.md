# When it does not work

Arranged by **what you see**, not by cause. You do not know the cause yet;
that is why you are here.

---

## Nothing comes out

**Look at `/admin` first.** Nine times in ten the message is sitting in
"waiting", because nothing prints until you approve it. That is the system
working.

Then, in order:

| Check | How | If not |
| :-- | :-- | :-- |
| Is the bridge running? | the tab, or `systemctl status printer-agent` | start it |
| Is the printer awake? | its light | press its button |
| Is there paper? | look | and check which way round the roll is |
| Is the message approved? | `/admin` | approve it |
| Is the queue moving? | `/admin` → recent | see below |

## The message says `failed`

Open `/admin` and read the error on the ticket.

| Error | Cause | Fix |
| :-- | :-- | :-- |
| `lease expired` | the bridge died mid-print | restart it, then requeue |
| `no paper` | the roll ran out | change it, then requeue |
| `printer too hot` | the head hit its ceiling | it retries itself; wait |
| `checksum ...` | the transfer was corrupted | usually a weak radio link |
| `render failed` | the message cannot be drawn | look at the text; report it |

**Requeue everything that failed** is one button on `/admin`.

`printer too hot` is not really a failure: nothing was sent and the message
goes back with its attempt refunded. If you see it constantly, raise
`head_max_c` **and** `cool_to_c` together — see
[07-operating §3](07-operating.md).

---

## The browser bridge

**No devices in the Bluetooth chooser.**

1. Is the printer awake? It sleeps after ~10 minutes and only its button wakes
   it. Not a scan. Not a reboot. The button.
2. Are you in Chrome, Edge or Opera on a desktop, or Chrome on Android? Safari
   and every browser on iOS have no Web Bluetooth. There is no flag for this.
3. Is the page on `https://` or `localhost`? Web Bluetooth refuses plain HTTP.
4. On Linux, is your user in the `bluetooth` group?

**It connects and then drops.** Almost always distance or a busy 2.4 GHz band.
Move it closer to the computer, off the WiFi router. The bridge reconnects on
its own; a drop mid-ticket loses that ticket, not the queue.

**"The token was refused".** The `PRINTER_TOKEN` in the bridge is not the one
the Worker has. Set it again:
`npx wrangler secret put PRINTER_TOKEN`, then re-paste.

**It prints, but the paper is blank.** The roll is in upside down. Thermal
paper only prints on one face.

**It prints diagonal noise.** The bitmap was rendered for a different width.
The bridge is supposed to refuse this — check `PROFILE` in
`web/bridge/bridge.js` matches your printer.

---

## The always-on agent

**`No backend available`.** `libusb` is not installed. The error mentions
neither.
```sh
sudo apt install libusb-1.0-0
```

**`Access denied` / `Operation not permitted`.** The udev rule. Copy it, reload
udev, then **unplug the printer and plug it back in** — the last part is the
one everybody skips.

**`no printer found`.** `lsusb` to see whether the machine sees it at all. If
it does not, it is the cable or the power. If it does, the ids in the udev rule
do not match.

**It worked and now it does not, after a reboot.** `journalctl -u
printer-agent -n 50`. Usually the network came up after the service did; the
unit waits for `network-online.target`, but some setups report that
optimistically.

---

## The Worker

**The page loads but the status dot never turns green.** The dot reflects your
printer, not the site. No bridge connected means no green, which is correct.

**`/admin` will not let me in.** Check the token. If you have lost it, set a
new one: `npx wrangler secret put ADMIN_TOKEN`.

**"D1 daily limit exceeded".** You read five million database rows in a day.
Either you are extremely popular, or something is reading the queue on a hot
path. Read [07-operating §4](07-operating.md) and run
`cd worker && node --test test/d1-cost.test.mjs`.

**Deploy fails with "More than one account".** Uncomment `account_id` in
`wrangler.jsonc` and paste in the one you want; wrangler prints the list.

**`npm run dev` prints the same thing and then no server starts.** Same cause,
same cure, and worth stating separately because the failure looks different: it
scrolls past in the middle of the start-up output and the port never opens. The
AI binding has no local implementation, so the dev server connects to your
account before it serves anything. Uncomment `account_id`, or set
`CLOUDFLARE_ACCOUNT_ID` in your shell for one session.

**`npm run dev` will not start with no internet, or before `wrangler login`.**
Same reason. If you want a dev server on a train, delete the `ai` line from
`wrangler.jsonc` for the session: messages are then held for you rather than
classified, which is what happens when the model is unavailable anyway.

**Messages arrive but the AI moderation never runs.** Check the `ai` binding is
still in `wrangler.jsonc`. When the model is unavailable, messages are held for
you rather than approved — which looks like "everything is pending", and is the
safe direction.

---

## Getting more detail

```sh
cd worker && npx wrangler tail        # live logs from the deployed Worker
npm test                              # the whole suite
python3 agent/diagnose.py             # ask the printer what it thinks
```

`/admin` also shows an event log: state changes and failures, not every poll.
It is deliberately not a log of everything — a row per keepalive would be tens
of thousands a day and would bury the six lines that matter.
