// The word list. YOURS TO WRITE.
//
// This file ships with barely anything in it, on purpose, and the reason is
// worth reading before you fill it.
//
// A published list of exactly which terms a filter catches, at which severity,
// is a published list of what to type to get past it. The project this came
// from keeps its real list out of version control for that reason, and so
// should you once yours is any good. The matching ENGINE - blocklist.js next
// door, with its confusable folding, its leetspeak, its allowlist that keeps
// Scunthorpe out of trouble - is the part worth sharing, and it is all there.
//
// What is here is a demonstration of the three modes and the three severities,
// with enough real entries that a fresh install is not defenceless. It is not
// a filter. Treat it as a shape to fill.
//
// -----------------------------------------------------------------------
//
// severity decides what happens to a message that matches:
//
//   high    rejected outright, and the author is told nothing. Use it only
//           where you would never want a second opinion.
//   medium  held as `pending`: it waits for you to look. This is where most
//           of a real list belongs.
//   low     printed, but recorded, so the admin page can show you what got
//           through and you can decide whether it should have.
//
// mode is the matching rule, chosen per term rather than globally:
//
//   exact   the pattern must BE a token, plus a short suffix. Use it for
//           anything short, ambiguous, or a plausible surname or place. This
//           is what stops "class" matching a three-letter term.
//   family  the pattern must be a substring of ONE token. Catches inflections
//           and padding - "...ing", "...z", tripled letters - without ever
//           gluing two innocent words into a guilty one.
//   phrase  two words with anything between them, for terms that are only
//           offensive together.
//
// The engine folds the input before matching - accents, Cyrillic and Greek
// lookalikes, leetspeak, spaced-out letters, repeated letters - so write your
// patterns in plain lowercase ASCII. Do not add "n1gg3r" by hand: it is
// already covered, and every variant you add by hand is one you have to
// maintain.
//
// -----------------------------------------------------------------------
//
// TWO THINGS THAT ARE NOT ON THIS LIST, AND MUST NOT BE.
//
// Identity words. "gay", "queer", "lesbian", "trans", "black", "jew",
// "muslim" and their neighbours are how people describe themselves. Blocking
// them is the loudest failure a filter like this can have, and it is invisible
// to you: the author just sees the same polite confirmation as everybody else.
//
// Names of people you have fallen out with. It will not work, it will not stay
// secret, and the list is read by whoever inherits the project.

export const TERMS = [
  // ---- high: what you would never want to see on your paper ----------------
  //
  // Deliberately almost empty. Slurs are specific to a language and a place,
  // and a list written by somebody else is a list that misses what your
  // friends would actually be hurt by. Add yours; there is no shortcut.
  { id: "slur-example", severity: "high", mode: "family", patterns: ["examplesluronly"] },

  // ---- medium: worth a human's eye before it prints ------------------------
  { id: "sexual",  severity: "medium", mode: "exact",  patterns: ["cock", "dick", "cum"] },
  { id: "porn",    severity: "medium", mode: "family", patterns: ["porn", "hentai"] },
  { id: "threat",  severity: "medium", mode: "phrase", patterns: [["kill", "you"], ["hope", "die"]] },
  // A URL in a message is almost never a message. See spam.js for the rest.
  { id: "invite",  severity: "medium", mode: "family", patterns: ["onlyfans", "telegram"] },

  // ---- low: it prints, and you get to see that it did ----------------------
  { id: "swear",   severity: "low", mode: "family", patterns: ["fuck", "shit"] },
  { id: "insult",  severity: "low", mode: "exact",  patterns: ["idiot", "moron"] },
];
