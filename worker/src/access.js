// The private door.
//
// A way in that stays open when the front door is shut, for exactly one
// person: whoever holds the key. It exists because "the season is over" and
// "nobody may ever send anything again" are different statements, and the
// system could only make the second one.
//
// What it is FOR, in order of how much it matters:
//
//   1. Testing the live service out of season, which otherwise means turning
//      the whole thing back on and hoping nobody notices.
//   2. A private beta: Season 2 opened to a handful of people first, by
//      sending them a link, without the queue filling from Threads on day one.
//
// What it is NOT for: the kill switch. That one is absolute and no key opens
// it. The season closing is a schedule, and a schedule can have exceptions;
// the kill switch is somebody deciding the machine must stop right now, and a
// back door around that would make it a switch you have to remember the
// exceptions to. See settings.js.

/**
 * Where the key travels, and why not in the query string.
 *
 * A header rather than `?key=`, because query strings end up in logs, in
 * referrers, and in the browser history of whoever borrowed the phone. The
 * page takes it from the URL fragment - which browsers never send anywhere -
 * and puts it here.
 */
export const ACCESS_HEADER = "x-access-key";

/** The key this request carries, if any. Bounded, because it is a header. */
export function keyFrom(request) {
  const raw = request.headers.get(ACCESS_HEADER);
  return typeof raw === "string" && raw.length <= 200 ? raw : "";
}

/**
 * Does this request hold the key?
 *
 * False whenever no key is configured, which is the safe direction: a
 * deployment that has never run `wrangler secret put ACCESS_KEY` has no
 * private door rather than one that anybody can walk through.
 */
export async function hasPrivateAccess(request, env) {
  const expected = env.ACCESS_KEY;
  if (!expected) return false;
  const offered = keyFrom(request);
  if (!offered) return false;
  return await safeEqual(offered, expected);
}

/**
 * Compares two strings without letting the clock say how far it got.
 *
 * `===` on strings stops at the first differing byte, so the time it takes
 * leaks the length of the matching prefix - enough, given a few thousand
 * tries, to recover the key one character at a time. Hashing both sides first
 * turns any pair of inputs into two fixed-length digests with no relation to
 * the original prefixes, and the loop below then always runs to the end.
 */
async function safeEqual(a, b) {
  const encoder = new TextEncoder();
  const [x, y] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  const left = new Uint8Array(x);
  const right = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
  return diff === 0;
}
