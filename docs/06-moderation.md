# Moderation

You are putting a link on the internet that makes something appear in your
home. This is the part to read properly.

---

## The default, and why you should keep it

**Nothing prints until you approve it.** Every message becomes a `pending` job,
you see it on `/admin`, and it only reaches paper when you tap approve.

The setting is `hold_all` and it is on. You can turn it off, and then the
filters decide on their own and clean messages print unattended. Do that only
when you know who has the link and you would be relaxed about any of them
sending anything at 3 a.m.

Reviewing is not overhead here. It is the feature.

---

## The three layers

A message passes through these in order, and the first one to have an opinion
wins.

### 1 · Spam — `worker/src/spam.js`

Links, repeated characters, the shapes of automated posting. Cheap, runs first,
and catches most of what a bot sends.

### 2 · The word list — `worker/src/blocklist.js` and `terms.js`

This is where the interesting work is. The engine, in `blocklist.js`, folds the
message before matching anything:

* **Confusables and accents** collapse to plain ASCII, so Cyrillic `о` is `o`.
* **Leetspeak** folds back to letters: `$h1t` is `shit`.
* **Separators disappear** and runs of single letters rejoin, so `f u c k` is a
  word again.
* **Repeated letters collapse**, on both sides of the comparison, so `fuuuuck`
  and `fuck` end up in the same place.

Which means: **do not add variants to your list by hand.** They are already
covered, and every one you add is one you have to maintain.

The opposite failure matters just as much. Substring matching is how a filter
starts eating "Scunthorpe" and "classic" and "analysis", so each term declares
how it is matched:

| Mode | Matches | Use it for |
| :-- | :-- | :-- |
| `exact` | a whole token, plus a short suffix | anything short, ambiguous, or a plausible name |
| `family` | a substring of one token | long, unambiguous terms and their inflections |
| `phrase` | two words with a small gap | terms only offensive together |

And an allowlist of ordinary words runs first, so a token that is a real word
is dropped before any matching happens at all.

**Severity decides what happens:**

* `high` → rejected outright, and the author is told nothing. Silence is
  deliberate: telling somebody which word tripped the filter is telling them
  what to change.
* `medium` → held for you.
* `low` → prints, but recorded, so `/admin` shows you what got through.

### 3 · The model — `worker/src/moderation.js`

What the word list has no opinion on goes to a small classifier on
Cloudflare's AI platform, free within a generous allowance. It catches what a
list cannot: a threat with no bad words in it.

If it is unavailable, the message is **held** rather than approved. When the
thing that decides is down, the safe direction is the one that waits for a
person.

Turn it off entirely with the `moderation` setting on `/admin`. The word list
still runs.

---

## Writing your own list

`worker/src/terms.js` ships with about a dozen entries. It is a demonstration
of the shape, not a filter. Yours will be better because it will be about the
language your friends actually speak.

```js
{ id: "something", severity: "medium", mode: "family", patterns: ["theterm"] },
```

Write patterns in plain lowercase ASCII. The folding handles the rest.

### Two things that must not go on it

**Identity words.** "gay", "queer", "trans", "black", "jew", "muslim" and
their neighbours are how people describe themselves. Blocking them is the
loudest failure a filter like this can have, and it is invisible to you: the
author sees the same polite confirmation as everybody else and simply never
hears from you again.

**Names of people you have fallen out with.** It will not work, it will not
stay secret, and the list outlives the argument.

### Keep your real list out of your public repository

A published list of exactly which terms a filter catches, at which severity, is
a published list of what to type to get past it.

That is why `terms.js` is a separate file from the engine. When yours is any
good, add it to `.gitignore` — there is a commented line waiting — and keep a
copy somewhere safe. The engine stays public; the list stops being useful to
anybody but you.

### When it eats an ordinary message

It will. Add the word to `ALLOW` in `blocklist.js` and redeploy. The allowlist
runs before any matching, so an allowed token cannot be part of a hit at all.

And every refusal is reversible: `/admin` can put a rejected message back in
the queue, keeping the record of what flagged it and why. A filter that no
human can overrule is the one failure mode with no appeal.

---

## What you can see afterwards

Nothing is ever deleted. Refused messages are kept alongside printed ones, with
what decided and why, and `/admin` can search all of it. That archive is the
point rather than a by-product: it is the record of what a public printer
actually receives.
