// Spam signals.
//
// The rate limits in ratelimit.js stop the same person posting too often. This
// stops the things that are worth printing zero times, not three times a day:
// links, contact details, and keyboard mashing.
//
// A public thermal printer is an advertising medium. A URL on a ticket costs
// the sender nothing and costs the owner paper, so links are refused outright
// rather than sent for review - there is no version of "visit my shop dot com"
// that this project wants on paper.
//
// Everything here is a hard reject, and the author still sees the ordinary
// confirmation. Telling a spammer which rule caught them is how they find the
// rule that does not.

import { normalize } from "./blocklist.js";

// Bare-domain detection, and the two rules that keep it out of French prose.
//
// A naive "word dot known-tld" catches "myshop.com" and also "ça.De rien",
// because `de`, `it`, `be`, `es`, `ca`, `us` and `to` are ordinary words as
// well as country codes, and people do forget the space after a full stop. So:
//
//   1. Those word-like endings are not on the bare-domain list at all. They
//      still count inside a real URL, where the scheme settles the question.
//   2. The suffix must be all lowercase. A sentence that runs on writes
//      "ça.De" with a capital, because it is the start of a sentence; a domain
//      does not. This is the discriminator that does most of the work, and it
//      costs nothing.
//
// A shouted "MYSHOP.COM" is handled by the all-uppercase alternative rather
// than by relaxing rule 2 to case-insensitive, which would let the French
// sentences back in.
const BARE_TLD =
  "com|net|org|io|co|dev|app|xyz|top|club|online|site|store|shop|link|info|biz" +
  "|ru|cn|tk|ml|ga|gq|fr|uk|nl|ch|eu|me|tv|cc|gg|ly";

const BARE_DOMAIN_LOWER = new RegExp(`\\b[a-z0-9][a-z0-9-]{0,30} ?\\. ?(?:${BARE_TLD})\\b(?![a-z])`);
const BARE_DOMAIN_UPPER = new RegExp(
  `\\b[A-Z0-9][A-Z0-9-]{0,30} ?\\. ?(?:${BARE_TLD.toUpperCase()})\\b(?![A-Z])`
);
// Anything shaped like a host with a path. The suffix does not have to be a
// TLD we know: "t.me/x", "example.zz/join". A slash after a dotted name is
// not something ordinary prose produces.
const HOST_WITH_PATH = /\b[a-z0-9][a-z0-9-]{0,30}\.[a-z]{2,12}\/\S/i;

const SIGNALS = [
  {
    id: "email",
    test: (raw) => /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(raw),
  },
  {
    id: "url",
    test: (raw) =>
      /\b(?:https?:\/\/|www\.)/i.test(raw) ||
      HOST_WITH_PATH.test(raw) ||
      BARE_DOMAIN_LOWER.test(raw) ||
      BARE_DOMAIN_UPPER.test(raw),
  },
  {
    id: "crypto",
    test: (raw) => /\b(?:0x[0-9a-f]{20,}|[13][a-km-zA-HJ-NP-Z1-9]{25,34}|bc1[a-z0-9]{20,})\b/i.test(raw),
  },
  {
    id: "phone",
    // Nine or more digits, however they are spaced. Short numbers - a date, a
    // house number, "24/7" - are left alone.
    test: (raw) => {
      const runs = raw.match(/[\d\s.\-()+]{9,}/g) ?? [];
      return runs.some((run) => (run.match(/\d/g) ?? []).length >= 9);
    },
  },
  {
    id: "solicitation",
    // Folded, so "fr33 m0ney" lands here too.
    test: (_raw, folded) =>
      /\b(?:buy now|order now|click here|follow me|subscribe|promo code|discount code|free money|make money|earn \$|casino|viagra|cialis|bitcoin|crypto wallet|onlyfans|only fans|telegram me|whats ?app me|dm me|forex|seo services|cheap [a-z]+ for sale)\b/.test(
        folded
      ),
  },
  {
    id: "repetition",
    // The same word over and over, or one key held down.
    test: (_raw, folded) => {
      if (/(.)\1{14,}/.test(folded)) return true;
      const words = folded.split(/[^a-z0-9]+/).filter(Boolean);
      if (words.length < 6) return false;
      const counts = new Map();
      for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1);
      return [...counts.values()].some((n) => n >= 6 && n / words.length > 0.5);
    },
  },
  {
    id: "gibberish",
    // A forty-character unbroken run is not a word anyone typed on purpose,
    // and it is what a base64 blob smuggled through a text field looks like.
    test: (raw) => /[^\s]{40,}/.test(raw.trim()),
  },
  {
    id: "empty",
    // Punctuation and emoji only. Nothing to print, nothing to moderate.
    test: (raw) => !/[a-z0-9]/i.test(raw.normalize("NFKD")),
  },
];

/**
 * @returns {{spam: boolean, reason: string|null}}
 */
export function spamCheck(text) {
  const raw = String(text ?? "");
  const folded = normalize(raw);
  for (const signal of SIGNALS) {
    if (signal.test(raw, folded)) return { spam: true, reason: signal.id };
  }
  return { spam: false, reason: null };
}
