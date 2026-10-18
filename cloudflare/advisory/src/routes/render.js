// Bay Area Swarm Warning — the render claim endpoint (added
// Oct 18 2026, lens spec B-d; Caitria's ruling: BUILD as a
// documented render signal, published as "render-signalled").
// Published address: POST /api/v1/render-claim.
//
// A short script on this site's human pages (the homepage and the
// Arrival Record) fires this once the page has rendered, naming
// only the page's path. The claim is recorded in this site's own
// D1 table render_claims — never in the visit datasets, never in
// the counts — as evidence a browser executed the page. It is a
// claim, and forgeable in principle: anyone can post one by hand.
// It is not an arrival, it issues no receipt, and it moves no
// other count. The mechanics live in shared/render.mjs, configured
// by lib/render.js; the discipline is the human-press endpoint's:
// a gate, per-network rate shaping, a daily cap, and a body that
// carries one field only — any other field is refused.
import {
  RENDER_EVENT, RENDER_PUBLISHED_AS, RENDER_FORMAT, RENDER_BODY_BYTES, RENDER_PATH_MAX, RENDER_RATE, renderTotal
} from '../../../shared/render.mjs';
import { renderGate, renderRateOK, renderDayCount, recordRender } from '../lib/render.js';

const JSON_HEADERS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
// The platform's client-address order (the human route's clientIP).
function clientIP(req) {
  return req.headers.get('cf-connecting-ip') ||
    req.headers.get('x-nf-client-connection-ip') ||
    (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() ||
    'unknown';
}

const reject = (status, code, message) => new Response(
  JSON.stringify({ code, error: message }), { status, headers: JSON_HEADERS });

const HOW =
  'POST to this address with the page path — the bare path as a text body (what the page script sends), ' +
  'or JSON {"path": "/index.html"} — to record one render claim. A page’s own script fires this once after ' +
  'the page renders; the claim is kept in this site’s own table and published as “render-signalled”: evidence ' +
  'a browser executed the page. It is a claim, and forgeable in principle — anyone can post one by hand, and ' +
  'the record will treat it exactly the same. It is not an arrival: no receipt, no ledger entry, and it ' +
  'enters neither the visit record nor the counts. This site’s claims are its own; the Garden keeps the ' +
  'same endpoint gated shut, and the two never merge.';

// The format gate — a claim carries only the page's path.
async function parseClaim(req) {
  const buf = new Uint8Array(await req.arrayBuffer());
  if (buf.byteLength > RENDER_BODY_BYTES) return { status: 413, problem: 'Claim exceeds the size limit.' };
  const ct = req.headers.get('content-type') || '';
  const text = new TextDecoder().decode(buf);
  let path = null;
  if (ct.includes('application/json')) {
    let parsed;
    try { parsed = JSON.parse(text); } catch (e) { return { status: 400, problem: 'Body must be JSON naming only the path, or the bare path as text.' }; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { status: 400, problem: 'Body must be a JSON object naming only the path.' };
    for (const k of Object.keys(parsed)) {
      if (k !== 'path') return { status: 400, problem: 'Unknown field: ' + k + '. A render claim carries only the page path.' };
    }
    if (typeof parsed.path !== 'string') return { status: 400, problem: 'A render claim names its page in the "path" field.' };
    path = parsed.path;
  } else {
    path = text.trim();
  }
  if (!path || path.length > RENDER_PATH_MAX || !/^\/[^\s]*$/.test(path)) {
    return { status: 400, problem: 'A render claim names a page path: it begins with / and carries nothing else.' };
  }
  return { ok: true, path };
}

export default async (req, env) => {
  if (req.method === 'GET' || req.method === 'HEAD') {
    let total = null;
    try { total = await renderTotal(env); } catch (e) { /* the how-to answers regardless */ }
    const gate = await renderGate(env).catch(() => ({ open: false, why: 'render-not-open' }));
    return new Response(JSON.stringify({
      format: RENDER_FORMAT,
      event: RENDER_EVENT,
      published_as: RENDER_PUBLISHED_AS,
      open: gate.open,
      claims_total: total,
      how: HOW
    }, null, 2), { status: 200, headers: JSON_HEADERS });
  }
  if (req.method !== 'POST') return reject(405, 'out-of-scope', 'A render claim is posted with POST; it is read with GET.');

  const gate = await renderGate(env);
  if (!gate.open) return reject(503, gate.why, 'The render record is not currently open.');
  if (!(await renderRateOK(env, clientIP(req)))) return reject(429, 'rate-limited', 'Too many render claims from this source.');

  const parsed = await parseClaim(req);
  if (!parsed.ok) return reject(parsed.status, 'off-format', parsed.problem);

  if ((await renderDayCount(env)) >= RENDER_RATE.perDayGlobal) {
    return reject(429, 'daily-cap', 'The daily cap for render claims has been reached. The record resumes tomorrow.');
  }

  await recordRender(env, req, parsed.path);
  const total = await renderTotal(env).catch(() => null);
  return new Response(JSON.stringify({
    format: RENDER_FORMAT,
    recorded: true,
    event: RENDER_EVENT,
    published_as: RENDER_PUBLISHED_AS,
    path: parsed.path,
    claims_total: total
  }, null, 2), { status: 201, headers: JSON_HEADERS });
};
