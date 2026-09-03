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
* A Cloudflare account. Free, no card — step 2 makes one if you have none.
* A terminal. Every command here is a single line: copy one, run it, read what
  it says, then come back for the next. Nothing below needs you to run a block
  of them at once.

Each step ends with something you can look at. If yours does not look like the
description, stop there — the next step will not fix it, and it will fail
somewhere that does not name the real cause.

---

## Before you start, if you are on Windows

**One command, once, and then the rest of this guide is the same for
everybody.**

Windows refuses to run any script by default, and two of the tools you are
about to install are scripts. Without this, the very first command in step 1
fails with a message about `npm.ps1` that says nothing about this project. Open
PowerShell and run:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

It asks you to confirm; type `Y` and press Enter. `CurrentUser` means your
account only and needs no administrator rights, and `RemoteSigned` means
scripts already on your machine may run while anything downloaded from the
internet still has to be signed. To put it back afterwards:
`Set-ExecutionPolicy -Scope CurrentUser Restricted`.

If you would rather not change it at all, use **Command Prompt** (`cmd`) rather
than PowerShell for every command in this guide. It is not affected.

---

## 1 · Get the code

```sh
git clone https://github.com/eliorpom-cmd/print-on-my-desk.git
```

```sh
cd print-on-my-desk/worker
```

```sh
npm install
```

Everything from here happens in that `worker` directory. Stay in it.

> **`git` is not a command my computer knows.** Then take the code as a file
> instead: the green **Code** button at the top of this repository, **Download
> ZIP**, unzip it, and `cd` into the `worker` folder inside. Nothing else
> changes.
>
> **`npm` is not a command my computer knows.** Install Node.js from
> [nodejs.org](https://nodejs.org) — the version it offers by default is fine —
> then **close the terminal and open a new one**. A terminal that was already
> open cannot see a program installed after it started.

## 2 · Make a Cloudflare account, and log in

No account yet? [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up).
Free, no card, an email address and a password. Confirm the email, then come
back here.

```sh
npx wrangler login
```

A browser opens. Log in, click **Allow**, come back to the terminal. It should
say it is logged in and give your account name.

## 3 · Create the database

```sh
npx wrangler d1 create printer
```

It says `Successfully created DB 'printer'`, prints a block of configuration,
and then asks up to three questions. **The second one has a wrong answer that
looks right:**

| It asks | Answer | Why |
| :-- | :-- | :-- |
| Would you like Wrangler to add it on your behalf? | **yes** | it writes the id into `wrangler.jsonc` so you do not have to copy it |
| What binding name would you like to use? | type **`DB`** | it offers `printer`. Do not take it. |
| For local dev, connect to the remote resource? | **no** | local runs should stay local |

**Why `DB`.** The code asks Cloudflare for a database binding by that exact
name, and `wrangler.jsonc` already has an entry called `DB` waiting for an id.
Accept `printer` instead and wrangler adds a *second* entry beside it, leaving
the first one still holding the placeholder — and the failure surfaces two
steps later as an error about an invalid uuid, naming neither the file nor the
line. It is the most common way to get stuck in this guide.

If you answered something else, or your wrangler is older and asked nothing at
all, do not go back: step 4 checks this and fills the id in itself.

> **"More than one account available"** — if wrangler says this, it also prints
> your account ids. Open `wrangler.jsonc`, uncomment the `account_id` line, and
> paste in the one you want.

## 4 · Three secrets, and your Worker

```sh
node setup.mjs
```

One command, and it is the one that used to be five. It:

* checks that `wrangler.jsonc` has your database id, and fetches it from your
  account if it does not;
* invents three secrets, 256 bits each, from your machine's random generator;
* uploads them to Cloudflare, so there is nothing to paste;
* writes the two you will need again into **`my-tokens.txt`**, and opens it.

**Your Worker is created at this moment**, because that is what setting a
secret on a Worker that does not exist does. It has no code on it until step 5
— an empty Worker that answers nothing is harmless, but do not be surprised to
see the name appear in your dashboard now.

**Keep the file it opens.** Cloudflare stores your secrets but will never show
them to you again, and nothing else has a copy. Do not close it thinking it
will still be in the terminal: it will not.

| | What it is for | When you need it again |
| :-- | :-- | :-- |
| `ADMIN_TOKEN` | getting into your own admin page | step 6, and every time after |
| `PRINTER_TOKEN` | what your printer end uses to take messages out of the queue | step 7 |
| `IP_SALT` | scrambles addresses for the rate limiter, so the database never holds anybody's actual IP | never — it is not in the file for that reason |

The file is ignored by git. Do not commit it and do not paste it into an issue.

Losing them is annoying and not fatal: nobody can recover a secret, but you can
replace one in a minute, either with `npx wrangler secret put ADMIN_TOKEN` or
in the dashboard under **Workers & Pages → your Worker → Settings → Variables
and Secrets**. A replaced `PRINTER_TOKEN` has to be pasted into your printer end
again.

> **Doing it by hand instead.** Three times: generate a value, then set it.
> ```sh
> node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
> ```
> ```sh
> npx wrangler secret put PRINTER_TOKEN
> ```
> and the same for `ADMIN_TOKEN` and `IP_SALT`, pasting a fresh value into each.
> Write the first two down somewhere before you close the terminal.

## 5 · Create the tables, and put it online

```sh
npm run db:remote
```

It prints the statements it ran and how many rows it touched. Nothing to keep.

```sh
npm run deploy
```

**The first deploy on a new account asks you to register a workers.dev
subdomain.** That is a name for your whole account, not for this project — pick
anything, it is free, and you do it once. Your address is then your Worker's
name in front of it:
`https://print-on-my-desk.YOUR-WORKER.workers.dev`.

**That is your link.** Open it — you should see the page, with a small grey dot
that says *prints later* (there is no printer connected yet, which is correct).

> **`Invalid property: databaseId => Invalid uuid`**, or an address with
> `PASTE_YOUR_DATABASE_ID_HERE` in it. Your `wrangler.jsonc` never got the real
> database id — see step 3. Open it and look at `d1_databases`: there should be
> **one** entry, its `binding` should be `DB`, and its `database_id` should be a
> long string of hex with dashes in it. If a second entry appeared, delete it,
> and move its id into the first one.

## 6 · Check the admin page

Go to `your-address/admin`. Paste your `ADMIN_TOKEN` — from `my-tokens.txt`.

Now go back to the main page and send yourself a message. Return to `/admin`:
it should be sitting there, waiting for you. Tap **approve**.

Nothing prints yet. That is right — there is nothing at the other end.

> **Nothing is printed until you approve it.** That is the default and you
> should keep it. It is the difference between a printer in your room and a
> printer anybody on the internet can put anything into.

## 7 · Connect the printer

Turn the printer on. Then go to `your-address/bridge` in Chrome or Edge.

1. **Connect over Bluetooth.** The browser asks which device; pick the one
   named MXW01. If nothing appears, see
   [08-troubleshooting](08-troubleshooting.md).
2. **Paste your `PRINTER_TOKEN`** into the box — from `my-tokens.txt` again.
3. **Start printing.**

The message you approved in step 6 comes out within a couple of seconds.

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

**When this project gets a fix**, one command brings your copy up to date, runs
the tests and redeploys: `node update.mjs`, from the folder you cloned.
[11-updating](11-updating.md) says what it touches and what it leaves alone.

---

## Things that go wrong at this stage

**Windows: `npm.ps1 cannot be loaded because running scripts is disabled on
this system`.** The execution policy, at the top of this page. One command, or
switch to Command Prompt.

**Windows: `'npm' is not recognized`, right after installing Node.js.** The
terminal you are typing in was open before Node existed. Close it, open a new
one.

**The browser will not show any Bluetooth device.** The printer sleeps after
about ten minutes and then only its own button wakes it — not a scan, not
software. Press its button and look again. If it is genuinely awake and still
invisible, you are probably in Safari; check [08](08-troubleshooting.md).

**"The token was refused".** The bridge is using a different `PRINTER_TOKEN`
from the one you set. The one in `my-tokens.txt` is the one the Worker has,
unless you have run `wrangler secret put` since.

**The message printed as diagonal noise.** The bitmap was rendered for a
different paper width. The bridge refuses this rather than printing it, so if
you are seeing it, something has been edited — check `PROFILE` in
`web/bridge/bridge.js`.

**Nothing prints and the log says nothing.** Look at `/admin`: the message is
probably still `pending`, waiting for you to approve it. That is the system
working.
