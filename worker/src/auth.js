// Shared-token auth for the machine endpoints.
//
// The Pico is the only client. The token lives in firmware/config.py, which is
// gitignored, and in the Worker as a secret. It is never in a URL: query
// strings end up in logs.

/** Constant-time-ish comparison. Not a hash, but not a length oracle either. */
export function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Accepts either `Authorization: Bearer <token>` or `X-Printer-Token: <token>`.
 * MicroPython's request helpers make plain headers easier, so both are allowed.
 */
export function checkToken(request, env) {
  const expected = env.PRINTER_TOKEN;
  if (!expected) return false; // Refuse rather than run unauthenticated.
  const header = request.headers.get("authorization") ?? "";
  const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7) : null;
  const direct = request.headers.get("x-printer-token");
  return safeEqual(bearer, expected) || safeEqual(direct, expected);
}

/**
 * The admin token, for the moderation page and its endpoints (M5).
 *
 * A different secret from PRINTER_TOKEN on purpose. The Pico's token lives in
 * plain text on a microcontroller taped to a shelf; it should not also be the
 * key to approving what gets printed.
 */
export function checkAdmin(request, env) {
  const expected = env.ADMIN_TOKEN;
  if (!expected) return false;
  const header = request.headers.get("authorization") ?? "";
  const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7) : null;
  return safeEqual(bearer, expected) || safeEqual(request.headers.get("x-admin-token"), expected);
}
