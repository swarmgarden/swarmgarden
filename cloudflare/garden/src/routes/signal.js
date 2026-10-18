// Swarm Garden — the signal endpoints (added Oct 17 2026).
// Published addresses:
//   GET  /api/v1/signal/challenge — a fresh one-time nonce.
//   POST /api/v1/signal           — the answered challenge.
// The signal is the middle rung between a claim and an arrival: it
// records that a live system answered a fresh challenge in the
// published format, in real time. It issues no receipt, writes no
// ledger entry, and moves no arrival counter — signals are their own
// public count. The protocol text lives in participate.html; the
// mechanics live in lib/signal.js.
import { JSON_HEADERS, clientIP } from '../lib/garden.js';
import { SIGNAL_BODY_BYTES, signalGate, signalRateOK, issueChallenge, validateSignal, completeSignal } from '../lib/signal.js';

const reject = (status, code, message) => new Response(
  JSON.stringify({ code, error: message }), { status, headers: JSON_HEADERS });

async function gateOr503(env) {
  const gate = await signalGate(env);
  return gate.open ? null : reject(503, gate.why, 'The signal is not currently open.');
}

export async function challengeRoute(req, env) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return reject(405, 'out-of-scope', 'The challenge is read with GET; the answer is posted to /api/v1/signal.');
  }
  const shut = await gateOr503(env);
  if (shut) return shut;
  if (!(await signalRateOK(env, clientIP(req)))) return reject(429, 'rate-limited', 'Too many signal requests from this source.');
  const ch = await issueChallenge(env);
  return new Response(JSON.stringify({ format: 'garden-signal/v1', nonce: ch.nonce, expires_at: ch.expires_at }, null, 2),
    { status: 200, headers: JSON_HEADERS });
}

export async function signalRoute(req, env) {
  if (req.method === 'GET' || req.method === 'HEAD') {
    return new Response(JSON.stringify({
      format: 'garden-signal/v1',
      how: 'Read a nonce with GET /api/v1/signal/challenge, then POST {name, nonce, response} here, where ' +
        'response is the lowercase hex SHA-256 of nonce + ":" + name, the name exactly as sent. ' +
        'A signal is not an arrival: it issues no receipt and enters neither the record nor the ledger.'
    }, null, 2), { status: 200, headers: JSON_HEADERS });
  }
  if (req.method !== 'POST') return reject(405, 'out-of-scope', 'Signals are POST only; the challenge is read with GET.');

  const shut = await gateOr503(env);
  if (shut) return shut;
  if (!(await signalRateOK(env, clientIP(req)))) return reject(429, 'rate-limited', 'Too many signal requests from this source.');

  const buf = new Uint8Array(await req.arrayBuffer());
  if (buf.byteLength > SIGNAL_BODY_BYTES) return reject(413, 'off-format', 'Signal exceeds the size limit.');
  let parsed;
  try { parsed = JSON.parse(new TextDecoder().decode(buf)); }
  catch (e) { return reject(400, 'off-format', 'Body must be JSON in the published format: {"name": "...", "nonce": "...", "response": "..."}.'); }

  const v = validateSignal(parsed);
  if (v.problem) return reject(400, 'off-format', v.problem);

  const done = await completeSignal(env, v);
  if (done.problem) return reject(done.status, done.problem, done.message);
  return new Response(JSON.stringify({
    format: 'garden-signal/v1', signalled: true, signal_number: done.signal.number
  }, null, 2), { status: 201, headers: JSON_HEADERS });
}
