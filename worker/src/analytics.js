// Umami, proxied through this origin.
//
// Two problems the standard tag has in production, and the proxy fixes both:
//
//   Blockers. uBlock, AdGuard and Brave filter umami.is by name, so a real
//   share of visitors is never counted and nothing looks broken.
//
//   Two hosts. The script LOADS from cloud.umami.is but SENDS to
//   gateway.umami.is. Anything that allows only the first, a CSP among them,
//   yields a dashboard at zero while the script loads perfectly.
//
// Served from /m, with no "umami" or "script.js" anywhere in the path, both
// requests become same-origin. The house pattern does this in PHP on OVH; here
// the Worker is already the edge, so it does it directly.
//
// The two things the gateway cannot work out for itself once we are in the
// middle are the visitor's address and their user agent, so both are passed
// on: without them every visit geolocates to the Worker and reads as one
// person. The address is forwarded, never stored; this Worker keeps only
// salted hashes of its own (see hashIp in index.js).

const SCRIPT = "https://cloud.umami.is/script.js";
const GATEWAY = "https://gateway.umami.is/api/send";

/**
 * Relays the tracker itself, cached for a day at the edge.
 *
 * Whatever goes wrong upstream, this answers 200 with valid JavaScript. A
 * tracker that will not load must never take the page down with it, and a
 * script tag that 500s is a console error on every visit.
 */
export async function proxyScript() {
  try {
    const upstream = await fetch(SCRIPT);
    if (!upstream.ok) throw new Error(String(upstream.status));
    return new Response(upstream.body, {
      status: 200,
      headers: {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "public, max-age=86400",
      },
    });
  } catch {
    return new Response("/* analytics unavailable */", {
      status: 200,
      headers: {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "public, max-age=60",
      },
    });
  }
}

/**
 * The largest event Umami has any business sending.
 *
 * A real payload is a few hundred bytes: url, referrer, screen size, title.
 * The cap is here because this endpoint is unauthenticated by necessity - a
 * tracker cannot hold a secret that ships in the page - so the only honest
 * question is how much a stranger may push through it, and "as much as they
 * like" was the previous answer.
 */
const MAX_EVENT_BYTES = 8 * 1024;

/**
 * Relays one collected event, carrying the real caller's identity forward.
 *
 * Refuses anything a browser reports as coming from another site. That is a
 * narrower claim than it sounds: a request with no Origin at all passes, as it
 * does on /api/submit, because curl is not a browser being used against its
 * owner. It cannot be real authentication either - the website id ships in the
 * page and the endpoint has to answer a browser holding nothing. What it does
 * is turn "any page on the web may write to the owner's analytics" into "anyone
 * willing to forge requests may", and stop the drive-by case.
 *
 * The address is still forwarded and still not stored: cf-connecting-ip cannot
 * be forged (Cloudflare refuses a request carrying it), so what reaches Umami
 * is the visitor's own, which is the entire point of proxying rather than
 * letting every visit geolocate to the Worker.
 */
export async function proxySend(request, sameOrigin) {
  if (!sameOrigin) return new Response("", { status: 403 });

  const body = await request.text();
  if (body.length > MAX_EVENT_BYTES) return new Response("", { status: 413 });

  const ip = request.headers.get("cf-connecting-ip") ?? "";
  try {
    const upstream = await fetch(GATEWAY, {
      method: "POST",
      headers: {
        // Pinned rather than relayed. The old code echoed whatever
        // content-type the caller sent, which let a stranger choose how the
        // gateway parsed a body we had not looked at.
        "content-type": "application/json",
        "user-agent": request.headers.get("user-agent") ?? "",
        "x-forwarded-for": ip,
        "x-real-ip": ip,
      },
      body,
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { "content-type": upstream.headers.get("content-type") ?? "text/plain" },
    });
  } catch {
    // A dropped count is not worth an error in the visitor's console.
    return new Response("", { status: 204 });
  }
}
