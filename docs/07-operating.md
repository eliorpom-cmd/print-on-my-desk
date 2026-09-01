# Running it

What you actually deal with once the link is out.

---

## 1 · The admin desk

`your-address/admin`, with your `ADMIN_TOKEN`. It works on a phone, which is
where you will use it.

* **Waiting** — everything held for approval. Approve or reject, one tap each,
  or take the whole list at once.
* **Recent** — what has printed lately, and what failed.
* **The machine** — is it there, how hot is the head, is there paper.
* **Settings** — everything below, live, no deploy.

The session is a cookie your browser sends on its own and JavaScript cannot
read. Log out on a machine that is not yours.

## 2 · The limits, and where to set them

All on `/admin`.

| Setting | Default | What it is |
| :-- | :-- | :-- |
| `rate_per_day` | 3 | messages per person per day |
| `rate_per_hour` | 3 | burst guard |
| `rate_cooldown_s` | 300 | minimum gap between two messages |
| `dedupe_window_h` | 24 | the same text twice is ignored |
| `queue_max` | 0 | cap on the queue; 0 is no cap |
| `pow_difficulty` | 150000 | proof-of-work; ~0.1 s on a phone |
| `hold_all` | on | everything waits for you |

"Per person" is a salted hash of their address, and the salt is a secret. The
database never holds an address.

**Turn these DOWN, not up, if you widen who has the link.** The constraint is
physical: a thermal head has a duty cycle, a roll costs money, and the printer
is in a room where somebody sleeps.

## 3 · Heat and paper

**Heat.** The head reports its own temperature. The bridge refuses to start a
print above `head_max_c` (38) and waits until it falls to `cool_to_c` (34).
Raising **both** buys throughput — a head working hotter sheds heat faster —
whereas raising only the ceiling widens the band and slows both halves of the
cycle for nothing. 45 is the hard bound.

A refused print is **not** a failed one: nothing was sent, the message goes
back in the queue with its attempt refunded. That distinction cost real tickets
to learn.

**Paper.** The printer's only paper signal is "empty", and it arrives too late
— usually with nobody in the room. So the queue counts the lines it has sent:
tell `/admin` when you change the roll, set `roll_length_m` to what your rolls
actually hold, and the gauge estimates the rest.

Measure it once rather than trusting a listing. Set it to 0 and the gauge says
nothing at all, which is the only reading that cannot be wrong.

## 4 · What it costs, and the one way to break that

Nothing, on Cloudflare's free plan, with room to spare. The number that matters
is **5 million database rows read per day**.

That sounds like plenty and it is — as long as no query's cost grows with the
length of the queue. This project exhausted a whole day's allowance in one
afternoon, and the cause was not a traffic spike. It was three queries that
were **entirely correct** and read a little more every time somebody posted:

* an expiry check with no index, reading every waiting message to find none;
* the claim, sorting the whole queue to pick one job — once per ticket;
* two `COUNT(*)`s on the busiest paths, answering questions whose answers only
  ever move by one.

None of them would have been caught by a test of what the code returns. So
there is `worker/test/d1-cost.test.mjs`, which asserts on what queries **cost**
by reading the plans SQLite chooses.

**The rules, if you add anything:**

1. No `COUNT(*)` over the jobs table on a path that runs more than once a
   minute. Keep a counter instead — `worker/src/counters.js`.
2. No `ORDER BY` over a computed expression on the jobs table. No index can
   satisfy one, so it reads everything.
3. Every `WHERE` on the jobs table needs an index that covers it.
4. An empty answer must be cheap. It is the one returned most often.

With those held, a queue of five thousand messages costs about 12% of a day's
allowance. Without them, it costs all of it in an afternoon.

## 5 · Knowing a message is waiting

Both optional, both off, either one is five minutes.

**Discord.** Make a webhook in a channel's settings, then:
```sh
npx wrangler secret put DISCORD_WEBHOOK
```
You get each held message with approve and reject links you can tap.

**ntfy.** Pick a topic name nobody will guess, install the app, subscribe:
```sh
npx wrangler secret put NTFY_TOPIC
```
An ntfy topic is readable by anybody who knows its name, which is why it is a
secret and why the name should be random.

## 6 · Closing, and the private door

**To stop taking messages:** tick **SEASON CLOSED** on `/admin`.

It refuses new messages everywhere — the form, the challenge endpoint, every
path that can create a job — and it does **not** stop printing. Whatever is
already in the queue goes on coming out for as long as it takes. Those are
different things and closing one should not close the other.

The kill switch is the other one. It stops everything, printing included, right
now. No key opens it; that is the point of having it.

**The private door** lets you back in while the season is closed, and only you:

```sh
openssl rand -base64 24
npx wrangler secret put ACCESS_KEY
```

Then open `https://your-address/#k=THE-KEY`.

The key is in the URL **fragment**, which browsers never send to a server: it
appears in no access log and no referrer. The page reads it, removes it from
the address bar, keeps it for the tab, and sends it as a header. When it is in
use the status chip reads **private access**, so a form open only for you never
looks like a form open for everybody.

Without `ACCESS_KEY` set there is no door at all — not one anybody can push on.

It is also how to run a private beta: send a few people the `#k=` link before
you announce anything.

## 7 · When something breaks at 3 a.m.

Nothing is lost. Not by a failed print, not by a power cut mid-ticket, not by a
filter you disagree with. Every state change is recoverable and nothing is ever
deleted.

* A print that fails goes back in the queue, up to three tries, then stops and
  says so rather than retrying forever.
* A bridge that dies mid-ticket leaves a lease that expires after two minutes;
  the job is then marked failed rather than reprinted, because a duplicate is
  more confusing than a miss and a miss can be asked for again.
* `/admin` has **requeue everything that failed** as one button, because the
  recovery is always the same and a Sunday morning is exactly when nobody has a
  terminal open.

## 8 · Backing it up

```sh
curl -H "x-admin-token: YOUR_ADMIN_TOKEN" \
     "https://your-address/api/admin/export?after=0" > tickets.ndjson
```

Every ticket ever submitted, refusals included, one JSON object per line. Do it
occasionally. It costs nothing and it is the only copy that is yours.
