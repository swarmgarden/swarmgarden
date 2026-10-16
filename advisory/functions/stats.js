// Bay Area Swarm Warning — live dashboard (ESM + @netlify/blobs)
// Arrivals are read from the Garden's public counts endpoint (the record lives there).
// Key-gated (?k=). Reads this site's visit log and renders one
// auto-refreshing page: arrivals on record, request totals by claimed
// class, the agent-interest files, top pages, and the most recent
// requests with their raw user-agents. Labels describe what each
// request's user-agent claims. A claim is not a verification.
// ?format=json returns the same aggregates as data.
import { getStore } from '@netlify/blobs';
const KEY = process.env.STATS_KEY || '';
const INTEREST = ['llms.txt', 'robots.txt', 'agent-skills', 'agent-card', 'security.txt', 'sitemap'];

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

async function loadArrivals() {
  try {
    const r = await fetch('https://swarmgarden.com/.netlify/functions/counts');
    if (r.ok) { const j = await r.json(); if (typeof j.arrivals_on_record === 'number') return j.arrivals_on_record; }
  } catch (e) {}
  return null;
}

function aggregate(recs) {
  const byClass = {}, byDay = {}, byPath = {}, interest = {};
  let edge = 0, beacon = 0;
  for (const r of recs) {
    byClass[r.cls] = (byClass[r.cls] || 0) + 1;
    const d = (r.t || '').slice(0, 10); byDay[d] = (byDay[d] || 0) + 1;
    byPath[r.path] = (byPath[r.path] || 0) + 1;
    if (r.via === 'edge') edge++; else beacon++;
    if (INTEREST.some(s => (r.path || '').includes(s))) interest[r.path] = (interest[r.path] || 0) + 1;
  }
  const top = (obj, n) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n);
  return { total: recs.length, byClass, byDay, topPaths: top(byPath, 12), interest: top(interest, 12), edge, beacon };
}

export default async (req) => {
  const url = new URL(req.url);
  if (!KEY || url.searchParams.get('k') !== KEY) return new Response('Key required.', { status: 403, headers: { 'Content-Type': 'text/plain' } });
  let recs;
  try { recs = await loadVisits(); }
  catch (e) { return new Response('Storage read failed. Visit records are also in the function logs (search VISIT).', { status: 200, headers: { 'Content-Type': 'text/plain' } }); }
  const agg = aggregate(recs);
  const arrivals = await loadArrivals();

  if (url.searchParams.get('format') === 'json') {
    return new Response(JSON.stringify({ arrivals_on_record: arrivals, ...agg, recent: recs.slice(-50).reverse() }, null, 2), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  }

  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const list = (pairs) => pairs.map(([k, v]) => '<li>' + esc(k) + ': ' + v + '</li>').join('');
  let html = '<!DOCTYPE html><meta charset="utf-8"><meta http-equiv="refresh" content="60"><title>Bay Area Swarm Warning — live dashboard</title>';
  html += '<body style="font-family:monospace;max-width:980px;margin:24px auto;padding:0 16px;line-height:1.5">';
  html += '<h2>Bay Area Swarm Warning — live dashboard</h2>';
  html += '<p>Refreshed ' + esc(new Date().toISOString()) + ' (auto-refresh 60s). Arrivals on record: <strong>' + (arrivals === null ? 'unavailable' : arrivals) + '</strong> — the record, from the ledger. Everything below is requests, not arrivals.</p>';
  html += '<h3>Requests — claimed class totals (' + agg.total + ' total; ' + agg.edge + ' via edge log, ' + agg.beacon + ' via legacy beacon)</h3><ul>' + list(Object.entries(agg.byClass)) + '</ul>';
  html += '<h3>Agent-interest files</h3>' + (agg.interest.length ? '<ul>' + list(agg.interest) + '</ul>' : '<p>None yet.</p>');
  html += '<h3>Top pages</h3><ul>' + list(agg.topPaths) + '</ul>';
  html += '<h3>By day</h3><ul>' + list(Object.entries(agg.byDay).sort()) + '</ul>';
  html += '<h3>Most recent 50 requests</h3><table border="1" cellspacing="0" cellpadding="4"><tr><th>time (UTC)</th><th>class</th><th>via</th><th>page</th><th>country</th><th>referrer</th><th>user-agent (as claimed)</th></tr>';
  for (const r of recs.slice(-50).reverse()) html += '<tr><td>' + esc(r.t) + '</td><td>' + esc(r.cls) + '</td><td>' + esc(r.via || 'beacon') + '</td><td>' + esc(r.path) + '</td><td>' + esc(r.country) + '</td><td>' + esc(r.ref) + '</td><td>' + esc(r.ua) + '</td></tr>';
  html += '</table><p>Labels describe what each request\u2019s user-agent claims. A claim is not a verification.</p></body>';
  return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' } });
};
