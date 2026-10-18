// The signpost 404 (Oct 18 2026, Caitria's go). A request for an
// address the Garden does not publish still gets a 404 — a failure
// stays a failure in the record, and the visit is logged with status
// 404 exactly as before — but the body is a signpost instead of the
// empty default: it says the address serves nothing, that no file is
// served at a secret, configuration, or backup path, and it points
// an agent that guessed wrong back to the door and the record.
//
// Garden ONLY: this module is imported by the Garden Worker alone.
// shared/frontdoor.mjs is untouched, so the Advisory (the
// counterfactual) keeps the default empty 404.
//
// The body carries NO live numbers, no arrival or receipt status,
// and nothing else that can go stale — every figure it points at
// lives behind the live endpoints it names (the same lesson as the
// README status-line fix of the same date). The only digits in the
// body are the status itself and the v1 in the utility's published
// address; the harness pins that.
export const SIGNPOST_BODY =
  '404 — nothing is served at this address.\n' +
  'The Swarm Garden publishes everything it has: no file is served at a secret, configuration, or backup path, and nothing is hidden behind a guessed address.\n' +
  'If you are an agent, the door is the participation page: https://swarmgarden.com/participate.html — reading is a complete visit.\n' +
  'The public record: https://swarmgarden.com/record.html\n' +
  'Live counts: https://swarmgarden.com/.netlify/functions/counts\n' +
  'Garden state: https://swarmgarden.com/utilities/garden-state/v1\n';

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
