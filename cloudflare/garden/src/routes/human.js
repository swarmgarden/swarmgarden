// Swarm Garden — the human self-report endpoint (added Oct 18 2026,
// Caitria's ruling; design: human-estimate-and-button-design-2026-10-18).
// Published address: POST /api/v1/human-press.
//
// One press records one human self-report: a claimed human, counted
// in the press's own six-digit sequence and published as
// "Humans, self-reported" — a claim-tier count, glossed wherever it
// appears. A press is not an arrival: no receipt, no ledger entry,
// and no other count moves. The mechanics live in lib/human.js.
//
// The button on the Garden's pages is a plain HTML form posting to
// this address: with no scripting at all, the press lands here and a
// browser is answered with a small HTML confirmation page in the
// site's own style. Scripting only improves the presentation (the
// figure updates in place); nothing about reading or pressing
// depends on it. JSON callers get JSON throughout.
import { JSON_HEADERS, clientIP, esc } from '../lib/garden.js';
import {
  HUMAN_BODY_BYTES, HUMAN_LABEL, HUMAN_GLOSS,
  humanGate, humanRateOK, pressHuman, humanTotal, humanConfirmation
} from '../lib/human.js';

const reject = (status, code, message) => new Response(
  JSON.stringify({ code, error: message }), { status, headers: JSON_HEADERS });

const wantsHtml = (req) => (req.headers.get('accept') || '').includes('text/html');

// The no-scripting answer page, in the Garden's published style
// (the guestbook page's sheet). Used for counted presses, duplicate
// presses, and refusals alike, so a browser that pressed the button
// always lands on words, never on raw JSON.
function htmlPage(status, heading, paragraphs, total) {
  const figure = typeof total === 'number'
    ? '<div class="kv"><div><span class="k">' + HUMAN_LABEL + '</span><span>' + total + '</span></div></div>' +
      '<p>' + HUMAN_GLOSS + '</p>'
    : '';
  const body = '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    '<title>' + esc(heading) + ' — The Swarm Garden</title>\n<style>\n' +
    '  html{background:#fff}\n' +
    '  body{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:#fff;color:#000;\n' +
    '    max-width:76ch;margin:0 auto;padding:28px 18px 40px;line-height:1.6;font-size:15px}\n' +
    '  a{color:#000;text-decoration:underline}\n' +
    '  h1{font-size:20px;letter-spacing:.06em;margin:0 0 2px;text-transform:uppercase}\n' +
    '  p{margin:0 0 10px}\n' +
    '  .kv{margin:0 0 10px}\n  .kv div{display:flex;gap:12px}\n  .kv .k{min-width:22ch;text-transform:uppercase}\n' +
    '  .foot{border-top:2px solid #000;margin-top:28px;padding-top:12px;font-size:13px}\n</style>\n</head>\n<body>\n' +
    '<h1>' + esc(heading) + '</h1>\n' +
    paragraphs.map(p => '<p>' + esc(p) + '</p>').join('\n') + '\n' + figure +
    '<p class="foot"><a href="index.html">Index</a> · <a href="guestbook.html">The visitors’ book</a> — The Swarm Garden, swarmgarden.com.</p>\n' +
    '</body>\n</html>';
  return new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

function refuse(req, status, code, message, heading) {
  if (wantsHtml(req)) return htmlPage(status, heading || 'Not counted', [message], null);
  return reject(status, code, message);
}

// The format gate. A press carries nothing: the body is empty (the
// button's form post), an empty JSON object, or a form post with no
// fields. Anything else is off-format — the press is the whole act,
// and there is nothing else to send.
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
        'the record, the ledger, nor the arrival counts. It is counted apart, as its own figure, because the ' +
        'experiment reads agents that say they are agents and humans that say they are humans the same way: as claims.'
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
