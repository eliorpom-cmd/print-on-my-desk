# Contributing

This is a small project with a narrow purpose: one printer, one link, the
people you send it to. It is not trying to become a platform, and a change that
moves it that way will probably be turned down however good it is.

That said — bug reports, printer profiles, and documentation fixes are all
welcome, and the last one most of all.

## Before you open a pull request

```sh
cd worker && npm test          # the Worker, the page, the renderer
cd ..
python3 agent/test_loop.py           # the always-on agent's loop
python3 agent/test_escpos_printer.py # the USB driver, byte by byte
python3 agent/test_ble_printer.py    # the Bluetooth driver
python3 firmware/test_loop.py        # the Pico's loop
python3 firmware/test_ble_printer.py # the Pico against captured traces
node tools/sync_web.mjs --check      # the page's copy of the renderer
```

All of them run without hardware. That is the property worth protecting: you
can break something and know it with no printer on your desk.

This list is what CI runs, and it used to be shorter than what CI runs — three
of these were enforced on every pull request and mentioned nowhere, so it was
possible to pass everything this page asked for and still go red. The last one
is the usual way that happened: `web/lib` is a copy of the Worker's renderer,
and a copy that has drifted is a preview that lies about what the paper will
say.

## How this codebase is written

The comments explain **why**, not what, and they are long. That is deliberate.
Most of them exist because something went wrong once and the next person needed
to know — several say plainly "do not remove this", and those cost a day each.

If you change something here:

* **Match the comment density.** A change with no explanation, in a file where
  every decision is explained, reads as an accident.
* **If you remove a safeguard, say why it is no longer needed.** Not "removed
  unused check".
* **Do not reflow or reword existing comments** while doing something else. It
  makes the diff unreadable and buries the actual change.

## Things that will be turned down

* **Anything that weakens the defaults.** Nothing prints without approval; rate
  limits are on; proof-of-work is on. If a demo is awkward because of those,
  the demo is wrong.
* **A framework.** The page is plain HTML and ES modules with no build step,
  and that is a feature: somebody who has never used a bundler can edit it and
  see the result.
* **A query on a hot path with no cost test.** The database plan is billed per
  row read, and three perfectly correct queries once exhausted a whole day's
  allowance in an afternoon. See `worker/test/d1-cost.test.mjs` and
  [docs/07-operating.md §4](docs/07-operating.md).
* **Terms added to `worker/src/terms.js`.** The starter list stays small on
  purpose. Yours belongs in your own deployment, and out of your public
  repository — [docs/06-moderation.md](docs/06-moderation.md) explains why.

## Things that are very welcome

* **A printer profile that works.** `worker/src/profiles.js`, plus a line in
  [docs/04-printers.md](docs/04-printers.md) saying what you tested it on.
* **Protocol findings.** [docs/09-protocol.md](docs/09-protocol.md) has a "what
  is still unknown" section at the bottom. Same rule as the rest of that file:
  nothing goes in without evidence, and say how you measured.
* **Documentation that failed you.** If a step in the quick start did not work
  on your machine, that is a bug in the document. Say what you saw.

## Conduct

[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). It is short, and the part worth
knowing before you open anything is that a good change can still be turned
down for being out of scope, and that is not a judgement of you.

## Licence

By contributing you agree your work is released under the AGPL-3.0, like the
rest. See [NOTICE](NOTICE) for what that does and does not cover — in
particular, it does not cover names.
