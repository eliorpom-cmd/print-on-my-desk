// The admin session cookie, and the headers wrapped round every response.
//
// These exist because the failure they guard against is silent. A session that
// verifies a signature but forgets the expiry, or a cookie that loses its
// HttpOnly flag in an edit, both look exactly like a working desk - the only
// symptom is that something which should have been refused was not.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  mintSession,
  verifySession,
  readCookie,
  setCookie,
  clearCookie,
  adminAuth,
  COOKIE,
  SESSION_TTL_S,
} from "../src/session.js";
import { harden, htmlCsp, nonce, JSON_CSP } from "../src/headers.js";

const SECRET = "an-admin-token-that-is-24-bytes";

const req = (headers = {}) => new Request("https://print-on-my-desk.test/api/admin/queue", { headers });

test("a freshly minted session verifies", async () => {
  const session = await mintSession(SECRET);
  assert.equal(await verifySession(SECRET, session), true);
});

test("a session does not verify under a different secret", async () => {
  // This is what rotating ADMIN_TOKEN has to mean: every session ever issued
  // stops working. Rotation is the recovery for a leaked token, and it would
  // be worth nothing if old sessions survived it.
  const session = await mintSession(SECRET);
  assert.equal(await verifySession("another-token", session), false);
});

test("an expired session is refused even though its signature is ours", async () => {
  const now = Date.now();
  const session = await mintSession(SECRET, now, 60);
  assert.equal(await verifySession(SECRET, session, now + 30 * 1000), true);
  assert.equal(await verifySession(SECRET, session, now + 61 * 1000), false);
});

test("the expiry cannot be extended without breaking the signature", async () => {
  const session = await mintSession(SECRET, Date.now(), 60);
  const [, mac] = session.split(".");
  const forged = `${Math.floor(Date.now() / 1000) + 999999}.${mac}`;
  assert.equal(await verifySession(SECRET, forged), false);
});

test("nonsense is refused rather than thrown at", async () => {
  for (const value of ["", ".", "abc", "1.", ".abc", "9999999999.zz", null, undefined, 42]) {
    assert.equal(await verifySession(SECRET, value), false, `refused: ${String(value)}`);
  }
});

test("no ADMIN_TOKEN means nobody gets in", async () => {
  // The same posture as checkToken: refuse rather than run unauthenticated.
  const session = await mintSession(SECRET);
  const request = req({ cookie: `${COOKIE}=${session}` });
  assert.deepEqual(await adminAuth(request, {}), { ok: false, via: null });
});

test("the cookie carries the flags that make it worth having", () => {
  const value = setCookie("whatever");
  // HttpOnly is the entire point: no script on this origin may read it, which
  // is what localStorage could not promise while /m/c.js shares the origin.
  assert.match(value, /HttpOnly/);
  assert.match(value, /Secure/);
  assert.match(value, /SameSite=Strict/);
  assert.match(value, new RegExp(`Max-Age=${SESSION_TTL_S}`));
  assert.match(clearCookie(), /Max-Age=0/);
});

test("a cookie value containing '=' survives being read back", async () => {
  // Not hypothetical: the signature is hex today, but anything base64 would
  // carry padding, and splitting on every "=" would quietly truncate it.
  const request = req({ cookie: "other=1; pm_admin=aGVsbG8=; last=2" });
  assert.equal(readCookie(request, COOKIE), "aGVsbG8=");
});

test("a missing cookie header is not an error", () => {
  assert.equal(readCookie(req(), COOKIE), null);
});

test("both ways in work, and each says which one it was", async () => {
  const env = { ADMIN_TOKEN: SECRET };
  const session = await mintSession(SECRET);

  assert.deepEqual(await adminAuth(req({ "x-admin-token": SECRET }), env), {
    ok: true,
    via: "header",
  });
  assert.deepEqual(await adminAuth(req({ authorization: `Bearer ${SECRET}` }), env), {
    ok: true,
    via: "header",
  });
  // The distinction is not cosmetic: index.js puts an Origin check on cookie
  // writes and none on header writes, because only one of the two is ambient.
  assert.deepEqual(await adminAuth(req({ cookie: `${COOKIE}=${session}` }), env), {
    ok: true,
    via: "cookie",
  });
  assert.deepEqual(await adminAuth(req({ cookie: `${COOKIE}=nope.nope` }), env), {
    ok: false,
    via: null,
  });
  assert.deepEqual(await adminAuth(req(), env), { ok: false, via: null });
});

test("the page policy allows the nonce and nothing inline", () => {
  const n = nonce();
  const policy = htmlCsp(n);
  assert.match(policy, new RegExp(`script-src 'nonce-${n.replace(/[+/=]/g, "\\$&")}'`));
  // 'unsafe-inline' would have let the inline blocks run by letting every
  // injected string run too, which is the whole thing a policy is for.
  assert.ok(!policy.includes("unsafe-inline"), "no unsafe-inline anywhere");
  assert.match(policy, /frame-ancestors 'none'/);
  assert.match(policy, /default-src 'none'/);
  // The <link> to /style.css needs 'self'; the inline block needs the nonce.
  assert.match(policy, /style-src 'self' 'nonce-/);
});

test("two responses never share a nonce", () => {
  assert.notEqual(nonce(), nonce());
});

test("harden sets the headers and leaves a handler's own policy alone", () => {
  const plain = harden(new Response("{}", { headers: { "content-type": "application/json" } }));
  assert.equal(plain.headers.get("x-content-type-options"), "nosniff");
  assert.equal(plain.headers.get("x-frame-options"), "DENY");
  assert.equal(plain.headers.get("referrer-policy"), "no-referrer");
  assert.match(plain.headers.get("strict-transport-security"), /max-age=31536000/);
  // The static files carry this from web/_headers and the Worker's own pages
  // did not, so /admin was the one page on the site without it.
  assert.match(plain.headers.get("permissions-policy"), /camera=\(\)/);
  // And bluetooth stays unnamed, here as in web/_headers: restricting it is
  // how /bridge silently stops being able to see a printer.
  assert.doesNotMatch(plain.headers.get("permissions-policy"), /bluetooth/);
  assert.equal(plain.headers.get("content-security-policy"), JSON_CSP);
  assert.equal(plain.headers.get("content-type"), "application/json");

  // An HTML page has already set a policy carrying a nonce only it knows.
  // Overwriting it here would strip the nonce and stop the page dead.
  const page = harden(
    new Response("<p>", { headers: { "content-security-policy": "script-src 'nonce-abc'" } })
  );
  assert.equal(page.headers.get("content-security-policy"), "script-src 'nonce-abc'");
});

test("harden preserves the status and a Set-Cookie", () => {
  const response = harden(
    new Response(null, { status: 204, headers: { "set-cookie": setCookie("x") } })
  );
  assert.equal(response.status, 204);
  assert.match(response.headers.get("set-cookie"), /HttpOnly/);
});
