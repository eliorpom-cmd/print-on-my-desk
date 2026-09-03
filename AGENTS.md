# For a coding assistant

You are probably reading this because somebody said *"read AGENTS.md and set
this up for me"*. Good. This file is the whole brief.

Read it all before you run anything. It is short on purpose.

---

## What this is

A thermal printer with a web page in front of it. Somebody opens a link, writes
a message, and it comes out on paper on the user's desk.

Three parts:

* `web/` — the page people write on. Plain HTML and ES modules, no build step.
* `worker/` — a Cloudflare Worker plus a D1 (SQLite) database. The queue, the
  filter, the admin desk, the API.
* `agent/`, `firmware/`, `web/bridge/` — three ways of driving a printer.
  The user picks **one**.

---

## Your job, in order

Do not skip ahead. Each step fails in a way the next one cannot diagnose.

1. **Ask which printer they have.** Not which they want — which is on the desk,
   or on its way. `docs/04-printers.md` lists what works. If they have not
   bought one yet, help them choose and then stop: nothing below can be tested
   without it.

2. **Ask which of the three set-ups they want.** `README.md` has the table.
   Default to the browser bridge unless they have said otherwise: it is the one
   they can see working in half an hour.

3. **Cloudflare.** They need an account (free, no card). You cannot create it
   for them and you should not try. Once they have it:
   ```sh
   cd worker
   npm install
   npx wrangler login          # opens a browser; they click Allow
   npx wrangler d1 create printer
   ```
   That last command asks what to call the binding and offers `printer`.
   **The answer is `DB`** — the Worker asks Cloudflare for `env.DB`, and taking
   the default adds a second entry while leaving the real one on its
   placeholder. It fails two steps later as "Invalid uuid".

   On Windows, `npm` and `npx` are PowerShell scripts and the default execution
   policy refuses to run them. The cure is one command in their terminal,
   `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, and it is theirs to
   run, not yours to run for them: it changes a security setting on their
   machine and they should see it happen. `docs/01-quick-start.md` explains it.

4. **Secrets.** Three are required, and one script does all of it:
   ```sh
   node setup.mjs
   ```
   It fills in the database id from their account if step 3 did not, generates
   three 256-bit secrets, uploads them, and writes the two they need again into
   `my-tokens.txt`, which is gitignored. **Tell them that file matters** before
   they close it: Cloudflare will not show a secret twice.

   Do not read the tokens back to them in the chat, and do not put them in a
   commit, a comment, or a file that is not that one.

   By hand, if they would rather watch it happen: generate with
   `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`
   — not `openssl`, which does not exist on Windows — and set each with
   `npx wrangler secret put NAME`.

   Also copy `.dev.vars.example` to `.dev.vars` with different values, for
   local runs. `.dev.vars` is gitignored; keep it that way.

   **`npm run dev` is not offline.** The AI binding has no local
   implementation, so the dev server opens a connection to the user's
   Cloudflare account before it serves anything: it needs `wrangler login`
   and, if their login has more than one account, `account_id` uncommented in
   `wrangler.jsonc`. Without that it exits mid-start-up and no port opens. Do
   not go hunting in the code for this - it is the configuration, and
   `docs/08-troubleshooting.md` says so too.

5. **The database, then the deploy.**
   ```sh
   npm run db:remote
   npm run deploy
   ```

6. **Check it before handing it over.** Open the URL. Open `/admin` and log in
   with the admin token. Send a message. It should appear on the desk, waiting.

7. **Then the printer end**, following whichever of `docs/01`, `docs/02` or
   `docs/03` matches step 2.

**If they already have it running and want the latest fixes**, none of the
above applies: that is `node update.mjs` from the repository root, and
`docs/11-updating.md` explains what it will and will not touch. Do not
hand-roll a pull, a schema run and a deploy - the order matters and the script
has it.

---

## Things you must ask rather than decide

* **The name and the wording on the page.** `web/index.html` says "Print on my
  desk" and a few sentences about what happens. That is theirs to write, and a
  page in your voice rather than theirs is the one thing they will notice
  immediately. Ask, then edit.
* **Whether messages are held for approval.** The default is yes: nothing
  prints until they tap approve. Do not turn `hold_all` off to make a demo
  smoother. If they ask you to, make sure they understand it means a stranger's
  message reaches their paper unread.
* **The daily limit.** Default is three messages per person per day. Ask how
  many people they are sending the link to.
* **Notifications.** Discord and ntfy are both optional and both off. Ask
  before wiring either; it means giving this project a webhook URL.

## Things you must not do

* **Do not deploy to production without saying so first**, and never as a side
  effect of "checking something".
* **Do not turn off the moderation, the rate limits, or the proof-of-work** to
  make a test pass. If a test is failing, the test is telling you something.
* **Do not put a secret in a file that git can see.** `wrangler secret put`
  for the deployed Worker, `.dev.vars` for local. Nowhere else, ever.
* **Do not commit `worker/src/terms.js` to a public repository** once they have
  written a real word list into it. See `docs/06-moderation.md`.
* **Do not weaken the Content-Security-Policy in `web/_headers`** to make
  something load. Move the code into a file instead; there is a worked example
  in that file's own comments.

---

## How this codebase is written, so you fit in

The comments explain **why**, not what. They are unusually long and they are
not decoration: most of them exist because something went wrong once and the
next person needed to know. Several say plainly "do not remove this" — those
are the ones that cost a day each.

When you change something here:

* Match the comment density. A change with no comment, in a file where every
  decision is explained, reads as an accident.
* If you remove a safeguard, say in the comment why it is no longer needed.
* Do not translate or reflow existing comments. They are load-bearing.

## The tests

```sh
cd worker && npm test
```

Two of them are unusual and worth understanding before you touch anything near
them:

* `test/helpers/d1.mjs` runs the real SQL against a real SQLite engine rather
  than a hand-written fake. A fake cannot disagree with your query; it returns
  whatever the test author expected. Two of the worst bugs this project ever
  shipped went straight through a suite of fakes.
* `test/d1-cost.test.mjs` asserts on the **cost** of queries, by reading the
  plans SQLite actually chooses. The free database plan is billed per row
  *read*, and three perfectly correct queries once exhausted a day's allowance
  in an afternoon. If you add a query to a path that runs often, add a case
  there too.

## The shape of a print

Worth knowing before you debug anything:

```
  /api/submit    a message arrives, is filtered, and becomes a `pending` job
  /admin         a human approves it: `pending` -> `approved`
  /api/machine/next   the bridge claims it: `approved` -> `printing`
                      the Worker renders the bitmap and sends it
  /api/machine/done   the bridge reports: `printing` -> `printed` or `failed`
```

A job in `printing` holds a lease. If the bridge dies mid-ticket the lease
expires and the job is marked failed rather than reprinted — a duplicate is
more confusing than a miss, and a miss can be asked for again.

### Two rules about drawing a ticket, both already broken once

**The bitmap is rendered for the print head, not for eyes.** The MXW01's head
is mounted upside down, so its profile carries `flip180` and `renderTicket`
returns a picture that is correct on paper and mirrored gibberish on a screen.
Anything drawing a ticket for a person goes through `renderForScreen` in
`web/ticket.js`, which undoes it. Do not add a fourth copy of that line: two of
the three that existed had forgotten it, and neither author could see the bug,
because both wrote against a profile that has no rotation.

**The page must preview the printer that actually prints.** `CURRENT_PROFILE`
in `worker/src/profiles.js` and `PROFILE` in `web/bridge/bridge.js` are the
same machine seen from two ends. When they disagreed, the page showed a
512-dot ticket at 36 columns while the bridge printed a 384-dot one at 28, and
nothing failed — the preview was simply of a different printer.

`worker/test/screen-render.test.mjs` holds both. If you change the profile, the
rotation, or where a ticket gets drawn, read it first.

---

## If something is wrong with this file

Tell the user. Do not work around it silently: a stale instruction here is
worse than none, and they are the only one who can fix it.
