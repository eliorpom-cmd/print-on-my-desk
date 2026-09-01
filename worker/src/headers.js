// The headers every response carries, and why each one is here.
//
// Static files (/, /style.css, /app.js …) are served by Cloudflare's asset
// handler and never reach this Worker, so they get the same treatment from
// web/_headers. The two lists have to be read together; changing one without
// the other is how a policy ends up applying to half a site.
//
// The one that is doing real work is frame-ancestors. /admin holds "print
// everything waiting" and "reject everything waiting" as single buttons, and
// its session now persists in a cookie the browser attaches on its own - which
// is exactly the shape a clickjack needs. Nothing here may be framed.

const COMMON = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  // frame-ancestors covers this for anything modern; X-Frame-Options is for
  // what is not, and costs one line.
  "x-frame-options": "DENY",
};

/**
 * A fresh nonce for one HTML response.
 *
 * The pages served from here carry their CSS, and the desk its script, inline
 * in one template. A nonce is what lets them run under a policy that still
 * refuses everything else - 'unsafe-inline' would have allowed them by
 * allowing every injected string too, which is the whole thing a policy is for.
 */
export function nonce() {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
}

/**
 * The policy for a page this Worker generates.
 *
 * `'self'` in style-src is for the <link> to /style.css, which every one of
 * these pages borrows rather than carrying a second copy of the palette; the
 * nonce is for the inline block on top of it.
 */
export const htmlCsp = (n) =>
  [
    "default-src 'none'",
    `script-src 'nonce-${n}'`,
    `style-src 'self' 'nonce-${n}'`,
    "img-src 'self'",
    "font-src 'self'",
    "connect-src 'self'",
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; ");

/** For JSON. It has nothing to load, so it is allowed to load nothing. */
export const JSON_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";

/**
 * Adds the headers to a response without disturbing what it already set.
 *
 * Existing values win: handlers that set their own cache-control or
 * content-type have reasons the router does not know about.
 */
export function harden(response, csp = JSON_CSP) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(COMMON)) {
    if (!headers.has(key)) headers.set(key, value);
  }
  if (!headers.has("content-security-policy")) {
    headers.set("content-security-policy", csp);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
