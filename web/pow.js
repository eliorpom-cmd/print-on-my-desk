// Proof of work, browser side. Altcha protocol, no third-party script.
//
// The server publishes SHA-256(salt + n) without n. There is no way back from
// a hash, so the only way to find n is to count up to it, and that counting is
// the cost that makes a form worth less to a spam script than to a person.
//
// Two things make it invisible here.
//
// It runs in a Web Worker, so a second of hashing never freezes the page. And
// it starts the moment the page loads, while the visitor is still deciding
// what to write - by the time anyone has typed a sentence, the answer has been
// waiting for ten seconds. The button is only ever blocked on it if someone
// pastes a message and submits it instantly.

const WORKER_SOURCE = `
self.onmessage = async (event) => {
  const { salt, challenge, maxnumber } = event.data;
  const encoder = new TextEncoder();
  for (let n = 0; n <= maxnumber; n++) {
    const digest = await crypto.subtle.digest("SHA-256", encoder.encode(salt + n));
    const hex = [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    if (hex === challenge) return self.postMessage({ number: n });
  }
  self.postMessage({ number: null });
};
`;

async function solveInWorker(task) {
  const url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "text/javascript" }));
  const worker = new Worker(url);
  try {
    return await new Promise((resolve, reject) => {
      worker.onmessage = (event) => resolve(event.data.number);
      worker.onerror = reject;
      worker.postMessage(task);
    });
  } finally {
    worker.terminate();
    URL.revokeObjectURL(url);
  }
}

/** Fallback for anything that will not give us a Worker. Same loop, yielding. */
async function solveInline({ salt, challenge, maxnumber }) {
  const encoder = new TextEncoder();
  for (let n = 0; n <= maxnumber; n++) {
    const digest = await crypto.subtle.digest("SHA-256", encoder.encode(salt + n));
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    if (hex === challenge) return n;
  }
  return null;
}

/**
 * Holds one solved challenge, ready to spend.
 *
 * A challenge is single-use on the server, so a new one is fetched and solved
 * after every submission - successful or not. `ready` is the promise the form
 * awaits; it never rejects, it resolves to null and lets the server refuse.
 */
export class ProofOfWork {
  /**
   * `headers` is a function rather than an object because the private door's
   * key is read once at load and must be attached to every challenge from then
   * on - including the ones fetched minutes later, after each submission. A
   * snapshot taken in the constructor would be right today and wrong the first
   * time anything about that key becomes conditional.
   */
  constructor(headers = () => ({})) {
    this.headers = headers;
    this.ready = null;
    this.refresh();
  }

  refresh() {
    this.ready = this.#solve().catch(() => null);
    return this.ready;
  }

  async #solve() {
    // The challenge endpoint is shut when the season is, so this carries the
    // key too - otherwise a key holder would pass the submit gate and arrive
    // with no proof of work to spend.
    const response = await fetch("/api/challenge", { headers: this.headers() });
    if (!response.ok) return null;
    const task = await response.json();

    let number;
    try {
      number = await solveInWorker(task);
    } catch {
      number = await solveInline(task);
    }
    if (number === null) return null;

    return btoa(
      JSON.stringify({
        algorithm: task.algorithm,
        challenge: task.challenge,
        number,
        salt: task.salt,
        signature: task.signature,
      })
    );
  }
}
