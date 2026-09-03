# Images

Three pictures would carry this project further than three more pages of prose,
because what it makes is physical and a repository cannot show that in text.

Drop them here and the README picks them up:

| File | What it should show | |
| :-- | :-- | :-- |
| `ticket.jpg` | **The one that matters.** A real ticket, in a hand or on a desk, close enough to read. Not a screenshot of the preview - the whole promise is that this ends up on paper. | there |
| `printer.jpg` | The machine where it lives, with the roll and the mess around it. Somebody deciding whether to try this wants to see what they are signing up for. | there |
| `form.png` | The page on a phone. A screenshot is fine here; this one is a screen. | wanted |

**Look at a photograph before you commit it, and look at what is written on
the paper.** `tools/check_public.mjs` reads every file in this repository for
things that should not be published, and it cannot read an image: a name, an
address or somebody else's message printed on a ticket walks straight past it.
The two here were checked by eye and stripped of their EXIF - a phone photo
carries the coordinates of the room it was taken in, which for this project is
the room the printer is in.

Strip it like this, which also brings the file under the size above:

```sh
node -e "require('sharp')('big.jpg').rotate().resize({width:1200}).jpeg({quality:82}).toFile('docs/images/ticket.jpg')"
```

`.rotate()` applies the phone's orientation flag and then drops it; writing no
metadata is sharp's default, so there is nothing to remember to remove.

A phone photo in ordinary light beats a staged one. The point is that it is
somebody's actual desk.

Keep them under about 500 KB each - a README that takes five seconds to load is
a README people scroll past.
