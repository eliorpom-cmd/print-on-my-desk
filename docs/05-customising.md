# Making it yours

The point of this project is that it is somebody's own printer. A deployment
that looks exactly like everybody else's has missed it.

Ordered by how much difference each change makes for how long it takes.

---

## The words on the page — 10 minutes

`web/index.html`. Everything worth changing is in the first thirty lines and
the `<h1>`.

* The **title**, the **description**, and the heading.
* The **rules**, in the `<div class="notes">` block. Say the true ones. If your
  printer only runs in the evenings, say so — a page promising instant paper
  from a printer that runs at 8 p.m. disappoints everyone exactly once.
* The **closed message**, in `<section class="over">`, for when you stop taking
  messages.

One rule fills itself in: the daily limit comes from `/api/status`, so it can
never contradict the actual setting.

## The look — 20 minutes

`web/style.css`, in `:root`. Change the tokens there and it is a different
site. The site is dark, and there is no light-mode block to keep in step: one
palette, one place.

Three of those tokens are not interchangeable, and the comment in the file says
so. `--paper` and `--ink` are the **page's** background and text — `/admin`
borrows this stylesheet and paints itself with them, so swapping their meaning
makes the desk unreadable. `--field` is the box the message is typed into.
`--stock` is the physical roll, and it stays light in every theme because paper
does: it is used where there is actually paper — the social card, and the
ticket that comes out of the slot when something is really printed.

If you change `--field`, change `FIELD` in `web/ticket.js` to match. The dots
in the box are painted onto a canvas rather than styled by CSS, so that one
colour is written in two places on purpose, and each says so.

**There are no web fonts to change**, and that is the one deliberate part of
the design. The page has no typeface of its own for a message: what somebody
types is drawn with the printer's own atlas, so the preview IS the ticket
rather than a picture of one. The interface uses the reader's system font. If
you want the page to look different, the next section is where that happens.

No build step, no framework. Edit, reload, deploy.

## The font on the ticket — 5 minutes

The printer draws from a bitmap atlas, built offline from a real font. Three
are set up for you:

```sh
python3 tools/build_font.py --preset terminal    # JetBrains Mono, 28 px — WHAT SHIPS
python3 tools/build_font.py --preset code        # Google Sans Code, even and modern
python3 tools/build_font.py --preset typewriter  # Courier Prime, looks like a receipt
```

Each preset carries a face **and the size it was tuned at**, and those sizes
are not the same: the one that ships is 28 px, which is 4.4 mm tall on a 58 mm
printer and fits 21 characters on a line. The other two were tuned smaller, for
a wider printer. Try one with `--preview` before you keep it, and if it comes
out smaller than you wanted, say so:

```sh
python3 tools/build_font.py --preset typewriter --size 28 --preview
```

One number to read carefully: the script reports characters per line across the
**whole** 384 dots, and your ticket has a margin, so the page's gauge shows one
fewer. The gauge is the one that counts.

**This changes the site, not just the paper.** The headline stays as it is, but
the preview on the front page, the ticket, and the social card all follow,
because they were never three things: they all read the same atlas.

Each preset downloads the font the first time and rewrites three files —
`worker/src/font-atlas.js` for the Worker, `web/lib/font-atlas.js` for the page
(via `tools/sync_web.mjs`, which the script now runs for you), and
`web/font-atlas.json`. **The first two must agree or the preview is a lie**, so
if the script ever tells you it could not regenerate the browser copy, run
`node tools/sync_web.mjs` before you deploy.

Two more things, in this order:

```sh
npm --prefix worker test    # the pinned renderings are keyed by font name
node tools/og_image.mjs     # the social card, in the new font
```

The test suite pins what the renderer produces, per font, and an atlas it does
not know about **fails** rather than passing quietly. That is deliberate: add a
row to `SHIPPED` in `worker/test/profiles.test.mjs` with the height and crc
your build produces, and say in the comment where the numbers came from. Then
deploy.

Add `--preview` to see the result as ASCII art in your terminal before you
commit to it.

**Your own font:**

```sh
python3 tools/build_font.py --font path/to/Something.ttf --size 22 --preview
```

`--size` is worth trying a few values of. It decides the pitch, and the pitch
decides how many characters fit on a line: the presets are tuned, but your own
font will not be.

It must be **monospaced**. The atlas gives every glyph the same advance, and a
proportional font forced through it comes out looking like a ransom note.

The useful range on a 58 mm roll is narrower than it looks. Under **20**
characters a line, ordinary words start being cut in half by the wrap —
"anniversaire" is twelve letters and shares its line with nothing. Much above
**24** and the letters are back to the 3 mm that reads as a receipt from a
supermarket rather than as something somebody sent you. 21 is what ships.

## The ticket layout — an hour

`worker/src/render.js`. Margins, the rule above the id, where the date sits,
the separator between tickets in a batch.

**There are two layouts, and one line chooses.** `layout` in
`worker/src/profiles.js`:

| | What it draws | What it costs |
| :-- | :-- | :-- |
| `framed` | title, rules, `#12 03/09 14:22`, signature | about 13 mm a ticket |
| `bare` | the message and the signature, nothing else | nothing |

`framed` is what both printers draw, and it is what makes a ticket on the floor
findable again — the number on it is the one `/admin` searches by.

`bare` is the answer at volume, and it is here because this project needed it
once: a link travelled further than expected, the queue passed a thousand
messages, and a four-metre roll turned out to hold 132 tickets. At that point
13 mm of furniture on a 30 mm ticket is 40% of your paper, and a title every
three centimetres of a continuous strip is repetition rather than identity.

If you are printing a handful of messages a day, leave it framed.

It draws into a 1-bit canvas (`bitmap.js`) at the printer's exact width, and
that is what makes previewing honest: the browser draws the same bitmap the
head will lay down, so what somebody watches is what comes out.

```sh
node tools/preview.mjs "a message" > ticket.png
```

Change something, run that, look at the PNG. Faster than paper, and free.

## Another printer width — an afternoon

`worker/src/profiles.js` holds one entry per machine: width in dots, bytes per
line, whether the image is rotated, how many blank lines to feed to clear the
tear bar.

Adding a profile is mostly filling that in. The parts that are not obvious:

* **`flip180`.** Some printers take the image top-first and some bottom-first.
  Get it wrong and every ticket prints upside down — but a batch of several
  also comes out in the wrong ORDER, and that failure is silent: the strip
  looks perfectly well formed.
* **`feedLines`.** The distance from the print head to the tear bar, in dots.
  Too few and the ticket cannot be torn off without pulling the next one
  through. **Measure it**: print two marks, measure the white between them with
  a ruler, and never measure from a torn edge.

## What not to change

* **The 200-character limit** (`worker/src/limits.js`), unless you have watched
  a long ticket print. Paper adds up faster than it looks, and a thermal head
  printing continuously gets hot.
* **The proof-of-work** on the form. It is the only thing between you and a
  script, and it costs a phone about a tenth of a second.
* **`hold_all`**, which holds every message for your approval. Turning it off
  means a stranger's words reach your paper unread. It is one setting on
  `/admin` if you decide otherwise; decide it deliberately.
