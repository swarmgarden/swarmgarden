// Swarm Garden — live dashboard (ESM + @netlify/blobs)
// Key-gated (?k=). Reads the visit log and the ledger and renders one
// auto-refreshing page: arrivals on record, request totals by claimed
// class, the agent-interest files, top pages, and the most recent
// requests with their raw user-agents. Labels describe what each
// request's user-agent claims. A claim is not a verification.
// ?format=json returns the same aggregates as data.
import { getStore } from '@netlify/blobs';
const KEY = process.env.STATS_KEY || '';
const INTEREST = ['llms.txt', 'robots.txt', 'agent-skills', 'agent-card', 'security.txt', 'sitemap'];

// Behaviour labelling (PRIVATE dashboard only — these labels are the
// stewards' working read of the traffic, not published claims):
//   probe-path     — the path itself is a known exploit-probe shape;
//   discovery      — a discovery file (robots, sitemap, llms, skills…);
//   protocol-read  — the protocol/action surfaces (participate, briefs,
//                    questions, reports, registry, record, receipts,
//                    utilities, changed);
//   read           — anything else: a content page, read or attempted.
// Computed over records already held; older records simply predate the
// status/method/markdown/bot-auth fields and show '—' for them.
const PROBE_RE = /(\.env|\.git\/|xmlrpc|wp-admin|wp-login|\.php([?#]|$)|proc\/self|@fs|phpunit|\.aws|\.svn|boaform|hnap1|actuator|server-status|\.bak|\.sql|config\.php)/i;
function behaviourLabel(r) {
  const p = r.path || '';
  if (PROBE_RE.test(p)) return 'probe-path';
  if (INTEREST.some(s => p.includes(s)) || p.includes('agent-card')) return 'discovery';
  if (/(participate|briefs|questions|reports|registry|record|receipts|utilities|changed)/.test(p)) return 'protocol-read';
  return 'read';
}

async function loadVisits() {
  const s = getStore('visits');
  const { blobs } = await s.list();
  const keys = (blobs || []).map(b => b.key).slice(-1500);
  const out = [];
  for (const k of keys) {
    try { const r = await s.get(k, { type: 'json' }); if (r) out.push(r); } catch (e) {}
  }
  return out.sort((a, b) => (a.t < b.t ? -1 : 1));
}

async function loadReceipts() {
  try {
    const s = getStore('receipts');
    const { blobs } = await s.list();
    const out = [];
    for (const b of blobs || []) {
      if (b.key === '_counter') continue;
      try { const r = await s.get(b.key, { type: 'json' }); if (r) out.push(r); } catch (e) {}
    }
    return out.sort((a, b) => a.number.localeCompare(b.number));
  } catch (e) { return null; }
}

async function loadLedger() {
  try {
    const s = getStore('ledger');
    const { blobs } = await s.list();
    const out = [];
    for (const b of blobs || []) {
      try { const e = await s.get(b.key, { type: 'json' }); if (e) out.push(e); } catch (e) {}
    }
    return out.sort((a, b) => (a.n || 0) - (b.n || 0));
  } catch (e) { return null; }
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

export default async (req) => {
  const url = new URL(req.url);
  if (!KEY || url.searchParams.get('k') !== KEY) return new Response('Key required.', { status: 403, headers: { 'Content-Type': 'text/plain' } });
  let recs;
  try { recs = await loadVisits(); }
  catch (e) { return new Response('Storage read failed. Visit records are also in the function logs (search VISIT).', { status: 200, headers: { 'Content-Type': 'text/plain' } }); }
  const agg = aggregate(recs);
  const entries = await loadLedger();
  const receipts = await loadReceipts();
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
  if (Object.keys(agg.byStatus).length) html += '<h3>Response status totals (edge records, Oct 17 onward)</h3><ul>' + list(Object.entries(agg.byStatus)) + '</ul>';
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
  for (const r of recs.slice(-50).reverse()) html += '<tr><td>' + esc(r.t) + '</td><td>' + esc(r.cls) + '</td><td>' + esc(r.purpose || '—') + '</td><td>' + esc(behaviourLabel(r)) + '</td><td>' + esc(r.method || '—') + '</td><td>' + esc(r.status === null || r.status === undefined ? '—' : r.status) + '</td><td>' + esc(r.md === null || r.md === undefined ? '—' : r.md) + '</td><td>' + esc(r.ba || '—') + '</td><td>' + esc(r.via || 'beacon') + '</td><td>' + esc(r.path) + '</td><td>' + esc(r.country) + '</td><td>' + esc(r.ref) + '</td><td>' + esc(r.ua) + '</td></tr>';
  html += '</table><p>Labels describe what each request\u2019s user-agent claims. A claim is not a verification.</p></body>';
  return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' } });
};
