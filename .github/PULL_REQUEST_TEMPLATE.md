## What this changes, and why

<!-- The why is the part that is hard to reconstruct later. A sentence is
     plenty; a paragraph is welcome if something went wrong on the way. -->

## How you know it works

<!-- What you ran, or what came out on paper. "The tests pass" is fine for a
     change the tests cover. For anything touching a printer, say which one. -->

---

- [ ] The suites in [CONTRIBUTING](https://github.com/eliorpom-cmd/print-on-my-desk/blob/main/CONTRIBUTING.md) pass, including
      `node tools/sync_web.mjs --check` — the one people miss, and the one that
      catches a preview quietly disagreeing with the paper.
- [ ] Comments match the density around them. A change with no explanation, in
      a file where every decision is explained, reads as an accident.
- [ ] If a safeguard is gone, the comment says why it is no longer needed.
- [ ] No secret, token or account id in the diff.

**Worth reading before a large one:** CONTRIBUTING lists what gets turned down,
and the list is honest rather than a formality — a framework, anything that
weakens the defaults, a query on a hot path with no cost test, and additions to
the starter word list. A good change can still be out of scope, and it is
kinder to say so here than after you have written it.
