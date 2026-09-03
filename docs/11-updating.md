# Keeping it up to date

Bugs get fixed here. This is how the fix reaches the printer on your desk.

```sh
node update.mjs
```

From the folder you cloned, not from `worker/`. It fetches, shows you what is
new, applies it, runs the tests, brings the database up to date and deploys —
in that order, stopping at the first thing that fails without touching what is
already running.

To look without changing anything:

```sh
node update.mjs --check
```

---

## What it does, and why in that order

| | | If it is skipped |
| :-- | :-- | :-- |
| `git pull` | the new code | nothing changes, obviously |
| `npm install` | anything new it depends on | the deploy fails naming a package you have never heard of |
| `npm test` | proof it works before it goes out | you find out from a friend |
| `npm run db:remote` | new tables and columns | **nothing fails.** The Worker deploys, serves, and throws hours later on the one path that reads the new column |
| `npm run deploy` | it goes live | — |

The database step before the deploy, never after: `schema.sql` is written so it
can be run any number of times against any state, so the cost of running it
early is a few reads. The cost of running it late is a window where the new
code queries a column that does not exist yet.

**It stops rather than guessing.** If the tests fail, nothing is deployed and
your site keeps serving the version it was. If the update and your own changes
have both touched the same lines, it stops and tells you what to type — it will
not start a merge it cannot finish on your behalf.

## Your own changes are not in the way

This repository is meant to be edited. Your wording in `web/index.html`, your
word list in `worker/src/terms.js`, your database id in `wrangler.jsonc` —
those are yours, and git merges them with an update perfectly well as long as
they are **committed**:

```sh
git add -A && git commit -m "my wording"
```

Do that whenever you change something you want to keep. It is what makes an
update a merge instead of a decision about which copy to throw away.

If git does report a conflict, it means the same lines changed on both sides.
`git status` names the files; inside each, the part between `<<<<<<<` and
`>>>>>>>` is your version against the new one. Keep what you want, delete the
markers, then `git add -A && git commit` and run the update again.

## What is never touched

* **Your secrets.** They live on Cloudflare, not in these files. An update
  cannot see them and cannot lose them.
* **Your messages.** The database is added to, never rebuilt. Nothing in
  `schema.sql` deletes anything; that is the one rule it has.
* **`my-tokens.txt`.** Ignored by git, so it survives everything.

## The printer end

The Worker is updated. Whatever drives your printer may not be:

| | How it picks up an update |
| :-- | :-- |
| The browser bridge | reload the tab |
| The always-on agent | `sudo systemctl restart printer-agent` |
| The Pico | copy `firmware/` over again — [03-microcontroller](03-microcontroller.md) |

Only the agent and the firmware ever need this, and only when the update
touched them. The update tells you what changed; if none of the lines mention
`agent/` or `firmware/`, there is nothing to restart.

## Knowing there is something to update

There is no notification, on purpose: your Worker does not phone anywhere, and
adding a version check would be the first thing it ever did that was not about
your printer.

So either run `node update.mjs --check` when you think of it, or let GitHub
tell you — **Watch → Custom → Releases** on
[the repository](https://github.com/eliorpom-cmd/print-on-my-desk), which is an
email when something is released and silence otherwise.

## If you downloaded the ZIP

Then there is no git in your copy and nothing to pull. `update.mjs` says so and
stops rather than pretending.

Cloning it once is worth the five minutes, and every update after that is one
command:

```sh
git clone https://github.com/eliorpom-cmd/print-on-my-desk.git
```

Then copy three things from your old folder into the new one — your wording in
`web/index.html`, your word list in `worker/src/terms.js`, and the database id
in `worker/wrangler.jsonc` — and deploy. Your secrets are already on Cloudflare
and do not move.
