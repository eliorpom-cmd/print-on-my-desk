// What counts as "one person" for the rate limit.
//
// The answer cannot be the raw address, and getting this wrong makes the whole
// quota decorative.
//
// In IPv4 an address is scarce enough to stand in for a person. In IPv6 it is
// not: a home connection is routinely handed a whole /64, which is
// eighteen quintillion addresses, and a script can walk them for free. Three
// messages a day per /128 means three messages a day multiplied by a number
// with nineteen digits - the limit would exist and count nothing.
//
// So IPv6 is truncated to its /64 prefix, which is the smallest block that is
// reliably one subscriber. The cost is that two flatmates on the same line
// share a quota; that is the same trade IPv4 has always made, and it is the
// right way round.
//
// The address itself never leaves this function. What goes to the database is
// the salted hash of what this returns (see hashIp in index.js).

/**
 * Expands an IPv6 address and keeps its first four groups.
 * Returns null if the input is not something we recognise.
 */
function prefix64(ip) {
  const [head, tail] = ip.split("::");
  if (tail === undefined && ip.includes(":::")) return null;

  const headParts = head ? head.split(":") : [];
  const tailParts = tail ? tail.split(":") : [];
  const full =
    tail === undefined
      ? headParts
      : [
          ...headParts,
          ...Array(Math.max(0, 8 - headParts.length - tailParts.length)).fill("0"),
          ...tailParts,
        ];
  if (full.length < 4) return null;

  return full
    .slice(0, 4)
    .map((group) => group.toLowerCase().padStart(4, "0"))
    .join(":");
}

/**
 * @param {string} ip the address Cloudflare reported, which a client cannot
 *   forge: the edge refuses any request carrying its own CF-Connecting-IP.
 * @returns {string} the key one quota is counted against
 */
export function ipKey(ip) {
  const address = String(ip ?? "").trim();
  if (!address) return "unknown";

  // IPv4, or an IPv4-mapped IPv6 like ::ffff:203.0.113.7. Both are one address
  // per subscriber, so they are used whole.
  if (address.includes(".")) {
    const last = address.slice(address.lastIndexOf(":") + 1);
    return last;
  }

  if (address.includes(":")) return prefix64(address) ?? address.toLowerCase();

  return address;
}
