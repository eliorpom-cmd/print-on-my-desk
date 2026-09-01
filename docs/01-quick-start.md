# Quick start: the browser version

From nothing to a message on paper. About thirty minutes, most of it waiting
for downloads.

**When it is finished:** a link you can send people. While a tab is open on
your computer, messages print. When you close it, they queue up and wait.

**What you need:**

* A Bluetooth thermal printer — see [04-printers](04-printers.md). This guide
  assumes the common 58 mm one sold as "MXW01", "M02", or under a dozen other
  names.
* Chrome, Edge or Opera on a computer, or Chrome on Android. **Not Safari, and
  nothing on an iPhone or iPad** — Apple has not implemented the Bluetooth API
  browsers need and has said it will not.
* A Cloudflare account. Free, no card.
* A terminal. You will paste about ten commands into it.

---

## 1 · Get the code

Use the green **Code** button at the top of this repository, or the terminal —
replacing `YOUR-ACCOUNT` with whoever you are looking at this on:

```sh
git clone https://github.com/YOUR-ACCOUNT/print-on-my-desk.git
cd print-on-my-desk/worker
npm install
```

If `npm` is not a command your computer knows, install Node.js from
[nodejs.org](https://nodejs.org) — the version it offers by default is fine.

## 2 · Connect Cloudflare

```sh
npx wrangler login
```

A browser opens. Log in, click **Allow**. Come back to the terminal.

```sh
npx wrangler d1 create printer
```

This makes your database and prints something like:

```
[[d1_databases]]
binding = "DB"
database_name = "printer"
database_id = "8f3c1a44-...-9b2e"
```

Open `worker/wrangler.jsonc`, find `PASTE_YOUR_DATABASE_ID_HERE`, and put that
id there instead.

> **"More than one account available"** — if wrangler says this, it also prints
> your account ids. Uncomment the `account_id` line in `wrangler.jsonc` and
> paste in the one you want.

## 3 · Set three secrets

These are passwords, and they should look like passwords. Generate each one:

```sh
openssl rand -base64 32
```

Then, one at a time — each command asks you to paste a value:

```sh
npx wrangler secret put PRINTER_TOKEN
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put IP_SALT
```

* `PRINTER_TOKEN` — what your printer end uses to fetch messages. **Keep this
  one somewhere you can copy it from**; you need it again in step 6.
* `ADMIN_TOKEN` — how you get into your own admin page.
* `IP_SALT` — scrambles addresses for the rate limiter, so the database never
  holds anybody's actual IP.

## 4 · Create the tables and put it online

```sh
npm run db:remote
npm run deploy
```

The last command prints your address. It looks like
`https://print-on-my-desk.YOUR-WORKER.workers.dev`. **That is your link.** Open
it — you should see the page, with a small grey dot that says *prints later*
(there is no printer connected yet, which is correct).

## 5 · Check the admin page

Go to `your-address/admin`. Paste your `ADMIN_TOKEN`.

Now go back to the main page and send yourself a message. Return to `/admin`:
it should be sitting there, waiting for you. Tap **approve**.

Nothing prints yet. That is right — there is nothing at the other end.

> **Nothing is printed until you approve it.** That is the default and you
> should keep it. It is the difference between a printer in your room and a
> printer anybody on the internet can put anything into.

## 6 · Connect the printer

Turn the printer on. Then go to `your-address/bridge` in Chrome or Edge.

1. **Connect over Bluetooth.** The browser asks which device; pick the one
   named MXW01. If nothing appears, see
   [08-troubleshooting](08-troubleshooting.md).
2. **Paste your `PRINTER_TOKEN`** into the box.
3. **Start printing.**

The message you approved in step 5 comes out within a couple of seconds.

Leave that tab open. That is the whole trick: the tab is the printer's
connection to the internet.

---

## What now

**Send the link to some friends.** Then keep `/admin` open on your phone —
messages arrive there and print when you tap approve.

Three things worth doing next, roughly in order of how much you will miss them:

* **Turn on notifications** so you know a message is waiting without checking.
  Discord or ntfy, five minutes, [07-operating §5](07-operating.md).
* **Write your own word list.** The one that ships is a dozen entries and a
  demonstration. [06-moderation](06-moderation.md).
* **Make the page yours** — the name, the wording, the font on the ticket.
  [05-customising](05-customising.md).

And when you want it printing while you are out, without a tab open:
[02-always-on](02-always-on.md). Same Worker, same queue, same link — you only
change what is at the far end.

---

## Things that go wrong at this stage

**The browser will not show any Bluetooth device.** The printer sleeps after
about ten minutes and then only its own button wakes it — not a scan, not
software. Press its button and look again. If it is genuinely awake and still
invisible, you are probably in Safari; check [08](08-troubleshooting.md).

**"The token was refused".** The bridge is using a different `PRINTER_TOKEN`
from the one you set. Set it again with `wrangler secret put` and re-paste.

**The message printed as diagonal noise.** The bitmap was rendered for a
different paper width. The bridge refuses this rather than printing it, so if
you are seeing it, something has been edited — check `PROFILE` in
`web/bridge/bridge.js`.

**Nothing prints and the log says nothing.** Look at `/admin`: the message is
probably still `pending`, waiting for you to approve it. That is the system
working.
