// Proof of work, Altcha protocol, self-hosted.
//
// The brief asks for Altcha: open source, no third party. So this is the
// Altcha challenge format implemented directly rather than pulled in as a
// dependency - the protocol is thirty lines of WebCrypto, and vendoring a
// widget from a CDN would reintroduce exactly the third party the brief rules
// out (and would need a CSP hole to load).
//
// The exchange:
//
//   server  picks a secret number n in [0, maxnumber], publishes
//           challenge = SHA-256(salt + n) and signature = HMAC(challenge).
//   browser has no way back from the hash, so it counts up from 0 until it
//           finds n. That is the work.
//   server  re-derives the hash from the n it is handed, checks its own HMAC
//           so the challenge cannot be forged, and burns the challenge so the
//           same solution cannot be spent twice.
//
// What this actually buys: it makes a submission cost ~100 ms of CPU instead
// of one HTTP request. That does not stop a determined attacker - nothing at
// this tier does - it stops the drive-by scripts that post to every form they
// find, which is the entire realistic threat to a printer in a flat.

const encoder = new TextEncoder();

const hex = (buffer) =>
  [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function sha256Hex(text) {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
}

async function hmacHex(key, message) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return hex(await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(message)));
}

/** How long a challenge stays solvable. Long enough to type a message in. */
export const CHALLENGE_TTL_MS = 30 * 60 * 1000;

function randomHex(bytes = 12) {
  return hex(crypto.getRandomValues(new Uint8Array(bytes)));
}

/**
 * Mints a challenge. The expiry travels inside the salt, as Altcha specifies,
 * so it is covered by the signature and cannot be edited by the client.
 */
export async function createChallenge(key, { maxnumber = 150000, now = Date.now() } = {}) {
  const expires = Math.floor((now + CHALLENGE_TTL_MS) / 1000);
  const salt = `${randomHex()}?expires=${expires}`;
  const number = crypto.getRandomValues(new Uint32Array(1))[0] % (maxnumber + 1);
  const challenge = await sha256Hex(salt + number);
  return {
    algorithm: "SHA-256",
    challenge,
    salt,
    signature: await hmacHex(key, challenge),
    maxnumber,
  };
}

/**
 * Checks a solution. Pure: the replay check lives in the caller, because it
 * needs the database and this file should stay testable without one.
 *
 * @returns {{ok: boolean, reason?: string, challenge?: string, expires?: number}}
 */
export async function verifySolution(key, payload, now = Date.now()) {
  let solution = payload;
  if (typeof payload === "string") {
    try {
      solution = JSON.parse(atob(payload));
    } catch {
      return { ok: false, reason: "malformed" };
    }
  }
  if (!solution || typeof solution !== "object") return { ok: false, reason: "malformed" };

  const { algorithm, challenge, number, salt, signature } = solution;
  if (algorithm !== "SHA-256") return { ok: false, reason: "algorithm" };
  if (typeof challenge !== "string" || typeof salt !== "string" || typeof signature !== "string") {
    return { ok: false, reason: "malformed" };
  }
  if (!Number.isInteger(number) || number < 0) return { ok: false, reason: "malformed" };

  const expires = Number(new URLSearchParams(salt.split("?")[1] ?? "").get("expires"));
  if (!expires || expires * 1000 < now) return { ok: false, reason: "expired" };

  // Signature first. It is the cheap check, and it is the one that proves the
  // challenge came from us rather than from the client's imagination.
  const expected = await hmacHex(key, challenge);
  if (expected !== signature) return { ok: false, reason: "signature" };

  if ((await sha256Hex(salt + number)) !== challenge) return { ok: false, reason: "solution" };

  return { ok: true, challenge, expires: expires * 1000 };
}

/**
 * Burns a challenge, and reports whether it was already spent.
 *
 * The primary key does the work: a second INSERT of the same challenge throws,
 * and that throw IS the replay detection. Doing it as SELECT-then-INSERT would
 * leave a window where two parallel requests both see it unused.
 */
export async function spendChallenge(db, challenge, expiresAt, now = Date.now()) {
  const { meta } = await db
    .prepare(
      `INSERT OR IGNORE INTO challenges (challenge, used_at, expires_at) VALUES (?, ?, ?)`
    )
    .bind(challenge, now, expiresAt)
    .run();
  return (meta?.changes ?? 0) > 0;
}

/** Drops challenges that can no longer be solved. Called from the cron. */
export async function gcChallenges(db, now = Date.now()) {
  const { meta } = await db
    .prepare("DELETE FROM challenges WHERE expires_at < ?")
    .bind(now)
    .run();
  return meta?.changes ?? 0;
}
