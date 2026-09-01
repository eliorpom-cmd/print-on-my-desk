// The admin session, as a cookie JavaScript cannot read.
//
// This replaces the token in localStorage, and the reason is the shape of this
// origin rather than anything wrong with the desk. localStorage is per ORIGIN,
// not per page, and this origin serves one script it does not control: /m/c.js
// relays Umami's tracker onto the public page (see analytics.js). Same origin,
// same storage - so a bad day upstream at Umami was a bad day for the
// moderation desk, and no Content-Security-Policy can help once the script is
// same-origin by design. An HttpOnly cookie takes the credential out of
// JavaScript's reach entirely, which is the only fix that does not depend on
// trusting a third party.
//
// Stateless on purpose. The cookie carries its own expiry and an HMAC over it,
// keyed by ADMIN_TOKEN: no table, no lookup on every request, and rotating
// ADMIN_TOKEN invalidates every session ever issued. That last property is the
// point - rotation is the recovery for a token that has leaked, and it should
// not leave old sessions standing.

import { safeEqual, checkAdmin } from "./auth.js";

const encoder = new TextEncoder();

export const COOKIE = "pm_admin";

/** Long enough that the desk is not a login screen; short enough to lapse. */
export const SESSION_TTL_S = 30 * 24 * 60 * 60;

async function sign(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** `<expiry seconds>.<HMAC of it>`. The expiry is signed, so it is not editable. */
export async function mintSession(secret, now = Date.now(), ttlS = SESSION_TTL_S) {
  const expires = Math.floor(now / 1000) + ttlS;
  return `${expires}.${await sign(secret, String(expires))}`;
}

export async function verifySession(secret, value, now = Date.now()) {
  if (!secret || typeof value !== "string") return false;
  const dot = value.indexOf(".");
  if (dot < 1) return false;
  const expires = Number(value.slice(0, dot));
  // Checked before the HMAC so an expired cookie costs no crypto, and checked
  // at all because a signature says the value is ours, never that it is current.
  if (!Number.isInteger(expires) || expires * 1000 < now) return false;
  return safeEqual(value.slice(dot + 1), await sign(secret, String(expires)));
}

/**
 * Reads one cookie.
 *
 * Written out rather than split on "=" once: a cookie value may contain "=",
 * and taking only the first separator is what keeps a base64 value intact.
 */
export function readCookie(request, name) {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

// SameSite=Strict is the CSRF story: the browser will not attach this to
// anything another site initiates, including a top-level navigation, so the
// bulk approve buttons cannot be driven from a page the owner happens to open.
// The Origin check in index.js backs it up rather than replaces it.
//
// Secure is kept even for local runs: browsers treat http://localhost as a
// trustworthy origin and accept it there, so `wrangler dev` is unaffected.
export const setCookie = (value) =>
  `${COOKIE}=${value}; Path=/; Max-Age=${SESSION_TTL_S}; HttpOnly; Secure; SameSite=Strict`;

export const clearCookie = () =>
  `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;

/**
 * Who is asking, and how they proved it.
 *
 * The two ways are not interchangeable, and the caller needs to know which one
 * happened. A header is carried deliberately by whoever wrote the request -
 * curl, the export script - and no browser attaches it on its own, so it has
 * no CSRF surface. A cookie IS ambient authority, and every state-changing
 * request authenticated by one gets an Origin check on top.
 *
 * @returns {{ok: boolean, via: "header"|"cookie"|null}}
 */
export async function adminAuth(request, env) {
  if (!env.ADMIN_TOKEN) return { ok: false, via: null };
  if (checkAdmin(request, env)) return { ok: true, via: "header" };
  const cookie = readCookie(request, COOKIE);
  if (cookie && (await verifySession(env.ADMIN_TOKEN, cookie))) {
    return { ok: true, via: "cookie" };
  }
  return { ok: false, via: null };
}
