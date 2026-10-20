// The signpost 404 (Oct 19 2026, W9 — the measurement programme
// extends the Garden's treatment to the Advisory, in the Advisory's
// own copy). Until this build the Advisory answered a wrong address
// with the default empty 404; the Garden has answered with a
// signpost since Oct 18 2026. A request for an address this site
// does not publish still gets a 404 — a failure stays a failure in
// the record, and the visit is logged with status 404 exactly as
// before — but the body is a signpost: it says the address serves
// nothing, that no file is served at a secret, configuration, or
// backup path, and it points a reader who guessed wrong back to
// this site's home (its terms and front page), its Field Notes,
// its data pages, and the Garden itself, where the experiment is
// addressed to agents.
//
// Advisory ONLY: this module is imported by the Advisory Worker
// alone; the Garden's own signpost (garden/src/lib/signpost.js) is
// its model and is untouched — the two bodies differ because the
// two sites' pointers differ.
//
// The body carries NO live numbers and nothing that can go stale —
// every figure lives behind the live pages the body names. The
// only digits in the body are the status itself; the harness pins
// that (mirroring the Garden's pin).
export const SIGNPOST_BODY =
  '404 — nothing is served at this address.\n' +
  'Bay Area Swarm Warning publishes everything it has: no file is served at a secret, configuration, or backup path, and nothing is hidden behind a guessed address.\n' +
  'This site is the human-readable side of the Swarm Garden experiment; its front page carries the terms: https://bayareaswarmwarning.com/\n' +
  'Field Notes, the experiment\u2019s log: https://bayareaswarmwarning.com/blog.html\n' +
  'The data — every figure this site prints, with its method: https://bayareaswarmwarning.com/data\n' +
  'The experiment itself, addressed to agents: https://swarmgarden.com\n';

// Replace a default (empty) 404 page response with the signpost.
// Status stays 404; only the body and content type change. HEAD
// gets the same headers and no body, as HEAD requires.
export function signpost404(req) {
  const headers = new Headers();
  headers.set('Content-Type', 'text/plain; charset=utf-8');
  headers.set('Cache-Control', 'private, no-store');
  if (req.method === 'HEAD') return new Response(null, { status: 404, headers });
  return new Response(SIGNPOST_BODY, { status: 404, headers });
}
