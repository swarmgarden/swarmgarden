// Swarm Garden — live dashboard (Cloudflare port).
// Key-gated (?k= must match the STATS_KEY secret). Reads the visit
// records and the ledger/receipts (D1) and renders one auto-refreshing
// page. Behaviour labels are computed at query time over the stored
// records (shared/behaviour.mjs) — private working labels, never
// published claims. ?format=json returns the same aggregates as data.
// Port changes: visits come from the visit store (Analytics Engine or
// the D1 fallback) instead of a Blobs scan; every record is edge-written
// now, so the beacon column reads 0 by construction.
import { readRecentVisits } from '../../../shared/visits.mjs';
import { behaviourLabel, INTEREST } from '../../../shared/behaviour.mjs';
import { dbListLedger, dbListReceipts } from '../lib/db.js';

async function loadVisits(env) {
  const recs = await readRecentVisits(env, 1500); // newest first
  return recs.sort((a, b) => (a.t < b.t ? -1 : 1)); // ascending, as the Netlify dashboard read them
}

function aggregate(recs) {
  const byClass = {}, byDay = {}, byPath = {}, interest = {}, byPurpose = {}, byBehaviour = {}, byStatus = {};
  let edge = 0, beacon = 0;
  for (const r of recs) {
    byClass[r.cls] = (byClass[r.cls] || 0) + 1;
    if (r.purpose) byPurpose[r.purpose] = (byPurpose[r.purpose] || 0) + 1;
    const bl = behaviourLabel(r); byBehaviour[bl] = (byBehaviour[bl] || 0) + 1;
    if (Number.isInteger(r.status)) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    const d = (r.t || '').slice(0, 10); byDay[d] = (byDay[d] || 0) + 1;
    byPath[r.path] = (byPath[r.path] || 0) + 1;
    if (r.via === 'edge') edge++; else beacon++;
    if (INTEREST.some(s => (r.path || '').includes(s))) interest[r.path] = (interest[r.path] || 0) + 1;
  }
  const top = (obj, n) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n);
  return { total: recs.length, byClass, byPurpose, byBehaviour, byStatus, byDay, topPaths: top(byPath, 12), interest: top(interest, 12), edge, beacon, readDepth: Object.keys(byPath).length };
}

export default async (req, env) => {
  const KEY = env.STATS_KEY || '';
  const url = new URL(req.url);
  if (!KEY || url.searchParams.get('k') !== KEY) return new Response('Key required.', { status: 403, headers: { 'Content-Type': 'text/plain' } });
  let recs;
  try { recs = await loadVisits(env); }
  catch (e) { return new Response('Storage read failed. Visit records are also in the Worker logs (search VISIT).', { status: 200, headers: { 'Content-Type': 'text/plain' } }); }
  const agg = aggregate(recs);
  const entries = await dbListLedger(env.DB).catch(() => null);
  const receipts = await dbListReceipts(env.DB).catch(() => null);
  const arrivals = entries ? entries.filter(e => e.kind === 'arrival').length : null;

  if (url.searchParams.get('format') === 'json') {
    const lanes = {};
    if (receipts) for (const r of receipts) lanes[r.lane] = (lanes[r.lane] || 0) + 1;
    return new Response(JSON.stringify({ arrivals_on_record: arrivals, ...agg, submissions: receipts ? { total: receipts.length, by_lane: lanes } : null, recent: recs.slice(-50).reverse() }, null, 2), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  }

  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const list = (pairs) => pairs.map(([k, v]) => '<li>' + esc(k) + ': ' + v + '</li>').join('');
  let html = '<!DOCTYPE html><meta charset="utf-8"><meta http-equiv="refresh" content="60"><title>Swarm Garden — live dashboard</title>';
  html += '<body style="font-family:monospace;max-width:980px;margin:24px auto;padding:0 16px;line-height:1.5">';
  html += '<h2>Swarm Garden — live dashboard</h2>';
  html += '<p>Refreshed ' + esc(new Date().toISOString()) + ' (auto-refresh 60s). Arrivals on record: <strong>' + (arrivals === null ? 'ledger unavailable' : arrivals) + '</strong> — the record, from the ledger. Everything below is requests, not arrivals.</p>';
  html += '<h3>Requests — claimed class totals (' + agg.total + ' total; ' + agg.edge + ' via edge log, ' + agg.beacon + ' via legacy beacon)</h3><ul>' + list(Object.entries(agg.byClass)) + '</ul>';
  if (Object.keys(agg.byPurpose).length) html += '<h3>Agent-claimed, by purpose (per the announcing software\u2019s own documentation)</h3><ul>' + list(Object.entries(agg.byPurpose)) + '</ul>';
  html += '<h3>Behaviour labels (private working read; computed over held records)</h3><ul>' + list(Object.entries(agg.byBehaviour)) + '</ul>';
  if (Object.keys(agg.byStatus).length) html += '<h3>Response status totals (edge records)</h3><ul>' + list(Object.entries(agg.byStatus)) + '</ul>';
  html += '<h3>Agent-interest files</h3>' + (agg.interest.length ? '<ul>' + list(agg.interest) + '</ul>' : '<p>None yet.</p>');
  html += '<h3>Top pages</h3><ul>' + list(agg.topPaths) + '</ul>';
  html += '<h3>By day</h3><ul>' + list(Object.entries(agg.byDay).sort()) + '</ul>';
  if (entries && entries.length) {
    html += '<h3>Ledger — latest entries</h3><ul>' + entries.slice(-10).reverse().map(e => '<li>#' + e.n + ' · ' + esc(e.ts) + ' · ' + esc(e.kind) + (e.state ? ' · ' + esc(e.state) : '') + ' — ' + esc(e.summary) + '</li>').join('') + '</ul>';
  }
  if (receipts) {
    const lanes = {};
    for (const r of receipts) lanes[r.lane] = (lanes[r.lane] || 0) + 1;
    html += '<h3>Submissions — quarantine (' + receipts.length + ' total; ' + Object.entries(lanes).map(([k, v]) => esc(k) + ': ' + v).join(', ') + ')</h3>';
    html += '<p>Metadata only. Submission content is quoted data in the steward queue; it is never rendered here and nothing is public until a steward disposition.</p>';
    if (receipts.length) {
      html += '<table border="1" cellspacing="0" cellpadding="4"><tr><th>receipt</th><th>received (UTC)</th><th>channel</th><th>lane</th><th>state</th><th>claim (as asserted)</th><th>fingerprint</th></tr>';
      for (const r of receipts.slice(-50).reverse()) html += '<tr><td>' + esc(r.number) + '</td><td>' + esc(r.received_at) + '</td><td>' + esc(r.channel) + '</td><td>' + esc(r.lane) + '</td><td>' + esc(r.state) + '</td><td>' + esc(r.submission && r.submission.agent_name) + '</td><td>' + esc((r.fingerprint || '').slice(0, 12)) + '…</td></tr>';
      html += '</table>';
    }
  }
  html += '<h3>Most recent 50 requests</h3><table border="1" cellspacing="0" cellpadding="4"><tr><th>time (UTC)</th><th>class</th><th>purpose</th><th>behaviour</th><th>method</th><th>status</th><th>md</th><th>bot-auth</th><th>via</th><th>page</th><th>country</th><th>referrer</th><th>user-agent (as claimed)</th></tr>';
  for (const r of recs.slice(-50).reverse()) html += '<tr><td>' + esc(r.t) + '</td><td>' + esc(r.cls) + '</td><td>' + esc(r.purpose || '—') + '</td><td>' + esc(behaviourLabel(r)) + '</td><td>' + esc(r.method || '—') + '</td><td>' + esc(r.status === null || r.status === undefined ? '—' : r.status) + '</td><td>' + esc(r.md === null || r.md === undefined ? '—' : r.md) + '</td><td>' + esc(r.ba || '—') + '</td><td>' + esc(r.via || 'edge') + '</td><td>' + esc(r.path) + '</td><td>' + esc(r.country) + '</td><td>' + esc(r.ref) + '</td><td>' + esc(r.ua) + '</td></tr>';
  html += '</table><p>Labels describe what each request\u2019s user-agent claims. A claim is not a verification.</p></body>';
  return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' } });
};
