# Security

## Reporting something

Open a private security advisory through the repository's **Security** tab, or
email the maintainer if the repository lists an address. Please do not open a
public issue for anything that would let somebody else print on a stranger's
paper.

There is no bounty. There is a thank-you, and a ticket printed with your name
on it if you want one.

## What this project is, in security terms

A public form that causes a physical event in somebody's home. That framing is
worth keeping in mind, because it makes some ordinary web risks worse and some
milder.

**Worse:** the output is on paper, in a room, and cannot be un-printed. There
is no "delete" for a ticket somebody is holding. Everything in this codebase
that looks over-cautious about what reaches the queue is over-cautious for that
reason.

**Milder:** there are no accounts, no passwords, no personal data beyond what
somebody types, and nothing to steal from the database that is not already
public. The worst outcome of a total compromise is a wasted roll of paper and
an unpleasant afternoon.

## The trust boundaries

| Who | Holds | Can |
| :-- | :-- | :-- |
| Anybody | nothing | submit a message, subject to every limit below |
| A key holder | `ACCESS_KEY` | submit while the service is closed |
| A printer | `PRINTER_TOKEN` | take messages out of the queue and mark them printed |
| You | `ADMIN_TOKEN` | everything |

`IP_SALT` is not a capability: it salts the hash used for rate limiting, so the
database never holds an address. Changing it resets everybody's daily
allowance.

## What stands between a stranger and your paper

In the order a request meets them:

1. **The origin check.** A submission driven from somebody else's page is
   refused.
2. **Proof of work.** One solved challenge per message, single-use, replay
   detected in the database. Costs a phone about a tenth of a second and a
   script rather more.
3. **Rate limits.** Per day, per hour, and a cooldown, all per salted address.
4. **Duplicate and echo detection.** The same text twice, from one person or
   from many.
5. **The word list**, folded against leetspeak and lookalike alphabets.
6. **A model**, for what a list cannot catch. Unavailable means *held*, not
   approved.
7. **You**, tapping approve. On by default, and the one nobody should turn off.
8. **A paper ceiling.** A message that would render taller than
   `MAX_PUBLIC_LINES` is refused while its author is still there to be told.

## Known limitations, stated plainly

**The bridge's token lives in a browser.** `/bridge` keeps your
`PRINTER_TOKEN` in `localStorage`, where anything with access to that browser
profile can read it. It grants the right to drain your queue and mark messages
printed - not to read anything private, and not to reach your admin page. It is
fine on your own machine and wrong on a shared one. There is a "forget" button;
use it.

**A key in a link is a key in a link.** The private door is a `#k=` fragment,
which browsers never send to a server - so it is in no access log and no
referrer. It is still in whatever chat you pasted it into. Rotate it with
`wrangler secret put ACCESS_KEY` whenever that matters.

**The kill switch is not instant across the world.** It is read from the
database on every request, so it takes effect on the next one - but a response
already in flight is already in flight. There is no cache in front of it, and
that was a deliberate choice: a ten-second settings cache was written once and
removed the same hour, because the moment somebody flips that switch is the
moment they need it to have already happened.

**Moderation is not a guarantee.** It is a filter and a queue. The guarantee is
you, which is why nothing prints unattended by default.

**An admin session is a cookie.** HttpOnly, so page scripts cannot read it, and
`SameSite` plus an origin check on every state-changing request. Log out on a
machine that is not yours.

## What is deliberately absent from this repository

The upstream project's real word list, and its payment webhook. A published
list of exactly which terms a filter catches is a published list of what to
type to get past it - see [NOTICE](NOTICE) and
[docs/06-moderation.md](docs/06-moderation.md). Yours should leave your public
repository too, once it is any good.

## If you fork this and run it for more than friends

Read [docs/07-operating.md](docs/07-operating.md) first and turn the limits
**down**. The defaults assume a link you sent to people you know. A thermal
head has a duty cycle, a roll costs money, and the printer is in a room where
somebody sleeps.
