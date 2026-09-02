// The 404, served by the Worker because the Worker owns every path that is not
// a file on disk (see not_found_handling in wrangler.jsonc).
//
// It borrows the front page's stylesheet rather than carrying a second copy of
// the palette, so it cannot drift out of step with the site it belongs to.
//
// That is also why it declares no `color-scheme` of its own and preloads no
// fonts. Both used to be here and both were edition-specific: the meta said
// `light`, which is this deployment and not the open-source one, and the two
// preloads named font files the open-source edition does not ship - so its 404
// page asked the browser for two things that answered 404. The stylesheet
// already sets `color-scheme` on :root, and preloading a webfont on an error
// page was optimising the one page nobody waits on.

export const NOT_FOUND_PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Nothing here · Print on my desk</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/style.css">
<style nonce="__CSP_NONCE__">
  main { display: flex; flex-direction: column; justify-content: center; min-height: 70vh; }
  /* The slot, and nothing under it. The one page where no paper comes out. */
  .slot { height: 3px; background: var(--slot); margin-bottom: 2.5rem; }
  .code {
    font-family: var(--display); font-weight: 900; font-size: 40px;
    letter-spacing: 0.05em; line-height: 1; margin: 0 0 1rem;
  }
  .said { margin: 0 0 2rem; color: var(--mute); max-width: 30rem; }
  .back {
    align-self: flex-start; padding: 0.9rem 1.2rem;
    border: 1px solid var(--ink); background: var(--ink); color: var(--paper);
    font-family: var(--display); font-weight: 900; font-size: 16px;
    letter-spacing: 0.12em; text-decoration: none;
    transition: background-color 0.12s linear, color 0.12s linear;
  }
  .back:hover { background: var(--paper); color: var(--ink); }
</style>
</head>
<body>
<main>
  <div class="slot" aria-hidden="true"></div>
  <h1 class="code">404</h1>
  <p class="said">This address has nothing behind it. Nothing was printed, and nothing was lost.</p>
  <a class="back" href="/">Write a message</a>
</main>
</body>
</html>
`;
