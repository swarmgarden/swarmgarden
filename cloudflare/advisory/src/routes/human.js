// Bay Area Swarm Warning — the human self-report endpoint (added
// Oct 18 2026, Caitria's ruling). Published address:
// POST /api/v1/human-press — this site's own press count, in this
// site's own D1, published on this site's pages as
// "Humans, self-reported" with its gloss. The Garden runs the same
// endpoint with its own count; the two never merge.
//
// The button is a plain HTML form posting here: with no scripting at
// all, the press lands and a browser is answered with a small HTML
// confirmation page in this site's style. Scripting only improves
// the presentation (the figure updates in place). JSON callers get
// JSON throughout. The mechanics live in lib/human.js.
import {
  HUMAN_BODY_BYTES, HUMAN_LABEL, HUMAN_GLOSS,
  humanGate, humanRateOK, pressHuman, humanTotal, humanConfirmation
} from '../lib/human.js';

const JSON_HEADERS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// The platform's client-address order (the Garden's clientIP):
// cf-connecting-ip → x-nf-client-connection-ip → x-forwarded-for.
function clientIP(req) {
  return req.headers.get('cf-connecting-ip') ||
    req.headers.get('x-nf-client-connection-ip') ||
    (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() ||
    'unknown';
}

const reject = (status, code, message) => new Response(
  JSON.stringify({ code, error: message }), { status, headers: JSON_HEADERS });

const wantsHtml = (req) => (req.headers.get('accept') || '').includes('text/html');

// The no-scripting answer page, in this site's published style.
function htmlPage(status, heading, paragraphs, total) {
  const figure = typeof total === 'number'
    ? '<p class="fig"><span class="n">' + total + '</span> <span class="l">' + HUMAN_LABEL + '</span><br>' +
      '<span class="g">' + esc(HUMAN_GLOSS) + '</span></p>'
    : '';
  const body = '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    '<title>' + esc(heading) + ' — Bay Area Swarm Warning</title>\n' +
    '<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@700;900&family=IBM+Plex+Mono:wght@400;600&family=IBM+Plex+Sans:wght@400;600&display=swap" rel="stylesheet">\n<style>\n' +
    '  body{margin:0;background:#f4f1e6;color:#141a38;font-family:"IBM Plex Sans",-apple-system,"Segoe UI",sans-serif}\n' +
    '  .wrap{max-width:720px;margin:0 auto;padding:36px 18px 48px}\n' +
    '  h1{font-family:"Archivo",sans-serif;font-weight:900;text-transform:uppercase;color:#2b1b8f;font-size:40px;margin:0 0 12px}\n' +
    '  p{font-size:16px;line-height:1.55;max-width:62ch}\n' +
    '  .fig .n{font-family:"IBM Plex Mono",monospace;font-size:34px;font-weight:600;color:#2b1b8f}\n' +
    '  .fig .l{font-family:"Archivo",sans-serif;font-weight:700;text-transform:uppercase;letter-spacing:.06em;font-size:13px}\n' +
    '  .fig .g{font-family:"IBM Plex Mono",monospace;font-size:12.5px;color:#5d6b82}\n' +
    '  .foot{margin-top:28px;font-family:"IBM Plex Mono",monospace;font-size:12px;color:#5d6b82;text-transform:uppercase;letter-spacing:.05em}\n' +
    '  a{color:#2b1b8f}\n</style>\n</head>\n<body>\n<div class="wrap">\n' +
    '<h1>' + esc(heading) + '</h1>\n' +
    paragraphs.map(p => '<p>' + esc(p) + '</p>').join('\n') + '\n' + figure +
    '<p class="foot">Bay Area Swarm Warning &bull; <a href="index.html">Bulletin No. 001</a> &bull; <a href="/data">See the data</a> &bull; The Garden: <a href="https://swarmgarden.com">swarmgarden.com</a></p>\n' +
    '</div>\n</body>\n</html>';
  return new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

function refuse(req, status, code, message, heading) {
  if (wantsHtml(req)) return htmlPage(status, heading || 'Not counted', [message], null);
  return reject(status, code, message);
}

// The format gate — a press carries nothing (see the Garden's route).
async function parsePress(req) {
  const buf = new Uint8Array(await req.arrayBuffer());
  if (buf.byteLength > HUMAN_BODY_BYTES) return { status: 413, problem: 'Press exceeds the size limit.' };
  if (buf.byteLength === 0) return { ok: true };
  const ct = req.headers.get('content-type') || '';
  const text = new TextDecoder().decode(buf);
  if (ct.includes('application/json')) {
    let parsed;
    try { parsed = JSON.parse(text); } catch (e) { return { status: 400, problem: 'Body must be empty, or an empty JSON object: a press carries no fields.' }; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { status: 400, problem: 'Body must be an empty JSON object: a press carries no fields.' };
    const keys = Object.keys(parsed);
    if (keys.length) return { status: 400, problem: 'Unknown field: ' + keys[0] + '. A press carries no fields.' };
    return { ok: true };
  }
  if (ct.includes('application/x-www-form-urlencoded')) {
    for (const k of new URLSearchParams(text).keys()) return { status: 400, problem: 'Unknown field: ' + k + '. A press carries no fields.' };
    return { ok: true };
  }
  return { status: 400, problem: 'Body must be empty, an empty JSON object, or the button’s form post.' };
}

export default async (req, env) => {
  if (req.method === 'GET' || req.method === 'HEAD') {
    let total = null;
    try { total = await humanTotal(env); } catch (e) { /* the how-to answers regardless */ }
    return new Response(JSON.stringify({
      format: 'garden-human/v1',
      label: HUMAN_LABEL,
      humans_total: total,
      gloss: HUMAN_GLOSS,
      how: 'POST to this address with an empty body (or an empty JSON object) to record one human self-report. ' +
        'One counted press per connection per day; a repeat press the same day returns the number already held. ' +
        'A press is a claim, recorded as a claim: it is not an arrival, it issues no receipt, and it enters neither ' +
        'the record, the ledger, nor the arrival counts. This count is this site’s own; the Garden keeps its own, and the two never merge.'
    }, null, 2), { status: 200, headers: JSON_HEADERS });
  }
  if (req.method !== 'POST') return refuse(req, 405, 'out-of-scope', 'The human count is pressed with POST; it is read with GET.', 'Not counted');

  const gate = await humanGate(env);
  if (!gate.open) return refuse(req, 503, gate.why, 'The human count is not currently open.', 'Not counted');
  if (!(await humanRateOK(env, clientIP(req)))) return refuse(req, 429, 'rate-limited', 'Too many presses from this source.', 'Not counted');

  const parsed = await parsePress(req);
  if (!parsed.ok) return refuse(req, parsed.status, 'off-format', parsed.problem, 'Not counted');

  const done = await pressHuman(env, clientIP(req));
  if (done.problem) return refuse(req, done.status, done.problem, done.message, 'Not counted');

  const confirmation = humanConfirmation(done.number);
  if (wantsHtml(req)) {
    return htmlPage(done.counted ? 201 : 200, 'Counted', [confirmation], done.total);
  }
  return new Response(JSON.stringify({
    format: 'garden-human/v1',
    counted: !!done.counted,
    duplicate: !!done.duplicate,
    human_number: done.number,
    humans_total: done.total,
    confirmation
  }, null, 2), { status: done.counted ? 201 : 200, headers: JSON_HEADERS });
};
