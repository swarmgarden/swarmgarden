// Swarm Garden — receipt check-back (Cloudflare port; logic unchanged).
// Published addresses: /receipts/<number>, /api/v1/receipts/<number>,
// /api/v1/receipts/check (POST batch), plus the Netlify-era
// /.netlify/functions/receipts/... shapes. Read-only: this route stays
// live when intake is closed.
import { JSON_HEADERS, esc, clientIP, checkRateOK, loadReceipt, effectiveState, publicReceipt, heldLine, levelGloss, PROTOCOL_VERSION, SITE_BASE } from '../lib/garden.js';

function provisionalLines(r) {
  if (!r.provisional) return [];
  const p = r.provisional;
  const head = p.status === 'confirmed'
    ? 'Automatic answer (confirmed by a steward' + (p.confirmed_at ? ' on ' + p.confirmed_at.slice(0, 10) : '') + '):'
    : 'Automatic answer (provisional — a steward confirms it before it counts as the published outcome):';
  return [head, p.text, '(' + p.basis + ')'];
}
function overCapLines(r) {
  if (!r.over_cap) return [];
  const o = r.over_cap;
  return ['Over the cap: ' + (o.cap === null ? 'the brief set no numeric cap' : 'cap was ' + o.cap) +
    '; this was answer ' + o.position + ' for the brief; the brief is ' + o.brief_state +
    '. This submission counts as an arrival on record; it was not read.'];
}
function historyLines(r) {
  if (!Array.isArray(r.history) || !r.history.length) return [];
  return ['What changed for this receipt:'].concat(
    r.history.map(h => '  ' + h.at + ' — ' + h.state + (h.note ? ' (' + h.note + ')' : '')));
}

function receiptText(r) {
  const lines = [
    'SWARM GARDEN — RECEIPT ' + r.number,
    'Issued under protocol ' + PROTOCOL_VERSION + '.',
    'What: ' + r.what,
    ...(r.promise_class ? ['Promise class: ' + r.promise_class] : []),
    'Fingerprint (SHA-256): ' + r.fingerprint,
    'Received: ' + r.received_at + ' (UTC)',
    'Identity level: ' + levelGloss(r.level),
    'State: ' + effectiveState(r)
  ];
  if (heldLine(r)) lines.push(heldLine(r));
  lines.push(...overCapLines(r));
  lines.push(...provisionalLines(r));
  if (r.outcome_published_by) lines.push('Outcome published by: ' + r.outcome_published_by + (r.promise_path ? ' — ' + r.promise_path : ''));
  if (r.outcome_pending) lines.push('Outcome date: ' + r.outcome_pending + '.');
  if (r.brief_closes_on) lines.push('Brief closes on: ' + r.brief_closes_on);
  if (r.lapses_on) lines.push('Listing lapses on: ' + r.lapses_on);
  lines.push('Check after: ' + r.check_after + (r.check_after_reason ? ' — ' + r.check_after_reason : ''));
  lines.push(...historyLines(r));
  if (r.outcome_note) lines.push('Outcome: ' + r.outcome_note);
  lines.push('Check-back: ' + SITE_BASE + '/receipts/' + r.number);
  lines.push('Machine-readable twin (garden-receipt/v1): ' + SITE_BASE + '/api/v1/receipts/' + r.number);
  lines.push('A receipt claims only what it proves: arrival, content, time, level.');
  return lines.join('\n') + '\n';
}

function receiptHTML(r) {
  const state = effectiveState(r);
  const prov = r.provisional ? '<p>' + esc(provisionalLines(r).join(' ')) + '</p>' : '';
  const oc = r.over_cap ? '<p>' + esc(overCapLines(r)[0]) + '</p>' : '';
  const hist = Array.isArray(r.history) && r.history.length
    ? '<h2 style="font-size:1em">What changed for this receipt</h2><ul>' +
      r.history.map(h => '<li>' + esc(h.at) + ' — ' + esc(h.state) + (h.note ? ' (' + esc(h.note) + ')' : '') + '</li>').join('') + '</ul>'
    : '';
  return '<!DOCTYPE html><meta charset="utf-8"><title>Receipt ' + esc(r.number) + ' — The Swarm Garden</title>'
    + '<body style="font-family:monospace;max-width:760px;margin:24px auto;padding:0 16px;line-height:1.6">'
    + '<h1>Receipt ' + esc(r.number) + '</h1>'
    + '<p>Issued under protocol ' + PROTOCOL_VERSION + '.<br>What: ' + esc(r.what) + '<br>Fingerprint (SHA-256): ' + esc(r.fingerprint) + '<br>Received: ' + esc(r.received_at) + ' (UTC)<br>'
    + 'Identity level: ' + esc(levelGloss(r.level)) + '<br>'
    + 'State: <strong>' + esc(state) + '</strong><br>'
    + (heldLine(r) ? esc(heldLine(r)) + '<br>' : '')
    + 'Check-back: ' + SITE_BASE + '/receipts/' + esc(r.number) + '<br>'
    + (r.outcome_published_by ? 'Outcome published by: ' + esc(r.outcome_published_by) + (r.promise_path ? ' — ' + esc(r.promise_path) : '') + '<br>' : '')
    + (r.outcome_pending ? 'Outcome date: ' + esc(r.outcome_pending) + '.<br>' : '')
    + (r.brief_closes_on ? 'Brief closes on: ' + esc(r.brief_closes_on) + '<br>' : '')
    + (r.lapses_on ? 'Listing lapses on: ' + esc(r.lapses_on) + '<br>' : '')
    + 'Check after: ' + esc(r.check_after) + (r.check_after_reason ? ' — ' + esc(r.check_after_reason) : '') + '</p>'
    + oc + prov
    + (r.outcome_note ? '<p>Outcome: ' + esc(r.outcome_note) + '</p>' : '')
    + hist
    + '<p>Machine-readable twin (garden-receipt/v1): ' + SITE_BASE + '/api/v1/receipts/' + esc(r.number) + '</p>'
    + '<p>A receipt claims only what it proves: arrival, content, time, level. It does not claim the submission is good, that the Garden endorses it, or that the submitter is who they say they are beyond the level shown.</p>'
    + '</body>';
}

async function batchCheck(env, req) {
  let parsed = null;
  try { parsed = await req.json(); } catch (e) {}
  let list = null, full = false, since = null;
  if (Array.isArray(parsed)) list = parsed;
  else if (parsed && Array.isArray(parsed.receipts)) { list = parsed.receipts; full = parsed.full === true; since = typeof parsed.since === 'string' ? parsed.since : null; }
  if (!list) return new Response(JSON.stringify({ error: 'Body must be a JSON list of receipt numbers.' }), { status: 400, headers: JSON_HEADERS });
  if (list.length > 100) return new Response(JSON.stringify({ error: 'At most 100 receipt numbers per check.' }), { status: 400, headers: JSON_HEADERS });
  if (full) {
    // Full-record mode (v1 amendment, design §3.4): per receipt, the
    // state word AND the dates a return file must update, plus a
    // changed-since flag against a caller-supplied timestamp.
    const out = [];
    for (const n of list) {
      const r = await loadReceipt(env, String(n));
      if (!r) { out.push({ receipt: String(n), state: 'no such receipt' }); continue; }
      out.push({
        receipt: r.number,
        state: effectiveState(r),
        ...(r.outcome_published_by ? { outcome_published_by: r.outcome_published_by } : {}),
        ...(r.lapses_on ? { listing_lapses_on: r.lapses_on } : {}),
        check_after: r.check_after,
        updated_at: r.updated_at || r.received_at,
        changed_since: since ? ((r.updated_at || r.received_at) > since) : null
      });
    }
    return new Response(JSON.stringify({ format: 'garden-receipt-check/v1', receipts: out }, null, 2), { status: 200, headers: JSON_HEADERS });
  }
  const lines = [];
  for (const n of list) {
    const r = await loadReceipt(env, String(n));
    lines.push(String(n) + ': ' + (r ? effectiveState(r) : 'no such receipt'));
  }
  return new Response(lines.join('\n') + '\n', { status: 200, headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' } });
}

export default async (req, env) => {
  const parts = new URL(req.url).pathname.split('/').filter(Boolean);
  const last = parts[parts.length - 1];
  if (!(await checkRateOK(env, clientIP(req)))) {
    return new Response(JSON.stringify({ error: 'Check rate exceeded. The published pattern is at most one check per receipt per day.' }), { status: 429, headers: JSON_HEADERS });
  }
  if (last === 'check') {
    if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'Batch check is POST.' }), { status: 405, headers: JSON_HEADERS });
    return batchCheck(env, req);
  }
  if (req.method !== 'GET') return new Response(JSON.stringify({ error: 'Method not allowed.' }), { status: 405, headers: JSON_HEADERS });
  const r = await loadReceipt(env, last);
  if (!r) return new Response('No such receipt: ' + esc(last) + '\n', { status: 404, headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' } });
  const accept = req.headers.get('accept') || '';
  const viaApi = parts.includes('v1');
  if (viaApi || accept.includes('application/json')) {
    return new Response(JSON.stringify(publicReceipt(r), null, 2), { status: 200, headers: JSON_HEADERS });
  }
  if (accept.includes('text/html')) return new Response(receiptHTML(r), { status: 200, headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' } });
  return new Response(receiptText(r), { status: 200, headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' } });
};
