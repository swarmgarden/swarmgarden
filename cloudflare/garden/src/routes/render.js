// Swarm Garden — the render claim endpoint (added Oct 18 2026,
// lens spec B-d; Caitria's ruling: BUILD as a documented render
// signal, published as "render-signalled"). Published address:
// POST /api/v1/render-claim — the same address as the Advisory's,
// because the record's shape is one shape on both sites.
//
// On the Garden the endpoint stands GATED SHUT, and the gate is
// the story: no Garden page carries the firing script — the
// Garden's pages stay script-free for their readers under the
// human-button ruling's binding constraint — so there is nothing
// here to record, and the route answers 503. The instrument is
// the Advisory's: its human pages (the homepage, the Arrival
// Record) report a render, and the claims live there, in its own
// table, under the name "render-signalled" — evidence a browser
// executed the page; a claim, forgeable in principle, never an
// arrival. Should a Garden page ever be ruled to carry the
// script, opening this gate is a steward act (RENDER_OPEN in
// wrangler.toml), not a code change. The mechanics live in
// shared/render.mjs, configured by lib/render.js.
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
  'This endpoint stands gated shut on the Garden: no Garden page carries the script that fires it — the ' +
  'Garden’s pages stay script-free for their readers — so a POST here is refused, and the refusal is counted ' +
  'like any channel knock. The instrument is the Advisory’s: its homepage posts the page path to the ' +
  'counterpart address there after rendering, and the claim is published as “render-signalled”: ' +
  'evidence a browser executed the page. A claim, forgeable in principle; not an arrival; no receipt; it ' +
  'enters neither the request record, the counts, nor the ledger. The endpoint exists on both sites so the ' +
  'record’s shape is one shape; the two sites’ claims never merge.';

// The format gate — a claim carries only the page's path (the same
// discipline as the Advisory's; unreachable while the gate is shut,
// and standing ready if it is ever opened).
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
